/**
 * NOTICE.txt: the licence and attribution notice that travels with every
 * distributed copy of the compiled lists (the packed Chrome extension, the
 * staged Safari extension, and apps/shared/blocklists for the mobile apps).
 * CC BY and CC BY-SA require the attribution to go with the data.
 *
 * Generated, never hand-copied: the attribution part is
 * blocklist/imports/ATTRIBUTION.md read at build time, so it cannot drift.
 * Deterministic: depends only on that file's text (line endings normalized).
 */
import { readFileSync } from "node:fs";

const REPO = "https://github.com/terrancoder/sitr";

export function renderNotice(attributionMd: string): string {
  return [
    "Sitr Shield: licence notice",
    "",
    `Source code: ${REPO}`,
    "",
    "The code is licensed under the Mozilla Public License 2.0 (MPL-2.0).",
    `Full text: ${REPO}/blob/main/LICENSE`,
    "",
    "The blocklist data and the compiled lists in this package are licensed",
    "under Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0).",
    `Full text: ${REPO}/blob/main/blocklist/LICENSE`,
    "(also https://creativecommons.org/licenses/by-sa/4.0/legalcode)",
    "",
    "The attribution below is blocklist/imports/ATTRIBUTION.md from the",
    "source repository, reproduced verbatim; paths in it are relative to",
    "that repository.",
    "",
    "========================================================================",
    "",
    attributionMd.replace(/\r\n/g, "\n").trimEnd(),
    "",
  ].join("\n");
}

/** renderNotice over the ATTRIBUTION.md at `attributionFile`. Throws if unreadable. */
export function readNotice(attributionFile: string): string {
  return renderNotice(readFileSync(attributionFile, "utf8"));
}
