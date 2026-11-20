package com.sitrshield.core

import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.sync.SyncClient
import com.sitrshield.core.sync.Entitlement
import com.sitrshield.core.sync.HouseholdEnd
import com.sitrshield.core.sync.SyncCrypto
import com.sitrshield.core.sync.SyncRefusal
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
        val body: ByteArray?,
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
            recorded.add(Recorded(method, url, headers, body))
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

    private fun respond(
        status: Int,
        etag: String? = null,
        body: ByteArray = ByteArray(0),
        expires: String? = null,
    ) = SyncHttpResponse(status, etag, body, expires)

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
        assertEquals(1L, outcome.etag)

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
    fun joinPlaceholderWritesNothingOn404() {
        val transport = ScriptedTransport(listOf(respond(404)))
        val placeholder = Household.emptyState("device-a", 0.0)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, placeholder, maxSeenRev = 0, deviceId = "device-a")
        )
        assertEquals(SyncStatus.State.NOT_FOUND, outcome.status.state)
        assertEquals(placeholder, outcome.state)
        assertEquals(listOf("GET"), transport.recorded.map { it.method })
    }

    @Test
    fun leavingAJoinPlaceholderSendsNothing() {
        val transport = ScriptedTransport(emptyList())
        client(transport).unenroll(
            SyncInput(secret, Household.emptyState("device-a", 0.0), maxSeenRev = 0, deviceId = "device-a")
        )
        assertTrue(transport.recorded.isEmpty())
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
        assertEquals(7L, outcome.etag)
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
        assertEquals(10L, outcome.etag)
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
        assertEquals(7L, outcome.etag)
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

    @Test
    fun unenrollPushesTheLatestStateWithoutThisDevice() {
        val remote = state(rev = 5).copy(devices = listOf("device-a", "me"))
        val transport = ScriptedTransport(
            listOf(
                respond(200, "\"5\"", sealed(remote)), // round 1: already in sync
                respond(200, "\"5\"", sealed(remote)), // round 2: pull
                respond(200, "\"6\""),                 // round 2: push
            )
        )
        val outcome = client(transport).unenroll(
            SyncInput(secret, remote, maxSeenRev = 5, deviceId = "me")
        )

        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(listOf("device-a"), outcome.state.devices)
        val pushed = Household.openState(transport.recorded.last().body!!, keys.encKey).getOrNull()!!
        assertEquals(listOf("device-a"), pushed.devices)
        assertEquals(6, pushed.rev)
    }

    @Test
    fun joinStateAtEpochZeroLosesToANeverEditedHousehold() {
        // A household created and never edited is still rev 1. The joining
        // device's empty state must not win the merge and replace it.
        val created = state(rev = 1).copy(devices = listOf("creator"))
        val joiner = Household.emptyState("joiner", 0.0)
        assertEquals(created, Household.merge(joiner, created))
    }

    /* ------------------------------ entitlement v2 ----------------------------- */

    @Test
    fun expiresHeaderFromThePullWhenNothingIsWritten() {
        val shared = state(rev = 4)
        val transport = ScriptedTransport(listOf(respond(200, "\"4\"", sealed(shared), " 1796342400000 ")))
        val outcome = client(transport).syncOnce(SyncInput(secret, shared, maxSeenRev = 4, deviceId = "device-a"))
        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(1_796_342_400_000.0, outcome.entExp)
        assertNull(outcome.refusal)
        assertEquals(false, outcome.created)
    }

    @Test
    fun expiresHeaderFromTheWriteAndACreationIsReported() {
        val transport = ScriptedTransport(listOf(respond(404), respond(201, "\"1\"", expires = "1799020800000")))
        val outcome = client(transport).syncOnce(SyncInput(secret, state(rev = 1), maxSeenRev = 0, deviceId = "device-a"))
        assertEquals(1_799_020_800_000.0, outcome.entExp)
        assertTrue(outcome.created)
        // No header anywhere (a version 1 server): no E.
        val v1 = ScriptedTransport(listOf(respond(404), respond(201, "\"1\"")))
        assertNull(client(v1).syncOnce(SyncInput(secret, state(rev = 1), maxSeenRev = 0, deviceId = "device-a")).entExp)
    }

    @Test
    fun forcedWriteSendsAnUnchangedStateWithTheToken() {
        val shared = state(rev = 4)
        val transport = ScriptedTransport(listOf(respond(200, "\"4\"", sealed(shared)), respond(200, "\"5\"", expires = "1799020800000")))
        val outcome = client(transport).syncOnce(
            SyncInput(secret, shared, maxSeenRev = 4, deviceId = "device-a", entitlement = "sitr-ent-v2.a.b", forceWrite = true)
        )
        assertEquals(SyncStatus.State.OK, outcome.status.state)
        assertEquals(listOf("GET", "PUT"), transport.recorded.map { it.method })
        val put = transport.recorded[1]
        assertEquals("\"4\"", put.headers["If-Match"])
        assertEquals("sitr-ent-v2.a.b", put.headers["X-Sitr-Entitlement"])
        // The same revision: a forced write bumps nothing.
        assertEquals(shared, Household.openState(put.body!!, keys.encKey).getOrNull())
        assertEquals(1_799_020_800_000.0, outcome.entExp)
        assertEquals(false, outcome.created)
    }

    @Test
    fun forcedWriteNeverWritesAJoinPlaceholder() {
        val transport = ScriptedTransport(listOf(respond(404)))
        val placeholder = Household.emptyState("device-a", 0.0)
        val outcome = client(transport).syncOnce(
            SyncInput(secret, placeholder, maxSeenRev = 0, deviceId = "device-a", entitlement = "sitr-ent-v2.a.b", forceWrite = true)
        )
        assertEquals(SyncStatus.State.NOT_FOUND, outcome.status.state)
        assertEquals(listOf("GET"), transport.recorded.map { it.method })
    }

    @Test
    fun syncRefusalsAreReadFromThe402Body() {
        fun refusedBy(body: String, expires: String? = null) = client(
            ScriptedTransport(listOf(respond(200, "\"3\"", sealed(state(rev = 3))), respond(402, body = body.toByteArray(), expires = expires)))
        ).syncOnce(SyncInput(secret, state(rev = 4), maxSeenRev = 3, deviceId = "device-a"))

        val lapsed = refusedBy("lapsed\n", "1796342400000")
        assertEquals(SyncStatus.State.ERROR, lapsed.status.state)
        assertEquals(SyncRefusal.LAPSED, lapsed.refusal)
        assertEquals(HouseholdEnd.WAITING_TEXT, lapsed.status.error)
        assertEquals(1_796_342_400_000.0, lapsed.entExp)
        assertEquals(state(rev = 4), lapsed.state, "local changes are kept")

        val used = refusedBy("token-used")
        assertEquals(SyncRefusal.TOKEN_USED, used.refusal)
        assertEquals(Entitlement.TEXTS["token-used"], used.status.error)
        assertEquals(SyncRefusal.PLAN_NOT_ACCEPTED, refusedBy("plan-not-accepted\nmore").refusal)
    }

    @Test
    fun versionOneServer402BodiesAreUnderstood() {
        fun create(body: String) = client(ScriptedTransport(listOf(respond(404), respond(402, body = body.toByteArray()))))
            .syncOnce(SyncInput(secret, state(rev = 1), maxSeenRev = 0, deviceId = "device-a", entitlement = "sitr-ent-v2.a.b"))
        assertEquals(SyncRefusal.TOKEN_REQUIRED, create("entitlement required\n").refusal)
        assertEquals(SyncRefusal.TOKEN_INVALID, create("malformed entitlement token\n").refusal)
        assertEquals(SyncRefusal.TOKEN_EXPIRED, create("entitlement expired — please renew\n").refusal)
        // Prose the client does not know: no reason, the plain status.
        val unknown = create("checkout not completed\n")
        assertNull(unknown.refusal)
        assertEquals("server responded 402", unknown.status.error)
    }
}
