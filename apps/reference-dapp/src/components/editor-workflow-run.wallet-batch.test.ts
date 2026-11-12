// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Editor's whole-workflow batch send (B1): the "may have been sent" attempt is kept only when the wallet is asked to send (`onSending`),
 * so a failure before `wallet_sendCalls` (a network switch, the account check, anything else) never blocks the group, while a request whose
 * answer was lost is never sent again. Every send double checks, when it is entered and before it calls `onSending`, that no attempt is
 * stored yet (the timing itself is under test). Another tab of this browser (B4): its record found the moment the wallet would be asked stops
 * this tab's request, and a failure proving this tab sent nothing never deletes it. The hook runs under a minimal in-process hook emulator;
 * every server action and the wallet are doubles (no network).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `effects`: the effects of the last render, by hook position — never run by a render; a test runs them (`poll`), as React would after it. */
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
const server = vi.hoisted(() => ({ review: vi.fn(), authorize: vi.fn(), status: vi.fn(), prepare: vi.fn(), authorizeGroup: vi.fn(), report: vi.fn() }));
vi.mock('../app/editor-workflow-execution-action', () => ({ editorWorkflowExecutionAvailability: async () => ({ enabled: true, code: null }),
  reviewEditorWorkflow: server.review, authorizeEditorWorkflow: server.authorize }));
vi.mock('../app/approve-action', () => ({ workflowRunStatusHandoff: server.status, prepareUserFundedGroup: server.prepare, authorizeUserFundedGroup: server.authorizeGroup,
  reportUserFundedBatch: server.report, cancelWorkflowRunHandoff: vi.fn(), resumeWorkflowRunHandoff: vi.fn() }));
const browser = vi.hoisted(() => ({ send: vi.fn(), hashes: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ sendWalletBatch: browser.send, walletBatchHashes: browser.hashes, walletProfile: async () => ({}),
  signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { useEditorWorkflowRun, EXECUTION_REFUSAL, EXECUTION_REASON, STEP_REFUSAL, reviewOffersStepByStep, BATCH_PREPARATION_VALIDITY_MS } = await import('./editor-workflow-run');
const { translate } = await import('../i18n/locale');

const OWNER = '0x' + 'ab'.repeat(20), APPROVAL = 'apr_' + 'b'.repeat(26), GROUP_ID = '0x' + '12'.repeat(32), ANSWERED = '0x' + '34'.repeat(32), HASH = '0x' + 'ef'.repeat(32);
const STORAGE_KEY = 'flofi.editor-workflow-runs.v2';
const storage = new Map<string, string>();
const workflow = { workflowId: 'wf-1', revision: 1, nodes: [{ chainId: 'eip155:8453' }] };
const runView = { workflowRunId: 'wfr_' + 'b'.repeat(26), approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2, currentStep: 0, code: null,
  nextAction: 'OWNER_SIGNS_GROUP', steps: [], authority: 'NONE', note: null,
  groups: [{ index: 0, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 1], state: 'PREPARED', batchId: GROUP_ID, signed: false,
    validUntil: null, feePayer: OWNER, planned: { steps: [{ index: 0 }, { index: 1 }], calls: 1, approvals: 0, healthFactorAfter: null } }] };
const proposal = { view: { workflowRun: { run: runView } } };
const prepared = { feePayer: OWNER, prepared: { kind: 'EVM_WALLET_BATCH', request: { version: '2.0.0', id: GROUP_ID, chainId: '0x2105', from: OWNER, atomicRequired: true,
  calls: [{ to: '0x' + '56'.repeat(20), value: '0x0', data: '0x095ea7b3' }] } } };
const review = { owner: OWNER, workflowHash: '0x' + '1'.repeat(64), validUntil: '2999-01-01T00:00:00.000Z', mode: 'ONE_WALLET_CONFIRMATION', refusal: null,
  steps: [{ index: 0 }, { index: 1 }], groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 1], chain: 'eip155:8453' }] };

/** One render of the hook (the emulator keeps its state between renders, as React would). */
const render = () => { hooks.at = 0; return useEditorWorkflowRun({ workflow, evmAccount: OWNER, enabled: true }); };
const stored = () => (JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as { approvalId: string; sent?: { group: number; batchId: string; attempt?: boolean } }[])
  .find(s => s.approvalId === APPROVAL) ?? null;
/** Reviews, then authorizes: the first group is handed to the wallet once (the wallet double decides what happens). */
async function authorizeOnce() {
  await render().startReview();
  expect(render().phase).toBe('reviewed');
  await render().authorize();
  return render();
}

