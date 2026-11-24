package com.sitrshield.core.lock

/**
 * Apps whose windows the guard reads only while Reels blocking is on.
 * Never in GuardRules.packages: the child lock reads nothing from them.
 */
val REELS_APPS: Set<String> = setOf("com.facebook.katana")

/**
 * Reels blocking's whole decision for the Facebook app, pure so it is
 * testable off-device. The service looks up only the nodes whose text or
 * description contains [lookups], passes their class, description and
 * selected state here, and acts on the answer. Nothing is kept.
 *
 * Signatures (Facebook 588, English and Bengali, checked 2026-11-22):
 *  - the Reels tab: the selected tab button whose description has the
 *    word "Reels" ("Reels, tab 2 of 6"; Bengali keeps "Reels" in Latin
 *    letters). Back does not leave this tab, so the answer is the first
 *    tab (Home). The tab is in the tree on every tab; only selected counts;
 *  - a reel opened full screen: Facebook's ImmersiveActivity window with a
 *    node described "Reel" (Bengali "রিল"), alone, as the first sentence
 *    ("Reel. Swipe up to see more." on an ad reel) or with its author
 *    ("Reel by <name>" when opened from a link). Back returns to the
 *    feed. "Reel" alone never counts elsewhere: the main tabs keep a
 *    hidden reel player after the Reels tab was visited, and a story that
 *    shares a reel carries the same label.
 *
 * ponytail: English and Bengali labels of one Facebook version. Another
 * language that translates "Reel", or a Facebook update that renames
 * these, stops detection silently. Upgrade path: add the label here.
 */
object ReelsRules {
    enum class Action { NONE, FIRST_TAB, BACK }

    /** One node returned by the lookup. */
    data class Node(val className: String?, val description: String?, val selected: Boolean)

    const val TAB_CLASS = "android.app.ActionBar\$Tab"
    private const val PLAYER_WINDOW = "immersiveactivity.ImmersiveActivity"
    private val TAB_WORD = Regex("\\bReels\\b")
    private val PLAYER_LABELS = setOf("Reel", "রিল")

    /**
     * "Reel" alone, as a first sentence, or with its author: a reel opened
     * from a link is "Reel by <name>" (Bengali "<name>-এর রিল"). "Reels",
     * "View reel by" and "View <name>'s reels" don't count.
     */
    private fun isPlayerLabel(description: String?): Boolean {
        val d = description?.trim() ?: return false
        return PLAYER_LABELS.any { d == it || d.startsWith("$it.") || d.startsWith("$it।") } ||
            d.startsWith("Reel by ") || d.endsWith("-এর রিল")
    }

    private fun isPlayer(windowClass: String?) = windowClass?.endsWith(PLAYER_WINDOW) == true

    /**
     * Texts to look up (case-insensitive substring of text or description).
     * "Reel" also finds the "Reels" tab; the Bengali label only matters in
     * the player window, so the main tabs cost one lookup.
     */
    fun lookups(windowClass: String?): List<String> =
        if (isPlayer(windowClass)) listOf("Reel", "রিল") else listOf("Reel")

    fun decide(windowClass: String?, nodes: List<Node>): Action = when {
        nodes.any { it.selected && it.className == TAB_CLASS && TAB_WORD.containsMatchIn(it.description ?: "") } ->
            Action.FIRST_TAB
        isPlayer(windowClass) && nodes.any { isPlayerLabel(it.description) } -> Action.BACK
        else -> Action.NONE
    }
}
