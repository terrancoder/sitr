# Sitr encrypted-DNS hosts policy

The `doh` list powers an optional setting that stops a browser's encrypted
DNS from quietly going around Sitr's DNS filter, for well-known providers. It lives in
[`blocklist/optional/doh/domains.txt`](../optional/doh/domains.txt).

## Why it exists

Sitr's Android filter works by answering DNS lookups. A browser with its
own "Secure DNS" set to a specific provider sends its lookups encrypted to
that provider instead, and the filter never sees them. Nothing tells the
user or the parent that this happened.

If the provider's own hostname is answered as blocked, the browser can no
longer reach its server. Tested with Chrome on Android 15:

- Secure DNS on "automatic" (Chrome's default): Sitr filters normally,
  with the switch on or off.
- A built-in provider chosen (Google, Cloudflare): with the switch off,
  Chrome silently bypasses Sitr and a blocked site loads. With it on,
  every page fails to load with Chrome's secure-DNS error until secure DNS
  is set back to automatic. Chrome did not fall back to the system's DNS.
- A connection Chrome already had open kept working for a few minutes
  after the switch was turned on.
- With the switch on, Google search, YouTube and Android's own
  connectivity check still worked.

Other browsers, newer Chrome versions and other Android versions have not
been tested.

Android's own Private DNS is a different case, and this switch has no
effect on it: a fixed Private DNS hostname conflicts with Sitr. On the
Android 15 and 16 devices tested, the phone could not look up any name
while both were on, and Sitr showed protection as not active. The fix is
to set Private DNS to Automatic or Off.

The list is **off by default**, **Android only** for now (an iOS DNS engine
may use it later), and it is a separate artifact (`doh.domains`), never
part of the shared blocklist. Every user who turns it on gets the same list.

## Criteria for adding a hostname

1. The hostname's **primary purpose** is to serve as an encrypted-DNS
   endpoint (DNS-over-HTTPS or DNS-over-TLS) for the public.
2. Entries are **full hostnames**, not registrable domains:
   `dns.quad9.net`, not `quad9.net`. A registrable domain is listed only
   when the whole domain is the DNS service (`cloudflare-dns.com`,
   `dns.google`, `doh.pub`). A company's main domain (`google.com`,
   `opendns.com`) never qualifies.
3. The hostname resolves and is documented by the provider or a public
   reference such as the curl project's "DNS over HTTPS" list. Evidence
   goes in the pull request.
4. VPN services and Apple's iCloud Private Relay are out of scope for this
   list; they are a different feature.

## What it cannot do

- An encrypted-DNS server entered as an **IP address** (for example
  `https://1.1.1.1/dns-query`) is not stopped by a hostname list, nor is a
  provider that is not on the list.
- The list is **never complete**. Anyone can run a DNS-over-HTTPS server,
  and new public ones appear all the time. It covers the well-known ones.
- It does not stop VPNs, proxies or Tor.

## Criteria for removing a hostname

- It no longer serves encrypted DNS, or
- it serves something else as its main purpose (blocking it breaks more
  than it protects).

Changes go through the same [appeals process](appeals-process.md) and
reviewed pull requests as the blocklist. The compiler's guards (public
suffixes, the [never-block list](never-block.txt), duplicates) apply to
this list too. Because the list deliberately names hosts under large
providers, it has a narrow exemption from the never-block guard: an entry
may sit under a never-block name, but may never be one or contain one.
