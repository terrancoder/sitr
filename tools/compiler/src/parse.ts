import { type CompileIssue, type Result, err, ok } from "./types.js";

/**
 * Parse a `domains.txt` category source file.
 *
 * Format: one domain per line; `#` starts a comment; blank lines ignored.
 * Output is deduplicated and sorted (code-point order) so the same input set
 * always yields the same output list — a requirement for deterministic builds.
 *
 * Invalid lines are hard errors, never skipped: a silently dropped domain is a
 * silently unprotected user (CLAUDE.md §4 — validate all external data).
 */
export function parseDomainList(
  content: string,
  file: string,
): Result<string[], CompileIssue[]> {
  const parsed = parseEntries(content, file);
  if (!parsed.ok) return parsed;
  if (parsed.value.length === 0) {
    return err([
      { kind: "empty-category", message: "no domains in source file", file },
    ]);
  }
  return ok([...new Set(parsed.value.map((e) => e.domain))].sort());
}

/** One list entry with where it came from, for guard error messages. */
export interface Entry {
  domain: string;
  file: string;
  /** Absent for entries defined in code (SITE_MEDIA_HOSTS). */
  line?: number;
}

/**
 * Same line format as parseDomainList, but keeps file and line per entry,
 * keeps duplicates (first occurrence first) and accepts a file with no
 * entries — an `imported.txt` or `import-exclusions.txt` may be empty.
 */
export function parseEntries(
  content: string,
  file: string,
): Result<Entry[], CompileIssue[]> {
  const issues: CompileIssue[] = [];
  const entries: Entry[] = [];

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const normalized = line.toLowerCase();
    if (!isValidDomain(normalized)) {
      issues.push({
        kind: "invalid-domain",
        message: `invalid domain "${line}"`,
        file,
        line: i + 1,
      });
      continue;
    }
    entries.push({ domain: normalized, file, line: i + 1 });
  }

  return issues.length > 0 ? err(issues) : ok(entries);
}

/**
 * Conservative registrable-domain check: ASCII LDH labels, at least two
 * labels, no scheme/path/port/wildcard. Punycode (`xn--`) is allowed;
 * raw Unicode must be pre-converted so the public list stays unambiguous.
 */
export function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}
