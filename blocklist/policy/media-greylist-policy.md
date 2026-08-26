# Sitr media-greylist inclusion policy

The media greylist powers the optional **media filtering** layer
(threat-model T12): with the greylist mode on, Sitr blocks `image` and
`media` resource loads on the listed hosts. The sites themselves stay
fully reachable — only their images and media are withheld.

The greylist is deliberately **not part of the shared blocklist**. Every
host on it is an admittedly legitimate, general-purpose platform that
fails the blocklist's primary-purpose test — that is *why* it is here
instead. It ships as a separate artifact (`extension/rulesets/greylist.json`,
compiled from [`blocklist/greylist/hosts.txt`](../greylist/hosts.txt)),
behind a user toggle that defaults to off.

## Criteria for adding a host

1. **Explicit imagery is reachable without leaving the site** — the
   platform hosts or serves adult imagery as ordinary in-feed/search
   content, at a scale users actually meet, not as a rare edge case.
2. **Domain blocking is off the table** — the platform's primary purpose
   is legitimate, so it can never enter the blocklist (same test as
   T11's refusal to block search engines).
3. **Image-blocking degrades, not breaks** — with images and media off,
   the platform's core use (reading, posting, search) still works. A
   platform whose core function *is* the media (a messaging app, a
   photo-first service used for direct communication) fails this
   criterion: blocking its images breaks it, and such hosts belong only
   in the user's own allowlist-only mode, never on the greylist.
   Discord and Telegram Web are the canonical exclusions.
4. Evidence for 1–3 is recorded in the pull request.
5. Hosts are listed at the **registrable domain** level; the rule
   matches by *initiator*, so all of the platform's CDNs are covered
   automatically.

## Criteria for removing a host

- The platform now fails criterion 1 (e.g. it introduced an effective,
  default-on explicit-content control), or
- experience shows it fails criterion 3 in practice.

The blocklist's false-positive bar does not apply here — every entry is
a "false positive" by that definition, deliberately. Contests are argued
against the three criteria above, through the same
[appeals process](appeals-process.md).

## Maintainers

Same maintainers and process as the blocklist: all changes via reviewed
pull requests, compiled only by the deterministic compiler.
