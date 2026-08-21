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

    Spacer(Modifier.height(16.dp))
    TextButton(onClick = { ctx.navigate(Screen.HOME) }) { Text("Back") }
}
