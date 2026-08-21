package com.sitrshield.app.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.sitrshield.app.SitrApp
import com.sitrshield.core.household.Household
import com.sitrshield.core.sync.SyncClient
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncStatus
import java.util.concurrent.TimeUnit

/**
 * Sync scheduling — every 30 minutes while a household exists (matching
 * the extension's alarm cadence) plus an immediate run after household
 * mutations. FIRST LINE: no root secret → return without touching the
 * network — the zero-requests-without-household invariant, structurally
 * enforced and grep-verifiable.
 *
 * Ordering: syncOnce → engine apply → persist (via applySettings).
 * Sync outcomes write only household state + sync status; they cannot
 * touch protection status (EngineFacts has no sync input).
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val app = applicationContext as SitrApp
        val secret = app.secretStore.load() ?: return Result.success()

        val settings = app.repository.current()
        val now = { System.currentTimeMillis().toDouble() }
        val local = settings.household
            ?: Household.emptyState(settings.deviceId, now())
        val client = SyncClient(SyncHttp(), now)

        var outcome = client.syncOnce(
            SyncInput(
                rootSecret = secret,
                local = local,
                maxSeenRev = settings.maxSeenRev,
                deviceId = settings.deviceId,
                entitlement = settings.entitlementToken,
            )
        )

        // Honest fair-use enrollment (mirrors the extension's service
        // worker): join the device list only below the 20-device cap;
        // at the cap, surface it — filtering stays fully active.
        if (outcome.status.state == SyncStatus.State.OK &&
            settings.deviceId !in outcome.state.devices
        ) {
            if (outcome.state.devices.size >= Household.MAX_HOUSEHOLD_DEVICES) {
                outcome = outcome.copy(
                    status = SyncStatus(
                        SyncStatus.State.ERROR,
                        error = "this household is at its " +
                            "${Household.MAX_HOUSEHOLD_DEVICES}-device fair-use cap",
                    )
                )
            } else {
                val enrolled = Household.bumpRev(
                    outcome.state.copy(
                        devices = (outcome.state.devices + settings.deviceId).sorted(),
                    ),
                    settings.deviceId,
                    now(),
                )
                outcome = client.syncOnce(
                    SyncInput(
                        rootSecret = secret,
                        local = enrolled,
                        maxSeenRev = outcome.maxSeenRev,
                        deviceId = settings.deviceId,
                        entitlement = settings.entitlementToken,
                    )
                )
            }
        }

        app.applySettings(
            app.repository.current().copy(
                household = outcome.state,
                maxSeenRev = outcome.maxSeenRev,
                syncStatus = outcome.status,
            ),
            kickSync = false,
        )
        return Result.success()
    }

    companion object {
        fun schedulePeriodic(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "sitr-sync",
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
                    .setConstraints(
                        Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .build()
                    )
                    .build(),
            )
        }

        fun kick(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                "sitr-sync-now",
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().build(),
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork("sitr-sync")
        }
    }
}
