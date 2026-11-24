package com.sitrshield.core

import com.sitrshield.core.lock.GuardRules
import com.sitrshield.core.lock.REELS_APPS
import com.sitrshield.core.lock.ReelsRules
import com.sitrshield.core.lock.ReelsRules.Action
import com.sitrshield.core.lock.ReelsRules.Node
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Labels recorded from Facebook 588 on a Redmi, Android 16 (2026-11-22). */
class GuardRulesReelsTest {
    private val main = "com.facebook.katana.activity.FbMainTabActivity"
    private val player = "com.facebook.katana.immersiveactivity.ImmersiveActivity"
    private val story = "com.facebook.stories.viewer.activity.StoryViewerActivity"

    private fun tab(desc: String, selected: Boolean) = Node(ReelsRules.TAB_CLASS, desc, selected)
    private fun button(desc: String) = Node("android.widget.Button", desc, false)

    @Test
    fun selectedReelsTabGoesToFirstTab() {
        for (desc in listOf(
            "Reels, tab 2 of 6",
            "Reels, tab 2 of 6, 1 new",
            "Reels, ৬টির ট্যাব ২",
            "১টি নতুন, Reels, ৬টির ট্যাব ২",
        )) {
            assertEquals(Action.FIRST_TAB, ReelsRules.decide(main, listOf(tab(desc, true))), desc)
            assertEquals(Action.FIRST_TAB, ReelsRules.decide(null, listOf(tab(desc, true))), desc)
            assertEquals(Action.NONE, ReelsRules.decide(main, listOf(tab(desc, false))), desc)
        }
    }

    @Test
    fun reelPlayerGoesBack() {
        assertEquals(Action.BACK, ReelsRules.decide(player, listOf(button("Reel"))))
        assertEquals(Action.BACK, ReelsRules.decide(player, listOf(button("রিল"))))
        // An ad reel, seen on the phone in English.
        assertEquals(Action.BACK, ReelsRules.decide(player, listOf(Node("android.view.ViewGroup", "Reel. Swipe up to see more.", false))))
        // A reel opened from a link, seen on the phone in English and Bengali.
        assertEquals(Action.BACK, ReelsRules.decide(player, listOf(button("Reel by Some Page"))))
        assertEquals(Action.BACK, ReelsRules.decide(player, listOf(button("Some Page-এর রিল"))))
        assertEquals(listOf("Reel", "রিল"), ReelsRules.lookups(player))
        assertEquals(listOf("Reel"), ReelsRules.lookups(main))
    }

    @Test
    fun trapsAreLeftAlone() {
        val feed = listOf(
            Node("android.view.View", "Reels", false), // feed shelf header
            Node("android.view.ViewGroup", "Reels", false),
            button("View reel by Someone"),
            button("Create a post, story, or reel"),
            button("Someone-এর রিল দেখুন"), // bn "View reel by"
            button("রিলটি লুকান"), // bn "Hide reel"
            tab("Reels, tab 2 of 6", false),
            tab("Home, tab 1 of 6", true),
        )
        assertEquals(Action.NONE, ReelsRules.decide(main, feed))
        // A reel player retained in the main tabs after the Reels tab was visited.
        assertEquals(Action.NONE, ReelsRules.decide(main, feed + button("Reel") + button("রিল")))
        // A story that shares a reel.
        assertEquals(Action.NONE, ReelsRules.decide(story, listOf(button("Reel"))))
        // In the player only the reel's own label counts, not links to reels.
        assertEquals(Action.NONE, ReelsRules.decide(player, listOf(button("View reel by Someone"))))
        assertEquals(Action.NONE, ReelsRules.decide(player, listOf(button("Reels"), button("View Someone's reels"))))
        assertEquals(Action.NONE, ReelsRules.decide(player, listOf(button("Someone-এর রিল দেখুন"))))
        // Outside the player the author form doesn't count either.
        assertEquals(Action.NONE, ReelsRules.decide(main, listOf(button("Reel by Someone"))))
        assertEquals(Action.NONE, ReelsRules.decide(story, listOf(button("Reel by Someone"))))
        assertEquals(Action.NONE, ReelsRules.decide(story, listOf(button("Reel. Swipe up to see more."))))
    }

    @Test
    fun childLockDoesNotReadFacebook() {
        assertFalse(GuardRules.watches("com.facebook.katana"))
        assertTrue(REELS_APPS.intersect(GuardRules.packages).isEmpty())
    }
}
