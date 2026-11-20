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
import com.sitrshield.core.gate.HouseholdRole
import com.sitrshield.core.household.Household
import com.sitrshield.core.sync.FamilyRound
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncRun
import com.sitrshield.core.sync.SyncStatus
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Sync scheduling — every 30 minutes while a household exists (matching
 * the extension's alarm cadence) plus an immediate run after household
 * mutations. FIRST LINE: no root secret → return without touching the
 * network — the zero-requests-without-household invariant, structurally
 * enforced and grep-verifiable.
 *
 * The round is a Sitr Family round (FamilyRound via SyncRun): it claims
 * from the claim host only with a subscription code and only when a claim
 * is due, inside this same run — no job of its own.
 *
 * Ordering: round → engine apply → persist (via SitrApp.update).
 * Sync outcomes write only household state + sync status; they cannot
 * touch protection status (EngineFacts has no sync input).
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    // One round at a time (SyncRun.exclusive): the immediate and periodic
    // runs can start together, and both would claim.
    override fun doWork(): Result = SyncRun.exclusive { runRound() }

    private fun runRound(): Result {
        val app = applicationContext as SitrApp
        val secret = app.secretStore.load() ?: return Result.success()

        val settings = app.repository.current()
        val now = { System.currentTimeMillis().toDouble() }
        val local = settings.household
            ?: Household.emptyState(settings.deviceId, now())
        // No code (or a child device): FamilyRound sends nothing to the
        // claim host; with a code, only when a claim is due (Entitlement.next).
        val subscription = app.secretStore.loadSubscription()
        // The claim state is kept in memory during the run and written once,
        // below, with the rest of the result.
        var claims = settings.claims
        val round = FamilyRound(
            SyncHttp(), now, { Random.nextDouble() },
            loadClaims = { claims }, saveClaims = { claims = it },
            syncBaseUrl = Endpoints.sync(app), claimBaseUrl = Endpoints.claim(app),
        )
        var dropped = false
        val outcome = SyncRun.run(
            round,
            SyncInput(
                rootSecret = secret,
                local = local,
                maxSeenRev = settings.maxSeenRev,
                deviceId = settings.deviceId,
                entitlement = settings.entitlementToken,
            ),
            subscription,
            HouseholdRole.fromWire(settings.role),
            now(),
        ) {
            // A code of an Institutions plan: deleted with its claim secret.
            dropped = true
        }

        // Merge into the settings as they are NOW, not as they were when
        // this run started: the network round-trip takes seconds, and a
        // result written wholesale would undo anything changed meanwhile.
        var changedMeanwhile = false
        app.update { current ->
            // Left the household while we were on the network — this
            // result belongs to a household the device is no longer in.
            if (app.secretStore.load()?.contentEquals(secret) != true) return@update current
            // The code was entered, changed or removed meanwhile: that
            // change reset the claim state; keep it.
            val sameCode = app.secretStore.loadSubscription() == subscription
            if (dropped && sameCode) app.secretStore.clearSubscription()
            val withClaims =
                if (!sameCode) current
                else current.copy(claims = claims, planNotAccepted = current.planNotAccepted || dropped)
            when {
                // Edited locally meanwhile: keep the edit, sync again from it.
                current.household != settings.household -> {
                    changedMeanwhile = true
                    withClaims.copy(maxSeenRev = maxOf(current.maxSeenRev, outcome.maxSeenRev))
                }
                else -> withClaims.copy(
                    household = outcome.state,
                    maxSeenRev = outcome.maxSeenRev,
                    syncStatus = outcome.status,
                )
            }
        }
        if (changedMeanwhile) kick(applicationContext)
        // Connectivity dropped mid-run: WorkManager retries with backoff
        // once the network constraint holds again. A claim's failure never
        // retries here: the claim state's own backoff (Entitlement.record)
        // decides when the next periodic run claims again.
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
