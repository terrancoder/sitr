package com.sitrshield.app.managed

import android.content.Context
import android.content.RestrictionsManager
import com.sitrshield.core.domains.DomainInput

/**
 * Managed configurations — the storage.managed analog, delivered by an
 * EMM / Family Link. Strongest gate layer (managed > household > device
 * user > static). Invalid entries are dropped, never fatal; applied
 * policy is always visible in Settings; there is no usage reporting to
 * the organization — same rules as the extension's managed.ts.
 */
data class ManagedPolicy(
    val organizationName: String? = null,
    val lockOptions: Boolean = false,
    val forcedCategories: List<String> = emptyList(),
    val blockDomains: List<String> = emptyList(),
    val allowDomains: List<String> = emptyList(),
) {
    val isManaged: Boolean
        get() = organizationName != null || lockOptions ||
            forcedCategories.isNotEmpty() || blockDomains.isNotEmpty() ||
            allowDomains.isNotEmpty()
}

object ManagedConfig {
    fun read(context: Context): ManagedPolicy {
        val manager =
            context.getSystemService(RestrictionsManager::class.java) ?: return ManagedPolicy()
        val restrictions = manager.applicationRestrictions ?: return ManagedPolicy()

        fun domains(key: String): List<String> =
            (restrictions.getString(key) ?: "")
                .split(',', '\n')
                .map { it.trim().lowercase() }
                .filter { DomainInput.isValidDomain(it) }
                .distinct()
                .sorted()

        val knownCategories = setOf("sitr_gambling", "sitr_dating")
        return ManagedPolicy(
            organizationName = restrictions.getString("organizationName")?.ifBlank { null },
            lockOptions = restrictions.getBoolean("lockOptions", false),
            forcedCategories = (restrictions.getString("forcedCategories") ?: "")
                .split(',')
                .map { it.trim() }
                .filter { it in knownCategories }
                .distinct(),
            blockDomains = domains("managedBlockDomains"),
            allowDomains = domains("managedAllowDomains"),
        )
    }
}
