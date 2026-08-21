package com.sitrshield.core.domainset

import com.sitrshield.core.SitrResult
import com.sitrshield.core.domains.DomainInput
import java.security.MessageDigest

/**
 * A compiled category domain set — loads the plain-text artifact emitted
 * by tools/compiler (--android-out) after verifying its SHA-256 against
 * the committed checksums.json. A checksum or parse failure is a surfaced
 * error and the engine refuses to start (fail-visible, never "start
 * anyway"); invalid lines are hard errors, mirroring the compiler's
 * "a silently dropped domain is a silently unprotected user".
 */
class DomainSet private constructor(val domains: Set<String>) {
    val size: Int get() = domains.size

    companion object {
        fun load(artifact: ByteArray, expectedSha256Hex: String?): SitrResult<DomainSet> {
            if (expectedSha256Hex != null) {
                val got = MessageDigest.getInstance("SHA-256")
                    .digest(artifact)
                    .joinToString("") { "%02x".format(it) }
                if (got != expectedSha256Hex.lowercase()) {
                    return SitrResult.Err(
                        "domain list failed checksum verification — refusing to load"
                    )
                }
            }
            val text = String(artifact, Charsets.UTF_8)
            val domains = HashSet<String>()
            for ((index, line) in text.split("\n").withIndex()) {
                if (line.isEmpty()) continue
                if (!DomainInput.isValidDomain(line)) {
                    return SitrResult.Err("invalid domain on line ${index + 1}: \"$line\"")
                }
                domains.add(line)
            }
            return SitrResult.Ok(DomainSet(domains))
        }
    }
}
