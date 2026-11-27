// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): the Editor's whole-workflow panel for a lone Solana Batch Payment (EN/PT), rendered from a given
 * hook state — the Review says ONE Solana signing request for one atomic transaction, the network fee and the token-account deposits at most in SOL, each
 * recipient in full (base58, as written); an underfunded owner sees the shortfall in SOL with the deposits and Solana's minimum balance; a refusal of the
 * core is said in its own words. Rendering calls no server action and no wallet (every one is a double that refuses to be called).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../app/editor-workflow-execution-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeEditorWorkflow: never, editorWorkflowExecutionAvailability: never, reviewEditorWorkflow: never };
});
vi.mock('../app/approve-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizeUserFundedGroup: never, cancelWorkflowRunHandoff: never, prepareUserFundedGroup: never, reportUserFundedBatch: never, resumeWorkflowRunHandoff: never,
    workflowRunStatusHandoff: never };
});
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => null, batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined,
  sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn(), proveSolana: vi.fn() }) }));
const { EditorWorkflowRunPanel } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { EditorExecutionReview } from '../editor/workflow-execution';
import type { Language } from '../i18n/locale';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', OWNER = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', FUTURE = '2999-01-01T00:00:00.000Z';
const RECIPIENTS = ['C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG', 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH'];
const usdc = (units: string) => ({ asset: `${SOLANA}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, units, decimals: 6, symbol: 'USDC', text: `${Number(units) / 1e6} USDC` });
const batch = { atomic: true as const, asset: { symbol: 'USDC', decimals: 6 }, total: '6000000', estimatedFeeLamports: '5000', accountCreationLamports: '2039280',
  maximumAccountCreationLamports: '6117840', maximumNetworkCostLamports: '6122840', requiredLamports: '7013720', transactionBytes: 621 };
const review = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => ({ workflowHash: '0x' + '2'.repeat(64), stepCount: 3, owner: OWNER,
  reviewedAt: '2026-11-27T12:00:00.000Z', validUntil: FUTURE, mode: 'ONE_WALLET_CONFIRMATION', reasons: [], refusal: null,
  groups: [{ index: 0, chain: SOLANA, network: 'Solana', strategy: 'SOLANA_SIGN_ALL', steps: [0, 2], signing: 'UPFRONT', interactions: 1, setup: [], downgrades: [], calls: null,
    approvals: null, fee: null, healthFactorAfter: null, solanaBatch: batch }],
  steps: RECIPIENTS.map((recipient, index) => ({ index, action: 'transfer', network: 'Solana', chain: SOLANA, provider: null, spend: usdc(String((index + 1) * 1_000_000)),
    basis: 'EXACT' as const, boundTo: null, expected: null, minimum: null, recipient })),
  counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] }, ...patch });
const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'reviewed', review: review(), error: null, run: null, updated: [],
  started: false, grouped: true, unrecorded: false, visible: true, stepByStep: false, unloaded: false, canReview: true, namespace: 'solana',
  resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(), end: vi.fn(), dismiss: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN', stage: 'simulate' | 'execute' = 'execute') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s} stage={stage}/></LocaleProvider>);

describe('KAN-20: the Editor panel of a lone Solana Batch Payment', () => {
  it('the Review: one atomic Solana transaction, the fee and the deposits at most in SOL, every recipient in full; no token permission', () => {
    const html = render(state({}));
    expect(html).toContain('One Solana signing request for one atomic transaction');
    expect(html).toContain('about 0.000005 SOL in network fees, plus up to 0.00611784 SOL in deposits for recipients who need a token account; your wallet pays both in SOL');
    // The Review block's fee ceiling (fee + deposits at most), with its deposits note beside it.
    expect(html).toContain('0.00612284 SOL');
    expect(html).toContain('Includes up to <span class="numeric">0.00611784 SOL</span> in deposits for recipients who need a token account.');
    for (const recipient of RECIPIENTS) expect(html).toContain(recipient);
    expect(html).toContain('No new token permission');
    expect(html).not.toContain('One Solana signing request for every transaction');
    expect(html).not.toContain('ETH');
    // The same Review on Simulate shows the same fee ceiling and its note.
    expect(render(state({}), 'EN', 'simulate')).toContain('in deposits for recipients who need a token account.');
  });
  it('no recipient needs a token account: the network fee alone; a recipient that is the owner is marked as such (exact base58 match only)', () => {
    const noDeposits = { ...batch, accountCreationLamports: '0', maximumAccountCreationLamports: '0', maximumNetworkCostLamports: '5000' };
    const own = review({ groups: [{ ...review().groups[0]!, solanaBatch: noDeposits }], steps: review().steps.map((s, i) => i === 0 ? { ...s, recipient: OWNER } : s) });
    const html = render(state({ review: own }));
    expect(html).toContain('about 0.000005 SOL in network fees; your wallet pays it in SOL');
    expect(html).not.toContain('in deposits for recipients');
    expect(html).toContain(`${OWNER} (your wallet)`);
    const variant = review({ steps: review().steps.map((s, i) => i === 0 ? { ...s, recipient: OWNER.toLowerCase() } : s) });
    expect(render(state({ review: variant }))).not.toContain('(your wallet)');
  });
  it('an underfunded owner: "Not enough SOL on Solana", the shortfall in SOL with the deposits and Solana\'s minimum balance, nothing sent', () => {
    const evidence = { kind: 'NATIVE_FEE_SHORTFALL' as const, chainId: SOLANA, owner: OWNER, unit: 'lamports' as const, balance: '1000000', maxFee: '6122840', nativeSpend: '0',
      required: '7013720', shortfall: '6013720', deposits: '6117840', reserve: '890880' };
    const refused = review({ validUntil: null, refusal: { code: 'SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL', step: 0, evidence },
      groups: [{ ...review().groups[0]!, solanaBatch: undefined as never }] });
    const html = render(state({ review: refused, grouped: false }));
    expect(html).toContain('Not enough SOL on Solana for the network fee');
    // The fee row already includes the deposits (its own row says so), so the rows add up: fee + minimum balance - balance = missing.
    for (const [label, value] of [['You have', '0.001 SOL'], ['The fee can reach', '0.00612284 SOL'], ['Includes token-account deposits, at most', '0.00611784 SOL'],
      ['Kept as Solana&#x27;s minimum balance', '0.00089088 SOL'], ['Missing, at least', '0.00601372 SOL']] as const) expect(html).toContain(`${label}</dt><dd class="numeric">${value}</dd>`);
    expect(html).not.toContain('<dt>Token-account deposits, at most</dt>');
    expect(html).not.toContain('This request also sends');
    const pt = render(state({ review: refused, grouped: false }), 'PT');
    expect(pt).toContain('Inclui depósitos de contas de token, no máximo');
    expect(pt).toContain('Mantido como saldo mínimo da Solana');
  });
  it('the core\'s refusals and the earlier request say what happened, in English and Portuguese', () => {
    const tooLarge = render(state({ review: review({ validUntil: null, refusal: { code: 'SOLANA_BATCH_PAYMENT_TRANSACTION_TOO_LARGE', step: null } }), grouped: false }));
    expect(tooLarge).toContain('This Batch Payment does not fit in one Solana transaction, so FloFi does not split it. Nothing was signed or sent. Pay fewer recipients.');
    const unknown = render(state({ review: review({ validUntil: null, refusal: { code: 'SOLANA_BATCH_PAYMENT_SOMETHING_NEW', step: null } }), grouped: false }));
    expect(unknown).toContain('FloFi could not prepare this Solana Batch Payment (SOLANA_BATCH_PAYMENT_SOMETHING_NEW). Nothing was signed or sent.');
    const live = render(state({ review: review(), error: 'SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE' }), 'PT');
    expect(live).toContain('Nada foi enviado. O pedido que a FloFi preparou antes para este pagamento em lote ainda pode ser executado na Solana por pouco tempo');
    expect(render(state({ review: review(), error: 'SOLANA_WALLET_PROOF_REQUIRED' }), 'PT')).toContain('Entre com sua carteira Solana para acompanhar este fluxo.');
    expect(render(state({ review: review() }), 'PT')).toContain('Um pedido de assinatura Solana para uma única transação atômica');
  });
});
