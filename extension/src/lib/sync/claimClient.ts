/**
 * The claim call (docs/sync-protocol.md §Entitlement version 2, `POST
 * /v1/entitlement/claim`, source `polar`). It sends through client.ts's
 * postJson, so client.ts stays the only network call site. Left out of the
 * Mac App Store staging, with entitlement.ts (tools/pack/stage-safari.mjs).
 */
import { claimOutcome, type ClaimOutcome } from "../entitlement.js";
import { CLAIM_BASE_URL, postJson } from "./client.js";

export interface ClaimRequest {
  /** The subscription code, as the caller normalized it. */
  credential: string;
  /** 32 random bytes, base64url (43 characters). */
  claimSecret: string;
  replace: boolean;
  current: boolean;
}

export interface ClaimDeps {
  fetch: typeof fetch;
  baseUrl?: string;
}

/** One claim. No household ID, no sync credential, no other header. */
export async function claim(request: ClaimRequest, deps: ClaimDeps): Promise<ClaimOutcome> {
  const answer = await postJson(
    deps.fetch,
    `${deps.baseUrl ?? CLAIM_BASE_URL}/v1/entitlement/claim`,
    JSON.stringify({
      source: "polar",
      credential: request.credential,
      claim_secret: request.claimSecret,
      replace: request.replace,
      current: request.current,
    }),
  );
  return answer === null ? claimOutcome(0, null) : claimOutcome(answer.status, answer.body);
}
