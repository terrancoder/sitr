# Sitr violence list policy

The `violence` list is an optional list, **off by default**, for people who
want to block gore sites and hate sites. It lives in
[`blocklist/optional/violence/`](../optional/violence/) and ships as a
separate artifact on every platform (`violence.json`, `violence.safari.json`,
`violence.domains`). It is never merged into a category or into Safari's
default list.

## What it is

- **Mostly long-standing hate sites:** neo-Nazi, Ku Klux Klan,
  white-supremacist and Holocaust-denial sites, taken from the "agressif"
  category of the UT1 blacklists.
- **A small set of gore and shock-video sites,** from Sinfonietta's
  snuff-hosts list and the gore entries in UT1 "agressif".

Be clear about its limits:

- **It is old.** Much of the UT1 "agressif" list dates from the early web.
- **Some generic names may have changed owner** since they were listed
  (`spotlight.org`, `resistance.com` and similar), and may now be unrelated
  sites.
- **It is not a complete or current list of such sites.** Turning it on
  blocks a few hundred known names, not hate or gore in general.

## Sources and licences

The list is imported only; there is no curated tier. The sources are
declared in [`blocklist/imports/sources.json`](../imports/sources.json) and
credited in [`blocklist/imports/ATTRIBUTION.md`](../imports/ATTRIBUTION.md):

- **Sinfonietta/hostfiles `snuff-hosts`**, MIT. Its names are claimed for
  this list ahead of the always-on adult list (`claimFirst`).
- **UT1 blacklists, category "agressif"**, by Fabrice Prigent, Université
  Toulouse Capitole, CC BY-SA 4.0, pinned to a commit of the
  `olbat/ut1-blacklists` mirror.

Every entry passes the import guards in
[`inclusion-policy.md`](inclusion-policy.md): no public suffixes, nothing
on or under a never-block name, and nothing in
[`import-exclusions.txt`](import-exclusions.txt).

## What it does not include

- News reporting, including reporting on extremism and violence.
- Research and archives that study extremism (`jihadology.net`).
- Human-rights and anti-hate monitoring (`splcenter.org`, `nizkor.org`).
- Legal firearms and replica retail.
- General platforms, file hosts, forums and political commentary whose
  primary purpose is not gore or hate.

Such names found in an upstream are added to `import-exclusions.txt`
with a reason.

## Appeals

A wrongly listed site, for example a generic name now owned by someone
else, is removed through the [appeals process](appeals-process.md): the
name goes into `import-exclusions.txt` and the import is re-run.
