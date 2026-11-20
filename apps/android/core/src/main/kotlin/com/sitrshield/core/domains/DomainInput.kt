package com.sitrshield.core.domains

import com.sitrshield.core.SitrResult

/**
 * Domain validation and free-text normalization.
 * Port of isValidDomain / normalizeDomainInput from
 * extension/src/lib/userRules.ts — the same conservative check the
 * blocklist compiler uses (normalize refuses more, see there).
 */
object DomainInput {
    /**
     * Lowercase ASCII LDH labels, ≥2 labels, ≤253 chars — identical to the
     * reference's per-label regex `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
     */
    fun isValidDomain(domain: String): Boolean {
        if (domain.isEmpty() || domain.length > 253) return false
        val labels = domain.split(".")
        if (labels.size < 2) return false
        fun alnum(c: Char) = c in 'a'..'z' || c in '0'..'9'
        return labels.all { label ->
            label.length in 1..63 &&
                alnum(label.first()) &&
                alnum(label.last()) &&
                label.all { alnum(it) || it == '-' }
        }
    }

    const val IP_REFUSAL = "Sitr filters site names. An IP address cannot be blocked or allowed."
    const val DUPLICATE = "Already in the list."

    /**
     * Normalize free-text user input ("HTTPS://Example.com/x") to a domain.
     * Unlike the extension, an IP address is refused (a DNS filter only
     * ever sees names), one trailing dot is dropped, and a name already in
     * [existing] is refused.
     */
    fun normalize(input: String, existing: Collection<String> = emptyList()): SitrResult<String> {
        var s = input.trim().lowercase()
        s = s.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
        s = s.replace(Regex("[/?#].*$"), "")
        // IPv6, bracketed or not, before the port strip mangles it.
        val host = s.removePrefix("[").substringBefore("]")
        if (host.count { it == ':' } >= 2 && host.all { it in "0123456789abcdef:." }) {
            return SitrResult.Err(IP_REFUSAL)
        }
        s = s.replace(Regex(":\\d+$"), "")
        s = s.removeSuffix(".")
        s = s.replace(Regex("^www\\."), "")
        // An all-digit last label: an IPv4 address (no top-level domain is numeric).
        if (s.substringAfterLast('.').let { it.isNotEmpty() && it.all(Char::isDigit) }) {
            return SitrResult.Err(IP_REFUSAL)
        }
        if (!isValidDomain(s)) {
            return SitrResult.Err("\"${input.trim()}\" is not a valid domain")
        }
        if (s in existing) return SitrResult.Err(DUPLICATE)
        return SitrResult.Ok(s)
    }
}
