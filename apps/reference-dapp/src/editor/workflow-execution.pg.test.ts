// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution (the owner's production report, 2026-11-08): the Editor's whole-workflow Review and Authorize for the Canvas workflow
 * Swap 3 USDC → WETH (Uniswap) → Supply the swap's WETH (Aave V3) → Borrow 0.8 USDC (Aave V3) on Arbitrum One, with a MetaMask that reports EIP-5792
 * atomic batching — end to end on PostgreSQL through the real Canvas → strategy conversion, the real approval service, run store, runner and
 * user-funded builders, on the MOCKED Arbitrum One chain double (a modelled Aave V3 market). Nothing reaches a network; evidence is MOCKED.
 *
 *   Review     read-only: ONE wallet confirmation, ONE transaction, the 5 exact calls, the whole-batch simulation (health factor ≥ 2) and the
 *              amounts every step spends/receives — nothing stored, nothing signed
 *   Authorize  the shared run is started, claimed for the owner's wallet and started in user-funded mode with the wallet's real capabilities;
 *              its first group is prepared from fresh facts: exactly the calls the Review showed (Scenario B)
 *   Wallet     the owner's account executes the batch (one transaction from itself); FloFi reconciles every step from the chain (Scenario G)
 *   Recovery   the run is read back by its id after a "reload": nothing is prepared or sent again (Scenario F)
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval, workflowRunCancel, workflowRunStatus } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport, workflowRunUserFundedStart } from '../platform/approve.ts';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { workflowRunHarness } from '../workflow-runs/workflow-run.test-harness.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { reviewEditorExecution } from './workflow-execution.ts';
import { bindingOf, runMatchesBinding } from './authorize-binding.ts';
import { canvasWorkflowOfStrategy } from './workflow-strategy.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN];
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth;
const POOL = delegationAavePool(CHAIN, CHAINS)!;
const reserve = (asset: string) => delegationAaveReserve(CHAIN, POOL, asset)!;
const RESERVES = [{ ...reserve(WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
/** MetaMask on Arbitrum One reporting EIP-5792 atomic batching (as `wallet_getCapabilities` answers it). */
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } } as const;
const strategy = (owner: string, borrow = '0.8') => ({ version: 2, steps: [
  { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
  { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.0013', beneficiary: owner },
  { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: borrow, beneficiary: owner }], bindings: [{ step: 1, amountFrom: 0 }] });

async function setup(t: Awaited<ReturnType<typeof createTestDatabase>>) {
  // The chain's clock is the run's clock (a batched swap carries an on-chain deadline from the preparation time).
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP, aave: { pool: POOL, reserves: RESERVES } });
  const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap', 'arbitrum-aave'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' },
    userFundedChains: CHAINS, userFundedRpc: c => c === CHAIN ? chain.rpc : null });
  clock = h.d.now;
  const owner = h.d.evmOwner.address.toLowerCase();
  chain.control.fundToken(owner, USDC, 10_000_000n); chain.control.fundNative(owner, 10n ** 17n);
  return { chain, h, owner };
}

