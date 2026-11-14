// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): /approve's panel, driven through its own buttons (no DOM:
 * React's hooks are stubbed and recorded, each click handler is taken from the rendered element tree, the consent card is answered through the
 * resolver the panel keeps for it). A FloFi Wallet owner-step group is asked about before its first step loads: ETH covers → the step loads exactly
 * as before; Circle → FloFi's consent card; "Not now" → the server withdraws it and loads the step, nothing signed; agreed → the signatures, then
 * the group's authorization. Every server action and the wallet are in-process doubles; nothing leaves the process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { circleGasPayment, type CircleFacts } from '../user-funded/circle-facts';

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], sets: [] as unknown[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, (next: unknown) => { hooks.sets.push(next); }],
    useRef: (v: unknown) => { const ref = { current: v }; hooks.refs.push(ref); return ref; }, useEffect: () => undefined };
});
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (key: string, ...args: string[]) => key.replace(/\{(\d+)\}/g, (_, i: string) => args[Number(i)] ?? '') }) }));
const server = vi.hoisted(() => ({ prepare: vi.fn(), continue: vi.fn(), decline: vi.fn(), start: vi.fn(), authorize: vi.fn(), permit: vi.fn(), consent: vi.fn(), upgrade: vi.fn() }));
vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_HERE'); };
  return { authorizeWorkflowRunHandoff: never, cancelWorkflowRunHandoff: never, resumeWorkflowRunHandoff: never, reviewWorkflowRunAuthorization: never,
    startWorkflowRunHandoff: never, workflowRunStatusHandoff: never, reportUserFundedBatch: never,
    continueWorkflowRunHandoff: server.continue, prepareUserFundedGroup: server.prepare, declineUserFundedGroupCircle: server.decline, startUserFundedWorkflowRun: server.start,
    authorizeUserFundedGroup: server.authorize, permitUserFundedGroup: server.permit, consentUserFundedGroupUpgrade: server.consent, upgradeUserFundedGroup: server.upgrade };
});
const browser = vi.hoisted(() => ({ kind: 'FLOFI_WALLET' as string | null, sign: vi.fn(), profile: vi.fn() }));
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => browser.kind, batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  isCirclePaid: (p: Record<string, unknown>) => p.kind === 'EVM_USER_OPERATION' && Boolean(p.circle), signCirclePaidGroup: browser.sign, walletProfile: browser.profile,
  sendWalletBatch: vi.fn(), walletBatchHashes: vi.fn(), revokeUserOperation: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), entryPointOfGroup: vi.fn() }));
vi.mock('../wallet/evm-discovery', () => {
  const provider = { request: async ({ method }: { method: string }) => method === 'eth_accounts' ? [OWNER] : null };
  return { chosenEvmProvider: () => provider, injected: () => provider };
});
vi.mock('./delegation-browser', () => ({ signWorkflowGrant: vi.fn() }));
const { WorkflowRunPanel } = await import('./workflow-run-panel');
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';

const APPROVAL = 'apr_' + 'a'.repeat(26), RUN = 'wfr_' + 'a'.repeat(26), OWNER = '0x' + 'ab'.repeat(20), SIGNATURE = '0x' + '5c'.repeat(64) + '1b';
const USDC = C.circlePinsOf(8453)!.usdc;
const facts: CircleFacts = { stage: 'AUTHORIZATION', accountKind: 'SIMPLE_7702_V0_8', entryPoint: erc4337.ENTRY_POINT_V0_8, paymaster: C.CIRCLE_PAYMASTER_V08, usdc: USDC,
  permitCap: '420000', permitNonce: '3', price: { ethUsd: '300000000000', usdcUsd: null, observedAt: '2026-11-13T12:00:00.000Z' }, surchargeBps: '1000', marginBps: '2000',
  nonce: '7', callData: erc4337.simple7702CallData([{ target: USDC, value: 0n, data: '0xa9059cbb' + '00'.repeat(64) }]),
  gas: { verificationGasLimit: '250000', callGasLimit: '200000', preVerificationGas: '150000', maxFeePerGas: '2100000000', maxPriorityFeePerGas: '100000000',
    paymasterVerificationGasLimit: '200000', paymasterPostOpGasLimit: '40000' }, nativeRequired: '1', usdcSpend: '0', plannedStrategy: 'EVM_OWNER_STEP',
  upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId: 8453, nonce: '4' } };
const CIRCLE = { ok: true, value: { groupIndex: 0, strategy: 'EVM_USER_OPERATION', chain: 'eip155:8453', feePayer: OWNER, validUntil: null, handout: null,
  prepared: { kind: 'EVM_USER_OPERATION', chainId: 8453, owner: OWNER, circle: facts, gasPayment: circleGasPayment(facts) } } };
