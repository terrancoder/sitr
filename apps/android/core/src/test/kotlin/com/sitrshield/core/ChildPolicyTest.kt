package com.sitrshield.core

import com.sitrshield.core.household.ChildPolicy
import com.sitrshield.core.household.ChildSync
import com.sitrshield.core.household.Household
import com.sitrshield.core.household.HouseholdState
import com.sitrshield.core.household.LockRequest
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** policy.child — the vectors in docs/sync-protocol.md §Test vectors. */
class ChildPolicyTest {
    private fun state(child: ChildPolicy?, rev: Int = 5) =
        HouseholdState(rev = rev, updatedAt = 1000.0, updatedBy = "g", devices = listOf("a", "b"), child = child)

    @Test
    fun sanitizeVectorFromTheSpec() {
        val policy = JSONObject(
            """{ "childLockOptions": true, "child": { "at": 1764320000000, "strictSearch": true,
              "mediaOff": ["x", "Imgur", "x", "reddit", "bad key!", 7, "newsite"],
              "optionalLists": "violence", "reelsOff": "yes",
              "lock": { "on": true, "at": 1764320100000 },
              "lockAcks": { "dev-a": 1764320100000, "dev-b": 1764310000000, "": 5, "dev-c": "x" } } }"""
        )
        val p = ChildPolicy.sanitize(policy.get("child"))!!
        val expected = JSONObject(
            """{ "at": 1764320000000, "strictSearch": true, "mediaOff": ["newsite", "reddit", "x"],
              "optionalLists": [], "reelsOff": false, "lock": { "on": true, "at": 1764320100000 },
              "lockAcks": { "dev-a": 1764320100000, "dev-b": 1764310000000 } }"""
        )
        assertTrue(ChildPolicy.toJSONObject(p).similar(expected), ChildPolicy.toJSONObject(p).toString())
        assertEquals(1, ChildPolicy.confirmed(p))
        assertEquals(LockRequest(true, 1764320100000), ChildPolicy.newLockRequest(p, 1764310000000))
        assertNull(ChildPolicy.newLockRequest(p, 1764320100000))
    }

    @Test
    fun badShapesFallBack() {
        for (raw in listOf("5", "null", "[]")) {
            assertNull(ChildPolicy.sanitize(JSONObject("""{"c": $raw}""").opt("c")))
        }
        for (lock in listOf("""{"on": "true", "at": 1}""", """{"on": true}""", """{"on": true, "at": 1.5}""")) {
            assertNull(ChildPolicy.sanitize(JSONObject("""{"lock": $lock}"""))!!.lock)
        }
        for (at in listOf("-1", "1e300", "\"1\"")) {
            assertEquals(0, ChildPolicy.sanitize(JSONObject("""{"at": $at}"""))!!.at)
        }
        val many = (1..25).joinToString(",") { "\"d%02d\": 7".format(it) }
        assertEquals(20, ChildPolicy.sanitize(JSONObject("{\"lockAcks\": {$many}}"))!!.lockAcks.size)
    }

    @Test
    fun householdEmitsChildOnlyWhenSetAndRoundTrips() {
        assertFalse(Household.toJSONObject(state(null)).getJSONObject("policy").has("child"))
        val s = state(ChildPolicy(at = 9, mediaOff = listOf("x"), lock = LockRequest(false, 3)))
        assertEquals(s, Household.sanitize(Household.toJSONObject(s)).getOrNull())
    }

    @Test
    fun guardianEditsMoveAtForward() {
        val base = ChildPolicy(at = 500, lock = LockRequest(true, 400), lockAcks = mapOf("a" to 400L))
        val e = ChildPolicy.edited(base, now = 100) { it.copy(strictSearch = true, mediaOff = listOf("x", "imgur", "x")) }
        assertEquals(listOf("imgur", "x"), e.mediaOff)
        assertEquals(501, e.at)
        assertEquals(base.lockAcks, e.lockAcks)
        val l = ChildPolicy.lockRequested(base, on = false, now = 100)
        assertEquals(LockRequest(false, 401), l.lock)
        assertEquals(emptyMap(), l.lockAcks)
    }

