package com.sitrshield.core

import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.SyncClient
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncHttpResponse
import com.sitrshield.core.sync.SyncInput
import com.sitrshield.core.sync.SyncStatus
import com.sitrshield.core.sync.SyncTransport
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Sync-client scenarios against a scripted transport — mirrors
 * tests/src/syncClient.test.ts (and the Swift SyncClientTests) case by
 * case: create, pull-merge, push preconditions, one 409 retry, rollback
 * refusal, offline mapping.
 */
class SyncClientTest {
    private class Recorded(
        val method: String,
        val url: String,
        val headers: Map<String, String>,
    )

    private class ScriptedTransport(steps: List<Any>) : SyncTransport {
        // Steps: SyncHttpResponse to respond, or "offline" to throw.
        private val queue = ArrayDeque(steps)
        val recorded = mutableListOf<Recorded>()

        override fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: ByteArray?,
        ): SyncHttpResponse {
            recorded.add(Recorded(method, url, headers))
            return when (val step = queue.removeFirstOrNull() ?: fail("script exhausted")) {
                "offline" -> throw IOException("offline")
                is SyncHttpResponse -> step
                else -> fail("bad script step")
            }
        }
    }

    private val secret = ByteArray(32) { it.toByte() }
    private val now = 1_700_000_000_000.0
    private val keys = SyncCrypto.deriveKeys(secret).getOrNull()!!

    private fun state(rev: Int, by: String = "device-a") =
        HouseholdState(rev = rev, updatedAt = rev * 1000.0, updatedBy = by)

    private fun sealed(s: HouseholdState): ByteArray =
        Household.sealState(s, keys.encKey).getOrNull()!!

    private fun client(transport: ScriptedTransport) = SyncClient(transport, { now })

    private fun respond(status: Int, etag: String? = null, body: ByteArray = ByteArray(0)) =
        SyncHttpResponse(status, etag, body)

    @Test
    fun createWhenServerHasNoBlob() {
        val transport = ScriptedTransport(
            listOf(respond(404), respond(201, "\"1\""))
        )
        val local = state(rev = 1)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, local, maxSeenRev = 0, deviceId = "device-a")
        )

        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(local, outcome.state)
        assertEquals(1, outcome.maxSeenRev)
        assertEquals(1, outcome.etag)

        assertEquals(2, transport.recorded.size)
        val put = transport.recorded[1]
        assertEquals("PUT", put.method)
        assertEquals("*", put.headers["If-None-Match"])
        assertNull(put.headers["If-Match"])
        assertNull(put.headers["X-Sitr-Entitlement"])
        assertEquals("Bearer ${keys.authToken}", put.headers["Authorization"])
        assertTrue(put.url.endsWith("/v1/blob/${keys.householdId}"))
    }

    @Test
    fun entitlementHeaderSentOnCreateWhenProvided() {
        val transport = ScriptedTransport(listOf(respond(404), respond(201, "\"1\"")))
        client(transport).syncOnce(
            SyncInput(
                secret, state(rev = 1), maxSeenRev = 0,
                deviceId = "device-a", entitlement = "sitr-ent-v1.x.y",
            )
        )
        assertEquals("sitr-ent-v1.x.y", transport.recorded[1].headers["X-Sitr-Entitlement"])
    }

    @Test
    fun remoteNewerStateWinsWithoutPush() {
        val remote = state(rev = 5, by = "device-b")
        val transport = ScriptedTransport(listOf(respond(200, "\"7\"", sealed(remote))))
        val outcome = client(transport).syncOnce(
            SyncInput(secret, state(rev = 3), maxSeenRev = 3, deviceId = "device-a")
        )

        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(remote, outcome.state)
        assertEquals(5, outcome.maxSeenRev)
        assertEquals(7, outcome.etag)
        assertEquals(1, transport.recorded.size, "no push when the server copy won")
    }

    @Test
    fun localAheadPushesWithIfMatch() {
        val remote = state(rev = 5, by = "device-b")
        val transport = ScriptedTransport(
            listOf(respond(200, "\"9\"", sealed(remote)), respond(200, "\"10\""))
        )
        val local = state(rev = 7)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, local, maxSeenRev = 5, deviceId = "device-a")
        )

        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(local, outcome.state, "local won the merge; pushed unbumped")
        assertEquals(10, outcome.etag)
        assertEquals("\"9\"", transport.recorded[1].headers["If-Match"])
        assertNull(transport.recorded[1].headers["If-None-Match"])
    }

    @Test
    fun rollbackIsRefused() {
        val stale = state(rev = 2, by = "device-b")
        val transport = ScriptedTransport(listOf(respond(200, "\"4\"", sealed(stale))))
        val local = state(rev = 6)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, local, maxSeenRev = 5, deviceId = "device-a")
        )

        assertEquals(SyncStatus.State.ERROR, outcome.status.state)
        assertTrue(outcome.status.error!!.contains("older household state"))
        assertEquals(local, outcome.state, "stale server state must never be applied")
        assertEquals(5, outcome.maxSeenRev)
        assertEquals(1, transport.recorded.size)
    }

    @Test
    fun conflictRetriesExactlyOnce() {
        val remoteFirst = state(rev = 5, by = "device-b")
        val remoteSecond = state(rev = 6, by = "device-c")
        val transport = ScriptedTransport(
            listOf(
                respond(200, "\"5\"", sealed(remoteFirst)),
                respond(409, "\"6\""),
                respond(200, "\"6\"", sealed(remoteSecond)),
                respond(200, "\"7\""),
            )
        )
        val outcome = client(transport).syncOnce(
            SyncInput(secret, state(rev = 7), maxSeenRev = 5, deviceId = "device-a")
        )

        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(4, transport.recorded.size, "pull, conflicted push, re-pull, re-push")
        assertEquals(7, outcome.etag)
    }

    @Test
    fun repeatedConflictSurfacesError() {
        val remote = state(rev = 5, by = "device-b")
        val transport = ScriptedTransport(
            listOf(
                respond(200, "\"5\"", sealed(remote)),
                respond(409, "\"6\""),
                respond(200, "\"6\"", sealed(remote)),
                respond(409, "\"7\""),
            )
        )
        val outcome = client(transport).syncOnce(
            SyncInput(secret, state(rev = 7), maxSeenRev = 5, deviceId = "device-a")
        )
        assertEquals(SyncStatus.State.ERROR, outcome.status.state)
        assertTrue(outcome.status.error!!.contains("conflict"))
    }

    @Test
    fun offlineIsOfflineNotError() {
        val transport = ScriptedTransport(listOf("offline"))
        val local = state(rev = 1)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, local, maxSeenRev = 1, deviceId = "device-a")
        )
        assertEquals(SyncStatus.State.OFFLINE, outcome.status.state)
        assertEquals(local, outcome.state)
    }

    @Test
    fun equalStatesNoPush() {
        val shared = state(rev = 4)
        val transport = ScriptedTransport(listOf(respond(200, "\"4\"", sealed(shared))))
        val outcome = client(transport).syncOnce(
            SyncInput(secret, shared, maxSeenRev = 4, deviceId = "device-a")
        )
        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(1, transport.recorded.size)
    }
}
