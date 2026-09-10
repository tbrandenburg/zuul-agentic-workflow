import type { AgentResult } from "@repo/agent-contracts";

export interface ClaimsCrossCheckOutcome {
  ok: boolean;
  message: string;
}

type Claim = NonNullable<AgentResult["claims"]>[number];

/**
 * Check 9 (docs/PLAN.md §6): cross-check `claims[].verifiable == true`
 * against evidence. WARNING severity only (never fails the run) - a claim
 * marked verifiable with empty/missing `evidence` is suspicious but not
 * proof of a bad patch, so it is surfaced for the reviewer rather than
 * blocking `tool-validation`.
 */
export function crossCheckClaims(result: AgentResult): ClaimsCrossCheckOutcome {
  const claims = result.claims ?? [];
  const unsupported = claims.filter(
    (c: Claim) => c.verifiable === true && !(c.evidence && c.evidence.trim().length > 0),
  );
  if (unsupported.length === 0) {
    return { ok: true, message: `all ${claims.length} claim(s) with verifiable=true carry non-empty evidence` };
  }
  return {
    ok: false,
    message: `${unsupported.length} claim(s) marked verifiable=true have no evidence: ${unsupported
      .map((c: Claim) => JSON.stringify(c.statement))
      .join(", ")}`,
  };
}
