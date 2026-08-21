package com.sitrshield.core.domains

import com.sitrshield.core.SitrResult

/**
 * Domain validation and free-text normalization.
 * Port of isValidDomain / normalizeDomainInput from
 * extension/src/lib/userRules.ts — the same conservative check the
 * blocklist compiler uses.
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

    /** Normalize free-text user input ("HTTPS://Example.com/x") to a domain. */
    fun normalize(input: String): SitrResult<String> {
        var s = input.trim().lowercase()
        s = s.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
        s = s.replace(Regex("[/?#].*$"), "")
        s = s.replace(Regex(":\\d+$"), "")
        s = s.replace(Regex("^www\\."), "")
        if (!isValidDomain(s)) {
            return SitrResult.Err("\"${input.trim()}\" is not a valid domain")
        }
        return SitrResult.Ok(s)
    }
}
