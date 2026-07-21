# Deploying Sitr in an organization

Sitr supports managed deployment on Chromium browsers (Chrome, Edge) using the
browser's own enterprise machinery. Two independent levers:

1. **Force-install** — the browser installs Sitr on every managed profile and
   prevents users from uninstalling or disabling it
   (`ExtensionInstallForcelist` / `ExtensionSettings`).
2. **Managed policy** — configuration delivered to the extension through
   `chrome.storage.managed` (schema: [`extension/managed_schema.json`](../../extension/managed_schema.json)).

Nothing here changes Sitr's privacy architecture: policy flows *from* the
admin *to* the device through the browser. Sitr still contacts no servers and
reports nothing back — there is no usage reporting to the organization either.
Managed policy can force filtering ON; it cannot observe browsing.

## Policy keys

| Key | Type | Effect |
|---|---|---|
| `organizationName` | string | Shown to users: "Managed by {name}" |
| `forcedCategories` | string[] | Categories users cannot disable (`sitr_gambling`, `sitr_dating`; adult + SafeSearch are always on for everyone) |
| `managedBlockDomains` | string[] | Domains blocked org-wide (bare lowercase domains) |
| `managedAllowDomains` | string[] | Domains allowed org-wide (outranks household/device rules, not managed blocks) |
| `lockOptions` | boolean | Make the options page read-only |

Invalid entries are dropped (never fatal); the applied state is always
visible on the options page. If policy fails to apply, the badge goes red —
fail-visible applies to admins too.

## Per-platform delivery

- Windows (GPO / registry): [`policy-windows-gpo.md`](policy-windows-gpo.md)
- macOS (configuration profile / plist): [`policy-macos.plist`](policy-macos.plist)
  with instructions in the file header
- Google Admin console (Chrome browser management): [`google-admin.md`](google-admin.md)

`EXTENSION_ID` in these files is the Chrome Web Store ID of Sitr; substitute
the real ID after store publication (or your own ID for a self-hosted CRX).

## Verification checklist (run on one managed machine first)

1. Open `chrome://policy` → verify `ExtensionInstallForcelist` and the Sitr
   entry under "Extension policies" appear with status OK.
2. Open the browser toolbar → Sitr icon has **no red badge**.
3. Open Sitr's options page → banner "Managed by {organizationName}" is
   shown; forced categories are checked and locked; managed domain lists
   appear under "Managed by your organization".
4. Navigate to a domain in `managedBlockDomains` → blocked
   (`ERR_BLOCKED_BY_CLIENT`).
5. Try to remove the extension → the browser itself refuses (force-install).
