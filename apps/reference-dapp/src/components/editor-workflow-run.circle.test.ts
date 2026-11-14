// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review UX1/UX4 (ADR-0010 §2, §3): the Editor's whole-workflow run of a group whose network fee is paid
 * from the owner's USDC through Circle.
 *
 *   UX1  the USDC cap is recomputed from live gas and ETH/USD prices on every preparation, so the one prepared at Authorize may be above the
 *        reviewed one by any amount: it is shown beside it and confirmed (CIRCLE_FEE_CAP_ROSE_CONFIRM), never refused as a mechanism change and
 *        never applied silently; a real mechanism change (the owner's ETH now covers the fee, or no longer does) keeps
 *        GAS_MECHANISM_CHANGED_REVIEW_REQUIRED, says so, and has a way forward: end the run and review again
 *   UX4  while the wallet is asked, the page says which of the two signatures it shows (the USDC permit and its cap, then the operation)
 *
 * The hook runs under the same minimal in-process hook emulator as the batch tests; every server action and the wallet are doubles (no network,
 * no signature).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { erc4337 } from '@defi-workflow-engine/reference-compiler';

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, effects: [] as (() => unknown)[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const slot = <T>(init: () => T): T => { const k = hooks.at++; if (!(k in hooks.slots)) hooks.slots[k] = init(); return hooks.slots[k] as T; };
  return { ...actual,
    useState: (v: unknown) => { const k = hooks.at; const value = slot(() => typeof v === 'function' ? (v as () => unknown)() : v);
      return [value, (next: unknown) => { hooks.slots[k] = typeof next === 'function' ? (next as (p: unknown) => unknown)(hooks.slots[k]) : next; }]; },
    useRef: (v: unknown) => slot(() => ({ current: v })), useCallback: (f: unknown) => { hooks.at++; return f; },
    useEffect: (f: () => unknown) => { hooks.effects[hooks.at++] = f; } };
});
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn(), prepare: vi.fn(), permit: vi.fn(), authorizeGroup: vi.fn(), cancel: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => ({ enabled: true, code: null }),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: server.prepare, permitUserFundedGroup: server.permit,
  authorizeUserFundedGroup: server.authorizeGroup, reportUserFundedBatch: vi.fn(), cancelWorkflowRunHandoff: server.cancel, resumeWorkflowRunHandoff: vi.fn() }));
const browser = vi.hoisted(() => ({ send: vi.fn(), circle: vi.fn(), seen: [] as unknown[] }));
vi.mock('./user-funded-browser', async () => {
  const { circleFactsOf } = await import('../user-funded/circle-facts');
  return { evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined, sendWalletBatch: browser.send,
    walletBatchHashes: async () => { throw new Error('EIP5792_UNKNOWN_BUNDLE_ID'); }, walletProfile: async () => ({}), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(),
    isCirclePaid: (p: Readonly<Record<string, unknown>>) => p.kind === 'EVM_USER_OPERATION' && circleFactsOf(p) !== null, signCirclePaidGroup: browser.circle };
});
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { useEditorWorkflowRun, EXECUTION_REFUSAL } = await import('./editor-workflow-run');
const { CIRCLE_FEE_CAP_ROSE_CONFIRM } = await import('../domain/token-fee');
const { translate } = await import('../i18n/locale');

