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

/**
 * Guard mode's enforcer. Reads the text of the window in front when it
 * belongs to Settings, an installer or a system dialog — on this device
 * only, never stored or sent anywhere — and closes it when
 * GuardRules says it is a way to switch Sitr off. Does nothing at all
 * unless a guardian armed the child lock.
 */
class GuardService : AccessibilityService() {
    private var lastActionAt = 0L
    private val handler = Handler(Looper.getMainLooper())

    private val recheck = Runnable {
        rootInActiveWindow?.packageName?.toString()?.let { check(it, null) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        check(pkg, event.text)
    }

    /** Close the window in front if it is a way to switch Sitr off. */
    private fun check(pkg: String, eventText: List<CharSequence>?): Boolean {
        val app = application as SitrApp
        if (!app.repository.current().childLock) return false
        if (pkg == packageName || !GuardRules.watches(pkg)) return false
        // One close per half second: closing a window fires more events.
        if (SystemClock.uptimeMillis() - lastActionAt < 500) return false

        val label = applicationInfo.loadLabel(packageManager).toString()
        val root = rootInActiveWindow
        val texts = if (root?.packageName?.toString() == pkg) collectTexts(root) else emptyList()
        val allTexts = texts + listOfNotNull(eventText?.joinToString(" "))
        if (!GuardRules.shouldClose(pkg, allTexts, label)) return false

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
    }
}
