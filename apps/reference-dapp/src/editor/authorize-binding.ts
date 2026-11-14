// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: what the owner reviewed, as the Editor's Authorize binds it — the wallet, the canonical workflow hash and the plan of
 * groups. Authorize starts nothing that differs from it (the started run must have exactly this hash and these groups). Pure, so it is tested
 * without a server action.
 */
// The reviewed mechanism is shared with the platform and the run service (the platform never imports a surface module).
import { isReviewedGas, type ReviewedGas } from '../workflow-runs/execution-groups.ts';
export { isReviewedGas, type ReviewedGas };
export type ReviewedBinding = { readonly owner: string; readonly workflowHash: string;
  readonly groups: readonly { readonly strategy: string; readonly steps: readonly [number, number] }[];
  /**
   * Final review (P3): who pays the first group's network fee as the Review showed it (the owner's ETH, or the owner's USDC through Circle).
   * Authorize prepares that group only with the same mechanism (anything else is refused before it is stored). Absent: not bound (an older page).
   */
  readonly firstGroupGas?: ReviewedGas };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The canonical workflow hash format (`0x` + SHA-256 hex), exactly as `workflow_runs.workflow_hash` stores it. */
const WORKFLOW_HASH = /^0x[0-9a-f]{64}$/;

/** The binding the browser sent, validated (null when anything is missing or malformed: Authorize then refuses with REVIEW_REQUIRED). */
export function bindingOf(value: unknown): ReviewedBinding | null {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!v || typeof v.owner !== 'string' || !EVM_ADDRESS.test(v.owner) || typeof v.workflowHash !== 'string' || !WORKFLOW_HASH.test(v.workflowHash)
    || !Array.isArray(v.groups) || !v.groups.length || v.groups.length > 16) return null;
  const groups = v.groups.map(g => {
    const x = g && typeof g === 'object' ? g as Record<string, unknown> : null, steps = x && Array.isArray(x.steps) ? x.steps : null;
    return x && typeof x.strategy === 'string' && steps && steps.length === 2 && steps.every(n => Number.isSafeInteger(n) && (n as number) >= 0)
      ? { strategy: x.strategy, steps: [steps[0] as number, steps[1] as number] as const } : null;
  });
  if (v.firstGroupGas !== undefined && !isReviewedGas(v.firstGroupGas)) return null;
  return groups.every(Boolean) ? { owner: v.owner.toLowerCase(), workflowHash: v.workflowHash, groups: groups as ReviewedBinding['groups'],
    ...isReviewedGas(v.firstGroupGas) ? { firstGroupGas: v.firstGroupGas } : {} } : null;
}

/** Whether a started run is exactly the reviewed workflow with the reviewed groups (mechanism and steps, in order). */
export function runMatchesBinding(run: { readonly workflowHash: string; readonly groups?: readonly { readonly strategy: string; readonly steps: readonly [number, number] }[] },
  binding: ReviewedBinding): boolean {
  const groups = run.groups ?? [];
  return run.workflowHash === binding.workflowHash && groups.length === binding.groups.length
    && groups.every((g, i) => g.strategy === binding.groups[i]!.strategy && g.steps[0] === binding.groups[i]!.steps[0] && g.steps[1] === binding.groups[i]!.steps[1]);
}
