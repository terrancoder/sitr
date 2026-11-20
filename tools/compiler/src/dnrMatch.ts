/**
 * Which rule declarativeNetRequest applies to a request — a test model of
 * Chrome's documented precedence, for the decision-order fixture and its
 * tests (never shipped). The highest priority wins; at equal priority
 * allow > allowAllRequests > block > upgradeScheme > redirect. modifyHeaders
 * is left out (it never decides block or allow). Conditions modelled:
 * requestDomains (a listed parent covers its subdomains), urlFilter in the
 * "||domain/path-prefix" form the SafeSearch rules use, resourceTypes.
 * The smoke run (tests/smoke/smoke.mjs) checks the same cases in a browser.
 */
export interface MatchableRule {
  id: number;
  priority?: number;
  action: { type: string };
  condition: { requestDomains?: string[]; urlFilter?: string; resourceTypes?: string[] };
}

const ACTION_ORDER = ["allow", "allowAllRequests", "block", "upgradeScheme", "redirect"];

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function matches(rule: MatchableRule, url: URL, type: string): boolean {
  const c = rule.condition;
  if (c.resourceTypes !== undefined && !c.resourceTypes.includes(type)) return false;
  if (c.requestDomains !== undefined && !c.requestDomains.some((d) => under(url.hostname, d))) {
    return false;
  }
  if (c.urlFilter !== undefined) {
    const m = /^\|\|([^/]+)(.*)$/.exec(c.urlFilter);
    if (m === null) throw new Error(`urlFilter form not modelled: ${c.urlFilter}`);
    if (!under(url.hostname, m[1]!) || !(url.pathname + url.search).startsWith(m[2]!)) return false;
  }
  return true;
}

/** The rule that decides the request, or undefined (nothing matches). */
export function winningRule<R extends MatchableRule>(
  rules: readonly R[],
  url: string,
  type = "main_frame",
): R | undefined {
  const u = new URL(url);
  let best: R | undefined;
  for (const r of rules) {
    if (r.action.type === "modifyHeaders" || !matches(r, u, type)) continue;
    if (
      best === undefined ||
      (r.priority ?? 1) > (best.priority ?? 1) ||
      ((r.priority ?? 1) === (best.priority ?? 1) &&
        ACTION_ORDER.indexOf(r.action.type) < ACTION_ORDER.indexOf(best.action.type))
    ) {
      best = r;
    }
  }
  return best;
}
