# Appeals process

Think a domain is wrongly blocked? Every rule is public and contestable.

1. **Open an issue** with the
   [unblock request form](https://github.com/terrancoder/sitr/issues/new?template=unblock-request.yml)
   (title `unblock request: <domain>`),
   stating what the site actually is and which inclusion criterion it fails.
   The apps and the extension link to the same form under "Report a site".
   Issues are public; to report privately, write to support@sitrshield.com.
2. A maintainer responds **within 14 days** with accept / reject / needs-info,
   citing the [inclusion policy](inclusion-policy.md).
3. Accepted appeals are removed in a public pull request: a hand-curated
   entry is deleted from `domains.txt`; an imported entry is added to
   [`import-exclusions.txt`](import-exclusions.txt) so the next import
   cannot bring it back. The fix ships with the next published ruleset.
4. Rejected appeals get a written reason on the issue. The issue stays public
   so decisions are auditable.

Meanwhile, users can always add a **local, on-device allow rule** for any
domain in the extension's options — that choice never leaves their browser.
