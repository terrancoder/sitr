/**
 * Entitlement hook — a typed NO-OP in v1.
 *
 * If billing ever ships, the `X-Sitr-Entitlement` header becomes a signed
 * token verified here at PUT-create time. Per docs/data-flow.md rules, any
 * such change is documented in docs/sync-protocol.md before it ships, and
 * the token must remain unlinkable to the household's encryption keys.
 */

export type EntitlementOutcome = { kind: "ok" } | { kind: "denied" };

export function checkEntitlement(_header: string | undefined): EntitlementOutcome {
  return { kind: "ok" };
}
