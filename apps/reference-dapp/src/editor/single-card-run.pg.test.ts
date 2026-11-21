// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 — the mandatory acceptance scenario on a deterministic MOCKED chain (CI evidence, never public
 * execution): Arbitrum One, a MetaMask that reports EIP-5792 atomic batching, ONE Uniswap V3 card "Swap 0.0006 WETH → USDC" with an allowance
 * that does not cover it. End to end on PostgreSQL through the real Canvas → strategy conversion, the real Editor approval handoff (a SEQUENTIAL
 * plan of ONE step, EDITOR_SESSION only), the real run store, runner and user-funded builders, on the MOCKED Arbitrum One chain double:
 *
 *   Review     read-only: ONE wallet confirmation, ONE transaction, exactly [approve(router, 0.0006 WETH), swap] — nothing stored or sent
 *   Authorize  one handoff, one run of ONE step, started user-funded with the wallet's real capabilities; group 0 is one EVM_WALLET_BATCH
 *   Wallet     the owner's wallet executes ONE atomic batch (counted at the chain double); FloFi never submits a transaction itself
 *   Reconcile  automatic and independent: from the chain's receipt and Transfer legs; the run completes with no further owner action
 *
 * Also: an existing sufficient allowance (no approval call), a non-zero insufficient one (reset to 0, then exact), rejection (nothing executes),
 * insufficient balance and a provider failure (refused before anything is stored), unsupported wallet capabilities (the Review says the card
 * cannot run as one confirmation, so the Editor keeps the card's own flow), an unanswered batch past its validity (never resent; the outcome stays
 * unknown, the run halts), a reload (read back, never prepared or sent again), and the dormant gate (a database without migration 0032 is never
 * offered a one-step run; MCP/channel one-step handoffs keep SINGLE_FLOW).
 *
 * The database is migrated exactly as the operator release leaves it: the shipped history, then the certified 0029–0032 from their pinned fixtures.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, type Migration } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createAccountStore } from '../accounts/account-store.ts';
import type { Command } from '../domain/commands';
import { editorReducer, initialEditor } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { composeWorkflow, dappReviewContext } from '../engine/strategy-engine';
import { assembleApprovalSurface, claimApproval, fixedWindow, requestApproval, workflowRunStatus, type HandoffPolicy } from '../platform/index.ts';
import { workflowRunUserFundedAuthorize, workflowRunUserFundedPrepare, workflowRunUserFundedReport, workflowRunUserFundedStart } from '../platform/approve.ts';
import { evmCallsOf, type EvmGroupCalls } from '../user-funded/evm-calls.ts';
import { singleStepRunsSupported } from '../workflow-runs/pg-store.ts';
import { workflowRunHarness } from '../workflow-runs/workflow-run.test-harness.ts';
import { editorApprovalScheme, editorClaimPolicy, startEditorRun, type EditorRunConfig } from './approval.ts';
import { bindingOf, runMatchesBinding } from './authorize-binding.ts';
import { reviewEditorExecution } from './workflow-execution.ts';

const CHAIN = 'eip155:42161', CHAINS = [CHAIN];
const USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase(), ROUTER = ARBITRUM_MAINNET_SWAP.router.toLowerCase();
const AMOUNT_IN = 600_000_000_000_000n; // 0.0006 WETH
const SWAP = { version: 1, action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006', slippageBps: 50 };
/** MetaMask on Arbitrum One reporting EIP-5792 atomic batching (as `wallet_getCapabilities` answers it). */
const METAMASK = { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'supported' }, typedData: true } } as const;
const CLOSED: HandoffPolicy = { ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' };
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(t => t.drop())); });