/** The attempt each send found stored for the group WHEN IT WAS ENTERED, before calling `onSending`: always none (checked after each test). */
const onEntry: unknown[] = [];
/** How many requests reached the wallet (a send double counts one only after `onSending` returned, as `sendWalletBatch` does). */
let walletSent = 0;
/** The wallet's send double: notes the stored attempt on entry, then `then` decides (call `onSending` or not, answer or throw). */
const sendThen = (then: (onSending?: () => void) => Promise<string>) => async (_request: unknown, onSending?: () => void) => {
  onEntry.push(stored()?.sent ?? null);
  return then(onSending);
};
const asked = (onSending?: () => void) => { onSending?.(); walletSent++; };
/** Another tab of this browser handed group 0 to the wallet (its own record, its own nonce). */
const OTHER_TAB = { group: 0, batchId: GROUP_ID, attempt: true, nonce: 'other-tab' };
const fromOtherTab = (sent: unknown = OTHER_TAB) => storage.set(STORAGE_KEY, JSON.stringify((JSON.parse(storage.get(STORAGE_KEY) ?? '[]') as { approvalId: string }[])
  .map(s => s.approvalId === APPROVAL ? { ...s, sent } : s)));

afterEach(() => { expect(onEntry.filter(m => m !== null), 'an attempt was stored before the wallet was asked to send').toEqual([]); });
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; storage.clear(); onEntry.length = 0; walletSent = 0;
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  for (const f of [...Object.values(server), ...Object.values(browser)]) f.mockReset();
  server.review.mockResolvedValue({ ok: true, value: review });
  server.authorize.mockResolvedValue({ ok: true, value: { approvalId: APPROVAL, proposal, prepared } });
  server.status.mockResolvedValue({ ok: true, value: proposal });
  server.prepare.mockResolvedValue({ ok: true, value: prepared });
  server.authorizeGroup.mockResolvedValue({ ok: true, value: proposal });
  server.report.mockResolvedValue({ ok: true, value: proposal });
  // The wallet knows only the batch it answered with; its receipts are final at once.
  browser.hashes.mockImplementation(async (id: string) => { if (id !== ANSWERED) throw new Error('EIP5792_UNKNOWN_BUNDLE_ID'); return { hashes: [HASH], failed: false }; });
  browser.send.mockImplementation(sendThen(async onSending => { asked(onSending); return ANSWERED; }));
});

describe('Editor batch send: the attempt is kept only once the wallet is asked to send', () => {
  it('a failure before wallet_sendCalls keeps nothing: the group can be authorized again and is sent then', async () => {
    for (const code of ['WALLET_WRONG_NETWORK', 'WALLET_ACCOUNT_MISMATCH']) {
      hooks.slots = []; storage.clear();
      browser.send.mockImplementationOnce(sendThen(async () => { throw new Error(code); }));
      const failed = await authorizeOnce();
      expect(failed.error).toBe(code);
      expect(failed.unrecorded).toBe(false);
      expect(stored()?.sent).toBeUndefined();
      await failed.authorizeDue();
      expect(render().error).toBeNull();
      expect(server.authorizeGroup).toHaveBeenLastCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
      expect(stored()?.sent).toEqual({ group: 0, batchId: ANSWERED, nonce: expect.any(String) });
    }
    expect(browser.send).toHaveBeenCalledTimes(4);
    expect(walletSent).toBe(2);
  });
  it('any other failure before the wallet was asked (onSending never ran) keeps nothing either: a retry sends', async () => {
    browser.send.mockImplementationOnce(sendThen(async () => { throw Object.assign(new Error('provider crashed'), { code: -32603 }); }));
    const failed = await authorizeOnce();
    expect(failed.error).toBe('EDITOR_EXECUTION_FAILED');
    expect(failed.unrecorded).toBe(false);
    expect(stored()?.sent).toBeUndefined();
    await failed.authorizeDue();
    expect(render().error).toBeNull();
    expect(walletSent).toBe(1);
    expect(server.authorizeGroup).toHaveBeenLastCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
  });
  it('a request whose answer was lost after the wallet was asked is never sent again', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { asked(onSending); throw Object.assign(new Error('timeout'), { code: -32603 }); }));
    const lost = await authorizeOnce();
    expect(lost.error).toBe('EDITOR_EXECUTION_FAILED');
    expect(lost.unrecorded).toBe(true);
    expect(stored()?.sent).toEqual({ group: 0, batchId: GROUP_ID, attempt: true, nonce: expect.any(String) });
    await lost.authorizeDue();
    expect(render().error).toBe('WALLET_BATCH_SEND_UNCONFIRMED');
    expect(browser.send).toHaveBeenCalledTimes(1);
  });
  it('a pre-send refusal the wallet returns after being asked (WALLET_BATCH_NOT_SENT) clears this send\'s own attempt', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { asked(onSending); throw new Error('WALLET_BATCH_NOT_SENT'); }));
    const refused = await authorizeOnce();
    expect(refused.error).toBe('WALLET_BATCH_NOT_SENT');
    expect(refused.unrecorded).toBe(false);
    expect(stored()?.sent).toBeUndefined();
  });
});

