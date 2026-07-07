# Appeals process

Think a domain is wrongly blocked? Every rule is public and contestable.

1. **Open an issue** at
   [github.com/terrancoder/sitr/issues](https://github.com/terrancoder/sitr/issues)
   titled `unblock request: <domain>`,
   stating what the site actually is and which inclusion criterion it fails.
2. A maintainer responds **within 14 days** with accept / reject / needs-info,
   citing the [inclusion policy](inclusion-policy.md).
3. Accepted appeals are removed from the source list in a public pull request;
   the fix ships with the next published ruleset.
4. Rejected appeals get a written reason on the issue. The issue stays public
   so decisions are auditable.

Meanwhile, users can always add a **local, on-device allow rule** for any
domain in the extension's options — that choice never leaves their browser.
