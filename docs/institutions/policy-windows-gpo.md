# Windows deployment (GPO / registry)

Applies to Chrome; for Edge replace `Google\Chrome` with `Microsoft\Edge`
(policy names are identical).

## 1. Force-install

Group Policy: `Computer Configuration → Administrative Templates → Google →
Google Chrome → Extensions → Configure the list of force-installed apps and
extensions`, add:

```
EXTENSION_ID;https://clients2.google.com/service/update2/crx
```

Registry equivalent:

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="EXTENSION_ID;https://clients2.google.com/service/update2/crx"
```

## 2. Managed policy for Sitr

Extension policy lives under `3rdparty\extensions\<id>\policy`:

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy]
"organizationName"="Al-Noor Academy"
"lockOptions"=dword:00000001

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy\forcedCategories]
"1"="sitr_gambling"
"2"="sitr_dating"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy\managedBlockDomains]
"1"="example-blocked.com"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy\managedAllowDomains]
"1"="example-allowed.com"
```

Run `gpupdate /force` (or restart the browser) and verify per the checklist
in [deployment.md](deployment.md).