type Run = WorkflowRunClaim['run'];
/** A FloFi Wallet run on Base whose first group (two transfers) is planned as owner steps, its first step READY and not loaded. */
const run = (patch: Partial<Run> = {}): Run => ({ workflowRunId: RUN, approvalId: APPROVAL, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 2, currentStep: 0, code: null,
  workflowHash: '0x' + '1'.repeat(64), expiresAt: '2999-01-01T00:00:00.000Z', completedAt: null, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  stepsVisible: true, nextAction: 'OWNER_SIGNS_STEP', halted: null, resumable: false, authority: 'NONE', note: null,
  steps: [0, 1].map(index => ({ index, action: 'transfer', state: index ? 'PENDING' : 'READY', flow: 'base-mainnet-transfer', stepWorkflowHash: null, code: null, bound: null, outcome: null })),
  groups: [{ index: 0, chain: 'eip155:8453', strategy: 'EVM_OWNER_STEP', signing: 'WHEN_DUE', steps: [0, 1], state: 'PLANNED', awaitsDelivery: null, code: null, validUntil: null,
    feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null, signed: false, planned: null }], ...patch }) as Run;
const claim = (r: Run): WorkflowRunClaim => ({ step: null, stepWallet: null, run: r,
  plan: { stepCount: 2, confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155'] },
    delegatedSingleAuthorization: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED', walletSignatures: 0, passkeyAssertions: 0, enrollments: [], ownerKnown: true },
    userFunded: { available: true, reason: null, groups: [{ index: 0, namespace: 'eip155', chain: 'eip155:8453', steps: [], stepFrom: 0, stepTo: 1, strategy: 'EVM_WALLET_BATCH',
      signing: 'UPFRONT', awaitsDelivery: null, interactions: 1, setup: [], downgrades: [], feePayer: 'OWNER_WALLET' }], interactions: null, feePayer: 'OWNER_WALLET', wallets: 'ASSUMED' },
    recommended: 'USER_FUNDED', steps: [], bindings: [], notes: [] } } as unknown as WorkflowRunClaim);
const proposalOf = (name: string, r: Run = run(), step: { index: number; count: number } | null = null) => ({ name, view: { workflowRun: { ...claim(r), step } } });

/** Renders the panel once and clicks the button whose text starts with `label`; returns what the page was told. */
function click(c: WorkflowRunClaim, label: string) {
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
  return { onProposal, onError };
}
const settled = (r: ReturnType<typeof click>, calls = 1) => vi.waitFor(() => expect(r.onProposal.mock.calls.length + r.onError.mock.calls.length).toBe(calls));
/** The consent card the panel opened (its offer, as set), answered through the resolver the panel keeps for it. */
async function answerCard(agreed: boolean) {
  await vi.waitFor(() => expect(hooks.sets.some(s => s && typeof s === 'object' && 'upgrade' in s)).toBe(true));
  const resolve = hooks.refs.find(r => typeof r.current === 'function')?.current as ((agreed: boolean) => void) | undefined;
  expect(resolve).toBeTypeOf('function');
  resolve!(agreed);
}

beforeEach(() => {
  hooks.refs.length = 0; hooks.sets.length = 0; browser.kind = 'FLOFI_WALLET';
  for (const f of [...Object.values(server), browser.sign, browser.profile]) f.mockReset();
  server.continue.mockResolvedValue({ ok: true, value: proposalOf('step loaded') });
  server.decline.mockResolvedValue({ ok: true, value: proposalOf('declined; step loaded') });
  server.authorize.mockResolvedValue({ ok: true, value: proposalOf('authorized') });
  browser.sign.mockResolvedValue(SIGNATURE);
  browser.profile.mockResolvedValue({ eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true } });
});

