// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The /approve panel's owner-funded EIP-5792 batch path, driven through the panel's own buttons (no DOM: React's hooks are stubbed and each
 * click handler is taken from the rendered element tree). Every server action and the wallet are in-process doubles; nothing leaves the process.
 *
 *   B1  the "may have been sent" attempt marker is written only when the wallet is asked to send (`onSending`), so a failure before that
 *       request never makes the group unsendable; a request whose answer was lost is never sent again. Every send double checks, when it is
 *       entered and before it calls `onSending`, that no marker is stored yet (the timing itself is under test)
 *   B2  the wallet's capabilities are read for its selected account (the send-time account check is the safety guarantee)
 *   B3  a batch the wallet already holds is recorded BEFORE the group is prepared again (a refused re-preparation never hides it), and a lost
 *       answer for a group whose (fixed) batch id the wallet does not know is refused without preparing again
 *   B4  another tab of this browser: its attempt found the moment the wallet would be asked stops this tab's request, and a failure that proves
 *       this tab sent nothing never deletes it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => undefined],
    useRef: (v: unknown) => ({ current: v }), useEffect: () => undefined };
});
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (key: string, ...args: string[]) => key.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)] ?? '') }) }));
const server = vi.hoisted(() => ({ prepare: vi.fn(), authorize: vi.fn(), report: vi.fn(), start: vi.fn() }));
vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_HERE'); };
  return { authorizeWorkflowRunHandoff: never, cancelWorkflowRunHandoff: never, continueWorkflowRunHandoff: never, resumeWorkflowRunHandoff: never,
    reviewWorkflowRunAuthorization: never, startWorkflowRunHandoff: never, workflowRunStatusHandoff: never,
    prepareUserFundedGroup: server.prepare, authorizeUserFundedGroup: server.authorize, reportUserFundedBatch: server.report, startUserFundedWorkflowRun: server.start };
});
const browser = vi.hoisted(() => ({ send: vi.fn(), hashes: vi.fn(), profile: vi.fn(), accounts: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ sendWalletBatch: browser.send, walletBatchHashes: browser.hashes, walletProfile: browser.profile,
  revokeUserOperation: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn() }));
vi.mock('../wallet/evm-discovery', () => {
  const provider = { request: async ({ method }: { method: string }) => method === 'eth_accounts' ? browser.accounts() : null };
  return { chosenEvmProvider: () => provider, injected: () => provider };
});
vi.mock('./delegation-browser', () => ({ signWorkflowGrant: vi.fn() }));
const { WorkflowRunPanel } = await import('./workflow-run-panel');
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';

const APPROVAL = 'apr_' + 'a'.repeat(26), OWNER = '0x' + 'aB'.repeat(20), GROUP_ID = '0x' + '12'.repeat(32), ANSWERED = '0x' + '34'.repeat(32);
const HASH = '0x' + 'ef'.repeat(32), ATTEMPTS = 'flofi.approve-batch-attempts.v1', KEY = `${APPROVAL}:0`;
const PROPOSAL = { reported: true };
type Group = WorkflowRunClaim['run']['groups'][number];
const group = (patch: Partial<Group> = {}): Group => ({ index: 0, chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', steps: [0, 1], state: 'PREPARED',
  awaitsDelivery: null, code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: GROUP_ID, signed: false, planned: null, ...patch });
function claim(run: Partial<WorkflowRunClaim['run']>): WorkflowRunClaim {
  const step = (index: number) => ({ index, action: 'swap', state: 'PENDING', flow: 'base-swap', stepWorkflowHash: null, code: null, bound: null, outcome: null });
  return { step: null, stepWallet: null,
    run: { workflowRunId: 'wfr_' + 'a'.repeat(26), approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2, currentStep: 0, code: null,
      workflowHash: '0x' + '1'.repeat(64), expiresAt: '2026-11-10T00:00:00.000Z', completedAt: null, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      stepsVisible: true, steps: [step(0), step(1)], nextAction: 'OWNER_SIGNS_GROUP', groups: [group()], authority: 'NONE', note: null, ...run },
    plan: { stepCount: 2, confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155'] },
      delegatedSingleAuthorization: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED', walletSignatures: 0, passkeyAssertions: 0, enrollments: [], ownerKnown: true },
      userFunded: { available: true, reason: null, groups: [{ index: 0, namespace: 'eip155', chain: 'eip155:8453', steps: [], stepFrom: 0, stepTo: 1, strategy: 'EVM_WALLET_BATCH',
        signing: 'UPFRONT', awaitsDelivery: null, interactions: 1, setup: [], downgrades: [], feePayer: 'OWNER_WALLET' }], interactions: null, feePayer: 'OWNER_WALLET', wallets: 'REPORTED' },
      recommended: 'USER_FUNDED', steps: [], bindings: [], notes: [] } } as unknown as WorkflowRunClaim;
}