describe('P0: the Editor reviews and authorizes Swap → Supply → Borrow on Arbitrum One as ONE wallet confirmation', () => {
  it('Review (read-only) → Authorize (one batch, the reviewed calls) → the owner\'s wallet executes it → every step reconciled → recovered after reload', async () => {
    const t = await createTestDatabase();
    try {
      const { chain, h, owner } = await setup(t);
      const canvas = canvasWorkflowOfStrategy(strategy(owner));
      if (!canvas.ok) throw new Error(canvas.code);
      // ── Review: read-only ───────────────────────────────────────────────────────────────────────────────────────────────────────
      const reviewed = await reviewEditorExecution({ workflow: canvas.workflow, owner, profile: METAMASK, facts: h.runs.userFundedFacts!, deps: h.runs.userFunded!,
        now: h.d.now() });
      if (!reviewed.ok) throw new Error(reviewed.code);
      const review = reviewed.value;
      expect(review).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', stepCount: 3, refusal: null,
        counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 5, networkSwitches: 0 } });
      expect(review.groups).toHaveLength(1);
      expect(review.groups[0]!.calls!.map(c => [c.kind, c.step])).toEqual([['ERC20_APPROVE', 0], ['UNISWAP_V3_EXACT_INPUT_SINGLE', 0], ['ERC20_APPROVE', 1],
        ['AAVE_V3_SUPPLY', 1], ['AAVE_V3_BORROW', 2]]);
      expect(BigInt(review.groups[0]!.healthFactorAfter!)).toBeGreaterThanOrEqual(2n * 10n ** 18n);
      expect(review.groups[0]!.fee).toMatchObject({ payer: owner });
      // Every step's amounts are visible before anything is signed: the swap's input, quote and signed minimum; the supply spends that minimum;
      // the borrow delivers exactly 0.8 USDC.
      const [swap, supply, borrow] = review.steps;
      expect(swap).toMatchObject({ action: 'swap', network: 'Arbitrum One', provider: 'Uniswap V3', basis: 'EXACT', spend: { text: '3 USDC' }, expected: { text: '0.0012 WETH' } });
      expect(supply).toMatchObject({ action: 'supply', basis: 'GUARANTEED_MINIMUM', boundTo: 0, spend: { units: swap!.minimum!.units, symbol: 'WETH' } });
      expect(borrow).toMatchObject({ action: 'borrow', expected: { text: '0.8 USDC' } });
      // Nothing was stored, signed or sent by the Review.
      expect((await t.db.query('SELECT count(*)::int AS n FROM workflow_runs')).rows).toEqual([{ n: 0 }]);
      expect(chain.control.sends()).toBe(0);
      expect(chain.control.tokenBalance(USDC, owner)).toBe(10_000_000n);

      // ── Authorize: the shared run, claimed for the owner's wallet, user-funded with the wallet's real capabilities ─────────────────
      const approval = await h.request(strategy(owner));
      await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now());
      const started = await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      expect(started.view.workflowRun!.run).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', nextAction: 'OWNER_SIGNS_GROUP',
        groups: [{ index: 0, strategy: 'EVM_WALLET_BATCH', steps: [0, 2], feePayer: owner }] });
      // The Authorize binding the Editor sends (the Review's own hash and groups) matches the run it starts, exactly.
      const binding = bindingOf({ owner, workflowHash: review.workflowHash, groups: review.groups.map(g => ({ strategy: g.strategy, steps: g.steps })) });
      expect(binding).not.toBeNull();
      expect(runMatchesBinding(started.view.workflowRun!.run, binding!)).toBe(true);
      const prepared = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const p = prepared.prepared as unknown as { group: EvmGroupCalls; request: { atomicRequired: boolean; id: string } };
      // Exactly what the Review showed (same calls, same amounts at an unchanged price), as ONE atomic request with the group's own id.
      expect(p.group.calls.map(c => c.kind)).toEqual(review.groups[0]!.calls!.map(c => c.kind));
      expect((p.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum).toBe(swap!.minimum!.units);
      expect(p.request).toMatchObject({ atomicRequired: true });
      expect(p.request).not.toHaveProperty('capabilities');
      // The owner's own view lists what the wallet is asked, per step, before it is asked.
      const before = await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(before.view.workflowRun!.run.groups[0]!.planned).toMatchObject({ calls: 5, approvals: 2, steps: [
        { index: 0, spend: { text: '3 USDC' }, expected: { text: '0.0012 WETH' } }, { index: 1, spend: { symbol: 'WETH' } }, { index: 2, expected: { text: '0.8 USDC' } }] });

      // ── The owner's wallet sends ONE transaction from its own account; FloFi reconciles each step from the chain ──────────────────
      const hash = chain.control.walletBatch(owner, evmCallsOf(p.group));
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
      const done = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [hash]);
      const run = done.view.workflowRun!.run;
      expect(run).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED', nextAction: 'NONE' });
      expect(run.steps.map(s => s.state)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
      expect(run.steps[2]!.outcome!.received).toEqual([{ asset: `${CHAIN}/erc20:${USDC}`, amount: '800000' }]);
      expect(run.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: owner }, submissions: [{ hash }] });
      expect(chain.control.accountData(owner).hf).toBeGreaterThanOrEqual(2n * 10n ** 18n);
      expect(chain.control.sends()).toBe(0);

      // ── Reload: the run is read back by its id; nothing is prepared or sent again ─────────────────────────────────────────────────
      const reloaded = await workflowRunStatus(h.surface, approval.approvalId, [h.evm, h.sol]);
      expect(reloaded.view.workflowRun!.run).toMatchObject({ state: 'COMPLETED', groups: [{ state: 'RECONCILED', submissions: [{ hash }] }] });
    } finally { await t.drop(); }
  });

  it('a batch sent before its answer was lost still reconciles after the group expired and was prepared again (same EIP-5792 id, no FAILED run)', async () => {
    const t = await createTestDatabase();
    try {
      const { chain, h, owner } = await setup(t);
      const approval = await h.request(strategy(owner));
      await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now());
      await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
      const first = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0);
      const a = first.prepared as unknown as { group: EvmGroupCalls; request: { id: string } };
      // The wallet executes it, but its answer never reaches FloFi (a reload while the wallet prompt was open)…
      const hash = chain.control.walletBatch(owner, evmCallsOf(a.group));
      // …the preparation expires, a first attempt to prepare it again fails (the owner briefly lacks gas money: the group is back to PLANNED)…
      // (Past its validity and the settle margin; only the browser that holds the batch's hand-out token prepares it again.)
      h.d.advance(13 * 60_000);
      chain.control.fundNative(owner, 0n);
      await expect(workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0, first.handout!)).rejects.toThrow('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
      chain.control.fundNative(owner, 10n ** 17n);
      // …then the price moves and the group is prepared again under the SAME id (the wallet would refuse a second batch).
      chain.control.setPrice(390_000_000_000_000n);
      const second = await workflowRunUserFundedPrepare(h.surface, approval.approvalId, [h.evm, h.sol], 0, first.handout!);
      const b = second.prepared as unknown as { group: EvmGroupCalls; request: { id: string }; superseded: unknown[] };
      expect(b.request.id).toBe(a.request.id);
      expect((b.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum).not.toBe((a.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum);
      expect(b.superseded).toHaveLength(1);
      // The owner's browser reads the batch back by its id and reports the FIRST batch's transaction: the run reconciles it against the
      // preparation it was sent from (its own signed minimums), never as a failed group.
      await workflowRunUserFundedAuthorize(h.surface, approval.approvalId, [h.evm, h.sol], 0, { kind: 'EVM_WALLET_BATCH', batchId: a.request.id });
      const done = await workflowRunUserFundedReport(h.surface, approval.approvalId, [h.evm, h.sol], 0, [hash]);
      expect(done.view.workflowRun!.run).toMatchObject({ state: 'COMPLETED', groups: [{ state: 'RECONCILED', submissions: [{ hash }] }] });
      const signedSupply = (a.group.calls[1] as { amountOutMinimum: string }).amountOutMinimum;
      expect(done.view.workflowRun!.run.steps[1]!.outcome!.spent).toEqual([{ asset: `${CHAIN}/erc20:${WETH}`, amount: signedSupply }]);
      // The step is recorded with what the batch that ran was signed to spend (never the newer preparation's amount): a later consumer of the
      // swap's delivery is funded only by what is really left of it.
      const supplyStep = (await t.db.query<{ bound: { used: string } | null; strategy: { amount: string } }>(
        'SELECT bound, strategy FROM workflow_run_steps WHERE step_index = 1')).rows[0]!;
      expect(supplyStep.bound?.used).toBe(signedSupply);
      // The owner's view shows what the batch that ran was signed for (never the newer preparation's amounts).
      expect(done.view.workflowRun!.run.groups[0]!.planned!.steps.find(st => st.index === 1)!.spend!.units).toBe(signedSupply);
      expect(supplyStep.strategy.amount).toBe('0.001194');
    } finally { await t.drop(); }
  });

  it('an Authorize that ended its run before the wallet was asked does not count against the pending-approval limit', async () => {
    const t = await createTestDatabase();
    try {
      const { h, owner } = await setup(t);
      // The harness requester may have 5 approvals waiting. Five claimed runs, each ended before anything was asked (as a failed Editor
      // Authorize ends its run), wait for nobody: a sixth request is still accepted.
      for (let i = 0; i < 5; i++) {
        const approval = await h.request(strategy(owner));
        await claimApproval(h.surface, approval.secret, [h.evm, h.sol], true, h.d.now());
        await workflowRunUserFundedStart(h.surface, approval.approvalId, [h.evm, h.sol], METAMASK);
        const ended = await workflowRunCancel(h.surface, approval.approvalId, [h.evm, h.sol]);
        expect(ended.view.workflowRun!.run.state).toBe('CANCELLED');
      }
      const sixth = await h.request(strategy(owner));
      // A claimed run that is still open keeps counting, exactly like an unclaimed approval.
      await claimApproval(h.surface, sixth.secret, [h.evm, h.sol], true, h.d.now());
      await workflowRunUserFundedStart(h.surface, sixth.approvalId, [h.evm, h.sol], METAMASK);
      for (let i = 0; i < 4; i++) await h.request(strategy(owner));
      await expect(h.request(strategy(owner))).rejects.toThrow('HANDOFF_PENDING_LIMIT');
    } finally { await t.drop(); }
  });

  it('a Borrow that would leave the health factor below 2.0 is shown as a refusal in the Review: nothing is offered to the wallet', async () => {
    const t = await createTestDatabase();
    try {
      const { h, owner } = await setup(t);
      const canvas = canvasWorkflowOfStrategy(strategy(owner, '1.4'));
      if (!canvas.ok) throw new Error(canvas.code);
      const reviewed = await reviewEditorExecution({ workflow: canvas.workflow, owner, profile: METAMASK, facts: h.runs.userFundedFacts!, deps: h.runs.userFunded!, now: h.d.now() });
      expect(reviewed).toMatchObject({ ok: true, value: { refusal: { code: 'BORROW_UNSAFE_HEALTH_FACTOR', step: 2 }, groups: [{ calls: null, fee: null }] } });
    } finally { await t.drop(); }
  });

  it('a wallet without atomic batching gets an honest step-by-step plan with its reason (Scenario I), never a "single" claim', async () => {
    const t = await createTestDatabase();
    try {
      const { h, owner } = await setup(t);
      const canvas = canvasWorkflowOfStrategy(strategy(owner));
      if (!canvas.ok) throw new Error(canvas.code);
      const reviewed = await reviewEditorExecution({ workflow: canvas.workflow, owner, profile: { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'unsupported' }, typedData: true } },
        facts: h.runs.userFundedFacts!, deps: h.runs.userFunded!, now: h.d.now() });
      expect(reviewed).toMatchObject({ ok: true, value: { mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'], counts: { walletPrompts: 3, atLeast: true } } });
    } finally { await t.drop(); }
  });

  it('as many wallet batches as steps (Arbitrum Swap, then a Base Transfer) is GROUPED, never forced step by step: grouping is never more wallet prompts', async () => {
    const t = await createTestDatabase();
    try {
      const { h, owner } = await setup(t);
      const BASE = 'eip155:8453';
      const canvas = canvasWorkflowOfStrategy({ version: 2, steps: [
        { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
        { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '4'.repeat(40) }] });
      if (!canvas.ok) throw new Error(canvas.code);
      const reviewed = await reviewEditorExecution({ workflow: canvas.workflow, owner, profile: { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported', [BASE]: 'supported' },
        typedData: true } }, facts: { ...h.runs.userFundedFacts!, chains: [CHAIN, BASE] }, deps: h.runs.userFunded!, now: h.d.now() });
      if (!reviewed.ok) throw new Error(reviewed.code);
      // Two batches for two steps: a tie with confirming each step (at least 2: each flow may add a token approval, which a batch folds in).
      expect(reviewed.value.groups.map(g => [g.strategy, g.signing, g.steps])).toEqual([['EVM_WALLET_BATCH', 'UPFRONT', [0, 0]], ['EVM_WALLET_BATCH', 'WHEN_DUE', [1, 1]]]);
      expect(reviewed.value).toMatchObject({ mode: 'GROUPED', refusal: null, counts: { walletPrompts: 2, atLeast: false, networkSwitches: 1 } });
      // Nothing claims a saving it does not have, and the retired "not fewer" reason is never emitted.
      expect(reviewed.value.reasons).toEqual([]);
    } finally { await t.drop(); }
  });
});