    @Test
    fun adoptAndWriteBackGoByAt() {
        val stored = ChildPolicy(at = 200)
        assertEquals(stored, ChildPolicy.adopt(stored, ChildPolicy(at = 100)))
        assertEquals(ChildPolicy(at = 200, strictSearch = true), ChildPolicy.adopt(stored, ChildPolicy(at = 200, strictSearch = true)))
        assertEquals(stored, ChildPolicy.writeBack(ChildPolicy(at = 100), stored))
        assertNull(ChildPolicy.writeBack(ChildPolicy(at = 200), stored))
        assertNull(ChildPolicy.writeBack(ChildPolicy(at = 300), stored))
        // Absent child: the copy's acks for its own request only.
        val copy = ChildPolicy(at = 600, lock = LockRequest(true, 500), lockAcks = mapOf("a" to 500L, "b" to 400L))
        assertEquals(mapOf("a" to 500L), ChildPolicy.writeBack(null, copy)!!.lockAcks)
    }

    @Test
    fun ackHealsButNeverPastTheCap() {
        val c = ChildPolicy(lock = LockRequest(true, 50))
        assertEquals(mapOf("me" to 50L), ChildPolicy.withAck(c, "me", 50)!!.lockAcks)
        assertNull(ChildPolicy.withAck(c.copy(lockAcks = mapOf("me" to 50L)), "me", 50))
        assertNull(ChildPolicy.withAck(c, "me", 49))
        val full = c.copy(lockAcks = (1..20).associate { "a%02d".format(it) to 50L })
        assertNull(ChildPolicy.withAck(full, "zz", 50))
    }

    @Test
    fun childStepCopiesOnceAndLocksWhenReady() {
        val p = ChildPolicy(at = 10, strictSearch = true, lock = LockRequest(true, 20))
        val notReady = ChildSync.step(true, state(p), null, 0, ready = false, deviceId = "b", now = 2000.0)
        assertEquals(p, notReady.copyFilters)
        assertNull(notReady.setLock)
        assertEquals(5, notReady.household.rev)

        val ready = ChildSync.step(true, state(p), p, 0, ready = true, deviceId = "b", now = 3000.0)
        assertNull(ready.copyFilters) // same `at`: filters are not copied again
        assertEquals(true, ready.setLock)
        assertEquals(20, ready.lockAppliedAt)
        assertEquals(6, ready.household.rev)
        assertEquals(mapOf("b" to 20L), ready.household.child!!.lockAcks)

        // A lock-only policy never touches the phone's filters.
        val lockOnly = ChildPolicy(at = 40, lock = LockRequest(true, 40))
        assertNull(ChildSync.step(true, state(lockOnly), null, 0, true, "b", 4000.0).copyFilters)
        assertNull(ChildSync.step(true, state(p.copy(at = 50)), p, 20, true, "b", 4000.0).copyFilters)

        // An unlock never waits for readiness; an applied request is not redone.
        val unlock = ChildSync.step(true, state(p.copy(lock = LockRequest(false, 30))), p, 20, false, "b", 4000.0)
        assertEquals(false, unlock.setLock)
        val again = ChildSync.step(true, state(p), p.copy(lockAcks = mapOf("b" to 20L)), 20, true, "b", 4000.0)
        assertNull(again.setLock)
    }

    @Test
    fun guardianStepRestoresADroppedCopy() {
        val copy = ChildPolicy(at = 10, reelsOff = true)
        val step = ChildSync.step(false, state(null), copy, 0, false, "g", 2000.0)
        assertEquals(copy, step.household.child)
        assertEquals(6, step.household.rev)
        val placeholder = Household.emptyState("g", 0.0)
        assertSame(placeholder, ChildSync.step(false, placeholder, copy, 0, false, "g", 1.0).household)
    }
}
