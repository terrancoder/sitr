package com.sitrshield.app.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sitrshield.app.R
import com.sitrshield.app.Screen

/*
 * The shared pieces of the app's look: screen titles, section labels,
 * cards, the status hero, switch rows and the bottom tab bar. Layout and
 * colour only: no component here reads settings or changes anything.
 */

private val CardShape = RoundedCornerShape(20.dp)
private val HeroShape = RoundedCornerShape(28.dp)

/** The screen's own heading, in the display serif. */
@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.headlineLarge,
        modifier = modifier.semantics { heading() },
    )
}

/**
 * Small mono label over a group of cards. Drawn in capitals; screen
 * readers get the text as written, so it is not spelled out letter by letter.
 */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(
        text.uppercase(),
        modifier = modifier
            .padding(start = 4.dp, bottom = 10.dp)
            .semantics {
                contentDescription = text
                heading()
            },
        style = MaterialTheme.typography.labelSmall,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.9.sp,
        color = color,
    )
}

/** A raised paper card with a hairline: the container for every group. */
@Composable
fun SitrCard(
    modifier: Modifier = Modifier,
    borderColor: Color = MaterialTheme.colorScheme.outlineVariant,
    contentPadding: PaddingValues = PaddingValues(16.dp),
    verticalArrangement: Arrangement.Vertical = Arrangement.spacedBy(10.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp, borderColor, CardShape)
            .padding(contentPadding),
        verticalArrangement = verticalArrangement,
        content = content,
    )
}

/** A card's own title. */
@Composable
fun CardTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        modifier = modifier.semantics { heading() },
    )
}

/** Explanatory text under a control: secondary ink, never the gold (too faint to read). */
@Composable
fun Note(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = color, modifier = modifier)
}

/** The hairline between rows inside a card. */
@Composable
fun RowDivider() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
}

/**
 * A label with a switch. The whole row is the switch (one large target,
 * read as one control); the Switch itself takes no clicks.
 */
@Composable
fun SwitchRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    strong: Boolean = false,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = if (strong) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

/**
 * A status word with its mark: a tick for on, a dash otherwise, so the two
 * differ by shape as well as colour. The word never wraps.
 */
@Composable
fun StatusWord(text: String, ok: Boolean, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(if (ok) R.drawable.ic_check else R.drawable.ic_minus),
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            color = color,
        )
    }
}

/**
 * The status hero: a block of one colour with fine rings in the corner
 * (an echo of the emblem's lines). Everything inside takes [content] as
 * its colour.
 */
@Composable
fun HeroCard(
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    rings: Boolean = true,
    goldRing: Boolean = false,
    body: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(HeroShape)
            .background(container)
            .drawBehind {
                if (rings) {
                    val centre = Offset(size.width - 48.dp.toPx(), 32.dp.toPx())
                    val line = Stroke(width = 1.dp.toPx())
                    for (i in 0..5) {
                        drawCircle(
                            color = if (goldRing && i == 2) Hero.Gold.copy(alpha = 0.5f)
                            else content.copy(alpha = 0.16f - 0.016f * i),
                            radius = (58 + 14 * i).dp.toPx(),
                            center = centre,
                            style = line,
                        )
                    }
                }
            }
            .padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        CompositionLocalProvider(LocalContentColor provides content) { body() }
    }
}

/** The round badge at the top of a hero or card: an icon on a tint of its own colour. */
@Composable
fun IconBadge(
    @DrawableRes icon: Int,
    tint: Color,
    modifier: Modifier = Modifier,
    large: Boolean = false,
) {
    Box(
        modifier
            .size(if (large) 52.dp else 36.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.14f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(if (large) 26.dp else 20.dp),
        )
    }
}

/** Title and one line of explanation inside a hero. */
@Composable
fun HeroText(title: String, body: String, bodyColor: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.semantics { heading() },
        )
        Text(body, style = MaterialTheme.typography.bodyLarge, color = bodyColor)
    }
}

/** The filled button on a hero: the hero's content colour as its ground. */
@Composable
fun HeroButton(
    text: String,
    onClick: () -> Unit,
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
) {
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, maxLines = 1)
    }
}

