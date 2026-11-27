// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02, surfaces 9.2 items 9 and 14): the Editor's in-place run of a lone Solana Batch Payment card
 * (Simulate → Review → Execute) with the owner's Solana wallet (Phantom or Solflare):
 *   - Review asks the server for exactly this owner (base58, verbatim) and the chosen Solana wallet's profile; without a Solana mainnet wallet the
 *     action stays open (SOLANA_WALLET_REQUIRED is transient), never a dead end;
 *   - Authorize asks the Solana sign-in once when the server requires it (never the EVM one), and only the reviewed wallet continues;
 *   - the prepared group is ONE transaction whose legs are exactly the reviewed recipients and amounts; it is signed once (`signSolanaGroup`) and
 *     authorized as SOLANA_SIGN_ALL; anything else is never handed to the wallet; a rejection says nothing was sent;
 *   - C.4's earlier request that can still land is transient (try again), never a Review refusal;
 *   - every other workflow keeps today's path: a Solana workflow without a batch is step by step, an EVM workflow is reviewed exactly as before.
 * The hook runs under a minimal in-process hook emulator; every server action and the wallet are doubles (no network, nothing signed).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn(), prepare: vi.fn(), authorizeGroup: vi.fn(), report: vi.fn(), refusal: vi.fn(), resume: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => ({ enabled: true, code: null }),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: server.prepare, authorizeUserFundedGroup: server.authorizeGroup,
  reportUserFundedBatch: server.report, reportUserFundedRefusal: server.refusal, cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: server.resume }));
const browser = vi.hoisted(() => ({ send: vi.fn(), hashes: vi.fn(), profile: vi.fn(), signSolana: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => null, batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  sendWalletBatch: browser.send, walletBatchHashes: browser.hashes, walletProfile: browser.profile, signSolanaGroup: browser.signSolana, signUserOperation: vi.fn(),
  isCirclePaid: () => false, signCirclePaidGroup: vi.fn() }));
const proof = vi.hoisted(() => ({ hook: vi.fn(), proveEvm: vi.fn(), proveSolana: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: proof.hook }));
const { useEditorWorkflowRun, batchPaymentRunBlocked, executedRunOwner, solanaBatchWorkflow, workflowRunErrorText, EXECUTION_REFUSAL } = await import('./editor-workflow-run');
const { translate } = await import('../i18n/locale');

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
// Seed-derived, on-curve keys (A and its valid case variant A' are two different wallets).
const OWNER = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', OTHER = '2CErLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb';
const RECIPIENTS = ['C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG', 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH'];
const AMOUNTS = ['10000000', '20000000', '30000000'];
const APPROVAL = 'apr_' + 'c'.repeat(26), HASH = '0x' + '2'.repeat(64), STORAGE_KEY = 'flofi.editor-workflow-runs.v2';
const PHANTOM = { solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };
const UNSIGNED = 'AQID', SIGNED = 'BAUG';
const storage = new Map<string, string>();
/** The lone Solana Batch Payment card (the server re-validates the canonical workflow; here only its shape matters). */
const workflow = { workflowId: 'wf-sol', revision: 1, nodes: [{ actionType: 'asset.transfer.batch', chainId: SOLANA }] };
const sol = (units: string) => ({ asset: `${SOLANA}/token:So11111111111111111111111111111111111111112`, units, decimals: 9, symbol: 'SOL', text: `${Number(units) / 1e9} SOL` });
const review = { owner: OWNER, workflowHash: HASH, validUntil: '2999-01-01T00:00:00.000Z', reviewedAt: '2026-11-27T12:00:00.000Z', mode: 'ONE_WALLET_CONFIRMATION', refusal: null,
  stepCount: 3, reasons: [], counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] },
  steps: RECIPIENTS.map((recipient, index) => ({ index, action: 'transfer', network: 'Solana', chain: SOLANA, provider: null, spend: sol(AMOUNTS[index]!), basis: 'EXACT',
    boundTo: null, expected: null, minimum: null, recipient })),
  groups: [{ index: 0, chain: SOLANA, network: 'Solana', strategy: 'SOLANA_SIGN_ALL', steps: [0, 2], signing: 'UPFRONT', interactions: 1, setup: [], downgrades: [], calls: null,
    approvals: null, fee: null, healthFactorAfter: null, solanaBatch: { atomic: true, asset: { symbol: 'SOL', decimals: 9 }, total: '60000000', estimatedFeeLamports: '5000',
      accountCreationLamports: '0', maximumAccountCreationLamports: '0', maximumNetworkCostLamports: '5000', requiredLamports: '60895880', transactionBytes: 367 } }] };
