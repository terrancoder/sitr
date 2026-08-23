package com.sitrshield.core.dns

import com.sitrshield.core.SitrResult
import org.json.JSONObject

/**
 * Strict Search — the optional, off-by-default setting that suppresses
 * image/thumbnail hosts used by search engines.
 *
 * Why this exists: SafeSearch can only be forced where a vendor
 * publishes an endpoint for it (threat-model.md T11). On engines that
 * publish none, the exposure users actually meet is explicit imagery in
 * results, and those thumbnails come from their own hostnames — so DNS
 * can suppress them without touching page content.
 *
 * What it deliberately does NOT do: hide text results. No vendor
 * publishes a gambling filter, and removing result rows would mean
 * reading and rewriting the search page — the traffic inspection this
 * product is built not to have. The app states that plainly next to the
 * toggle rather than implying the setting does more than it does.
 *
 * These hosts are not in the shared blocklist: a general-purpose search
 * engine fails the inclusion policy's primary-purpose test, so they ship
 * as a separate artifact behind a user toggle.
 */
class StrictSearchHosts(val entries: List<Entry>) {
    data class Entry(
        val engine: String,
        val host: String,
        /** True when the engine also has a vendor safe-mode endpoint. */
        val safeModeAvailable: Boolean,
    )

    /** Every host, for folding into the decision snapshot. */
    val hosts: Set<String> get() = entries.map { it.host }.toSet()

    /** Engines with no vendor safe mode — what the UI names explicitly. */
    val enginesWithoutSafeMode: List<String>
        get() = entries.filterNot { it.safeModeAvailable }.map { it.engine }.distinct()

    companion object {
        val EMPTY = StrictSearchHosts(emptyList())

        fun parse(json: String): SitrResult<StrictSearchHosts> {
            val o = try {
                JSONObject(json)
            } catch (_: Exception) {
                return SitrResult.Err("strict-search host map is not valid JSON")
            }
            if (o.optInt("v") != 1) {
                return SitrResult.Err("unknown strict-search host map version")
            }
            val array = o.optJSONArray("hosts")
                ?: return SitrResult.Err("strict-search host map has no hosts")
            val entries = ArrayList<Entry>(array.length())
            for (i in 0 until array.length()) {
                val e = array.optJSONObject(i)
                    ?: return SitrResult.Err("strict-search entry $i is not an object")
                val host = e.optString("host", "")
                val engine = e.optString("engine", "")
                if (host.isEmpty() || engine.isEmpty()) {
                    return SitrResult.Err("strict-search entry $i is missing engine/host")
                }
                entries.add(Entry(engine, host, e.optBoolean("safeModeAvailable", false)))
            }
            return SitrResult.Ok(StrictSearchHosts(entries))
        }
    }
}
