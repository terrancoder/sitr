package com.sitrshield.app.lock

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import com.sitrshield.app.SitrApp
import com.sitrshield.core.lock.GuardRules
import com.sitrshield.core.lock.REELS_APPS
import com.sitrshield.core.lock.ReelsRules
import com.sitrshield.core.lock.WindowClasses
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Sitr's accessibility service, with two separate uses. Screen text is
 * read on this device only, never stored, logged or sent anywhere.
 *  - Child lock: reads the window in front when it belongs to Settings,
 *    an installer, a system dialog or MIUI's Second space and Dual apps
 *    pages (class only, no text), and closes it when GuardRules says
 *    it is a way to switch Sitr off. Does nothing unless a guardian armed
 *    the lock.
 *  - Reels blocking: while the user has it on, looks up the "Reel" labels
 *    in the Facebook app and leaves Reels (ReelsRules). While it is off,
 *    Android sends this service nothing from Facebook.
 */
class GuardService : AccessibilityService() {
    private var lastActionAt = 0L
    /** No close before this (uptime ms): see LOCK_ARM_SETTLE_MS. */
    private var settleUntil = 0L
    private var lastReelsLookupAt = 0L
    private val reelsRecheck = Runnable { checkReels() }
    private val scope = CoroutineScope(Dispatchers.Main.immediate)

    private val windowClasses = WindowClasses()
    private val handler = Handler(Looper.getMainLooper())

    private val recheck = Runnable {
        rootInActiveWindow?.let { root -> root.packageName?.toString()?.let { check(it, null, root.windowId) } }
    }

    /**
     * From here on Android delivers only the watched apps' window events,
     * plus Facebook's while Reels blocking is on. Immediate dispatch sets
     * the list before this returns; the base set is never empty (empty
     * would mean every app).
     */
    override fun onServiceConnected() {
        scope.launch {
            (application as SitrApp).repository.settings.map { it.reelsOff }.distinctUntilChanged().collect { reels ->
                serviceInfo?.let {
                    it.packageNames = (GuardRules.packages + if (reels) REELS_APPS else emptySet()).toTypedArray()
                    serviceInfo = it
                }
            }
        }
        // Look at the window already in front when the lock turns on (a
        // guardian's request arrives by sync, without lock()'s Settings
        // restart) and when the service connects (a Settings page opened
        // before a restart stayed open). The first value covers the latter.
        // ponytail: such a window has no class yet (WindowClasses), so a
        // class-only page (private space setup, MIUI Second space) closes
        // only when it is opened again.
        scope.launch {
            (application as SitrApp).repository.settings.map { it.childLock }.distinctUntilChanged().collect { on ->
                if (on) {
                    settleUntil = SystemClock.uptimeMillis() + LOCK_ARM_SETTLE_MS
                    handler.postDelayed(recheck, LOCK_ARM_SETTLE_MS + 100)
                }
            }
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(reelsRecheck)
        scope.cancel()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        // Only a window-state event names the window's activity; content
        // events name a view. Private space setup is known by it alone.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            windowClasses.opened(event.windowId, event.className?.toString())
        }
        if (pkg in REELS_APPS) checkReels() else check(pkg, event.text, event.windowId)
    }

