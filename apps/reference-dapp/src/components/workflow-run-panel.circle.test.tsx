// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review UX8 (ADR-0010 §3): on `/approve`, a Circle-paid operation the owner signed and FloFi never
 * relayed is cancelled with an ordinary transaction from the owner's wallet, paid in ETH — the very coin that wallet lacked when Circle was
 * chosen. The page says so before the wallet is asked (EN/PT). Rendering calls no server action and no wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeWorkflowRunHandoff: never, cancelWorkflowRunHandoff: never, continueWorkflowRunHandoff: never, resumeWorkflowRunHandoff: never,
    reviewWorkflowRunAuthorization: never, startWorkflowRunHandoff: never, workflowRunStatusHandoff: never };
});
const { WorkflowRunPanel } = await import('./workflow-run-panel');
const { LocaleProvider } = await import('../i18n/locale');
import type { WorkflowRunClaim } from '../platform/workflow-run-approvals';
import type { Language } from '../i18n/locale';

const OWNER = '0x' + 'ab'.repeat(20);
type Group = NonNullable<WorkflowRunClaim['run']['groups']>[number];
const signedOperation = (patch: Partial<Group> = {}): Group => ({ index: 0, chain: 'eip155:8453', strategy: 'EVM_USER_OPERATION', signing: 'UPFRONT', steps: [0, 1],
  state: 'AUTHORIZED', awaitsDelivery: null, code: null, validUntil: null, feePayer: OWNER, maxFee: null, gasPaid: null, submissions: [], batchId: null, signed: true,
  planned: null, ...patch });
const circle = { mechanism: 'CIRCLE_USDC_PAYMASTER' as const, stage: 'OPERATION' as const, signatures: 2 as const, paymaster: '0x' + '4'.repeat(40),
  entryPoint: '0x' + '5'.repeat(40), permitCap: '210000', token: '0x' + '6'.repeat(40), symbol: 'USDC', decimals: 6 };
const claim = (group: Group): WorkflowRunClaim => ({ step: null, stepWallet: null,
  run: { workflowRunId: 'wfr_' + 'f'.repeat(26), approvalId: 'apr_' + 'f'.repeat(26), state: 'CANCELLED', mode: 'USER_FUNDED', stepCount: 2, currentStep: 0, code: null,
    workflowHash: '0x' + '1'.repeat(64), expiresAt: '2999-01-01T00:00:00.000Z', completedAt: null, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
    stepsVisible: true, steps: [], nextAction: 'NONE', groups: [group], halted: null, resumable: false, authority: 'NONE', note: null } as WorkflowRunClaim['run'],
  plan: { stepCount: 2, confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155'] },
    delegatedSingleAuthorization: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED', walletSignatures: 1, passkeyAssertions: 0, enrollments: [], ownerKnown: true },
    userFunded: { available: true, reason: null, groups: [], interactions: null, feePayer: 'OWNER_WALLET', wallets: 'REPORTED' }, recommended: 'USER_FUNDED', steps: [],
    bindings: [], notes: ['Your own wallet pays every network fee; FloFi never pays, advances or reimburses gas.'] } });
const render = (c: WorkflowRunClaim, language: Language = 'EN') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}>
  <WorkflowRunPanel claim={c} approvalId={c.run.approvalId} secret={null} onProposal={vi.fn()} onError={vi.fn()}/></LocaleProvider>);

describe('review UX8: cancelling an unrelayed Circle-paid operation needs ETH, said before the wallet is asked', () => {
  it('names the coin and the network beside the cancel button, which points to it (EN/PT)', () => {
    const html = render(claim(signedOperation({ gasPayment: circle })));
    expect(html).toContain('Cancel the signed operation for Steps 1–2 in my wallet');
    expect(html).toContain('<p role="note" id="revoke-fee-0">Cancelling is an ordinary transaction from your wallet, and its network fee is paid in ETH, not in USDC through Circle: you need a small amount of ETH on Base first.</p>');
    expect(html).toContain('aria-describedby="revoke-note-0 revoke-fee-0"');
    expect(render(claim(signedOperation({ gasPayment: circle })), 'PT')).toContain('você precisa de um pouco de ETH em Base antes.');
  });
  it('an owner-paid operation keeps its own note (its account paid in ETH already)', () => {
    const html = render(claim(signedOperation()));
    expect(html).toContain('Cancel the signed operation for Steps 1–2 in my wallet');
    expect(html).not.toContain('revoke-fee-0');
    expect(html).toContain('aria-describedby="revoke-note-0"');
  });
});

describe('review B1/LQ1: /approve names a later step that needs the native coin, before anything is signed', () => {
  const nativeLater = [{ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', network: 'Solana', symbol: 'SOL' as const, after: 0, steps: [{ index: 1, action: 'add_liquidity' }] }];
  const pending = (patch: Partial<WorkflowRunClaim['run']> = {}): WorkflowRunClaim => {
    const c = claim(signedOperation());
    return { ...c, run: { ...c.run, state: 'PENDING', mode: null, nextAction: 'OWNER_CHOOSES_MODE', groups: [], ...patch }, plan: { ...c.plan, nativeLater } };
  };
  it('while choosing how to authorize (EN/PT), whatever the mode', () => {
    expect(render(pending())).toContain('A later step on Solana needs SOL for its network fee: step 2 (Add liquidity). Add SOL before starting, or the run will stop there.');
    expect(render(pending(), 'PT')).toContain('Uma etapa posterior em Solana precisa de SOL para a taxa de rede: etapa 2 (Adicionar liquidez).');
  });
  it('not once something was signed or reconciled, and not for a plan without it', () => {
    expect(render(pending({ state: 'RUNNING', mode: 'USER_FUNDED', nextAction: 'OWNER_SIGNS_GROUP', groups: [signedOperation()] }))).not.toContain('A later step on Solana');
    expect(render(claim(signedOperation({ gasPayment: circle })))).not.toContain('A later step on');
  });
});