const OWNER = '0x' + 'ab'.repeat(20), APPROVAL = 'apr_' + 'd'.repeat(26), SIGNATURE = '0x' + '5c'.repeat(64) + '1b', HASH = '0x' + '1'.repeat(64);
const PAYMASTER = '0x' + '4'.repeat(40), USDC = '0x' + '6'.repeat(40);
const workflow = { workflowId: 'wf-circle', revision: 1, nodes: [{ chainId: 'eip155:8453' }] };
const facts = (permitCap: string, stage: 'PERMIT' | 'OPERATION' = 'PERMIT') => ({ stage, accountKind: 'METAMASK_DELEGATOR_V1_3', entryPoint: erc4337.ENTRY_POINT_V0_7,
  paymaster: PAYMASTER, usdc: USDC, permitCap, permitNonce: '0', price: { ethUsd: '300000000000', usdcUsd: null, observedAt: '2026-11-13T12:00:00.000Z' },
  surchargeBps: '1000', marginBps: '2000', nonce: '0', callData: '0x', gas: {}, nativeRequired: '1', usdcSpend: '0', plannedStrategy: 'EVM_WALLET_BATCH',
  ...stage === 'OPERATION' ? { permitSignature: SIGNATURE } : {} });
const circlePrepared = (permitCap: string, stage: 'PERMIT' | 'OPERATION' = 'PERMIT') => ({ feePayer: OWNER,
  prepared: { kind: 'EVM_USER_OPERATION', chainId: 8453, owner: OWNER, circle: facts(permitCap, stage) } });
const nativePrepared = { feePayer: OWNER, prepared: { kind: 'EVM_WALLET_BATCH', request: { version: '2.0.0', id: '0x' + '12'.repeat(32), chainId: '0x2105', from: OWNER,
  atomicRequired: true, calls: [] } } };
const gasPayment = (permitCap: string) => ({ mechanism: 'CIRCLE_USDC_PAYMASTER', maxFee: { token: USDC, symbol: 'USDC', decimals: 6, amount: permitCap }, signatures: 2,
  paymaster: PAYMASTER, entryPoint: erc4337.ENTRY_POINT_V0_7, permitCap });
/** A Review whose first (only) group's fee is paid from the owner's USDC through Circle, at most `cap` — or native (no `cap`). */
const reviewOf = (cap: string | null) => ({ owner: OWNER, workflowHash: HASH, validUntil: '2999-01-01T00:00:00.000Z', mode: 'GROUPED', refusal: null,
  steps: [{ index: 0 }, { index: 1 }], groups: [{ index: 0, strategy: 'EVM_WALLET_BATCH', steps: [0, 1], chain: 'eip155:8453', ...cap ? { gasPayment: gasPayment(cap) } : {} }] });
const runOf = (strategy: string, extra: Record<string, unknown> = {}) => ({ workflowRunId: 'wfr_' + 'd'.repeat(26), approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED',
  stepCount: 2, currentStep: 0, code: null, workflowHash: HASH, expiresAt: '2999-01-01T00:00:00.000Z', nextAction: 'OWNER_SIGNS_GROUP', steps: [], authority: 'NONE', note: null,
  groups: [{ index: 0, chain: 'eip155:8453', strategy, signing: 'UPFRONT', steps: [0, 1], state: 'PREPARED', batchId: null, signed: false, validUntil: '2999-01-01T00:00:00.000Z',
    feePayer: OWNER, planned: { steps: [{ index: 0 }, { index: 1 }], calls: 2, approvals: 0, healthFactorAfter: null }, ...extra }] });
const proposalOf = (run: unknown) => ({ view: { workflowRun: { run } } });

