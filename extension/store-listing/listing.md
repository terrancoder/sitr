# Chrome Web Store listing copy

*Must stay consistent with docs/privacy-policy.md, the data-safety form, the
in-app UI, and all public statements (six-way consistency rule). No
absolutist claims ("zero data collection", "we never track you") — only
specific, substantiated ones.*

## Name

Sitr — Halal & Family Content Filter

## Summary (132 chars max)

On-device adult-content filtering and SafeSearch enforcement. Your browsing
history never leaves your browser.

## Description

Sitr (سِتْر — "covering, protection") blocks adult, gambling and dating
sites and enforces SafeSearch — built for Muslim families, useful for anyone
who wants a cleaner internet without being watched.

**Private by design, not by promise**

Most content filters route your traffic through their servers or phone home
about what you visit. Sitr does neither — and you don't have to take our
word for it:

• All filtering happens on your device, using your browser's built-in
  declarativeNetRequest engine. Sitr cannot read the contents of pages or
  requests.
• The blocklist is identical for every user and published openly, so we have
  no way to see which sites you visit — and you can see and contest every rule.
• No analytics, no ads, no third-party SDKs. Analytics aren't "off by
  default" — they don't exist in the code.
• Open source with reproducible builds: anyone can rebuild the extension and
  verify the published package matches the public source.
• We run no ad network and we don't sell your data. Sitr is funded by users,
  never by data.

**What it does**

• Blocks adult content, gambling, and dating sites — about 100,000 domains
  from a public list (gambling and dating are optional categories you can
  toggle)
• Optional, off by default: a list of gore and extremist hate sites. It is
  old and incomplete, and says so
• Forces SafeSearch on Google, Bing, and DuckDuckGo
• Forces YouTube Restricted Mode
• Per-site allow and block lists — stored only in your browser (optional
  Family household lists sync end-to-end encrypted, unreadable to us)
• Optional "Wait before loosening": a change that loosens protection waits
  5 minutes to 24 hours before it can be made. It slows changes inside
  Sitr only; it can't stop the extension being disabled, and it relies on
  your computer's clock
• Shows an explicit red "Protection INACTIVE" warning if filtering ever
  stops working, instead of silently pretending

**What it doesn't do**

No account. No server that sees your traffic. No history collection. No
"anonymized" usage data. The optional Family plan stores exactly one thing
on our server: an end-to-end-encrypted household-settings blob we cannot
decrypt — household preferences, never browsing. Most of the list comes
from public blocklists, named with their licences in the repository, and
was checked by domain name rather than site by site, so some entries will
be wrong. If a rule wrongly blocks a legitimate site, add a local exception
instantly (except for a site on the adult list, which only a report can
fix) and report it from the options page: the link opens a public
GitHub issue form (or your mail app), and Sitr itself sends nothing. Every
rule is public and contestable.

Source code, blocklist, and appeals: https://github.com/terrancoder/sitr

## Support / homepage URLs for the listing form

- Homepage: https://github.com/terrancoder/sitr
- Support: https://github.com/terrancoder/sitr/issues
- Privacy policy: https://sitrshield.com/privacy

## Category

Make Chrome Yours → Privacy & Security (fallback: Lifestyle)

## Data-safety form answers

With no household configured: no user data of any type is collected — the
extension makes zero network requests. The optional Family sync (explicit
opt-in) transmits one end-to-end-encrypted household-settings blob to
sync.sitrshield.com: household preferences, household allow/block domain lists,
device identifiers (random, chosen by each device), and the guardian PIN as a salted hash — never browsing
history or page content, and the server cannot decrypt any of it.

On the form: declare **Authentication information** (the guardian PIN
record inside the encrypted blob, collected only when Family sync is used);
every other category: not collected. Certify no sale, no unrelated use, no
creditworthiness use. Limited Use certification: affirmed.

## Version with subscription code (not yet published)

> **NOT YET PUBLISHED.** For the store version that adds the Sitr Family
> subscription code. Nothing below applies to the listing that is live now,
> and the description above stays as it is until that version ships.

- **Permission justification (optional host `https://claim.sitrshield.com/*`):**
  Sitr asks for access to claim.sitrshield.com only when the user enters a
  Sitr Family subscription code, so that the extension can confirm and renew
  the household's Family plan there; it is an optional permission and is
  never requested otherwise.
- **Sentence the description will need when this ships:** "Sitr Family is
  an optional paid plan sold on sitrshield.com by the publisher, not by the
  browser store." For the Edge Add-ons listing, the description must also
  state the price range.
- **Privacy-form note:** the subscription code is sent to the publisher's
  claim service (claim.sitrshield.com). It is an identifier, so on Chrome's
  form it is likely "Personally identifiable information" and
  "Authentication information" — to be confirmed by the owner before
  submission.
- **Reviewer access:** a subscription code binds to one device, so
  reviewers do not get one. Give them a pairing code to a demo household
  (and its guardian PIN) in the test instructions; joining needs no code
  and no claim.
- **Mac App Store build:** stays join-only: no code entry and no claim
  host. Like every build, it shows the household's end date and the
  neutral renewal notices.