describe('Editor batch send: another tab of this browser handing the same group to the wallet', () => {
  it('its record, found the moment the wallet would be asked, stops this request: the wallet is never asked', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { fromOtherTab(); asked(onSending); return ANSWERED; }));
    const stopped = await authorizeOnce();
    expect(stopped.error).toBe('WALLET_BATCH_SEND_UNCONFIRMED');
    expect(stopped.unrecorded).toBe(true);
    expect(walletSent).toBe(0);
    expect(server.authorizeGroup).not.toHaveBeenCalled();
    expect(stored()?.sent).toEqual(OTHER_TAB);
  });
  it('a record of the other tab\'s answered batch stops it too (read back from the wallet, never sent again)', async () => {
    const answered = { group: 0, batchId: ANSWERED, nonce: 'other-tab' };
    browser.send.mockImplementationOnce(sendThen(async onSending => { fromOtherTab(answered); asked(onSending); return ANSWERED; }));
    expect((await authorizeOnce()).error).toBe('WALLET_BATCH_SENT_UNRECORDED');
    expect(walletSent).toBe(0);
    expect(stored()?.sent).toEqual(answered);
  });
  it('a failure proving this send sent nothing never deletes the other tab\'s record', async () => {
    for (const code of ['WALLET_ACCOUNT_MISMATCH', 'WALLET_WRONG_NETWORK', 'WALLET_BATCH_NOT_SENT']) {
      hooks.slots = []; storage.clear();
      browser.send.mockImplementationOnce(sendThen(async () => { fromOtherTab(); throw new Error(code); }));
      const failed = await authorizeOnce();
      expect(failed.error).toBe(code);
      expect(stored()?.sent).toEqual(OTHER_TAB);
      // The other tab's batch may be in the wallet: still shown as handed over, so the run is not ended and the group not offered again.
      expect(failed.unrecorded).toBe(true);
    }
    expect(walletSent).toBe(0);
  });
});

describe('review fix U4: the "handed to the wallet" marker is written and read back before the wallet is asked (fail closed)', () => {
  /** A browser whose storage refuses writes (blocked, full or failing): reads still answer. */
  const refusingWrites = (how: 'throw' | 'drop') => vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: () => { if (how === 'throw') throw new DOMException('QuotaExceededError'); } });
  it('storage that cannot keep the marker: WALLET_ATTEMPT_UNRECORDABLE, the wallet is never asked, and nothing blocks a later try', async () => {
    for (const how of ['throw', 'drop'] as const) {
      hooks.slots = []; storage.clear(); walletSent = 0; browser.send.mockClear(); server.authorizeGroup.mockClear();
      refusingWrites(how);
      const refused = await authorizeOnce();
      expect(refused.error, how).toBe('WALLET_ATTEMPT_UNRECORDABLE');
      expect(walletSent, how).toBe(0);
      expect(browser.send, how).toHaveBeenCalledTimes(1);
      expect(server.authorizeGroup, how).not.toHaveBeenCalled();
      // Nothing was sent: the group is not shown as handed over (it may be offered again).
      expect(refused.unrecorded, how).toBe(false);
      // Storage allowed again: the same group is sent once, with its marker (the run's record is rebuilt from this tab's copy).
      vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
      await refused.authorizeDue();
      expect(render().error, how).toBeNull();
      expect(walletSent, how).toBe(1);
      expect(server.authorizeGroup, how).toHaveBeenLastCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
      expect(stored(), how).toMatchObject({ workflowId: 'wf-1', owner: OWNER, sent: { group: 0, batchId: ANSWERED, nonce: expect.any(String) } });
    }
  });
  it('a run whose stored record is gone (e.g. evicted by newer runs) gets it back with the marker before the wallet is asked', async () => {
    let atSend: unknown = 'not asked';
    browser.send.mockImplementationOnce(sendThen(async onSending => {
      storage.set(STORAGE_KEY, '[]');
      onSending?.(); atSend = stored(); walletSent++;
      return ANSWERED;
    }));
    const sent = await authorizeOnce();
    expect(sent.error).toBeNull();
    expect(walletSent).toBe(1);
    expect(atSend).toMatchObject({ workflowId: 'wf-1', approvalId: APPROVAL, owner: OWNER, sent: { group: 0, batchId: GROUP_ID, attempt: true, nonce: expect.any(String) } });
  });
});