const render = () => { hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: OWNER, enabled: true }); };
async function authorizeOnce() {
  await render().startReview();
  expect(render().phase).toBe('reviewed');
  await render().authorize();
  return render();
}
/** Authorize starts the run and prepares its first group with `prepared` (the server's fresh preparation, which may differ from the Review). */
function authorizeAnswers(prepared: { feePayer: string; prepared: Record<string, unknown> }) {
  const run = runOf(String(prepared.prepared.kind));
  server.authorize.mockResolvedValue({ ok: true, value: { approvalId: APPROVAL, proposal: proposalOf(run), prepared } });
  server.status.mockResolvedValue({ ok: true, value: proposalOf(run) });
  server.prepare.mockResolvedValue({ ok: true, value: prepared });
}

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; browser.seen.length = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  for (const f of [...Object.values(server), browser.send, browser.circle]) f.mockReset();
  server.review.mockResolvedValue({ ok: true, value: reviewOf('210000') });
  server.permit.mockImplementation(async () => ({ ok: true, value: circlePrepared('210413', 'OPERATION') }));
  server.authorizeGroup.mockResolvedValue({ ok: true, value: proposalOf(runOf('EVM_USER_OPERATION', { state: 'AUTHORIZED', signed: true })) });
  server.cancel.mockResolvedValue({ ok: true, value: proposalOf({ ...runOf('EVM_USER_OPERATION'), state: 'CANCELLED', nextAction: 'NONE' }) });
  // The wallet double: notes what the page says it asks for (the signature stage) at each prompt, then answers the permit step and the operation.
  browser.circle.mockImplementation(async (_address: string, _prepared: unknown, permit: (signature: string) => Promise<{ ok: boolean }>) => {
    browser.seen.push(render().signing);
    const answered = await permit(SIGNATURE);
    if (!answered.ok) throw new Error('CIRCLE_PERMIT_INVALID');
    browser.seen.push(render().signing);
    return SIGNATURE;
  });
});

describe('review UX1: a USDC cap above the reviewed one is confirmed, never refused as a mechanism change', () => {
  it('the cap rose by any amount between Review and Authorize: shown beside the reviewed one (CIRCLE_FEE_CAP_ROSE_CONFIRM), the wallet not asked yet', async () => {
    authorizeAnswers(circlePrepared('210413'));
    const asked = await authorizeOnce();
    expect(asked.error).toBeNull();
    expect(asked.phase).toBe('confirm-update');
    expect(asked.updated).toEqual([{ index: 0, kind: 'fee', reviewed: '0.21 USDC', now: '0.210413 USDC', code: CIRCLE_FEE_CAP_ROSE_CONFIRM }]);
    expect(browser.circle).not.toHaveBeenCalled();
    // Confirmed: the same preparation is handed to the wallet (the permit, then the operation) and the run authorizes the group.
    server.prepare.mockResolvedValue({ ok: true, value: circlePrepared('210413') });
    await asked.confirmUpdate();
    const done = render();
    expect(done.error).toBeNull();
    expect(done.updated).toEqual([]);
    expect(browser.circle).toHaveBeenCalledTimes(1);
    expect(server.authorizeGroup).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_USER_OPERATION', signature: SIGNATURE });
  });
  it('a cap at or below the reviewed one is the owner\'s accepted ceiling: no question, straight to the wallet', async () => {
    for (const cap of ['210000', '199999']) {
      hooks.slots = []; browser.circle.mockClear(); server.authorizeGroup.mockClear();
      authorizeAnswers(circlePrepared(cap));
      const done = await authorizeOnce();
      expect(done.error, cap).toBeNull();
      expect(done.updated, cap).toEqual([]);
      expect(browser.circle, cap).toHaveBeenCalledTimes(1);
      expect(server.authorizeGroup, cap).toHaveBeenCalledTimes(1);
    }
  });
  it('a cap that rose again after the owner confirmed one is shown again (the accepted cap is the confirmed one, never the latest)', async () => {
    authorizeAnswers(circlePrepared('210413'));
    const asked = await authorizeOnce();
    server.prepare.mockResolvedValue({ ok: true, value: circlePrepared('220000') });
    await asked.confirmUpdate();
    const again = render();
    expect(again.phase).toBe('confirm-update');
    expect(again.updated).toEqual([{ index: 0, kind: 'fee', reviewed: '0.210413 USDC', now: '0.22 USDC', code: CIRCLE_FEE_CAP_ROSE_CONFIRM }]);
    expect(browser.circle).not.toHaveBeenCalled();
  });
});

