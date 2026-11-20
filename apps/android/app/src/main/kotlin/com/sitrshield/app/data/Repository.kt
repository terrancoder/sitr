package com.sitrshield.app.data

import android.content.Context
import android.content.SharedPreferences
import com.sitrshield.core.gate.Delay
import com.sitrshield.core.gate.DelayStamp
import com.sitrshield.core.gate.PauseRecord
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.ClaimState
import com.sitrshield.core.sync.Entitlement
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
 * through SitrApp.update, which installs the new DecisionSnapshot
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
    /** Strict Search — off by default; see StrictSearchHosts. */
    val strictSearch: Boolean = false,
    /** Sites whose images and video are off ("x", "reddit", …) — none by
     *  default; see SITE_MEDIA_HOSTS in the compiler. */
    val mediaOff: Set<String> = emptySet(),
    /** Opt-in lists turned on (OptionalLists ids) — none by default;
     *  device-local, never synced. */
    val optionalLists: Set<String> = emptySet(),
    /** Guard mode armed by a guardian (ChildLock); opened only by the PIN. */
    val childLock: Boolean = false,
    /** UI appearance: "system" | "light" | "dark" (ui.Appearance). */
    val appearance: String = "system",
    val userAllow: List<String> = emptyList(),
    val userBlock: List<String> = emptyList(),
    val role: String? = null,
    val household: HouseholdState? = null,
    val maxSeenRev: Int = 0,
    val entitlementToken: String? = null,
    /** Sitr Family version 2: this device's claim state, including the
     * household's last known end date and lapse (claims.end). Never in the
     * household blob; the code and claim secret are in SecretStore. */
    val claims: ClaimState = ClaimState(),
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
            strictSearch = prefs.getBoolean("strictSearch", false),
            // Up to 0.2.1 this was one "xMedia" boolean.
            mediaOff = prefs.getStringSet("mediaOff", emptySet())!! +
                (if (prefs.getBoolean("xMedia", false)) setOf("x") else emptySet()),
            optionalLists = prefs.getStringSet("optionalLists", emptySet())!!.toSet(),
            childLock = prefs.getBoolean("childLock", false),
            appearance = prefs.getString("appearance", null)
                ?.takeIf { it in setOf("system", "light", "dark") } ?: "system",
            deviceId = deviceId,
            disabledCategories = prefs.getStringSet("disabledCategories", emptySet())!!.toList(),
            userAllow = prefs.getStringSet("userAllow", emptySet())!!.sorted(),
            userBlock = prefs.getStringSet("userBlock", emptySet())!!.sorted(),
            role = prefs.getString("householdRole", null),
            household = household,
            maxSeenRev = prefs.getInt("syncMaxSeenRev", 0),
            entitlementToken = prefs.getString("entitlementToken", null),
            claims = Entitlement.loadClaimState(prefs.getString("claimState", null)),
            syncStatus = syncStatus,
        )
    }

    /** Persist + publish. Callers apply to the ENGINE first (SitrApp). */
    fun persist(next: Settings) {
        prefs.edit()
            .putBoolean("onboarded", next.onboarded)
            .putBoolean("filterEnabled", next.filterEnabled)
            .putBoolean("strictSearch", next.strictSearch)
            .putStringSet("mediaOff", next.mediaOff)
            .remove("xMedia")
            .putStringSet("optionalLists", next.optionalLists)
            .putBoolean("childLock", next.childLock)
            .putString("appearance", next.appearance)
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
            .putString("claimState", next.claims.toJson().toString())
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

    // "Wait before loosening": device-local keys outside Settings, so the
    // once-a-second status read never goes through SitrApp.update, and
    // never in the household state (older versions drop unknown fields).

    val loosenDelayMinutes: Int
        get() = Delay.sanitizeMinutes(prefs.getInt("loosenDelayMinutes", 0))

    var loosenDelayStamp: DelayStamp?
        get() {
            val mono = prefs.getLong("loosenDelayAtMono", -1)
            val wall = prefs.getLong("loosenDelayAtWall", -1)
            return if (mono >= 0 && wall >= 0) DelayStamp(mono, wall) else null
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    remove("loosenDelayAtMono").remove("loosenDelayAtWall")
                } else {
                    putLong("loosenDelayAtMono", value.atMono).putLong("loosenDelayAtWall", value.atWall)
                }
            }.apply()
        }

    /**
     * Pauses that still count against the allowance (Pause.live), as
     * "atMono,atWall,usedMs;…". Device-local, outside Settings like the
     * delay stamp; never synced. Stamps on both clocks, so neither a clock
     * change nor a reboot can hand the allowance back.
     */
    var pauseRecords: List<PauseRecord>
        get() = prefs.getString("pauseRecords", "")!!.split(';').mapNotNull { r ->
            r.split(',').mapNotNull(String::toLongOrNull).takeIf { it.size == 3 }
                ?.let { (mono, wall, used) -> PauseRecord(DelayStamp(mono, wall), used) }
        }
        set(value) {
            prefs.edit().putString(
                "pauseRecords",
                value.joinToString(";") { "${it.at.atMono},${it.at.atWall},${it.usedMs}" },
            ).apply()
        }

    /** Any change to the setting clears the request, in the same write. */
    fun setLoosenDelayMinutes(minutes: Int) {
        prefs.edit()
            .putInt("loosenDelayMinutes", Delay.sanitizeMinutes(minutes))
            .remove("loosenDelayAtMono")
            .remove("loosenDelayAtWall")
            .apply()
    }
}