/** Renders the panel once and clicks the button whose text starts with `label`; resolves once the action reported to the page. */
async function click(c: WorkflowRunClaim, label: string) {
  const onProposal = vi.fn(), onError = vi.fn();
  const tree = WorkflowRunPanel({ claim: c, approvalId: APPROVAL, secret: null, onProposal, onError }) as ReactElement;
  const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : '';
  const buttons: { label: string; onClick: () => void }[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const props = (node as ReactElement<{ children?: ReactNode; onClick?: () => void }>).props;
    if ((node as ReactElement).type === 'button' && props.onClick) buttons.push({ label: text(props.children), onClick: props.onClick });
    walk(props.children);
  };
  walk(tree);
  const button = buttons.find(b => b.label.startsWith(label));
  if (!button) throw new Error(`no button "${label}" among ${JSON.stringify(buttons.map(b => b.label))}`);
  button.onClick();
  await vi.waitFor(() => expect(onProposal.mock.calls.length + onError.mock.calls.length).toBe(1));
  return { proposal: onProposal.mock.calls[0]?.[0] ?? null, error: onError.mock.calls[0]?.[0] ?? null };
}
const attempts = () => JSON.parse(storage.get(ATTEMPTS) ?? '{}') as Record<string, { at: string; batchId?: string; nonce?: string }>;
const storage = new Map<string, string>();
const PREPARED = { ok: true, value: { feePayer: OWNER, prepared: { kind: 'EVM_WALLET_BATCH', request: { version: '2.0.0', id: GROUP_ID, chainId: '0x2105', from: OWNER,
  atomicRequired: true, calls: [{ to: '0x' + '56'.repeat(20), value: '0x0', data: '0x095ea7b3' }] } } } };
const AUTHORIZE = 'Authorize Steps 1–2 now';
/** The attempt each send found stored for the group WHEN IT WAS ENTERED, before calling `onSending`: always none (checked after each test). */
const onEntry: unknown[] = [];
/** How many requests reached the wallet (a send double counts one only after `onSending` returned, as `sendWalletBatch` does). */
let walletSent = 0;
/** The wallet's send double: notes the stored attempt on entry, then `then` decides (call `onSending` or not, answer or throw). */
const sendThen = (then: (onSending?: () => void) => Promise<string>) => async (_request: unknown, onSending?: () => void) => {
  onEntry.push(attempts()[KEY] ?? null);
  return then(onSending);
};
const asked = (onSending?: () => void) => { onSending?.(); walletSent++; };
/** Another tab of this browser handed the group to the wallet (its own attempt, its own nonce). */
const OTHER_TAB = { at: '2026-11-09T00:00:01.000Z', nonce: 'other-tab' };
const fromOtherTab = () => storage.set(ATTEMPTS, JSON.stringify({ [KEY]: OTHER_TAB }));