describe('review fix U3: a different batch than the one the run recorded is shown as such, never as "not recorded yet"', () => {
  it('the run refuses the batch id (WALLET_BATCH_ANSWER_MISMATCH): that code, never WALLET_BATCH_SENT_UNRECORDED', async () => {
    server.authorizeGroup.mockResolvedValue({ ok: false, code: 'WALLET_BATCH_ANSWER_MISMATCH' });
    expect((await authorizeOnce()).error).toBe('WALLET_BATCH_ANSWER_MISMATCH');
    expect(walletSent).toBe(1);
    // Any other refusal to record it still says the wallet holds a batch the run has not recorded yet.
    hooks.slots = []; storage.clear();
    server.authorizeGroup.mockResolvedValue({ ok: false, code: 'WORKFLOW_RUN_CHANGED' });
    expect((await authorizeOnce()).error).toBe('WALLET_BATCH_SENT_UNRECORDED');
  });
  it('the run refuses the reported transactions as another batch\'s: shown, never dropped silently', async () => {
    server.report.mockResolvedValue({ ok: false, code: 'WALLET_BATCH_ANSWER_MISMATCH' });
    expect((await authorizeOnce()).error).toBe('WALLET_BATCH_ANSWER_MISMATCH');
    expect(server.report).toHaveBeenCalledWith(APPROVAL, 0, [HASH], false);
  });
});

describe('review fix U2: a batch already prepared and still executable is never prepared again (refused before the wallet is asked)', () => {
  it('USER_FUNDED_PREPARED_STILL_VALID: shown as is; the wallet is not asked and no marker is kept', async () => {
    browser.send.mockImplementationOnce(sendThen(async () => { throw new Error('WALLET_WRONG_NETWORK'); }));
    const failed = await authorizeOnce();
    server.prepare.mockResolvedValue({ ok: false, code: 'USER_FUNDED_PREPARED_STILL_VALID' });
    await failed.authorizeDue();
    const refused = render();
    expect(refused.error).toBe('USER_FUNDED_PREPARED_STILL_VALID');
    expect(refused.unrecorded).toBe(false);
    expect(browser.send).toHaveBeenCalledTimes(1);
    expect(walletSent).toBe(0);
    expect(stored()?.sent).toBeUndefined();
  });
});

