package com.sitrshield.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sitrshield.app.R
import com.sitrshield.app.UiCtx
import com.sitrshield.core.SitrResult
import com.sitrshield.core.domains.DomainInput
import com.sitrshield.core.gate.MutationKind
import com.sitrshield.core.rules.DecisionSnapshot

/** The corner of a domain field and of the button beside it. */
private val FieldShape = RoundedCornerShape(14.dp)

/**
 * What a list does to its sites. Allow is green with a tick, block is red
 * with a barred circle: told apart by the mark as well as the colour. The
 * red is the scheme's error red, the same one "not protected" uses.
 */
enum class ListTone { NEUTRAL, ALLOW, BLOCK }

/** The tone's colour in the current appearance. */
@Composable
fun ListTone.color(): Color =
    if (this == ListTone.BLOCK) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary

/** The edge of a card that holds a list of this tone. */
@Composable
fun ListTone.edge(): Color =
    if (this == ListTone.NEUTRAL) MaterialTheme.colorScheme.outlineVariant else color().copy(alpha = 0.5f)

/**
 * Device allow/block lists. These never leave the device. Per the
 * ladder: adding an allow or removing a block is loosening (PIN-gated);
 * adding a block or removing an allow never is. Input runs through the
 * extension's normalizer, which here also refuses IP addresses and names
 * already listed.
 */
@Composable
fun ListsScreen(ctx: UiCtx) {
    ScreenTitle("Allow & block lists")
    Spacer(Modifier.height(10.dp))
    Text(
        "These lists apply on this device only and never leave it. " +
            "If a site is in both lists, the allow entry wins. " +
            "Household lists are managed on the Sitr Family screen. " +
            "An allowed site opens past Strict Search, a media switch or an " +
            "optional list. It never opens a site on the adult, gambling " +
            "or dating list.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(18.dp))

    SitrCard(borderColor = ListTone.ALLOW.edge()) {
        DomainListEditor(
            title = "Always allow these sites",
            tone = ListTone.ALLOW,
            domains = ctx.settings.userAllow,
            refuse = ctx.app::alwaysBlocked,
            onAdd = { domain, done ->
                ctx.attempt(MutationKind.ADD_DEVICE_ALLOW_RULE, "Allow $domain") {
                    ctx.actions.addDeviceDomain(allow = true, domain = domain)
                    done()
                }
            },
            onRemove = { domain ->
                // Tightening — never gated.
                ctx.attempt(MutationKind.REMOVE_DEVICE_ALLOW_RULE, "") {
                    ctx.actions.removeDeviceDomain(allow = true, domain = domain)
                }
            },
        )
    }

    Spacer(Modifier.height(14.dp))

    SitrCard(borderColor = ListTone.BLOCK.edge()) {
        DomainListEditor(
            title = "Always block these sites",
            tone = ListTone.BLOCK,
            domains = ctx.settings.userBlock,
            onAdd = { domain, done ->
                ctx.attempt(MutationKind.ADD_DEVICE_BLOCK_RULE, "") {
                    ctx.actions.addDeviceDomain(allow = false, domain = domain)
                    done()
                }
            },
            onRemove = { domain ->
                ctx.attempt(MutationKind.REMOVE_DEVICE_BLOCK_RULE, "Unblock $domain") {
                    ctx.actions.removeDeviceDomain(allow = false, domain = domain)
                }
            },
        )
    }

    Spacer(Modifier.height(14.dp))
    SitrCard(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ReportASite()
    }
}

/** Report targets — the iOS app and the extension use the same three. */
object ReportLinks {
    const val BLOCK = "https://github.com/terrancoder/sitr/issues/new?template=block-request.yml"
    const val UNBLOCK = "https://github.com/terrancoder/sitr/issues/new?template=unblock-request.yml"
    const val EMAIL = "mailto:support@sitrshield.com?subject=Site%20report"
}

/**
 * Hands a fixed link to the browser or mail app. Nothing from the app
 * (no domain, no setting) goes into it, and it changes nothing here, so
 * it is never gated — it works on a child's device too.
 */
@Composable
private fun ReportASite() {
    val context = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    fun open(url: String) {
        error = try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            null
        } catch (_: ActivityNotFoundException) {
            if (url.startsWith("mailto:")) "No mail app can open this. Write to support@sitrshield.com."
            else "No browser can open this link."
        }
    }
    CardTitle("Report a site")
    Note(
        "Something that should be blocked, or blocked by mistake? These open " +
            "GitHub or your mail app. A GitHub report is public and needs a " +
            "GitHub account. Sitr itself sends nothing.",
    )
    Spacer(Modifier.height(4.dp))
    RowDivider()
    LinkRow("Ask to block a site", R.drawable.ic_open_external, onClick = { open(ReportLinks.BLOCK) })
    RowDivider()
    LinkRow("Report a wrongly blocked site", R.drawable.ic_open_external, onClick = { open(ReportLinks.UNBLOCK) })
    RowDivider()
    LinkRow("Email instead", R.drawable.ic_mail, onClick = { open(ReportLinks.EMAIL) })
    error?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = ProtectionRed)
    }
}

/**
 * One list and its input, for the inside of a card: the title, the
 * field with its Add button, then the entries, each with a remove button.
 */
@Composable
fun DomainListEditor(
    title: String,
    domains: List<String>,
    onAdd: (String, () -> Unit) -> Unit,
    onRemove: (String) -> Unit,
    /** True for a name that may not be added: an allow entry for an
     *  adult-listed site. Checked BEFORE onAdd, so before the gate: no
     *  wait and no PIN for an entry that would be refused. */
    refuse: (String) -> Boolean = { false },
    tone: ListTone = ListTone.NEUTRAL,
) {
    val context = LocalContext.current
    val toned = tone != ListTone.NEUTRAL
    val accent = tone.color()
    val onAccent =
        if (tone == ListTone.BLOCK) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onPrimary
    val mark = if (tone == ListTone.BLOCK) R.drawable.ic_block else R.drawable.ic_check
    // Saveable: a rotation must not throw away a half-typed domain.
    var input by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (toned) IconBadge(mark, accent)
        CardTitle(title)
    }
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = input,
            onValueChange = { input = it; error = null },
            placeholder = { Text("example.com") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
            shape = FieldShape,
            modifier = Modifier.weight(1f),
        )
        Button(
            onClick = {
                if (input.isBlank()) {
                    error = "Type a domain, for example example.com"
                    return@Button
                }
                when (val normalized = DomainInput.normalize(input, domains)) {
                    is SitrResult.Err -> error = normalized.message
                    is SitrResult.Ok ->
                        if (refuse(normalized.value)) error = DecisionSnapshot.ADULT_ALLOW_REFUSAL
                        else onAdd(normalized.value) { input = "" }
                }
            },
            shape = FieldShape,
            colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = onAccent),
            modifier = Modifier.heightIn(min = 56.dp),
        ) { Text("Add") }
    }
    error?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = ProtectionRed)
    }
    if (error == DecisionSnapshot.ADULT_ALLOW_REFUSAL) {
        TextButton(onClick = {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ReportLinks.UNBLOCK)))
            } catch (_: ActivityNotFoundException) {
                error = "No browser can open this link."
            }
        }) { Text("Report a wrongly blocked site") }
    }
    Column {
        for (domain in domains) {
            RowDivider()
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (toned) {
                    Icon(
                        painterResource(mark),
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(
                    domain,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { onRemove(domain) }) {
                    Icon(
                        painterResource(R.drawable.ic_close),
                        contentDescription = "Remove $domain",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
        if (domains.isEmpty()) {
            Note("None yet.")
        }
    }
}