afterEach(() => { expect(onEntry.filter(m => m !== null), 'an attempt was stored before the wallet was asked to send').toEqual([]); });
beforeEach(() => {
  onEntry.length = 0; walletSent = 0;
  storage.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  for (const f of [...Object.values(server), ...Object.values(browser)]) f.mockReset();
  server.prepare.mockResolvedValue(PREPARED);
  server.authorize.mockResolvedValue({ ok: true, value: { authorized: true } });
  server.report.mockResolvedValue({ ok: true, value: PROPOSAL });
  server.start.mockResolvedValue({ ok: true, value: PROPOSAL });
  // The wallet knows only the batch it answered with; its receipts are final at once.
  browser.hashes.mockImplementation(async (id: string) => { if (id !== ANSWERED) throw new Error('EIP5792_UNKNOWN_BUNDLE_ID'); return { hashes: [HASH], failed: false }; });
  browser.send.mockImplementation(sendThen(async onSending => { asked(onSending); return ANSWERED; }));
  browser.profile.mockResolvedValue({});
  browser.accounts.mockResolvedValue(['0x' + '99'.repeat(20)]);
});

describe('B3: a batch the wallet already holds is recorded before the group is prepared again', () => {
  it('the batch id the wallet answered with (kept by this browser) is recorded as is; nothing is prepared or sent', async () => {
    storage.set(ATTEMPTS, JSON.stringify({ [KEY]: { at: '2026-11-09T00:00:00.000Z', batchId: ANSWERED } }));
    server.prepare.mockResolvedValue({ ok: false, code: 'SIMULATION_REVERTED' });
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(server.prepare).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
    expect(server.report).toHaveBeenCalledWith(APPROVAL, 0, [HASH]);
    expect(attempts()).toEqual({});
  });
  it('the group\'s own batch id the run shows is recorded when the wallet knows it, even though preparing again would be refused', async () => {
    browser.hashes.mockResolvedValue({ hashes: [HASH], failed: false });
    server.prepare.mockResolvedValue({ ok: false, code: 'SIMULATION_REVERTED' });
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(browser.hashes).toHaveBeenCalledWith(GROUP_ID);
    expect(server.prepare).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: GROUP_ID });
  });
  it('a batch id the wallet does not know: the group is prepared, then sent once and recorded', async () => {
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(server.prepare.mock.invocationCallOrder[0]).toBeGreaterThan(browser.hashes.mock.invocationCallOrder[0]!);
    expect(browser.send).toHaveBeenCalledTimes(1);
    expect(walletSent).toBe(1);
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
    expect(attempts()).toEqual({});
  });
  it('a group the run shows no batch id for (not prepared yet) is prepared first', async () => {
    expect(await click(claim({ groups: [group({ state: 'PLANNED', batchId: null })] }), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(server.prepare).toHaveBeenCalledTimes(1);
    expect(browser.send).toHaveBeenCalledTimes(1);
  });
  it('a lost answer (attempt without a batch id) for a group whose batch id the wallet does not know is refused WITHOUT preparing again', async () => {
    // The id is fixed per run and group: a fresh preparation could not change the answer, only fail (here: the sent batch made it revert).
    storage.set(ATTEMPTS, JSON.stringify({ [KEY]: OTHER_TAB }));
    server.prepare.mockResolvedValue({ ok: false, code: 'SIMULATION_REVERTED' });
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'WALLET_BATCH_SEND_UNCONFIRMED' });
    expect(browser.hashes).toHaveBeenCalledWith(GROUP_ID);
    expect(server.prepare).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
    expect(server.authorize).not.toHaveBeenCalled();
    expect(attempts()).toEqual({ [KEY]: OTHER_TAB });
  });
  it('a lost answer for a group the run shows no batch id for: prepared, its id asked of the wallet, and refused unless the wallet knows it', async () => {
    const planned = claim({ groups: [group({ state: 'PLANNED', batchId: null })] });
    storage.set(ATTEMPTS, JSON.stringify({ [KEY]: OTHER_TAB }));
    expect(await click(planned, AUTHORIZE)).toEqual({ proposal: null, error: 'WALLET_BATCH_SEND_UNCONFIRMED' });
    expect(server.prepare).toHaveBeenCalledTimes(1);
    expect(browser.hashes).toHaveBeenCalledWith(GROUP_ID);
    expect(browser.send).not.toHaveBeenCalled();
    // The wallet knows the prepared id after all: its batch is recorded, never sent again.
    browser.hashes.mockResolvedValue({ hashes: [HASH], failed: false });
    expect(await click(planned, AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: GROUP_ID });
    expect(browser.send).not.toHaveBeenCalled();
  });
});

