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
   * KAN-20: 'solana' when the reviewed owner is a Solana wallet (a base58 address, kept exactly as given: letter case matters), derived from the owner's
   * own format, never taken from the browser. Absent: the reviewed owner is an EVM wallet (lower-cased), exactly as before.
   */
  readonly namespace?: 'solana';
  /**
   * Final review (P3): who pays the first group's network fee as the Review showed it (the owner's ETH, or the owner's USDC through Circle).
   * Authorize prepares that group only with the same mechanism (anything else is refused before it is stored). Absent: not bound (an older page).
   */
  readonly firstGroupGas?: ReviewedGas };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** KAN-20: a Solana wallet address as FloFi accepts one (base58, 32 to 44 characters; case-sensitive, no `i` flag: `0`, `O`, `I` and `l` are not base58). */
export const SOLANA_OWNER = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The canonical workflow hash format (`0x` + SHA-256 hex), exactly as `workflow_runs.workflow_hash` stores it. */
const WORKFLOW_HASH = /^0x[0-9a-f]{64}$/;

/** The binding the browser sent, validated (null when anything is missing or malformed: Authorize then refuses with REVIEW_REQUIRED). */
export function bindingOf(value: unknown): ReviewedBinding | null {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const solana = v !== null && typeof v.owner === 'string' && SOLANA_OWNER.test(v.owner);
  if (!v || typeof v.owner !== 'string' || !EVM_ADDRESS.test(v.owner) && !solana || typeof v.workflowHash !== 'string' || !WORKFLOW_HASH.test(v.workflowHash)
    || !Array.isArray(v.groups) || !v.groups.length || v.groups.length > 16) return null;
  const groups = v.groups.map(g => {
    const x = g && typeof g === 'object' ? g as Record<string, unknown> : null, steps = x && Array.isArray(x.steps) ? x.steps : null;
    return x && typeof x.strategy === 'string' && steps && steps.length === 2 && steps.every(n => Number.isSafeInteger(n) && (n as number) >= 0)
      ? { strategy: x.strategy, steps: [steps[0] as number, steps[1] as number] as const } : null;
  });
  if (v.firstGroupGas !== undefined && !isReviewedGas(v.firstGroupGas)) return null;
  // KAN-20: a Solana owner is kept verbatim (never lower-cased: base58 is case-sensitive); an EVM owner is lower-cased exactly as before.
  return groups.every(Boolean) ? { owner: solana ? v.owner : v.owner.toLowerCase(), workflowHash: v.workflowHash, groups: groups as ReviewedBinding['groups'],
    ...isReviewedGas(v.firstGroupGas) ? { firstGroupGas: v.firstGroupGas } : {}, ...solana ? { namespace: 'solana' as const } : {} } : null;
}

/** A wallet this browser proved (its server-side sign-in session), as `currentWalletPrincipals` reads it. */
export type ProvenWallet = { readonly namespace: 'eip155' | 'solana'; readonly address: string };
/**
 * Which of this browser's proven wallets the Editor's Authorize claims the run with, or the proof the owner must give first. EVM, exactly as
 * before: every non-EVM principal plus the reviewed EVM wallet (case-insensitive), and at least that EVM wallet (EVM_WALLET_PROOF_REQUIRED
 * otherwise). KAN-20, a reviewed Solana owner: ONLY that Solana wallet, compared exactly (another proven wallet of this browser never runs a
 * workflow it did not review; a case variant is another key), else SOLANA_WALLET_PROOF_REQUIRED (the Editor asks its Sign-In With Solana once).
 */
export function reviewedWallets<W extends ProvenWallet>(principals: readonly W[], binding: ReviewedBinding):
  { readonly ok: true; readonly wallets: readonly W[] } | { readonly ok: false; readonly code: 'EVM_WALLET_PROOF_REQUIRED' | 'SOLANA_WALLET_PROOF_REQUIRED' } {
  if (binding.namespace === 'solana') {
    const wallets = principals.filter(w => w.namespace === 'solana' && w.address === binding.owner);
    return wallets.length ? { ok: true, wallets } : { ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' };
  }
  const wallets = principals.filter(w => w.namespace !== 'eip155' || w.address.toLowerCase() === binding.owner);
  return wallets.some(w => w.namespace === 'eip155') ? { ok: true, wallets } : { ok: false, code: 'EVM_WALLET_PROOF_REQUIRED' };
}

/** Whether a started run is exactly the reviewed workflow with the reviewed groups (mechanism and steps, in order). */
export function runMatchesBinding(run: { readonly workflowHash: string; readonly groups?: readonly { readonly strategy: string; readonly steps: readonly [number, number] }[] },
  binding: ReviewedBinding): boolean {
  const groups = run.groups ?? [];
  return run.workflowHash === binding.workflowHash && groups.length === binding.groups.length
    && groups.every((g, i) => g.strategy === binding.groups[i]!.strategy && g.steps[0] === binding.groups[i]!.steps[0] && g.steps[1] === binding.groups[i]!.steps[1]);
}
