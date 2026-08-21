package com.sitrshield.core.dns

import com.sitrshield.core.SitrResult
import org.json.JSONObject

/**
 * DNS-side SafeSearch host map — loads the compiler artifact
 * (apps/shared/blocklists/android/safesearch-hosts.json), which is the
 * single source of truth for SafeSearch across platforms.
 *
 * A `*` suffix in a match pattern stands for one or two trailing DNS
 * labels (Google's ccTLDs); every other pattern is an exact hostname.
 * Runtime resolution of the target is primary; the compiled-in fallback
 * addresses are used only when that lookup fails, so SafeSearch never
 * silently drops out.
 */
class SafeSearchMap(val rules: List<Rule>) {
    data class Rule(
        val match: List<String>,
        val target: String,
        val fallbackA: List<String>,
        val fallbackAaaa: List<String>,
    )

    fun ruleFor(qname: String): Rule? {
        val name = qname.lowercase().trimEnd('.')
        return rules.firstOrNull { rule -> rule.match.any { matches(it, name) } }
    }

    companion object {
        fun matches(pattern: String, qname: String): Boolean {
            if (!pattern.endsWith(".*")) return pattern == qname
            val base = pattern.dropLast(2) // "www.google.*" -> "www.google"
            if (!qname.startsWith("$base.")) return false
            val remainder = qname.substring(base.length + 1)
            val labels = remainder.split('.')
            return labels.size in 1..2 && labels.all { it.isNotEmpty() }
        }

        fun parse(json: String): SitrResult<SafeSearchMap> {
            val o = try {
                JSONObject(json)
            } catch (_: Exception) {
                return SitrResult.Err("safesearch host map is not valid JSON")
            }
            if (o.optInt("v") != 1) {
                return SitrResult.Err("unknown safesearch host map version")
            }
            val rulesJson = o.optJSONArray("rules")
                ?: return SitrResult.Err("safesearch host map has no rules")
            val rules = ArrayList<Rule>(rulesJson.length())
            for (i in 0 until rulesJson.length()) {
                val rule = rulesJson.optJSONObject(i)
                    ?: return SitrResult.Err("safesearch rule $i is not an object")
                val match = rule.optJSONArray("match")
                val target = rule.optString("target", "")
                val fallback = rule.optJSONObject("fallback")
                if (match == null || match.length() == 0 || target.isEmpty()) {
                    return SitrResult.Err("safesearch rule $i is missing match/target")
                }
                fun strings(key: String): List<String> {
                    val array = fallback?.optJSONArray(key) ?: return emptyList()
                    return (0 until array.length()).mapNotNull { array.optString(it, null) }
                }
                rules.add(
                    Rule(
                        match = (0 until match.length()).mapNotNull { match.optString(it, null) },
                        target = target,
                        fallbackA = strings("a"),
                        fallbackAaaa = strings("aaaa"),
                    )
                )
            }
            return SitrResult.Ok(SafeSearchMap(rules))
        }
    }
}