describe('Editor batch send: /approve handing the same run\'s group to the wallet (its own record, same origin)', () => {
  const APPROVE_ATTEMPTS = 'flofi.approve-batch-attempts.v1', KEY = `${APPROVAL}:0`;
  const fromApprove = (attempts: Record<string, unknown>) => storage.set(APPROVE_ATTEMPTS, JSON.stringify(attempts));
  it('the batch id the wallet answered /approve with is read back and recorded: the wallet is never asked to send', async () => {
    fromApprove({ [KEY]: { at: '2026-11-09T00:00:00.000Z', batchId: ANSWERED, nonce: 'approve' } });
    const recorded = await authorizeOnce();
    expect(recorded.error).toBeNull();
    expect(browser.send).not.toHaveBeenCalled();
    expect(server.authorizeGroup).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
  });
  it('a /approve request the wallet never answered, whose group id the wallet does not know: never sent again from here', async () => {
    const record = { [KEY]: { at: '2026-11-09T00:00:00.000Z', nonce: 'approve' } };
    fromApprove(record);
    const refused = await authorizeOnce();
    expect(refused.error).toBe('WALLET_BATCH_SEND_UNCONFIRMED');
    expect(refused.unrecorded).toBe(true);
    expect(browser.hashes).toHaveBeenCalledWith(GROUP_ID);
    expect(browser.send).not.toHaveBeenCalled();
    expect(server.authorizeGroup).not.toHaveBeenCalled();
    // /approve's record stays exactly as /approve wrote it (only /approve clears it).
    expect(JSON.parse(storage.get(APPROVE_ATTEMPTS)!)).toEqual(record);
  });
  it('a /approve record written the moment the wallet would be asked stops this request: the wallet is never asked', async () => {
    for (const [attempt, code] of [[{ at: '2026-11-09T00:00:00.000Z', nonce: 'approve' }, 'WALLET_BATCH_SEND_UNCONFIRMED'],
      [{ at: '2026-11-09T00:00:00.000Z', batchId: ANSWERED, nonce: 'approve' }, 'WALLET_BATCH_SENT_UNRECORDED']] as const) {
      hooks.slots = []; storage.clear();
      browser.send.mockImplementationOnce(sendThen(async onSending => { fromApprove({ [KEY]: attempt }); asked(onSending); return ANSWERED; }));
      const stopped = await authorizeOnce();
      expect(stopped.error).toBe(code);
      expect(stopped.unrecorded).toBe(true);
    }
    expect(walletSent).toBe(0);
    expect(server.authorizeGroup).not.toHaveBeenCalled();
  });
  it('a failure proving this send sent nothing keeps the group shown as handed over while /approve\'s record exists', async () => {
    browser.send.mockImplementationOnce(sendThen(async () => { fromApprove({ [KEY]: { at: '2026-11-09T00:00:00.000Z', nonce: 'approve' } }); throw new Error('WALLET_WRONG_NETWORK'); }));
    const failed = await authorizeOnce();
    expect(failed.error).toBe('WALLET_WRONG_NETWORK');
    expect(failed.unrecorded).toBe(true);
    expect(walletSent).toBe(0);
  });
  it('another group\'s or another run\'s /approve record never holds this group back', async () => {
    fromApprove({ [`${APPROVAL}:1`]: { at: '2026-11-09T00:00:00.000Z' }, [`apr_${'z'.repeat(26)}:0`]: { at: '2026-11-09T00:00:00.000Z' } });
    const sent = await authorizeOnce();
    expect(sent.error).toBeNull();
    expect(walletSent).toBe(1);
  });
  it('reads /approve\'s own store key', () => {
    const constant = (file: string, name: string) => new RegExp(`const ${name} = '([^']+)';`).exec(readFileSync(new URL(file, import.meta.url), 'utf8'))?.[1];
    expect(constant('./editor-workflow-run.tsx', 'APPROVE_ATTEMPTS_KEY')).toBe(APPROVE_ATTEMPTS);
    expect(constant('./workflow-run-panel.tsx', 'BATCH_ATTEMPTS_KEY')).toBe(APPROVE_ATTEMPTS);
  });
});

