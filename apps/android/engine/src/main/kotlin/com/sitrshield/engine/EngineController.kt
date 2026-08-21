package com.sitrshield.engine

import com.sitrshield.core.dns.SafeSearchMap
import com.sitrshield.core.rules.DecisionSnapshot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Process-singleton engine state.
 *
 * "Engine first, persist after": the app builds a complete
 * DecisionSnapshot from its settings + the verified blocklist artifacts,
 * installs it here (an atomic volatile swap), and only then persists the
 * settings. The service reads the snapshot per query; a service (re)start
 * finds the current one waiting.
 *
 * EngineFacts is the fail-visible input: ProtectionStatus is DERIVED from
 * these proven facts (never assumed), and sync state is deliberately not
 * part of them — sync can never touch protection status.
 */
data class EngineFacts(
    /** The tun is established and the read loop is alive. */
    val tunActive: Boolean = false,
    /** Checksums of the loaded blocklist artifacts verified. */
    val blocklistVerified: Boolean = false,
    /** The underlying network offered at least one resolver. */
    val hasUpstreams: Boolean = false,
    /** Strict Private DNS is set — DNS bypasses the filter entirely. */
    val privateDnsStrict: Boolean = false,
    /** The system or another VPN revoked us (epoch ms, 0 = never). */
    val revokedAt: Long = 0,
)

/** The fail-visible verdict shown as notification + home status card. */
sealed class Protection {
    object Active : Protection()
    data class Inactive(val reason: Reason) : Protection()

    enum class Reason {
        NOT_RUNNING,
        VPN_REVOKED,
        PRIVATE_DNS_STRICT,
        BLOCKLIST_LOAD_FAILED,
        NO_UPSTREAMS,
    }
}

object EngineController {
    @Volatile
    var snapshot: DecisionSnapshot = DecisionSnapshot()
        private set

    @Volatile
    var safeSearchMap: SafeSearchMap = SafeSearchMap(emptyList())
        private set

    private val factsFlow = MutableStateFlow(EngineFacts())
    val facts: StateFlow<EngineFacts> = factsFlow.asStateFlow()

    /** Atomic snapshot swap — the engine-first half of every change. */
    fun apply(newSnapshot: DecisionSnapshot, newSafeSearchMap: SafeSearchMap) {
        snapshot = newSnapshot
        safeSearchMap = newSafeSearchMap
    }

    fun updateFacts(transform: (EngineFacts) -> EngineFacts) {
        factsFlow.update(transform)
    }

    /**
     * Derived, never optimistic: any unproven or broken input is red.
     * A protection the user hasn't enabled (service simply not started)
     * is NOT_RUNNING — the UI distinguishes "off by choice" from failure
     * using its own enabled flag.
     */
    fun protection(f: EngineFacts = facts.value): Protection = when {
        f.revokedAt != 0L -> Protection.Inactive(Protection.Reason.VPN_REVOKED)
        !f.tunActive -> Protection.Inactive(Protection.Reason.NOT_RUNNING)
        !f.blocklistVerified -> Protection.Inactive(Protection.Reason.BLOCKLIST_LOAD_FAILED)
        f.privateDnsStrict -> Protection.Inactive(Protection.Reason.PRIVATE_DNS_STRICT)
        !f.hasUpstreams -> Protection.Inactive(Protection.Reason.NO_UPSTREAMS)
        else -> Protection.Active
    }
}