/** A disposable database exactly as the operator release leaves it: shipped migrations, then the certified 0029–0032 fixtures. */
async function schema32(): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false }); opened.push(t);
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 28)!;
  const ahead: Migration[] = await Promise.all(certificate.migrations.filter(m => m.version <= 32).map(async m => {
    const sql = await readFile(new URL(`../../../../packages/cloud-runtime/test/fixtures/${String(m.version).padStart(4, '0')}_${m.name}.sql`, import.meta.url), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(m.sha256);
    return { ...m, sql };
  }));
  expect(ahead.map(m => m.version)).toEqual([29, 30, 31, 32]);
  await migrate(t.db, [...await loadMigrations(), ...ahead]);
  return t;
}
/** ONE card on the Canvas, authored by the same command FloFi's chat produces for it. */
function canvasOf(strategy: unknown): Workflow {
  const composed = composeWorkflow(strategy);
  if (!composed.ok) throw new Error(composed.code);
  const state = editorReducer(initialEditor(), { ...composed.steps[0]!.command, baseRevision: initialEditor().workflow.revision } as Command, dappReviewContext());
  if (state.error) throw new Error(state.error);
  return state.workflow;
}

async function setup(t: TestDatabase, options: { readonly weth?: bigint; readonly rpc?: 'down' } = {}) {
  let clock: () => Date = () => new Date();
  const chain = createEvmDouble(42161, () => Math.floor(clock().getTime() / 1000), { profile: ARBITRUM_MAINNET_SWAP });
  const down = async () => { throw new Error('ECONNRESET'); };
  const h = await workflowRunHarness(t.db, { flows: ['arbitrum-swap'], policyEnv: { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'arbitrum-one' }, userFundedChains: CHAINS,
    userFundedRpc: c => c === CHAIN ? options.rpc === 'down' ? down : chain.rpc : null });
  clock = h.d.now;
  if (!h.policy.ok) throw new Error('policy');
  const owner = h.d.evmOwner.address.toLowerCase();
  chain.control.fundToken(owner, WETH, options.weth ?? 10n ** 18n); chain.control.fundNative(owner, 10n ** 17n);
  // Count every wallet batch the "wallet" executes (the only way anything reaches the chain in this flow).
  let batches = 0;
  const wallet = (calls: Parameters<typeof chain.control.walletBatch>[1]) => { batches += 1; return chain.control.walletBatch(owner, calls); };
  // The Editor's requester: the signed-in FloFi account that holds the owner's wallet, with the Editor's own scheme and policy.
  const accounts = createAccountStore(t.db, h.d.tenantId);
  const session = await accounts.signIn({ kind: 'email', subject: `single-${randomBytes(4).toString('hex')}@flofi.test`, label: null });
  await accounts.saveWallet(session.accountId, { ecosystem: 'evm', address: h.evm.address, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
    providerResource: null, label: 'MetaMask' });
  const config: Extract<EditorRunConfig, { enabled: true }> = { enabled: true, origin: 'http://localhost:3999', key: randomBytes(32), policy: h.policy };
  const runs = { ...h.runs, policyFor: (kind: string) => kind === 'EDITOR_SESSION' ? config.policy : CLOSED };
  const surface = assembleApprovalSurface([{ scheme: editorApprovalScheme(config.key), profiles: { EDITOR_SESSION: { policy: config.policy,
    claimPolicy: editorClaimPolicy(accountId => accounts.walletAddresses(accountId)) } } }], h.handoffs, h.flows.runtime, runs);
  const start = (workflow: unknown, singleStepRun = true) => startEditorRun({ config, origin: config.origin, handoffs: h.handoffs, allow: fixedWindow(t.db, h.d.tenantId).allow,
    runtime: h.flows.runtime, now: h.d.now() }, session.accountId, workflow, { singleStepRun });
  const review = (workflow: unknown, profile: Parameters<typeof reviewEditorExecution>[0]['profile'] = METAMASK, singleStep = true) =>
    reviewEditorExecution({ workflow, owner, profile, facts: h.runs.userFundedFacts!, deps: h.runs.userFunded!, now: h.d.now(), singleStep });
  const wallets = [h.evm, h.sol];
  /** Authorize exactly as the Editor's in-place action does: handoff → claim → user-funded start → prepare group 0. */
  async function authorize(workflow: unknown) {
    const started = await start(workflow);
    if (!started.ok) throw new Error(started.code);
    expect(started.value).toMatchObject({ stepCount: 1, authority: 'NONE' });
    const secret = decodeURIComponent(new URL(started.value.approvalUrl).hash.slice(1));
    await claimApproval(surface, secret, wallets, true, h.d.now());
    const proposal = await workflowRunUserFundedStart(surface, started.value.approvalId, wallets, METAMASK);
    const prepared = await workflowRunUserFundedPrepare(surface, started.value.approvalId, wallets, 0);
    return { approvalId: started.value.approvalId, proposal, prepared };
  }
  const runCount = async () => Number((await t.db.query('SELECT count(*)::int AS n FROM workflow_runs')).rows[0]!.n);
  return { chain, h, owner, surface, start, review, authorize, wallet, wallets, runCount, batches: () => batches };
}
const groupOf = (prepared: { prepared: unknown }) => prepared.prepared as unknown as { group: EvmGroupCalls; request: { atomicRequired: boolean; id: string; calls: unknown[] } };

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: one Uniswap V3 card on Arbitrum One in ONE wallet confirmation (MOCKED chain, PostgreSQL)', { timeout: 120_000 }, () => {
  it('acceptance: insufficient allowance → one Authorize, ONE atomic batch [exact approval, swap], automatic independent reconciliation, nothing resent', async () => {
    const t = await schema32();
    const { chain, h, owner, review, authorize, wallet, wallets, surface, runCount, batches } = await setup(t);
    expect(await singleStepRunsSupported(t.db)).toBe(true);
    const canvas = canvasOf(SWAP);
    expect(canvas.nodes.filter(n => !n.actionType.startsWith('mock-'))).toHaveLength(1);

    // ── Review: read-only, ONE wallet confirmation ──────────────────────────────────────────────────────────────────────────────────
    const reviewed = await review(canvas);
    if (!reviewed.ok) throw new Error(reviewed.code);
    expect(reviewed.value).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', stepCount: 1, refusal: null, reasons: [],
      counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 2, networkSwitches: 0 } });
    expect(reviewed.value.groups).toEqual([expect.objectContaining({ strategy: 'EVM_WALLET_BATCH', steps: [0, 0], signing: 'UPFRONT', interactions: 1, approvals: 1,
      calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }] })]);
    expect(reviewed.value.steps[0]).toMatchObject({ action: 'swap', network: 'Arbitrum One', provider: 'Uniswap V3', spend: { text: '0.0006 WETH' } });
    expect(await runCount()).toBe(0);
    expect(chain.control.sends()).toBe(0);
    // Without the single-step opt-in a single card is refused exactly as before (the Editor's default).
    const refused = await review(canvas, METAMASK, false);
    expect(refused).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' });

    // ── Authorize: ONE handoff (SEQUENTIAL plan of one step), ONE run of one step, one user-funded wallet batch ───────────────────────
    const { approvalId, proposal, prepared } = await authorize(canvas);
    const handoff = (await t.db.query(`SELECT plan->>'kind' AS kind, jsonb_array_length(plan->'steps') AS steps, requester_kind FROM mcp_handoffs WHERE handoff_id = $1`,
      [approvalId])).rows[0]!;
    expect(handoff).toEqual({ kind: 'SEQUENTIAL', steps: 1, requester_kind: 'EDITOR_SESSION' });
    const run = proposal.view.workflowRun!.run;
    expect(run).toMatchObject({ state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 1, nextAction: 'OWNER_SIGNS_GROUP',
      groups: [{ index: 0, strategy: 'EVM_WALLET_BATCH', steps: [0, 0], feePayer: owner }] });
    const binding = bindingOf({ owner, workflowHash: reviewed.value.workflowHash, groups: reviewed.value.groups.map(g => ({ strategy: g.strategy, steps: g.steps })) });
    expect(runMatchesBinding(run, binding!)).toBe(true);
    const p = groupOf(prepared);
    // Exactly the reviewed calls: an EXACT approval of the swap's own input to the registered SwapRouter02 (never unlimited), then the swap
    // paying the owner, with the signed minimum and an on-chain deadline — as ONE atomic request with the group's own stable id.
    expect(p.group.calls.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
    expect(p.group.calls[0]).toEqual({ kind: 'ERC20_APPROVE', token: WETH, spender: ROUTER, amount: AMOUNT_IN.toString() });
    const swap = p.group.calls[1] as Extract<EvmGroupCalls['calls'][number], { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE' }>;
    expect(swap).toMatchObject({ router: ROUTER, tokenIn: WETH, tokenOut: USDC, amountIn: AMOUNT_IN.toString() });
    expect(BigInt(swap.amountOutMinimum)).toBeGreaterThan(0n);
    expect(BigInt(swap.amountOutMinimum)).toBeLessThanOrEqual(BigInt(swap.quotedAmountOut));
    expect(Number(swap.deadline)).toBeGreaterThan(Math.floor(h.d.now().getTime() / 1000));
    expect(p.request).toMatchObject({ atomicRequired: true });
    expect(p.request).not.toHaveProperty('capabilities');
    expect(p.request.calls).toHaveLength(2);
    expect(await runCount()).toBe(1);


    // ── The owner's ONE wallet confirmation: one atomic transaction from the owner's own account ─────────────────────────────────────
    const usdcBefore = chain.control.tokenBalance(USDC, owner), wethBefore = chain.control.tokenBalance(WETH, owner);
    const hash = wallet(evmCallsOf(p.group));
    await workflowRunUserFundedAuthorize(surface, approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
    // ── Automatic reconciliation: only the wallet's read-only report of its batch's transaction; FloFi re-reads everything from the chain ─
    const done = await workflowRunUserFundedReport(surface, approvalId, wallets, 0, [hash]);
    const completed = done.view.workflowRun!.run;
    expect(completed).toMatchObject({ state: 'COMPLETED', mode: 'USER_FUNDED', nextAction: 'NONE', stepCount: 1 });
    expect(completed.steps.map(s => s.state)).toEqual(['RECONCILED']);
    const received = BigInt(chain.control.tokenBalance(USDC, owner) - usdcBefore);
    expect(received).toBeGreaterThanOrEqual(BigInt(swap.amountOutMinimum));
    expect(completed.steps[0]!.outcome!.received).toEqual([{ asset: `${CHAIN}/erc20:${USDC}`, amount: received.toString() }]);
    expect(completed.steps[0]!.outcome!.spent).toEqual([{ asset: `${CHAIN}/erc20:${WETH}`, amount: AMOUNT_IN.toString() }]);
    expect(wethBefore - chain.control.tokenBalance(WETH, owner)).toBe(AMOUNT_IN);
    // The exact approval was consumed by the swap: nothing is left approved to the router.
    expect(chain.control.allowance(WETH, owner, ROUTER)).toBe(0n);
    expect(completed.groups[0]).toMatchObject({ state: 'RECONCILED', gasPaid: { payer: owner }, submissions: [{ hash }] });
    // ONE wallet batch, and FloFi itself never submitted any transaction.
    expect(batches()).toBe(1);
    expect(chain.control.sends()).toBe(0);

    // ── Reload: read back by its id; nothing is prepared or sent again ────────────────────────────────────────────────────────────────
    const reloaded = await workflowRunStatus(surface, approvalId, wallets);
    expect(reloaded.view.workflowRun!.run).toMatchObject({ state: 'COMPLETED', groups: [{ state: 'RECONCILED', submissions: [{ hash }] }] });
    await expect(workflowRunUserFundedPrepare(surface, approvalId, wallets, 0)).rejects.toThrow();
    expect(batches()).toBe(1);
    expect(await runCount()).toBe(1);
  });

  it('existing allowance: no approval call at all (one swap call); a non-zero insufficient allowance is reset to 0, then approved exactly', async () => {
    const t = await schema32();
    const { chain, owner, review, authorize, wallet, wallets, surface } = await setup(t);
    chain.control.setAllowance(WETH, owner, ROUTER, AMOUNT_IN);
    const sufficient = await review(canvasOf(SWAP));
    if (!sufficient.ok) throw new Error(sufficient.code);
    expect(sufficient.value).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', counts: { walletPrompts: 1, batchedCalls: 1 } });
    expect(sufficient.value.groups[0]).toMatchObject({ approvals: 0, calls: [{ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }] });
    const { approvalId, prepared } = await authorize(canvasOf(SWAP));
    const p = groupOf(prepared);
    expect(p.group.calls.map(c => c.kind)).toEqual(['UNISWAP_V3_EXACT_INPUT_SINGLE']);
    const hash = wallet(evmCallsOf(p.group));
    await workflowRunUserFundedAuthorize(surface, approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: p.request.id });
    expect((await workflowRunUserFundedReport(surface, approvalId, wallets, 0, [hash])).view.workflowRun!.run.state).toBe('COMPLETED');

    chain.control.setAllowance(WETH, owner, ROUTER, 1n);
    const partial = await review(canvasOf(SWAP));
    if (!partial.ok) throw new Error(partial.code);
    expect(partial.value).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', counts: { walletPrompts: 1, batchedCalls: 3 } });
    expect(partial.value.groups[0]!.calls!.map(c => c.kind)).toEqual(['ERC20_APPROVE', 'ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
  });

  it('rejection: a declined prompt sends nothing and a retry is the SAME batch (never a second one); a wallet-reported "not sent" stops the run', async () => {
    const t = await schema32();
    const { chain, owner, authorize, wallets, surface, batches } = await setup(t);
    const wethBefore = chain.control.tokenBalance(WETH, owner);
    const { approvalId, prepared } = await authorize(canvasOf(SWAP));
    const first = groupOf(prepared);
    // The owner declines in the wallet (EIP-1193 4001): the page records nothing and the group stays prepared; asking again hands out exactly
    // the same request (same EIP-5792 id, same calls) to this browser only.
    const again = await workflowRunUserFundedPrepare(surface, approvalId, wallets, 0, (prepared as { handout?: string | null }).handout ?? undefined);
    expect(groupOf(again).request).toEqual(first.request);
    await expect(workflowRunUserFundedPrepare(surface, approvalId, wallets, 0)).rejects.toThrow('WALLET_BATCH_HANDED_OUT_ELSEWHERE');
    expect((await workflowRunStatus(surface, approvalId, wallets)).view.workflowRun!.run).toMatchObject({ state: 'RUNNING', groups: [{ state: 'PREPARED' }] });
    // A wallet that answers the batch but then reports it was not sent (EIP-5792 status 400, no receipts): the run stops, nothing executed.
    await workflowRunUserFundedAuthorize(surface, approvalId, wallets, 0, { kind: 'EVM_WALLET_BATCH', batchId: first.request.id });
    const reported = (await workflowRunUserFundedReport(surface, approvalId, wallets, 0, [], true)).view.workflowRun!.run;
    expect(reported).toMatchObject({ state: 'FAILED', groups: [{ state: 'BLOCKED', code: 'EIP5792_BATCH_NOT_SENT' }] });
    expect(reported.steps[0]!.state).toBe('BLOCKED');
    expect(batches()).toBe(0);
    expect(chain.control.sends()).toBe(0);
    expect(chain.control.tokenBalance(WETH, owner)).toBe(wethBefore);
    expect(chain.control.allowance(WETH, owner, ROUTER)).toBe(0n);
  });

  it('insufficient balance and provider failure: refused at Review, before anything is stored or asked of the wallet', async () => {
    const poor = await schema32();
    const short = await setup(poor, { weth: AMOUNT_IN - 1n });
    const refused = await short.review(canvasOf(SWAP));
    expect(refused.ok && refused.value.refusal).toBeTruthy();
    expect(await short.runCount()).toBe(0);
    expect(short.batches()).toBe(0);

    const offline = await schema32();
    const down = await setup(offline, { rpc: 'down' });
    const failed = await down.review(canvasOf(SWAP));
    const code = failed.ok ? failed.value.refusal?.code : failed.code;
    expect(code).toBe('USER_FUNDED_RPC_UNAVAILABLE');
    expect(await down.runCount()).toBe(0);
  });

  it('unsupported wallet capabilities: the Review says the card cannot run as one confirmation (the Editor keeps its own flow); FloFi Wallet too', async () => {
    const t = await schema32();
    const { review } = await setup(t);
    const unsupported = await review(canvasOf(SWAP), { eip155: { wallet: 'INJECTED', atomic: { [CHAIN]: 'unsupported' }, typedData: true } });
    if (!unsupported.ok) throw new Error(unsupported.code);
    expect(unsupported.value).toMatchObject({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'] });
    expect(unsupported.value.groups[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP' });
    const unknown = await review(canvasOf(SWAP), { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } });
    if (!unknown.ok) throw new Error(unknown.code);
    expect(unknown.value).toMatchObject({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNKNOWN'] });
    const flofi = await review(canvasOf(SWAP), { eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true } });
    if (!flofi.ok) throw new Error(flofi.code);
    expect(flofi.value.mode).toBe('STEP_BY_STEP');
    // A native-ETH swap has no batch builder (its own flow sends it as one transaction already): never presented as a batch.
    const native = await review(canvasOf({ ...SWAP, inputAsset: 'ETH' }));
    if (!native.ok) throw new Error(native.code);
    expect(native.value.mode).toBe('STEP_BY_STEP');
  });

  it('uncertain submission: a batch handed to the wallet and never answered is never resent; at the run window it halts with the outcome unknown', async () => {
    const t = await schema32();
    const { h, authorize, wallets, surface, batches } = await setup(t);
    const { approvalId, prepared } = await authorize(canvasOf(SWAP));
    expect(groupOf(prepared).request.id).toMatch(/^0x[0-9a-f]{64}$/);
    // The wallet never answers. Another browser is never handed this group; a new preparation needs this browser's hand-out token and, past the
    // batch's validity, the settle window (two overlapping batches could both execute).
    await expect(workflowRunUserFundedPrepare(surface, approvalId, wallets, 0)).rejects.toThrow('WALLET_BATCH_HANDED_OUT_ELSEWHERE');
    const run = (await workflowRunStatus(surface, approvalId, wallets)).view.workflowRun!.run;
    h.d.advance(Date.parse(run.expiresAt) - h.d.now().getTime() + 1_000);
    await h.drain();
    const halted = (await workflowRunStatus(surface, approvalId, wallets)).view.workflowRun!.run;
    // HALTED (not FAILED, not "not run"): the batch may have executed, so the group says its outcome is unknown and nothing is sent again.
    expect(halted).toMatchObject({ state: 'HALTED', groups: [{ state: 'BLOCKED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] });
    expect(batches()).toBe(0);
  });

  it('dormant gate: without migration 0032 no one-step run is offered (the database refuses it); MCP and channels keep SINGLE_FLOW', async () => {
    const shipped = await createTestDatabase(); opened.push(shipped);
    expect(await singleStepRunsSupported(shipped.db)).toBe(false);
    const { h, start, surface, wallets } = await setup(shipped);
    // Even a forced one-step handoff cannot become a run on such a database: its row is refused by 0015's CHECK at the claim (fail closed).
    const started = await start(canvasOf(SWAP));
    if (!started.ok) throw new Error(started.code);
    await expect(claimApproval(surface, decodeURIComponent(new URL(started.value.approvalUrl).hash.slice(1)), wallets, true, h.d.now())).rejects.toThrow();
    expect(Number((await shipped.db.query('SELECT count(*)::int AS n FROM workflow_runs')).rows[0]!.n)).toBe(0);
    // A tampered ledger row (another SHA-256 under 0032's version) is not 0032.
    const t = await schema32();
    await t.db.query(`UPDATE schema_migrations SET sha256 = repeat('a', 64) WHERE version = 32`);
    expect(await singleStepRunsSupported(t.db)).toBe(false);
    // A channel (or MCP) one-step request keeps its SINGLE_FLOW plan; it can never ask for a one-step run.
    const approval = await h.request(SWAP);
    expect(approval.executionPlan).toBe('SINGLE_FLOW');
    const composed = composeWorkflow(SWAP);
    if (!composed.ok) throw new Error(composed.code);
    expect(await requestApproval(h.deps(), h.requester, composed.strategy, composed.workflowHash, { singleStepRun: true }))
      .toEqual({ ok: false, code: 'APPROVAL_REQUESTER_INVALID' });
  });
});