describe('owner requirement: "Continue to step 1" for a FloFi Wallet owner-step group on a Circle network', () => {
  it('ETH covers: the server is asked first (FLOFI_WALLET), answers CIRCLE_NOT_NEEDED, and the step loads exactly as before; no card, nothing signed', async () => {
    server.prepare.mockResolvedValue({ ok: false, code: 'CIRCLE_NOT_NEEDED' });
    const r = click(claim(run()), 'Continue to step 1');
    await settled(r);
    expect(server.prepare).toHaveBeenCalledWith(APPROVAL, 0, undefined, 'FLOFI_WALLET');
    expect(server.continue).toHaveBeenCalledWith(APPROVAL);
    expect(r.onProposal).toHaveBeenCalledWith(proposalOf('step loaded'));
    expect(hooks.sets.some(s => s && typeof s === 'object' && 'upgrade' in s)).toBe(false);
    expect(browser.sign).not.toHaveBeenCalled();
  });
  it('another wallet: unchanged — the step loads at once, nothing is prepared', async () => {
    browser.kind = 'INJECTED';
    const r = click(claim(run()), 'Continue to step 1');
    await settled(r);
    expect(server.prepare).not.toHaveBeenCalled();
    expect(server.continue).toHaveBeenCalledWith(APPROVAL);
  });
  it('Circle eligible, "Not now": the card, then the server withdraws it and loads the step; nothing is signed or authorized', async () => {
    server.prepare.mockResolvedValue(CIRCLE);
    const r = click(claim(run()), 'Continue to step 1');
    await answerCard(false);
    await settled(r);
    expect(hooks.sets).toContainEqual({ chainId: 8453, upgrade: true, maxFee: '420000' });
    expect(server.decline).toHaveBeenCalledWith(APPROVAL, 0);
    expect(r.onProposal).toHaveBeenCalledWith(proposalOf('declined; step loaded'));
    expect(hooks.sets).toContain(1);
    expect(browser.sign).not.toHaveBeenCalled();
    expect(server.authorize).not.toHaveBeenCalled();
    expect(server.continue).not.toHaveBeenCalled();
  });
  it('Circle eligible, "Upgrade and continue": the signatures bound to this run (consent given on the card), then the group\'s authorization', async () => {
    server.prepare.mockResolvedValue(CIRCLE);
    const r = click(claim(run()), 'Continue to step 1');
    await answerCard(true);
    await settled(r);
    expect(browser.sign).toHaveBeenCalledTimes(1);
    const [address, prepared, , firstUse, binding] = browser.sign.mock.calls[0]!;
    expect([address, prepared, binding]).toEqual([OWNER, CIRCLE.value.prepared, { runId: RUN }]);
    expect(firstUse).toMatchObject({ runId: RUN });
    expect(await firstUse.consent({ chainId: 8453, delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8 })).toBe(true);
    expect(server.authorize).toHaveBeenCalledWith(APPROVAL, 0, { kind: 'EVM_USER_OPERATION', signature: SIGNATURE });
    expect(server.decline).not.toHaveBeenCalled();
    expect(r.onProposal).toHaveBeenCalledWith(proposalOf('authorized'));
  });
  it('final review (P1): FloFi Wallet refusing a signature it was already asked for is said in its own words, never APPROVAL_UNAVAILABLE', async () => {
    server.prepare.mockResolvedValue(CIRCLE);
    for (const code of ['FLOFI_WALLET_ALREADY_SIGNED', 'FLOFI_WALLET_SIGNATURE_UNKNOWN']) {
      browser.sign.mockRejectedValueOnce(new Error(code));
      const r = click(claim(run()), 'Continue to step 1');
      await answerCard(true);
      await settled(r);
      expect(r.onError).toHaveBeenCalledWith(code);
      hooks.refs.length = 0; hooks.sets.length = 0;
    }
    expect(server.authorize).not.toHaveBeenCalled();
    const { CIRCLE_REFUSAL } = await import('../domain/token-fee');
    expect(CIRCLE_REFUSAL.FLOFI_WALLET_ALREADY_SIGNED).toMatch(/already asked for this signature once.*Nothing was sent.*prepares a new one/);
  });
  it('a transient answer is shown and nothing is loaded (asking again can still find Circle)', async () => {
    server.prepare.mockResolvedValue({ ok: false, code: 'USER_FUNDED_RPC_UNAVAILABLE' });
    const r = click(claim(run()), 'Continue to step 1');
    await settled(r);
    expect(r.onError).toHaveBeenCalledWith('USER_FUNDED_RPC_UNAVAILABLE');
    expect(server.continue).not.toHaveBeenCalled();
  });
});

describe('owner requirement: "Authorize in groups" with FloFi Wallet', () => {
  const choosing = run({ state: 'PENDING', mode: null, nextAction: 'OWNER_CHOOSES_MODE', groups: [] });
  it('the started run is shown, then its first owner-step group is asked about before it loads (ETH covers: loaded as before)', async () => {
    server.start.mockResolvedValue({ ok: true, value: proposalOf('started') });
    server.prepare.mockResolvedValue({ ok: false, code: 'CIRCLE_NOT_NEEDED' });
    const r = click(claim(choosing), 'Authorize in groups');
    await settled(r, 2);
    expect(r.onProposal.mock.calls.map(([p]) => (p as { name: string }).name)).toEqual(['started', 'step loaded']);
    expect(server.prepare).toHaveBeenCalledWith(APPROVAL, 0, undefined, 'FLOFI_WALLET');
  });
  it('a start that already loaded its step (another wallet, a chain without Circle) is shown as is: nothing more is asked', async () => {
    server.start.mockResolvedValue({ ok: true, value: proposalOf('started with its step', run(), { index: 0, count: 2 }) });
    const r = click(claim(choosing), 'Authorize in groups');
    await settled(r);
    expect(server.prepare).not.toHaveBeenCalled();
    expect(server.continue).not.toHaveBeenCalled();
  });
});
