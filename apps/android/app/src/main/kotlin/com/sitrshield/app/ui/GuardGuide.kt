package com.sitrshield.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sitrshield.app.R

/** What sits at the end of a drawn settings row. */
internal enum class MockEnd { GEAR, CHEVRON, MENU, SWITCH_ON, SWITCH_OFF, ALLOW }

private val MockShape = RoundedCornerShape(12.dp)
private val Pill = RoundedCornerShape(50)

/**
 * One sub-step of the child lock guide: the instruction as real text,
 * then a drawn settings row showing what to look for. Drawn, not
 * screenshots: every phone maker's Settings looks different and
 * screenshots go stale. The drawing is decoration only — TalkBack reads
 * the instruction, which says the same. Nothing here is clickable.
 */
@Composable
internal fun GuideStep(
    letter: Char,
    text: String,
    mockLabel: String? = null,
    end: MockEnd = MockEnd.CHEVRON,
    tap: Boolean = true,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("$letter.", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
        if (mockLabel != null) MockRow(mockLabel, end, tap)
    }
}

/**
 * A settings row as the phone shows it. The thing to tap carries a ring
 * and the word "Tap"; a switch to leave alone says "Leave off" — never
 * colour alone.
 */
@Composable
private fun MockRow(label: String, end: MockEnd, tap: Boolean) {
    val scheme = MaterialTheme.colorScheme
    Row(
        Modifier
            .padding(start = 20.dp)
            .fillMaxWidth()
            .clearAndSetSemantics {}
            .clip(MockShape)
            .background(scheme.surface)
            .border(1.dp, scheme.outlineVariant, MockShape)
            .heightIn(min = 44.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        when {
            tap -> Tag("Tap", content = scheme.onPrimary, container = scheme.primary)
            end == MockEnd.SWITCH_OFF -> Tag("Leave off", content = scheme.onSurfaceVariant, container = null)
        }
        Box(
            if (tap) Modifier.border(2.dp, scheme.primary, Pill).padding(4.dp) else Modifier,
            contentAlignment = Alignment.Center,
        ) {
            val tint = if (tap) scheme.primary else scheme.onSurfaceVariant
            when (end) {
                MockEnd.GEAR -> MockIcon(R.drawable.ic_settings, tint)
                MockEnd.CHEVRON -> MockIcon(R.drawable.ic_chevron_right, tint)
                MockEnd.MENU -> MockIcon(R.drawable.ic_more_vert, tint)
                MockEnd.SWITCH_ON -> Switch(checked = true, onCheckedChange = null)
                MockEnd.SWITCH_OFF -> Switch(checked = false, onCheckedChange = null)
                MockEnd.ALLOW -> Text(
                    "Allow",
                    style = MaterialTheme.typography.labelLarge,
                    color = scheme.primary,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun MockIcon(icon: Int, tint: Color) {
    Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
}

/** A small word in a pill: filled for "Tap", outlined otherwise. */
@Composable
private fun Tag(word: String, content: Color, container: Color?) {
    Text(
        word,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = content,
        modifier = Modifier
            .clip(Pill)
            .then(if (container != null) Modifier.background(container) else Modifier.border(1.dp, content, Pill))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