describe('review UX1: a real mechanism change keeps GAS_MECHANISM_CHANGED_REVIEW_REQUIRED, in true words, with a way forward', () => {
  it('reviewed Circle, prepared native (the owner\'s ETH now covers the fee): refused before the wallet is asked', async () => {
    authorizeAnswers(nativePrepared);
    const refused = await authorizeOnce();
    expect(refused.error).toBe('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
    expect(browser.send).not.toHaveBeenCalled();
    expect(browser.circle).not.toHaveBeenCalled();
  });
  it('reviewed native, prepared Circle (the owner\'s ETH no longer covers it): refused, then ended and reviewed again in one action', async () => {
    server.review.mockResolvedValue({ ok: true, value: reviewOf(null) });
    authorizeAnswers(circlePrepared('210000'));
    const refused = await authorizeOnce();
    expect(refused.error).toBe('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
    expect(refused.started).toBe(true);
    expect(browser.circle).not.toHaveBeenCalled();
    // The way forward: the run (nothing of it signed) is ended and the workflow reviewed again, showing how the fee is paid now.
    server.review.mockResolvedValue({ ok: true, value: reviewOf('210000') });
    await refused.endAndReview!();
    const reviewed = render();
    expect(server.cancel).toHaveBeenCalledWith(APPROVAL);
    expect(server.review).toHaveBeenCalledTimes(2);
    expect(reviewed.error).toBeNull();
    expect(reviewed.run).toBeNull();
    expect(reviewed.phase).toBe('reviewed');
    expect(reviewed.review?.groups[0]).toMatchObject({ gasPayment: { permitCap: '210000' } });
    expect(reviewed.started).toBe(false);
  });
  it('a refusal to end (something of the run may still execute) is shown and nothing is reviewed over it', async () => {
    authorizeAnswers(nativePrepared);
    const refused = await authorizeOnce();
    server.cancel.mockResolvedValue({ ok: false, code: 'WORKFLOW_RUN_GROUP_IN_FLIGHT' });
    await refused.endAndReview!();
    expect(render().error).toBe('WORKFLOW_RUN_GROUP_IN_FLIGHT');
    expect(server.review).toHaveBeenCalledTimes(1);
  });
  it('the words say what changed and what to do, never that ETH moved when only the cap rose (EN/PT)', () => {
    const editor = EXECUTION_REFUSAL.GAS_MECHANISM_CHANGED_REVIEW_REQUIRED!;
    expect(editor).toMatch(/your ETH on this network now covers it, or no longer does/);
    expect(editor).toMatch(/End this workflow and review it again/);
    expect(translate('PT', editor)).toMatch(/^A forma de pagar a taxa de rede mudou desde a sua revisão/);
    expect(translate('PT', 'End and review again')).toBe('Encerrar e revisar de novo');
  });
});

describe('review UX4: the page says which Circle signature the wallet shows, advancing with the permit step', () => {
  it('signature 1 (the USDC permit and its cap), then signature 2 (the operation) once FloFi answered with the operation stage; cleared after', async () => {
    authorizeAnswers(circlePrepared('210000'));
    const done = await authorizeOnce();
    expect(browser.seen).toEqual([{ stage: 1, cap: '210000' }, { stage: 2, cap: '210000' }]);
    expect(done.signing).toBeNull();
  });
  it('a request whose permit is already signed starts at signature 2', async () => {
    authorizeAnswers(circlePrepared('210000', 'OPERATION'));
    browser.circle.mockImplementation(async () => { browser.seen.push(render().signing); return SIGNATURE; });
    await authorizeOnce();
    expect(browser.seen).toEqual([{ stage: 2, cap: '210000' }]);
  });
  it('a permit step that does not answer with the operation stage never advances it; a failure clears it', async () => {
    authorizeAnswers(circlePrepared('210000'));
    server.permit.mockResolvedValue({ ok: false, code: 'CIRCLE_PERMIT_INVALID' });
    const failed = await authorizeOnce();
    expect(browser.seen).toEqual([{ stage: 1, cap: '210000' }]);
    expect(failed.error).toBe('CIRCLE_PERMIT_INVALID');
    expect(failed.signing).toBeNull();
  });
});