const runView = { workflowRunId: 'wfr_' + 'c'.repeat(26), approvalId: APPROVAL, workflowHash: HASH, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 3, currentStep: 0, code: null,
  nextAction: 'OWNER_SIGNS_GROUP', steps: [], authority: 'NONE', note: null, expiresAt: '2999-01-01T00:00:00.000Z',
  groups: [{ index: 0, chain: SOLANA, strategy: 'SOLANA_SIGN_ALL', signing: 'UPFRONT', steps: [0, 2], state: 'PREPARED', batchId: null, signed: false,
    validUntil: '2999-01-01T00:00:00.000Z', feePayer: OWNER, planned: null, solanaBatch: review.groups[0]!.solanaBatch }] };
const proposal = { view: { workflowRun: { run: runView } } };
const legs = (patch: (leg: { stepIndex: number; recipient: string; amount: string }) => object = leg => leg) =>
  RECIPIENTS.map((recipient, i) => patch({ stepIndex: i, recipient, amount: AMOUNTS[i]! }));
const preparedWith = (txs: unknown[], feePayer = OWNER) => ({ feePayer, prepared: { kind: 'SOLANA_SIGN_ALL', owner: feePayer, atomic: true, transactions: txs } });
const prepared = preparedWith([{ kind: 'BATCH_PAYMENT', stepIndex: 0, unsignedTransaction: UNSIGNED, legs: legs() }]);

let solanaAccount: string | null = OWNER;
/** One render of the hook (the emulator keeps its state between renders, as React would). */
const render = (input: Partial<Parameters<typeof useEditorWorkflowRun>[0]> = {}) => {
  hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: null, solanaAccount, enabled: true, ...input });
};
/** The effects of the last render run once (the availability answer, the stored-run lookup), as React would after it commits. */
async function settle(input: Partial<Parameters<typeof useEditorWorkflowRun>[0]> = {}) {
  render(input);
  const cleanups = hooks.effects.map(effect => effect?.());
  for (let i = 0; i < 10; i++) await Promise.resolve();
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  return render(input);
}
const stored = () => (JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as { approvalId: string; owner: string }[]).find(s => s.approvalId === APPROVAL) ?? null;
async function authorizeOnce() {
  await render().startReview();
  expect(render().phase).toBe('reviewed');
  await render().authorize();
  return render();
}

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; storage.clear(); solanaAccount = OWNER;
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  for (const f of [...Object.values(server), ...Object.values(browser), proof.proveEvm, proof.proveSolana]) f.mockReset();
  proof.hook.mockReset().mockImplementation(() => ({ proveEvm: proof.proveEvm, proveSolana: proof.proveSolana }));
  server.review.mockResolvedValue({ ok: true, value: review });
  server.authorize.mockResolvedValue({ ok: true, value: { approvalId: APPROVAL, proposal, prepared } });
  server.status.mockResolvedValue({ ok: true, value: proposal });
  server.prepare.mockResolvedValue({ ok: true, value: prepared });
  server.authorizeGroup.mockResolvedValue({ ok: true, value: { view: { workflowRun: { run: { ...runView, groups: [{ ...runView.groups[0], state: 'AUTHORIZED', signed: true }] } } } } });
  browser.profile.mockImplementation(async (evm: string | null, chains: readonly string[], withSolana: boolean) => evm === null && withSolana && chains.length === 1 && chains[0] === SOLANA
    ? PHANTOM : { unexpected: [evm, chains, withSolana] });
  browser.signSolana.mockResolvedValue([SIGNED]);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('KAN-20: the Editor reviews a lone Solana Batch Payment with the owner\'s Solana wallet', () => {
  it('Review: exactly this owner (base58, verbatim) and the chosen Solana wallet\'s profile; one Solana sign-in hook on Solana mainnet', async () => {
    const state = await settle();
    expect(state).toMatchObject({ canReview: true, stepByStep: false, namespace: 'solana' });
    expect(proof.hook).toHaveBeenCalledWith('solana', 'solana:mainnet');
    await state.startReview();
    expect(server.review).toHaveBeenCalledExactlyOnceWith(workflow, OWNER, PHANTOM);
    expect(browser.profile).toHaveBeenCalledWith(null, [SOLANA], true);
    expect(render()).toMatchObject({ phase: 'reviewed', grouped: true, error: null });
    expect(batchPaymentRunBlocked(render())).toBeNull();
  });
  it('without a Solana mainnet wallet: SOLANA_WALLET_REQUIRED, the action stays open (transient), nothing asked of the server', async () => {
    solanaAccount = null;
    const state = await settle();
    await state.startReview();
    const after = render();
    expect(after.error).toBe('SOLANA_WALLET_REQUIRED');
    expect(server.review).not.toHaveBeenCalled();
    expect(after).toMatchObject({ canReview: true, stepByStep: false });
    expect(batchPaymentRunBlocked(after)).toBeNull();
    expect(workflowRunErrorText('SOLANA_WALLET_REQUIRED')).toBe('Connect your Solana wallet (Phantom or Solflare) on Solana mainnet to review this workflow.');
  });
});

