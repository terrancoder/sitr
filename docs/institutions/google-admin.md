# Google Admin console deployment (Chrome browser management)

For organizations using Google Workspace / Chrome Enterprise.

## 1. Force-install

Admin console → `Devices → Chrome → Apps & extensions → Users & browsers` →
select the target organizational unit → `+` → "Add Chrome app or extension by
ID" → enter Sitr's `EXTENSION_ID` → set installation policy to
**Force install**.

## 2. Managed policy

On the same app entry, open the **Policy for extensions** field and paste:

```json
{
  "organizationName": { "Value": "Al-Noor Academy" },
  "lockOptions": { "Value": true },
  "forcedCategories": { "Value": ["sitr_gambling", "sitr_dating"] },
  "managedBlockDomains": { "Value": ["example-blocked.com"] },
  "managedAllowDomains": { "Value": ["example-allowed.com"] }
}
```

(The Admin console wraps each key in `{"Value": …}` — this is Chrome's
extension-policy format, not Sitr's invention.)

## 3. Verify

Sync policy on a managed device (`chrome://policy` → Reload policies), then
run the verification checklist in [deployment.md](deployment.md).