describe('Editor batch send: refusals in plain words', () => {
  const CODES = ['WALLET_ACCOUNT_MISMATCH', 'WALLET_WRONG_NETWORK', 'SIMULATION_SWAP_OUTPUT_SHORT', 'TOKEN_METADATA_MISMATCH', 'CONTRACT_CODE_MISSING',
    'USER_FUNDED_DEADLINE_UNAVAILABLE'];
  it('explains the account check, a failed network switch and the chain\'s token refusals (EN and PT)', () => {
    for (const code of CODES) {
      const text = EXECUTION_REFUSAL[code]!;
      expect(text, code).toBeTruthy();
      expect(translate('PT', text), code).not.toBe(text);
    }
    expect(EXECUTION_REFUSAL.WALLET_ACCOUNT_MISMATCH).toMatch(/locked or another account is selected.*select the account this run belongs to.*nothing was sent/);
  });
  /**
   * Review fixes U2-U4: a batch still valid is never prepared again, a second different answer, a browser that cannot keep its marker; round 5:
   * an answer for a group FloFi had already stopped.
   */
  const REVIEW_FIXES = ['USER_FUNDED_PREPARED_STILL_VALID', 'WALLET_BATCH_ANSWER_MISMATCH', 'WALLET_ATTEMPT_UNRECORDABLE', 'WALLET_BATCH_ANSWERED_AFTER_STOP'];
  it('says what each review-fix code means: nothing was asked of the wallet, or it may have run twice (never "nothing was sent")', () => {
    for (const code of REVIEW_FIXES) expect(EXECUTION_REFUSAL[code], code).not.toMatch(/\{\d+\}/);
    // Undated (the run view could not date it, and /approve never can): words that stay true once the request has expired.
    expect(EXECUTION_REFUSAL.USER_FUNDED_PREPARED_STILL_VALID).toBe('FloFi already prepared a request for this step that may still be open in your wallet. Confirm it '
      + 'there, or try again once it has expired (at most 10 minutes after it was prepared); FloFi never prepares a second one that could run alongside it.');
    expect(EXECUTION_REFUSAL.USER_FUNDED_PREPARED_STILL_VALID).not.toMatch(/stays valid|wait until|few more minutes/);
    expect(EXECUTION_REFUSAL.WALLET_ATTEMPT_UNRECORDABLE).toMatch(/did not ask your wallet/);
    expect(EXECUTION_REFUSAL.WALLET_BATCH_ANSWER_MISMATCH).toMatch(/may have run twice/);
    expect(EXECUTION_REFUSAL.WALLET_BATCH_ANSWER_MISMATCH).not.toMatch(/nothing was sent|not asked/i);
  });
  it('round 5: a wallet answer for a step FloFi had already stopped may have executed and could not be recorded — never a nothing-sent code (EN/PT)', () => {
    const text = EXECUTION_REFUSAL.WALLET_BATCH_ANSWERED_AFTER_STOP!;
    expect(text).toBe('Your wallet reported a batch for a step FloFi had already stopped: it may have executed. Check your wallet\'s activity; FloFi could not record it.');
    expect(text).not.toMatch(/nothing was sent|not asked|not sent/i);
    expect(translate('PT', text)).toBe('Sua carteira informou um lote para uma etapa que a FloFi já tinha parado: ele pode ter sido executado. Verifique a atividade da '
      + 'sua carteira; a FloFi não conseguiu registrá-lo.');
    // The Editor's and /approve's "nothing was sent" sets (an answer in them clears the "handed to the wallet" marker) never hold it.
    for (const file of ['./editor-workflow-run.tsx', './workflow-run-panel.tsx']) {
      const set = /const NOTHING_SENT: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(readFileSync(new URL(file, import.meta.url), 'utf8'))?.[1];
      expect(set, file).toBeTruthy();
      expect(set, file).not.toContain('WALLET_BATCH_ANSWERED_AFTER_STOP');
    }
  });
  /** A group preparation's refusals (simulation, Aave risk, fee reading) that both pages show. */
  const PREPARATION = ['BORROW_UNSAFE_HEALTH_FACTOR', 'WITHDRAW_UNSAFE_HEALTH_FACTOR', 'REPAY_PARTIAL_DEBT_REQUIRED', 'SIMULATION_REVERTED', 'SWAP_MINIMUM_NOT_MET',
    'USER_FUNDED_SIMULATION_UNAVAILABLE', 'USER_FUNDED_L1_FEE_UNAVAILABLE'];
  it('/approve shows the same words for the codes both surfaces show (one translation each)', () => {
    const source = readFileSync(new URL('./approval-handoff.tsx', import.meta.url), 'utf8');
    // /approve cannot change the workflow's amounts (the run is bound to its hash): where the Editor says "lower the amount", /approve says what
    // the owner can do there (their position, Try this step again, End). Those codes have their own words, still translated.
    const approveOwn = new Set(['BORROW_UNSAFE_HEALTH_FACTOR', 'WITHDRAW_UNSAFE_HEALTH_FACTOR', 'REPAY_PARTIAL_DEBT_REQUIRED', 'USER_FUNDED_SIMULATION_UNAVAILABLE']);
    for (const code of [...CODES, ...PREPARATION, 'WALLET_BATCH_SEND_UNCONFIRMED', 'WALLET_BATCH_NOT_SENT', ...approveOwn, ...REVIEW_FIXES]) {
      const text = new RegExp(`\\n  ${code}: '((?:[^'\\\\]|\\\\.)*)',`).exec(source)?.[1]?.replace(/\\(.)/g, '$1');
      if (approveOwn.has(code)) {
        expect(text, code).toEqual(expect.stringContaining('nothing was sent'));
        expect(text, code).not.toMatch(/Lower the|Withdraw less/);
      } else expect(text, code).toBe(EXECUTION_REFUSAL[code]);
      expect(translate('PT', text!), code).not.toBe(text);
    }
  });
  it('a refusal that arrives as a bare code never shows a step number or the code itself; only a Review naming its step does', () => {
    for (const code of PREPARATION) expect(EXECUTION_REFUSAL[code], code).not.toMatch(/\{\d+\}/);
    for (const [code, text] of Object.entries(STEP_REFUSAL)) {
      expect(translate('EN', text, '2'), code).toMatch(/step 2/);
      expect(translate('PT', text, '2'), code).toMatch(/etapa 2/);
    }
  });
});

