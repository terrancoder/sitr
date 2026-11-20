package com.sitrshield.core

import com.sitrshield.core.domains.DomainInput
import kotlin.test.Test
import kotlin.test.assertEquals

/** What the list add fields accept and refuse (QA 2026-11-20, A-MI-02 and A-NO-01). */
class DomainInputTest {
    private fun ok(s: String) = SitrResult.Ok(s)
    private val ip = SitrResult.Err(DomainInput.IP_REFUSAL)

    @Test
    fun ipAddressesAreRefused() {
        for (input in listOf("1.2.3.4", "http://1.2.3.4:8080/x", "::1", "[::1]", "2001:db8::1", "http://[2001:db8::1]:8080/x")) {
            assertEquals(ip, DomainInput.normalize(input), input)
        }
        assertEquals(ok("example.com"), DomainInput.normalize("example.com:8080"))
    }

    @Test
    fun oneTrailingDotIsDropped() {
        assertEquals(ok("example.com"), DomainInput.normalize("example.com."))
        assertEquals(ok("example.com"), DomainInput.normalize("https://www.Example.com./x"))
        assertEquals(SitrResult.Err("\"example.com..\" is not a valid domain"), DomainInput.normalize("example.com.."))
    }

    @Test
    fun aNameAlreadyListedIsRefusedInAnyCase() {
        assertEquals(SitrResult.Err(DomainInput.DUPLICATE), DomainInput.normalize("Example.COM", listOf("example.com")))
        assertEquals(ok("example.org"), DomainInput.normalize("example.org", listOf("example.com")))
    }
}