describe('B1: the attempt marker is written only when the wallet is asked to send', () => {
  it('a failure before wallet_sendCalls (network switch, account check) leaves no marker: the owner can simply try again', async () => {
    for (const code of ['WALLET_WRONG_NETWORK', 'WALLET_ACCOUNT_MISMATCH', 'WALLET_REQUEST_REJECTED']) {
      browser.send.mockImplementationOnce(sendThen(async () => { throw new Error(code); }));
      expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: code });
      expect(attempts()).toEqual({});
    }
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(browser.send).toHaveBeenCalledTimes(4);
    expect(walletSent).toBe(1);
  });
  it('any other failure before the wallet was asked (onSending never ran) leaves no marker either: a retry sends', async () => {
    browser.send.mockImplementationOnce(sendThen(async () => { throw Object.assign(new Error('provider crashed'), { code: -32603 }); }));
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'APPROVAL_UNAVAILABLE' });
    expect(attempts()).toEqual({});
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: PROPOSAL, error: null });
    expect(walletSent).toBe(1);
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_WALLET_BATCH', batchId: ANSWERED });
  });
  it('a request whose answer was lost after the wallet was asked is never sent again, nor prepared again', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { asked(onSending); throw Object.assign(new Error('timeout'), { code: -32603 }); }));
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'APPROVAL_UNAVAILABLE' });
    expect(attempts()[KEY]).toEqual({ at: expect.any(String), nonce: expect.any(String) });
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'WALLET_BATCH_SEND_UNCONFIRMED' });
    expect(browser.send).toHaveBeenCalledTimes(1);
    expect(server.prepare).toHaveBeenCalledTimes(1);
  });
  it('a pre-send refusal the wallet returns after being asked (WALLET_BATCH_NOT_SENT) clears this call\'s own marker', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { asked(onSending); throw new Error('WALLET_BATCH_NOT_SENT'); }));
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'WALLET_BATCH_NOT_SENT' });
    expect(attempts()).toEqual({});
  });
});

describe('B4: another tab of this browser handing the same group to the wallet', () => {
  it('its attempt, found the moment the wallet would be asked, stops this request: the wallet is never asked', async () => {
    browser.send.mockImplementationOnce(sendThen(async onSending => { fromOtherTab(); asked(onSending); return ANSWERED; }));
    expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: 'WALLET_BATCH_SEND_UNCONFIRMED' });
    expect(walletSent).toBe(0);
    expect(server.authorize).not.toHaveBeenCalled();
    expect(attempts()).toEqual({ [KEY]: OTHER_TAB });
  });
  it('a failure proving this call sent nothing never deletes the other tab\'s attempt', async () => {
    for (const code of ['WALLET_ACCOUNT_MISMATCH', 'WALLET_WRONG_NETWORK', 'WALLET_BATCH_NOT_SENT']) {
      storage.clear();
      browser.send.mockImplementationOnce(sendThen(async () => { fromOtherTab(); throw new Error(code); }));
      expect(await click(claim({}), AUTHORIZE)).toEqual({ proposal: null, error: code });
      expect(attempts()).toEqual({ [KEY]: OTHER_TAB });
    }
    expect(walletSent).toBe(0);
  });
});

describe('B2: capabilities are read for the wallet\'s selected account', () => {
  // What the server sends while the owner chooses the mode: no groups yet and no step loaded (so no step wallet).
  const choosing = { state: 'PENDING', mode: null, nextAction: 'OWNER_CHOOSES_MODE' as const, groups: [] };
  it('eth_accounts[0], lower-cased (the batch send checks it is the run\'s account before the wallet is asked)', async () => {
    browser.accounts.mockResolvedValue([OWNER, '0x' + '99'.repeat(20)]);
    expect(await click(claim(choosing), 'Authorize in groups')).toEqual({ proposal: PROPOSAL, error: null });
    expect(browser.profile).toHaveBeenCalledWith(OWNER.toLowerCase(), ['eip155:8453'], false);
    expect(server.start).toHaveBeenCalledWith(APPROVAL, {});
  });
});