describe('P0 review fixes: a batch refused for good at Review sends the owner step by step', () => {
  it('a missing eth_simulateV1, a token that does not deliver what the pool sends, an unverifiable token or no expiry guard → step by step', () => {
    for (const code of ['USER_FUNDED_SIMULATION_UNAVAILABLE', 'SIMULATION_SWAP_OUTPUT_SHORT', 'TOKEN_METADATA_MISMATCH', 'CONTRACT_CODE_MISSING', 'USER_FUNDED_DEADLINE_UNAVAILABLE'])
      expect(reviewOffersStepByStep({ mode: 'ONE_WALLET_CONFIRMATION', refusal: { code, step: 0 } }), code).toBe(true);
    expect(reviewOffersStepByStep({ mode: 'STEP_BY_STEP', refusal: null })).toBe(true);
  });
  it('a refusal a new Review can change (a quote, the RPC for a moment) keeps the batch path', () => {
    for (const code of ['QUOTE_UNAVAILABLE', 'USER_FUNDED_RPC_UNAVAILABLE', 'SIMULATION_REVERTED'])
      expect(reviewOffersStepByStep({ mode: 'ONE_WALLET_CONFIRMATION', refusal: { code, step: 0 } }), code).toBe(false);
    expect(reviewOffersStepByStep({ mode: 'ONE_WALLET_CONFIRMATION', refusal: null })).toBe(false);
  });
});

describe('P0 review fixes: every reason the group planner gives the Editor has words', () => {
  it('each downgrade the planner can report for a browser-read wallet has EXECUTION_REASON copy (never "Not available for this step")', () => {
    // workflow-runs/execution-groups.ts: the downgrades pushed for a wallet the browser read (WALLET_CAPABILITIES_ASSUMED is for requesters only).
    for (const code of ['USER_FUNDED_CHAIN_DISABLED', 'USER_OPERATION_AAVE_SIGNED_WHEN_DUE', 'USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE', 'USER_OPERATION_BUNDLER_UNAVAILABLE',
      'WALLET_TYPED_DATA_USER_OPERATION_UNSUPPORTED', 'EVM_SMART_ACCOUNT_REQUIRED', 'WALLET_ATOMIC_BATCH_UNSUPPORTED', 'WALLET_ATOMIC_BATCH_UNKNOWN',
      'SOLANA_DURABLE_NONCE_NOT_OFFERED', 'SOLANA_MULTI_SIGN_UNSUPPORTED', 'WORKFLOW_BINDING_RESOLVED_WHEN_DUE', 'SOLANA_GROUP_STEP_DEPENDENT']) {
      expect(EXECUTION_REASON[code], code).toEqual(expect.any(String));
      expect(translate('PT', EXECUTION_REASON[code]!), code).not.toBe(EXECUTION_REASON[code]);
    }
    // Round 5: a Solana step spending an output of an earlier step of its own sign-all group starts a new group, signed when that output landed.
    expect(EXECUTION_REASON.SOLANA_GROUP_STEP_DEPENDENT).toBe('A Solana step that spends what an earlier step of the same batch delivers is signed once that output '
      + 'has landed (one more wallet prompt).');
    // A transfer of a token a batch cannot carry (a Stock Token, a token outside the catalog) runs through its own flow (user-funded/evm-calls.ts).
    expect(EXECUTION_REASON.USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED).toMatch(/transfer of this token.*own review and wallet confirmation/);
    expect(translate('PT', EXECUTION_REASON.USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED!)).not.toBe(EXECUTION_REASON.USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED);
    expect(readFileSync(new URL('../user-funded/evm-calls.ts', import.meta.url), 'utf8')).toContain("'USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED'");
    const planner = readFileSync(new URL('../workflow-runs/execution-groups.ts', import.meta.url), 'utf8');
    for (const code of ['USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE', 'WALLET_TYPED_DATA_USER_OPERATION_UNSUPPORTED']) expect(planner).toContain(`'${code}'`);
    // Every code the planner pushes as a group downgrade, read from its source (a new one cannot ship without words here).
    // (A value a condition compares with, e.g. `evm?.wallet !== 'INJECTED'`, is not a downgrade.)
    const pushed = new Set([...planner.matchAll(/downgrades\.push\(([\s\S]*?)\);/g)]
      .flatMap(m => [...m[1]!.matchAll(/(?<![!=]==\s*)'([A-Z][A-Z0-9_]+)'/g)].map(c => c[1]!)));
    expect(pushed.size).toBeGreaterThanOrEqual(10);
    for (const code of pushed) expect(EXECUTION_REASON[code], `planner downgrade ${code}`).toEqual(expect.any(String));
  });
  it('mirrors the server\'s new-preparation validity (EVM_PREPARED_TTL_MS): a fresh request is offered only while the run outlasts it', () => {
    const ttl = /export const EVM_PREPARED_TTL_MS = (\d+) \* ([\d_]+);/.exec(readFileSync(new URL('../user-funded/groups.ts', import.meta.url), 'utf8'));
    expect(ttl).not.toBeNull();
    expect(BATCH_PREPARATION_VALIDITY_MS).toBe(Number(ttl![1]) * Number(ttl![2]!.replaceAll('_', '')));
  });
});

