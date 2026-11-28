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
import com.sitrshield.app.HouseholdActions
import com.sitrshield.app.SitrApp
import com.sitrshield.core.SitrResult
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
 * Ordering: syncOnce → engine apply → persist (via SitrApp.update).
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

        // Honest fair-use enrolment (Household.enrolDevice, as the
        // extension's service worker): join the device list when missing —
        // after a join, or after a guardian refreshed the list — below the
        // 20-device cap; at the cap, surface it — filtering stays active.
        if (outcome.status.state == SyncStatus.State.OK) {
            when (val enrolled = Household.enrolDevice(outcome.state, settings.deviceId, now())) {
                is SitrResult.Err -> outcome = outcome.copy(
                    status = SyncStatus(SyncStatus.State.ERROR, error = enrolled.message)
                )
                is SitrResult.Ok -> enrolled.value?.let { state ->
                    outcome = client.syncOnce(
                        SyncInput(
                            rootSecret = secret,
                            local = state,
                            maxSeenRev = outcome.maxSeenRev,
                            deviceId = settings.deviceId,
                            entitlement = settings.entitlementToken,
                        )
                    )
                }
            }
        }

        // Merge into the settings as they are NOW, not as they were when
        // this run started: the network round-trip takes seconds, and a
        // result written wholesale would undo anything changed meanwhile.
        var changedMeanwhile = false
        val actions = HouseholdActions(app)
        app.update { current ->
            when {
                // Left the household while we were on the network — this
                // result belongs to a household the device is no longer in.
                app.secretStore.load()?.contentEquals(secret) != true -> current
                // Edited locally meanwhile: keep the edit, sync again from it.
                current.household != settings.household -> {
                    changedMeanwhile = true
                    current.copy(maxSeenRev = maxOf(current.maxSeenRev, outcome.maxSeenRev))
                }
                // The guardian's child settings: adopted, applied on a
                // child phone, restored or acked — a write syncs again.
                else -> actions.childStep(
                    current.copy(
                        household = outcome.state,
                        maxSeenRev = outcome.maxSeenRev,
                        syncStatus = outcome.status,
                    )
                ).also { changedMeanwhile = it.household != outcome.state }
            }
        }
        if (changedMeanwhile) kick(applicationContext)
        // Connectivity dropped mid-run: WorkManager retries with backoff
        // once the network constraint holds again.
        return if (outcome.status.state == SyncStatus.State.OFFLINE) Result.retry()
        else Result.success()
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
                OneTimeWorkRequestBuilder<SyncWorker>()
                    .setConstraints(
                        Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .build()
                    )
                    .build(),
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork("sitr-sync")
        }
    }
}
