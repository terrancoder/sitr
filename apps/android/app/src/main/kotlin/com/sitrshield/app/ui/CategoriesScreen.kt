package com.sitrshield.app.ui

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.sitrshield.app.R
import com.sitrshield.app.SitrApp
import com.sitrshield.app.UiCtx
import com.sitrshield.app.lock.ChildLock
import com.sitrshield.core.categories.OptionalLists
import com.sitrshield.core.gate.MutationKind

/**
 * Filter switches. Adult, gambling, dating and SafeSearch are always on
 * on Android, rendered as fact, not as toggles. Turning a switch off is
 * a loosening action (PIN-gated); turning one on never is.
 */
@Composable
fun CategoriesScreen(ctx: UiCtx) {
    val context = LocalContext.current
    // Each section opens and closes; closed, its header says in one line
    // what is on. A switch can only be reached with its section open, so
    // its explanation is always in view when the switch is used.
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var socialOpen by rememberSaveable { mutableStateOf(false) }
    var optionalOpen by rememberSaveable { mutableStateOf(false) }

    ScreenTitle("Filter categories")
    Spacer(Modifier.height(14.dp))
    // Fact, not a toggle: drawn as a locked, green-edged card.
    SitrCard(borderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconBadge(R.drawable.ic_nav_lock, MaterialTheme.colorScheme.primary)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                CardTitle("Always on")
                Text(
                    "Adult, gambling and dating blocking and SafeSearch are always on. " +
                        "No allow entry opens them.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
    Spacer(Modifier.height(18.dp))

    val strictAvailable = ctx.app.strictSearchHosts.hosts.isNotEmpty()
    SectionToggle(
        R.drawable.ic_search,
        "Search results",
        when {
            !strictAvailable -> "Strict Search is unavailable."
            ctx.settings.strictSearch -> "Strict Search is on."
            else -> "Strict Search is off."
        },
        expanded = searchOpen,
        onToggle = { searchOpen = !searchOpen },
        warning = !strictAvailable,
    )
    if (searchOpen) {
        Spacer(Modifier.height(10.dp))
        SitrCard(contentPadding = SwitchCardPadding) {
            SwitchRow(
                "Strict Search",
                checked = ctx.settings.strictSearch && strictAvailable,
                enabled = strictAvailable,
                strong = true,
                onCheckedChange = { on ->
                    val set = {
                        ctx.app.update { it.copy(strictSearch = on) }
                    }
                    // Turning it ON tightens; turning it OFF loosens.
                    if (on) ctx.attempt(MutationKind.ENABLE_CATEGORY, "") { set() }
                    else ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn off Strict Search") { set() }
                },
            )
            if (!strictAvailable) ListUnavailable()

            // The disclosure is part of the feature, not decoration: the setting
            // must not be read as "hides everything about betting and adult
            // content from search".
            Text(
                "Some search engines offer no SafeSearch setting" +
                    (ctx.app.strictSearchHosts.enginesWithoutSafeMode
                        .takeIf { it.isNotEmpty() }
                        ?.let { " (" + it.joinToString(", ") + ")" } ?: "") +
                    ". This blocks the servers they load result images from, so " +
                    "explicit pictures do not appear. Image results on those " +
                    "engines will look broken — that is this setting working." +
                    // Mojeek serves its pages and its images from one host, so the
                    // honest wording is "all of Mojeek", not "its images".
                    (if ("www.mojeek.com" in ctx.app.strictSearchHosts.hosts)
                        " Mojeek loads its pages and images from the same server, so " +
                            "this blocks Mojeek completely." else ""),
                style = MaterialTheme.typography.bodySmall,
            )
            RowDivider()
            Note(
                "Google, Bing and DuckDuckGo are left alone: SafeSearch is already " +
                    "forced on them, so breaking their image search would filter " +
                    "nothing extra.\n\nText results are untouched everywhere. A " +
                    "search for a gambling or adult site still lists it — Sitr " +
                    "blocks the site itself, so the link will not open. Removing " +
                    "result text would mean reading the pages you visit, which " +
                    "Sitr is built never to do.",
            )
        }
    }

    Spacer(Modifier.height(12.dp))
    val mediaOn = SitrApp.MEDIA_SITES.count { (key, _) ->
        key in ctx.settings.mediaOff && key in ctx.app.mediaHosts
    }
    val mediaBroken = SitrApp.MEDIA_SITES.any { (key, _) -> key !in ctx.app.mediaHosts }
    // Reels blocking that is switched on but not running is said on the
    // closed header too, in red (the same check as inside ReelsSwitch).
    val guard = remember(ctx.resumes) { ChildLock.isGuardServiceOn(context) }
    val reelsBroken = ctx.settings.reelsOff && !guard
    val reelsState = when {
        reelsBroken -> "Reels blocking is NOT on."
        ctx.settings.reelsOff -> "Reels blocking is on."
        else -> "Reels blocking is off."
    }
    SectionToggle(
        R.drawable.ic_eye_off,
        "Social media",
        "Images and video off on $mediaOn of ${SitrApp.MEDIA_SITES.size} sites. $reelsState" +
            (if (mediaBroken) " A list is unavailable." else ""),
        expanded = socialOpen,
        onToggle = { socialOpen = !socialOpen },
        warning = reelsBroken || mediaBroken,
    )
    if (socialOpen) {
        Spacer(Modifier.height(10.dp))
        SitrCard(contentPadding = SwitchCardPadding, verticalArrangement = Arrangement.Top) {
            for ((key, label) in SitrApp.MEDIA_SITES) {
                val available = key in ctx.app.mediaHosts
                SwitchRow(
                    "Images and video off on $label",
                    checked = key in ctx.settings.mediaOff && available,
                    enabled = available,
                    onCheckedChange = { on ->
                        val set = {
                            ctx.app.update {
                                it.copy(mediaOff = if (on) it.mediaOff + key else it.mediaOff - key)
                            }
                        }
                        if (on) ctx.attempt(MutationKind.ENABLE_CATEGORY, "") { set() }
                        else ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn on images and video on $label") { set() }
                    },
                )
                if (!available) ListUnavailable()
                RowDivider()
            }
            // Same honesty rule as Strict Search: say it blocks everything, not
            // "explicit content", and point at the one filter that does know.
            Note(
                "Each switch blocks every picture and video on that site, in its app " +
                    "and its website — Sitr cannot tell which ones are explicit. Posts " +
                    "and text still load.\n\nTo hide only media X marks as sensitive, " +
                    "use X's own setting: Settings and privacy → Privacy and safety → " +
                    "Content you see.",
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        Spacer(Modifier.height(10.dp))
        SitrCard(contentPadding = SwitchCardPadding) {
            ReelsSwitch(ctx)
        }
        Spacer(Modifier.height(10.dp))
        // Instagram and TikTok ban nudity and are built around their media,
        // so they get no switch (threat-model T12) — say where to go.
        Row(
            Modifier.padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                painterResource(R.drawable.ic_info),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Note(
                "Instagram and TikTok aren't filtered inside their apps: Sitr only sees " +
                    "site names. Use Instagram Teen Accounts, TikTok Family Pairing, or " +
                    "app limits in Google Family Link. Their websites can be blocked in " +
                    "Allow & block lists.",
            )
        }
    }

    Spacer(Modifier.height(12.dp))
    val optionalOn = OptionalLists.ALL.count {
        it.id in ctx.settings.optionalLists && it.id in ctx.app.optionalSets
    }
    val optionalBroken = OptionalLists.ALL.any { it.id !in ctx.app.optionalSets }
    SectionToggle(
        R.drawable.ic_nav_lists,
        "Optional lists",
        "$optionalOn of ${OptionalLists.ALL.size} on." +
            (if (optionalBroken) " A list is unavailable." else ""),
        expanded = optionalOpen,
        onToggle = { optionalOpen = !optionalOpen },
        warning = optionalBroken,
    )
    if (optionalOpen) {
        // Device-local and off by default; gated like Strict Search.
        for (list in OptionalLists.ALL) {
            val available = list.id in ctx.app.optionalSets
            Spacer(Modifier.height(10.dp))
            SitrCard(contentPadding = SwitchCardPadding) {
                SwitchRow(
                    list.title,
                    checked = list.id in ctx.settings.optionalLists && available,
                    enabled = available,
                    strong = true,
                    onCheckedChange = { on ->
                        val set = {
                            ctx.app.update {
                                it.copy(
                                    optionalLists = if (on) it.optionalLists + list.id
                                    else it.optionalLists - list.id,
                                )
                            }
                        }
                        if (on) ctx.attempt(MutationKind.ENABLE_CATEGORY, "") { set() }
                        else ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn off ${list.title}") { set() }
                    },
                )
                if (!available) ListUnavailable()
                Note(list.description)
            }
        }
    }
}

/** A card whose first row is a switch: the row brings its own height. */
private val SwitchCardPadding = PaddingValues(start = 16.dp, top = 6.dp, end = 16.dp, bottom = 16.dp)

/**
 * Reels blocking in the Facebook app, through Sitr's accessibility
 * service. Turning it on shows the same disclosure as the child lock;
 * only "I agree" turns it on. Turning it off is a loosening action.
 */
@Composable
private fun ReelsSwitch(ctx: UiCtx) {
    val context = LocalContext.current
    val guard = remember(ctx.resumes) { ChildLock.isGuardServiceOn(context) }
    var disclosure by remember { mutableStateOf(false) }
    if (disclosure) {
        AlertDialog(
            onDismissRequest = { disclosure = false },
            title = { Text(GUARD_DISCLOSURE_TITLE) },
            // Scrolls: at large font sizes the whole disclosure must stay readable.
            text = { Text(GUARD_DISCLOSURE, Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = {
                TextButton(onClick = {
                    disclosure = false
                    // Through the gate like every other switch: a managed
                    // lockOptions device must not change it.
                    ctx.attempt(MutationKind.ENABLE_CATEGORY, "") {
                        ctx.app.update { it.copy(reelsOff = true) }
                        if (!ChildLock.isGuardServiceOn(context)) {
                            context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        }
                    }
                }) { Text("I agree") }
            },
            dismissButton = {
                TextButton(onClick = { disclosure = false }) { Text("No thanks") }
            },
        )
    }
    SwitchRow(
        "Block Reels in the Facebook app",
        checked = ctx.settings.reelsOff,
        strong = true,
        onCheckedChange = { on ->
            if (on) disclosure = true
            else ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn off Reels blocking") {
                ctx.app.update { it.copy(reelsOff = false) }
            }
        },
    )
    if (ctx.settings.reelsOff && !guard) {
        Text(
            "Reels blocking is NOT on: Sitr's accessibility service is switched off.",
            style = MaterialTheme.typography.bodySmall,
            color = ProtectionRed,
        )
    }
    Note(
        "Closes the Reels tab and reels opened full screen. Reel previews in the " +
            "feed stay visible. Facebook in a browser is not covered.",
    )
}

/** Under a switch whose list failed its checksum or is missing from the app. */
@Composable
private fun ListUnavailable() {
    Text(
        "Unavailable: this list failed its integrity check, so Sitr will " +
            "not use it. Reinstalling Sitr restores it.",
        style = MaterialTheme.typography.bodySmall,
        color = ProtectionRed,
    )
}