/** The effects of the last render run once, as React would after it commits; then `ms` of (fake) time pass: the 4-second status poll reads the run. */
async function poll(ms = 4_000) {
  vi.useFakeTimers();
  try {
    const cleanups = hooks.effects.map(effect => effect?.());
    await vi.advanceTimersByTimeAsync(ms);
    // The poll's status answer (a resolved promise) reaches the hook before its effect is cleaned up.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  } finally { vi.useRealTimers(); }
}
/** A status answer whose run shows group 0 with `patch` applied. */
const withGroup = (patch: Record<string, unknown>) => ({ ok: true, value: { view: { workflowRun: { run: { ...runView, groups: [{ ...runView.groups[0], ...patch }] } } } } });

describe('round 5: a wallet answer for a group FloFi had already stopped is shown, never "not recorded yet" or dropped', () => {
  it('its batch id refused WALLET_BATCH_ANSWERED_AFTER_STOP: the owner is told it may have executed, never "FloFi reads it back"', async () => {
    server.authorizeGroup.mockResolvedValue({ ok: false, code: 'WALLET_BATCH_ANSWERED_AFTER_STOP' });
    const answered = await authorizeOnce();
    expect(walletSent).toBe(1);
    expect(server.authorizeGroup).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
    expect(answered.error).toBe('WALLET_BATCH_ANSWERED_AFTER_STOP');
    // The wallet holds the batch: it is never sent again from here.
    expect(stored()?.sent).toEqual({ group: 0, batchId: ANSWERED, nonce: expect.any(String) });
  });
  it('its transactions refused WALLET_BATCH_ANSWERED_AFTER_STOP: shown, never dropped silently', async () => {
    server.report.mockResolvedValue({ ok: false, code: 'WALLET_BATCH_ANSWERED_AFTER_STOP' });
    const reported = await authorizeOnce();
    expect(server.report).toHaveBeenCalledWith(APPROVAL, 0, [HASH], false);
    expect(reported.error).toBe('WALLET_BATCH_ANSWERED_AFTER_STOP');
  });
});

describe('round 5: a USER_FUNDED_PREPARED_STILL_VALID refusal names its group and is retired once that group was answered', () => {
  /** The first request sends nothing (a failed network switch); the group's next preparation is refused: the batch prepared before is still valid. */
  async function refusedStillValid() {
    browser.send.mockImplementationOnce(sendThen(async () => { throw new Error('WALLET_WRONG_NETWORK'); }));
    const first = await authorizeOnce();
    server.prepare.mockResolvedValue({ ok: false, code: 'USER_FUNDED_PREPARED_STILL_VALID' });
    await first.authorizeDue();
    return render();
  }
  it('the refusal carries the group it is about', async () => {
    const refused = await refusedStillValid();
    expect(refused.error).toBe('USER_FUNDED_PREPARED_STILL_VALID');
    expect(refused.refusedGroup).toBe(0);
    expect(walletSent).toBe(0);
  });
  it('a status update showing the group still prepared keeps it; one showing it answered elsewhere (another tab, /approve) retires it', async () => {
    await refusedStillValid();
    await poll();
    expect(server.status).toHaveBeenCalled();
    expect(render().error).toBe('USER_FUNDED_PREPARED_STILL_VALID');
    expect(render().refusedGroup).toBe(0);
    for (const answered of [{ state: 'AUTHORIZED', signed: true }, { state: 'BLOCKED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }]) {
      hooks.slots = []; hooks.effects = []; storage.clear(); server.prepare.mockReset(); server.status.mockResolvedValue({ ok: true, value: proposal });
      await refusedStillValid();
      server.status.mockResolvedValue(withGroup(answered));
      await poll();
      const after = render();
      expect(after.error, answered.state).toBeNull();
      expect(after.refusedGroup, answered.state).toBeNull();
    }
  });
  it('a later action\'s error replaces the refusal and its group; a status update never retires that error', async () => {
    await refusedStillValid();
    server.prepare.mockResolvedValue({ ok: false, code: 'SIMULATION_REVERTED' });
    await render().authorizeDue();
    expect(render().error).toBe('SIMULATION_REVERTED');
    expect(render().refusedGroup).toBeNull();
    server.status.mockResolvedValue(withGroup({ state: 'AUTHORIZED', signed: true }));
    await poll();
    expect(render().error).toBe('SIMULATION_REVERTED');
  });
});
