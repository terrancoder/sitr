package com.sitrshield.app.data

import android.content.Context
import android.content.SharedPreferences
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.SyncStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.UUID

/**
 * App settings — SharedPreferences-backed, exposed as one StateFlow.
 * Mirrors the extension's storage.local keys (docs/data-flow.md §Data
 * stored locally). The root secret is NOT here — see SecretStore.
 *
 * ORDERING RULE (engine first, persist after): every mutation goes
 * through SitrApp.applySettings, which installs the new DecisionSnapshot
 * into the engine BEFORE this repository persists — settings never claim
 * a state the engine doesn't have.
 */
data class Settings(
    val onboarded: Boolean = false,
    /** User intent: filtering on. The engine's facts say whether it IS. */
    val filterEnabled: Boolean = false,
    val deviceId: String = "",
    /** Device-level toggles; the household's list wins when joined. */
    val disabledCategories: List<String> = emptyList(),
    val userAllow: List<String> = emptyList(),
    val userBlock: List<String> = emptyList(),
    val role: String? = null,
    val household: HouseholdState? = null,
    val maxSeenRev: Int = 0,
    val entitlementToken: String? = null,
    val syncStatus: SyncStatus = SyncStatus.NEVER_SYNCED,
)

class Repository(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("sitr", Context.MODE_PRIVATE)

    private val state = MutableStateFlow(load())
    val settings: StateFlow<Settings> = state.asStateFlow()

    private fun load(): Settings {
        val deviceId = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString()
            .also { prefs.edit().putString("deviceId", it).apply() }
        val householdJson = prefs.getString("householdState", null)
        val household = householdJson?.let {
            try {
                Household.sanitize(JSONObject(it)).getOrNull()
            } catch (_: Exception) {
                null
            }
        }
        val syncJson = prefs.getString("syncStatus", null)
        val syncStatus = syncJson?.let {
            try {
                val o = JSONObject(it)
                SyncStatus(
                    state = SyncStatus.State.valueOf(o.getString("state")),
                    lastSuccessAt = if (o.has("lastSuccessAt")) o.getDouble("lastSuccessAt") else null,
                    error = o.optString("error").ifEmpty { null },
                )
            } catch (_: Exception) {
                null
            }
        } ?: SyncStatus.NEVER_SYNCED
        return Settings(
            onboarded = prefs.getBoolean("onboarded", false),
            filterEnabled = prefs.getBoolean("filterEnabled", false),
            deviceId = deviceId,
            disabledCategories = prefs.getStringSet("disabledCategories", emptySet())!!.toList(),
            userAllow = prefs.getStringSet("userAllow", emptySet())!!.sorted(),
            userBlock = prefs.getStringSet("userBlock", emptySet())!!.sorted(),
            role = prefs.getString("householdRole", null),
            household = household,
            maxSeenRev = prefs.getInt("syncMaxSeenRev", 0),
            entitlementToken = prefs.getString("entitlementToken", null),
            syncStatus = syncStatus,
        )
    }

    /** Persist + publish. Callers apply to the ENGINE first (SitrApp). */
    fun persist(next: Settings) {
        prefs.edit()
            .putBoolean("onboarded", next.onboarded)
            .putBoolean("filterEnabled", next.filterEnabled)
            .putStringSet("disabledCategories", next.disabledCategories.toSet())
            .putStringSet("userAllow", next.userAllow.toSet())
            .putStringSet("userBlock", next.userBlock.toSet())
            .putString("householdRole", next.role)
            .putString(
                "householdState",
                next.household?.let { Household.toJSONObject(it).toString() },
            )
            .putInt("syncMaxSeenRev", next.maxSeenRev)
            .putString("entitlementToken", next.entitlementToken)
            .putString(
                "syncStatus",
                JSONObject().apply {
                    put("state", next.syncStatus.state.name)
                    next.syncStatus.lastSuccessAt?.let { put("lastSuccessAt", it) }
                    next.syncStatus.error?.let { put("error", it) }
                }.toString(),
            )
            .apply()
        state.value = next
    }

    fun current(): Settings = state.value
}
