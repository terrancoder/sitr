package com.sitrshield.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sitrshield.app.Screen
import com.sitrshield.app.UiCtx
import com.sitrshield.core.categories.Categories
import com.sitrshield.core.gate.MutationKind

/**
 * Category toggles. Adult + SafeSearch are always on — the product's
 * single purpose, rendered as fact, not as toggles. Disabling an
 * optional category is a loosening action (PIN-gated); enabling never
 * is. With a household, the household's list is the effective one.
 */
@Composable
fun CategoriesScreen(ctx: UiCtx) {
    val managed = ctx.app.managedPolicy()
    val inHousehold = ctx.settings.household != null
    val disabled = ctx.settings.household?.disabledCategories
        ?: ctx.settings.disabledCategories

    Text("Filter categories", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(8.dp))
    Text(
        "Adult content blocking and SafeSearch are always on — they are " +
            "what Sitr is for.",
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(12.dp))

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (category in Categories.TOGGLEABLE_CATEGORIES) {
            val forced = category.rulesetId in managed.forcedCategories
            val isOn = forced || category.rulesetId !in disabled
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(category.label, style = MaterialTheme.typography.bodyLarge)
                    if (forced) {
                        Text(
                            "required by your organization",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
                Switch(
                    checked = isOn,
                    enabled = !forced,
                    onCheckedChange = { checked ->
                        val set: (Boolean) -> Unit = { off ->
                            if (inHousehold) {
                                ctx.actions.setHouseholdCategoryDisabled(
                                    category.rulesetId, off,
                                )
                            } else {
                                ctx.actions.setDeviceCategoryDisabled(
                                    category.rulesetId, off,
                                )
                            }
                        }
                        if (checked) {
                            // Tightening — never gated.
                            ctx.attempt(MutationKind.ENABLE_CATEGORY, "") { set(false) }
                        } else {
                            ctx.attempt(
                                MutationKind.DISABLE_CATEGORY,
                                "Turn off ${category.label} blocking",
                            ) { set(true) }
                        }
                    },
                )
            }
        }
    }

    Spacer(Modifier.height(20.dp))
    Text("Search results", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))

    val strictAvailable = ctx.app.strictSearchHosts.hosts.isNotEmpty()
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "Strict Search",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        Switch(
            checked = ctx.settings.strictSearch && strictAvailable,
            enabled = strictAvailable,
            onCheckedChange = { on ->
                val set = {
                    ctx.app.applySettings(
                        ctx.app.repository.current().copy(strictSearch = on)
                    )
                }
                // Turning it ON tightens; turning it OFF loosens.
                if (on) ctx.attempt(MutationKind.ENABLE_CATEGORY, "") { set() }
                else ctx.attempt(MutationKind.DISABLE_CATEGORY, "Turn off Strict Search") { set() }
            },
        )
    }

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
            "engines will look broken — that is this setting working.",
        style = MaterialTheme.typography.bodySmall,
    )
    Spacer(Modifier.height(6.dp))
    Text(
        "Google, Bing and DuckDuckGo are left alone: SafeSearch is already " +
            "forced on them, so breaking their image search would filter " +
            "nothing extra.\n\nText results are untouched everywhere. A " +
            "search for a gambling or adult site still lists it — Sitr " +
            "blocks the site itself, so the link will not open. Removing " +
            "result text would mean reading the pages you visit, which " +
            "Sitr is built never to do.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.secondary,
    )

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}