/** The quiet second button on a hero. */
@Composable
fun HeroOutlinedButton(
    text: String,
    onClick: () -> Unit,
    content: Color,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = content),
        border = BorderStroke(1.dp, content.copy(alpha = 0.5f)),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, maxLines = 1)
    }
}

/** The main action of a screen or card: full width, a comfortable height. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
    ) { Text(text) }
}

/** A secondary action at full width. */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp),
        border = BorderStroke(
            1.dp,
            if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
        ),
    ) { Text(text) }
}

/** A tappable card that leads to another screen: badge, two lines, chevron. */
@Composable
fun NavCard(
    @DrawableRes icon: Int,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    warning: Boolean = false,
) {
    val accent = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Row(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(
                1.dp,
                if (warning) accent.copy(alpha = 0.45f) else MaterialTheme.colorScheme.outlineVariant,
                CardShape,
            )
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 60.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(icon, accent)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            painterResource(R.drawable.ic_chevron_right),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
    }
}

/**
 * The header of a section that opens and closes. Closed, it says in one
 * line what is inside ([summary]); [warning] turns that line and the edge
 * red, so something wrong is never hidden by a closed section.
 */
@Composable
fun SectionToggle(
    @DrawableRes icon: Int,
    title: String,
    summary: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    warning: Boolean = false,
) {
    val accent = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Row(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(
                1.dp,
                if (warning) accent.copy(alpha = 0.45f) else MaterialTheme.colorScheme.outlineVariant,
                CardShape,
            )
            .clickable(
                onClickLabel = if (expanded) "Collapse" else "Expand",
                role = Role.Button,
                onClick = onToggle,
            )
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .heightIn(min = 64.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(icon, accent)
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                summary,
                style = MaterialTheme.typography.bodySmall,
                color = if (warning) accent else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // One chevron, turned: down when closed, up when open.
        Icon(
            painterResource(R.drawable.ic_chevron_right),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .size(20.dp)
                .rotate(if (expanded) -90f else 90f),
        )
    }
}

/** "Back", at the top of a screen that is not on the tab bar. */
@Composable
fun BackLink(onClick: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(
        onClick = onClick,
        modifier = modifier,
        contentPadding = PaddingValues(start = 4.dp, top = 8.dp, end = 12.dp, bottom = 8.dp),
    ) {
        Icon(
            painterResource(R.drawable.ic_arrow_back),
            contentDescription = null,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text("Back")
    }
}

/** A row inside a card that opens something: a link out, or another screen. */
@Composable
fun LinkRow(
    text: String,
    @DrawableRes icon: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.weight(1f),
        )
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(18.dp),
        )
    }
}

private class Tab(val screen: Screen, val label: String, @DrawableRes val icon: Int)

private val Tabs = listOf(
    Tab(Screen.HOME, "Home", R.drawable.ic_nav_home),
    Tab(Screen.CATEGORIES, "Filters", R.drawable.ic_nav_filters),
    Tab(Screen.LISTS, "Lists", R.drawable.ic_nav_lists),
    Tab(Screen.FAMILY, "Family", R.drawable.ic_nav_family),
    Tab(Screen.CHILD_LOCK, "Child lock", R.drawable.ic_nav_lock),
)

/** The screens that carry the tab bar. Onboarding, About and the licence do not. */
val TabScreens: Set<Screen> = Tabs.map { it.screen }.toSet()

/** The five places of the app. Moving between them changes nothing, so it is never gated. */
@Composable
fun SitrBottomBar(current: Screen, navigate: (Screen) -> Unit) {
    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        NavigationBar(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            tonalElevation = 0.dp,
        ) {
            for (tab in Tabs) {
                NavigationBarItem(
                    selected = current == tab.screen,
                    onClick = { if (current != tab.screen) navigate(tab.screen) },
                    icon = { Icon(painterResource(tab.icon), contentDescription = null) },
                    label = { Text(tab.label, maxLines = 1) },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = MaterialTheme.colorScheme.primary,
                        selectedTextColor = MaterialTheme.colorScheme.primary,
                        indicatorColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                )
            }
        }
    }
}
