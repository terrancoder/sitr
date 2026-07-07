/**
 * Shared types for the Sitr ruleset compiler.
 *
 * Errors are modelled as a discriminated Result (CLAUDE.md §4): every fallible
 * operation returns `ok | err` instead of throwing across module boundaries.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** A single problem found while parsing or compiling — always user-readable. */
export interface CompileIssue {
  kind:
    | "invalid-domain"
    | "empty-category"
    | "rule-limit-exceeded"
    | "io-error";
  message: string;
  /** Source file the issue came from, when known. */
  file?: string;
  /** 1-based line number, when known. */
  line?: number;
}

/** Minimal typing of the Chrome DNR rule shapes we emit. */
export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: "block" | "redirect" | "modifyHeaders" | "allow" | "upgradeScheme";
    redirect?: {
      transform?: {
        host?: string;
        queryTransform?: {
          addOrReplaceParams?: Array<{ key: string; value: string }>;
        };
      };
    };
    requestHeaders?: Array<{
      header: string;
      operation: "set" | "remove" | "append";
      value?: string;
    }>;
  };
  condition: {
    urlFilter?: string;
    requestDomains?: string[];
    resourceTypes?: string[];
  };
}
