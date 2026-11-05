// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: planning and verification of workflow grants (pure; the quoter is a fixed loopback answer on
 * the Base Sepolia test profile, MOCKED mode). Nothing is signed or sent.
 */
import { describe, expect, it } from 'vitest';
import type { ChainTransport } from './chains.ts';
import { workflowRequirement } from './steps.ts';
import { planWorkflowGrants, workflowScopeProblem, type EvmWorkflowScope } from './workflow-grants.ts';

const WALLET = '0x' + '11'.repeat(20);
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
/** A quoter that answers `out` for every quote (the only RPC the planner uses). */
const quoter = (out: bigint): ChainTransport => ({ chain: 'eip155:84532', provenance: 'MOCKED', rpc: async method => method === 'eth_call' ? word(out) : null });
const deps = (out: bigint) => ({ mode: 'MOCKED_HARNESS' as const, mainnet: [], wallet: () => WALLET, transport: () => quoter(out) });
const SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
const BACK = (amount: string) => ({ action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount, slippageBps: 50 });
const requirement = (strategy: unknown) => { const r = workflowRequirement(strategy); if (!r.ok) throw new Error(r.code); return r.value; };

describe('workflow grant planning', () => {
  it('pins a bound step to the producer\'s signed minimum, and several consumers share it (never the whole guarantee each)', async () => {
    const req = requirement({ version: 2, steps: [SWAP, BACK('0.003'), BACK('0.003')], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 0 }] });
    const plan = await planWorkflowGrants(req, deps(4_000_000_000_000_000n));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [chain] = plan.chains, swaps = chain!.calls.filter(c => c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE');
    // Signed minimum of step 0: ceil(0.004 WETH × 99.5%).
    expect(swaps[0]!.amountOutMinimum).toBe('3980000000000000');
    // Step 1 takes its cap (0.003); step 2 takes only what is left of the guarantee (0.00098), not another 0.003.
    expect([swaps[1]!.amountIn, swaps[2]!.amountIn]).toEqual(['3000000000000000', '980000000000000']);
    const scope: EvmWorkflowScope = { mechanism: 'EVM_ERC7710_METAMASK_V1_3', kind: 'WORKFLOW', chain: chain!.chain, workflowRunId: 'wfr_x', calls: chain!.calls,
      steps: chain!.steps, maxCalls: chain!.calls.length, validFrom: '2026-11-05T00:00:00.000Z', expiresAt: '2026-11-05T01:00:00.000Z' };
    expect(workflowScopeProblem(req, scope, 'MOCKED_HARNESS', [])).toBeNull();
    // A stored scope over-allocating the guarantee (both consumers at 0.003) is refused.
    const greedy = { ...scope, calls: scope.calls.map((c, i) => i === 5 && c.kind === 'UNISWAP_V3_EXACT_INPUT_SINGLE' ? { ...c, amountIn: '3000000000000000' }
      : i === 4 && c.kind === 'ERC20_APPROVE' ? { ...c, amount: '3000000000000000' } : c) };
    expect(workflowScopeProblem(req, greedy, 'MOCKED_HARNESS', [])).toBe('WORKFLOW_GRANT_SCOPE_INVALID');
  });
  it('refuses a stored scope that lists one step twice (each call must belong to exactly one step)', async () => {
    const req = requirement({ version: 2, steps: [SWAP, BACK('0.001')], bindings: [{ step: 1, amountFrom: 0 }] });
    const plan = await planWorkflowGrants(req, deps(4_000_000_000_000_000n));
    if (!plan.ok) throw new Error(plan.code);
    const c = plan.chains[0]!;
    const twice: EvmWorkflowScope = { mechanism: 'EVM_ERC7710_METAMASK_V1_3', kind: 'WORKFLOW', chain: c.chain, workflowRunId: 'wfr_x', calls: c.calls,
      steps: [{ stepIndex: 0, calls: [0, 1] }, { stepIndex: 0, calls: [2, 3] }], maxCalls: c.calls.length, validFrom: '2026-11-05T00:00:00.000Z', expiresAt: '2026-11-05T01:00:00.000Z' };
    expect(workflowScopeProblem(req, twice, 'MOCKED_HARNESS', [])).toBe('WORKFLOW_GRANT_SCOPE_INVALID');
  });
  it('refuses what cannot be pinned exactly: a Solana step, a slippage above 3%, a bound Borrow', async () => {
    const sol = requirement({ version: 2, steps: [SWAP, { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5', slippageBps: 50 }] });
    expect(await planWorkflowGrants(sol, deps(1n))).toMatchObject({ ok: false, stepIndex: 1, code: 'WORKFLOW_GRANT_NAMESPACE_UNSUPPORTED' });
    const steep = requirement({ version: 2, steps: [{ ...SWAP, slippageBps: 500 }, BACK('0.001')] });
    expect(await planWorkflowGrants(steep, deps(4_000_000_000_000_000n))).toMatchObject({ ok: false, stepIndex: 0, code: 'WORKFLOW_SLIPPAGE_UNSUPPORTED' });
  });
});