    /**
     * Leave Facebook's Reels tab or reel player. Gated on Reels blocking,
     * not on the child lock. One targeted lookup instead of a tree walk
     * (a walk of Facebook took ~240 ms), at most every 250 ms.
     */
    private fun checkReels() {
        if (!(application as SitrApp).repository.current().reelsOff) return
        val now = SystemClock.uptimeMillis()
        handler.removeCallbacks(reelsRecheck)
        if (now - lastActionAt < 500 || now - lastReelsLookupAt < 250) {
            // Look once more after the quiet period: the skipped event may
            // have been the last one before the screen settled on a reel.
            handler.postDelayed(reelsRecheck, 500)
            return
        }
        lastReelsLookupAt = now
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() !in REELS_APPS) return
        val windowClass = windowClasses.of(root.windowId)
        val found = ReelsRules.lookups(windowClass).flatMap { root.findAccessibilityNodeInfosByText(it) }
        val nodes = found.map {
            ReelsRules.Node(it.className?.toString(), it.contentDescription?.toString(), it.isSelected)
        }
        when (ReelsRules.decide(windowClass, nodes)) {
            ReelsRules.Action.NONE -> return
            ReelsRules.Action.BACK -> performGlobalAction(GLOBAL_ACTION_BACK)
            ReelsRules.Action.FIRST_TAB -> {
                // The first tab is Home. Facebook's tab bar shares its parent
                // with the pager, so take the first sibling that is a tab.
                val tab = found.first { it.isSelected && it.className?.toString() == ReelsRules.TAB_CLASS }
                val first = tab.parent?.let { p ->
                    (0 until p.childCount).firstNotNullOfOrNull { i ->
                        p.getChild(i)?.takeIf { it.className?.toString() == ReelsRules.TAB_CLASS }
                    }
                }
                if (first?.performAction(AccessibilityNodeInfo.ACTION_CLICK) != true) return
            }
        }
        // From after the action: a lookup in the reel player can take
        // hundreds of ms, and a second Back would leave the feed too.
        lastActionAt = SystemClock.uptimeMillis()
        Toast.makeText(this, "Reels are off in Sitr", Toast.LENGTH_SHORT).show()
    }

    /** Close the window in front if it is a way to switch Sitr off. */
    private fun check(pkg: String, eventText: List<CharSequence>?, windowId: Int): Boolean {
        val app = application as SitrApp
        if (!app.repository.current().childLock) return false
        if (pkg == packageName || !GuardRules.watches(pkg)) return false
        // One close per half second: closing a window fires more events.
        val now = SystemClock.uptimeMillis()
        if (now - lastActionAt < 500 || now < settleUntil) return false

        val label = applicationInfo.loadLabel(packageManager).toString()
        // A class-only package (MIUI's security core) is decided without its text.
        val root = rootInActiveWindow.takeIf { GuardRules.readsTexts(pkg) }
        val texts = if (root?.packageName?.toString() == pkg) collectTexts(root) else emptyList()
        val allTexts = texts + listOfNotNull(eventText?.takeIf { GuardRules.readsTexts(pkg) }?.joinToString(" "))
        if (!GuardRules.shouldClose(pkg, allTexts, label, windowClasses.of(windowId))) return false

        lastActionAt = SystemClock.uptimeMillis()
        // Back cancels a dialog; Home then clears whatever is left — Back
        // alone can land before a dialog is ready and be swallowed.
        performGlobalAction(GLOBAL_ACTION_BACK)
        performGlobalAction(GLOBAL_ACTION_HOME)
        // Just after a reboot Android dropped both while the window was
        // still opening, and App info stayed up — so make sure it went.
        handler.removeCallbacks(recheck)
        for (delay in AFTER_CLOSE_MS) handler.postDelayed(recheck, delay)
        Toast.makeText(this, "Locked by Sitr — ask your guardian.", Toast.LENGTH_SHORT).show()
        return true
    }

    /** Breadth-first, capped: a long settings list must not stall the UI. */
    private fun collectTexts(root: AccessibilityNodeInfo): List<String> {
        val out = ArrayList<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        var visited = 0
        while (queue.isNotEmpty() && visited < 400) {
            val node = queue.removeFirst()
            visited++
            node.text?.let { out.add(it.toString()) }
            node.contentDescription?.let { out.add(it.toString()) }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return out
    }

    override fun onInterrupt() {}

    private companion object {
        val AFTER_CLOSE_MS = longArrayOf(800, 2000)
        /** Arming as Sitr comes to the front: the outgoing Settings page is
         *  still in front for ~250 ms (POCO, QA 2026-11-28), so wait it out. */
        const val LOCK_ARM_SETTLE_MS = 1000L
    }
}