describe('KAN-20: Authorize hands ONE transaction of exactly the reviewed legs to the Solana wallet', () => {
  it('signs once with signSolanaGroup(feePayer, [tx]) and authorizes SOLANA_SIGN_ALL; the stored run keeps the owner in its exact case', async () => {
    const state = await authorizeOnce();
    expect(server.authorize).toHaveBeenCalledExactlyOnceWith(workflow, PHANTOM, { owner: OWNER, workflowHash: HASH,
      groups: [{ strategy: 'SOLANA_SIGN_ALL', steps: [0, 2] }], firstGroupGas: 'NATIVE_WALLET_GAS' });
    expect(browser.signSolana).toHaveBeenCalledExactlyOnceWith(OWNER, [UNSIGNED]);
    expect(server.authorizeGroup).toHaveBeenCalledExactlyOnceWith(APPROVAL, 0, { kind: 'SOLANA_SIGN_ALL', transactions: [SIGNED] });
    expect(state).toMatchObject({ phase: 'running', error: null, started: true });
    expect(stored()).toMatchObject({ approvalId: APPROVAL, owner: OWNER, workflowHash: HASH });
    expect(proof.proveEvm).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
  });
  it('the server asks for the Solana sign-in: proveSolana once, then the same Authorize; proveEvm never', async () => {
    server.authorize.mockResolvedValueOnce({ ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' });
    proof.proveSolana.mockResolvedValue({ account: OWNER, error: null, wallet: null });
    const state = await authorizeOnce();
    expect(proof.proveSolana).toHaveBeenCalledOnce();
    expect(proof.proveEvm).not.toHaveBeenCalled();
    expect(server.authorize).toHaveBeenCalledTimes(2);
    expect(browser.signSolana).toHaveBeenCalledOnce();
    expect(state.error).toBeNull();
  });
  it('a sign-in by another Solana wallet (even a case variant of the owner) runs nothing: SOLANA_WALLET_SESSION_REQUIRED', async () => {
    server.authorize.mockResolvedValueOnce({ ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' });
    proof.proveSolana.mockResolvedValue({ account: OTHER, error: null, wallet: null });
    const state = await authorizeOnce();
    expect(state.error).toBe('SOLANA_WALLET_SESSION_REQUIRED');
    expect(server.authorize).toHaveBeenCalledOnce();
    expect(browser.signSolana).not.toHaveBeenCalled();
  });
  it('the wallet rejects (4001): WALLET_REQUEST_REJECTED, nothing authorized or sent', async () => {
    browser.signSolana.mockRejectedValue(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    const state = await authorizeOnce();
    expect(state.error).toBe('WALLET_REQUEST_REJECTED');
    expect(server.authorizeGroup).not.toHaveBeenCalled();
    expect(translate('EN', workflowRunErrorText('WALLET_REQUEST_REJECTED'))).toMatch(/Nothing was sent/);
  });
  it('anything but exactly the reviewed legs, or more than one transaction, is never handed to the wallet', async () => {
    const cases: [unknown, string][] = [
      [preparedWith([{ kind: 'BATCH_PAYMENT', unsignedTransaction: UNSIGNED, legs: legs(l => ({ ...l, recipient: l.stepIndex === 1 ? OTHER : l.recipient })) }]), 'EDITOR_EXECUTION_PLAN_CHANGED'],
      [preparedWith([{ kind: 'BATCH_PAYMENT', unsignedTransaction: UNSIGNED, legs: legs(l => ({ ...l, amount: l.stepIndex === 2 ? '29999999' : l.amount })) }]), 'EDITOR_EXECUTION_PLAN_CHANGED'],
      [preparedWith([{ kind: 'BATCH_PAYMENT', unsignedTransaction: UNSIGNED, legs: legs().slice(0, 2) }]), 'EDITOR_EXECUTION_PLAN_UNVERIFIED'],
      [preparedWith([{ kind: 'BATCH_PAYMENT', unsignedTransaction: UNSIGNED, legs: [...legs()].reverse() }]), 'EDITOR_EXECUTION_PLAN_UNVERIFIED'],
      [preparedWith(legs().map(l => ({ kind: 'TRANSFER', unsignedTransaction: UNSIGNED, legs: [l] }))), 'EDITOR_EXECUTION_PLAN_UNVERIFIED'],
      [preparedWith([{ kind: 'BATCH_PAYMENT', unsignedTransaction: UNSIGNED, legs: legs() }], OTHER), 'SOLANA_WALLET_SESSION_REQUIRED'],
      [{ feePayer: OWNER, prepared: { kind: 'EVM_WALLET_BATCH', request: {} } }, 'EDITOR_EXECUTION_PLAN_UNVERIFIED'],
    ];
    for (const [shape, code] of cases) {
      hooks.slots = []; storage.clear();
      server.authorize.mockResolvedValueOnce({ ok: true, value: { approvalId: APPROVAL, proposal, prepared: shape } });
      expect((await authorizeOnce()).error, code).toBe(code);
    }
    expect(browser.signSolana).not.toHaveBeenCalled();
    expect(server.authorizeGroup).not.toHaveBeenCalled();
  });
  it('after a reload (no Review in this tab) every recipient is shown and confirmed before the wallet is asked', async () => {
    storage.set(STORAGE_KEY, JSON.stringify([{ workflowId: workflow.workflowId, approvalId: APPROVAL, workflowHash: HASH, owner: OWNER, revision: 1, at: '2026-11-27T12:00:00.000Z' }]));
    const state = await settle();
    expect(state.run?.approvalId).toBe(APPROVAL);
    await state.authorizeDue();
    const asking = render();
    expect(asking.phase).toBe('confirm-update');
    expect(asking.updated).toEqual(RECIPIENTS.map((recipient, index) => ({ index, kind: 'recipient', reviewed: null, now: recipient })));
    expect(browser.signSolana).not.toHaveBeenCalled();
    await asking.confirmUpdate();
    expect(browser.signSolana).toHaveBeenCalledExactlyOnceWith(OWNER, [UNSIGNED]);
    expect(server.authorizeGroup).toHaveBeenCalledExactlyOnceWith(APPROVAL, 0, { kind: 'SOLANA_SIGN_ALL', transactions: [SIGNED] });
  });
});

describe('KAN-20 C.4: an earlier request that can still land is transient, never a Review refusal', () => {
  it('a due group refused SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE: said in its words, nothing signed; the run is still offered; the path stays open', async () => {
    const state = await authorizeOnce();
    expect(browser.signSolana).toHaveBeenCalledOnce();
    server.prepare.mockResolvedValueOnce({ ok: false, code: 'SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE' });
    await state.authorizeDue();
    const after = render();
    expect(after.error).toBe('SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE');
    expect(browser.signSolana).toHaveBeenCalledOnce();
    expect(workflowRunErrorText('SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE')).toMatch(/^Nothing was sent\. The request FloFi prepared earlier for this Batch Payment can still land on Solana/);
    // Before any run: a Review that failed this way keeps the action open and never sends the owner step by step.
    const fresh = { started: false, available: true, canReview: true, availability: { known: true, code: null }, review: null, held: false,
      error: 'SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE' };
    expect(batchPaymentRunBlocked(fresh)).toBeNull();
    expect(EXECUTION_REFUSAL.BATCH_PAYMENT_EARLIER_REQUEST_LANDED).toMatch(/landed on Solana outside FloFi, so FloFi will not ask your wallet again/);
    for (const code of ['SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE', 'BATCH_PAYMENT_EARLIER_REQUEST_LANDED', 'SOLANA_WALLET_PROOF_REQUIRED', 'EDITOR_WORKFLOW_SOLANA_BATCH_ONLY'])
      expect(translate('PT', EXECUTION_REFUSAL[code]!), code).not.toBe(EXECUTION_REFUSAL[code]);
    // Any other Solana Batch Payment refusal names its code, never "could not complete".
    expect(workflowRunErrorText('SOLANA_BATCH_PAYMENT_SOMETHING_NEW')).toBe('FloFi could not prepare this Solana Batch Payment ({0}). Nothing was signed or sent.');
  });
});

describe('KAN-20: every other workflow keeps today\'s path', () => {
  it('a Solana workflow without a Batch Payment: never reviewed here, step by step as before', async () => {
    const send = { workflowId: 'wf-send', revision: 1, nodes: [{ actionType: 'asset.transfer', chainId: SOLANA }] };
    const state = await settle({ workflow: send });
    expect(state).toMatchObject({ canReview: false, stepByStep: true });
    expect(state).not.toHaveProperty('namespace');
    expect(proof.hook).toHaveBeenCalledWith('eip155', undefined);
    expect(solanaBatchWorkflow(send)).toBe(false);
  });
  it('an EVM workflow: the EVM sign-in hook and the EVM review exactly as before', async () => {
    const evm = { workflowId: 'wf-evm', revision: 1, nodes: [{ actionType: 'asset.transfer.batch', chainId: 'eip155:8453' }] };
    const EVM = '0x' + 'ab'.repeat(20);
    server.review.mockResolvedValue({ ok: true, value: { ...review, owner: EVM } });
    browser.profile.mockResolvedValue({ eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } });
    const state = await settle({ workflow: evm, evmAccount: EVM });
    expect(proof.hook).toHaveBeenCalledWith('eip155', undefined);
    expect(proof.hook).not.toHaveBeenCalledWith('solana', expect.anything());
    expect(state).toMatchObject({ canReview: true, stepByStep: false });
    await state.startReview();
    expect(server.review).toHaveBeenCalledExactlyOnceWith(evm, EVM, { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } });
    expect(browser.profile).toHaveBeenCalledWith(EVM, ['eip155:8453'], false);
    expect(solanaBatchWorkflow(evm)).toBe(false);
  });
  it('the in-place Solana scope: every financial node a Batch Payment on Solana mainnet (mock nodes ignored)', () => {
    expect(solanaBatchWorkflow(workflow)).toBe(true);
    expect(solanaBatchWorkflow({ nodes: [{ actionType: 'mock-start', chainId: 'eip155:1' }, ...workflow.nodes] })).toBe(true);
    expect(solanaBatchWorkflow({ nodes: [...workflow.nodes, { actionType: 'asset.transfer', chainId: SOLANA }] })).toBe(false);
    expect(solanaBatchWorkflow({ nodes: [{ actionType: 'asset.transfer.batch', chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }] })).toBe(false);
    expect(solanaBatchWorkflow({ nodes: [] })).toBe(false);
    expect(solanaBatchWorkflow(null)).toBe(false);
  });
});

// Surfaces 9.2 item 14 (the shell's wiring, read from its source: the shell is not rendered here) and design 2.4's owner fix.
describe('KAN-20: the Editor shell runs a lone Solana Batch Payment only through the whole-workflow path', () => {
  const shell = readFileSync(new URL('./app-shell.tsx', import.meta.url), 'utf8');
  it('hands the hook the Solana wallet connected on Solana mainnet, and offers no per-card network switch for a lone Solana batch', () => {
    expect(shell).toContain("solanaAccount: solanaSession?.chain === 'solana:mainnet' ? solanaSession.account.address : null");
    expect(shell).toMatch(/const loneSolanaBatch = !sequence && solanaBatchWorkflow\(state\.workflow\);\s+const networkAction = !loneSolanaBatch && signer &&/);
  });
  it('records the executed run\'s owner with executedRunOwner: an EVM fee payer lower-cased, a base58 one exactly as it is', () => {
    expect(shell).toContain('owner: executedRunOwner(groupedSingleRun.groups[0]?.feePayer)');
    expect(shell).not.toContain('feePayer?.toLowerCase()');
    expect(executedRunOwner(OWNER)).toBe(OWNER);
    expect(executedRunOwner(OTHER)).toBe(OTHER);
    expect(executedRunOwner('0x' + 'AB'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
    expect(executedRunOwner(null)).toBeNull();
  });
});
