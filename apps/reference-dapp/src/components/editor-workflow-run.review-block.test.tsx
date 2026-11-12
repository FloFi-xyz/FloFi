// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Board 06 ("Simular e revisar"): before anything is authorized, the Editor's whole-workflow Review reads as what the owner is authorizing — plain
 * step lines, the final minimum, the fee ceiling, the token permissions and the wallet requests — with everything it said before kept under a
 * collapsed "Technical details". In the chat-first Editor its ONE primary action is the footer's (`EditorWorkflowRunPrimaryAction`). Rendering
 * calls no server action and no wallet.
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
vi.mock('./user-funded-browser', () => ({ batchHandout: () => undefined, keepBatchHandout: () => undefined, sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
vi.mock('./wallet-proof', () => ({ useWalletProof: () => ({ proveEvm: vi.fn() }) }));
const { EditorWorkflowRunPanel, EditorWorkflowRunPrimaryAction } = await import('./editor-workflow-run');
const { LocaleProvider } = await import('../i18n/locale');
import type { EditorWorkflowRunState } from './editor-workflow-run';
import type { Language } from '../i18n/locale';
import { swapBridgeReview } from '../domain/review-block-test-harness';

const state = (patch: Partial<EditorWorkflowRunState>): EditorWorkflowRunState => ({ available: true, phase: 'reviewed', review: swapBridgeReview(), error: null, run: null,
  updated: [], started: false, grouped: true, unrecorded: false, visible: true, earlier: false, stepByStep: false, unloaded: false, canReview: true, following: false,
  followEarlier: vi.fn(), hide: vi.fn(), resume: vi.fn(), startReview: vi.fn(), authorize: vi.fn(), confirmUpdate: vi.fn(), authorizeDue: vi.fn(), checkWallet: vi.fn(),
  end: vi.fn(), dismiss: vi.fn(), ...patch });
const render = (s: EditorWorkflowRunState, language: Language = 'EN', actionsOutside = true) =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPanel state={s} actionsOutside={actionsOutside}/></LocaleProvider>);
const primary = (s: EditorWorkflowRunState, language: Language = 'EN') =>
  renderToStaticMarkup(<LocaleProvider initialLanguage={language}><EditorWorkflowRunPrimaryAction state={s}/></LocaleProvider>);
/** What the block shows before its collapsed "Technical details". */
const visible = (html: string) => html.slice(0, html.indexOf('<details'));

describe('board 06: the Review before authorization', () => {
  it('shows only: REVIEW, "You are authorizing", one line per step, the four summary rows and the wallet line; the rest is collapsed', () => {
    const html = render(state({}));
    const shown = visible(html);
    expect(shown).toContain('<p class="eyebrow">REVIEW</p><h2>You are authorizing</h2>');
    expect(shown).toContain('Swap <span class="numeric">2 USDC</span> → <span class="numeric">WETH</span> · <span class="numeric">Base</span>');
    expect(shown).toContain('title="0.000796123456789123 WETH">Bridge <span class="numeric">0.000796124 WETH</span> to <span class="numeric">Arbitrum One</span>');
    expect(shown).toContain('<dt>Minimum you receive</dt><dd title="0.000790555555555555 WETH"><span><span class="numeric">0.000790555 WETH</span></span></dd>');
    expect(shown).toContain('<dt>Network fee, at most</dt><dd><span><span class="numeric">0.000454 ETH</span></span></dd>');
    expect(shown).toContain('<span class="numeric">Uniswap</span> uses up to <span class="numeric">2 USDC</span>');
    expect(shown).toContain('<span class="numeric">Across</span> uses up to <span class="numeric">0.000796124 WETH</span>');
    expect(shown).toContain('<dt>Wallet requests</dt><dd><span><span class="numeric">1</span></span></dd>');
    expect(shown).toContain('Your wallet pays the network fees. FloFi never signs or sends for you.');
    // No chain ids, internal codes, group breakdown, route notes, deadlines or prices outside the collapsed details.
    for (const hidden of ['8453', 'Group', 'atomic', 'calls in the batch', 'Prices', '10 minutes', 'Step 1', 'Review the whole workflow', 'ONE wallet confirmation'])
      expect(shown, hidden).not.toContain(hidden);
    // Everything it said before is still there, one click away (closed by default).
    expect(html).toContain('<details class="review-panel-technical review-block-technical"><summary>Technical details</summary>');
    expect(html).toContain('All 2 steps run as ONE wallet confirmation on Base');
    expect(html).toContain('4 calls in the batch (2 token approvals)');
    expect(html).toContain('Confirm the wallet request promptly: about 10 minutes after FloFi prepares it');
    expect(html).not.toMatch(/<details[^>]* open/);
  });
  it('in Brazilian Portuguese', () => {
    const shown = visible(render(state({}), 'PT'));
    expect(shown).toContain('<p class="eyebrow">REVISÃO</p><h2>Você está autorizando</h2>');
    expect(shown).toContain('Trocar <span class="numeric">2 USDC</span> → <span class="numeric">WETH</span> · <span class="numeric">Base</span>');
    expect(shown).toContain('Levar <span class="numeric">0.000796124 WETH</span> para <span class="numeric">Arbitrum One</span>');
    expect(shown).toContain('<dt>Mínimo que você recebe</dt>');
    expect(shown).toContain('<dt>Taxa de rede, no máximo</dt>');
    expect(shown).toContain('<dt>Permissão de token</dt>');
    expect(shown).toContain('<span class="numeric">Uniswap</span> usa até <span class="numeric">2 USDC</span>');
    expect(shown).toContain('<dt>Pedidos à carteira</dt>');
    expect(shown).toContain('Sua carteira paga as taxas de rede. A FloFi nunca assina nem envia por você.');
    expect(render(state({}), 'PT')).toContain('<summary>Detalhes técnicos</summary>');
  });
  it('has no button of its own in the chat-first Editor: the footer hosts the ONE primary action, with the same handlers', () => {
    const html = render(state({}));
    expect(html).not.toContain('<button');
    // The engineering workspace (no footer) keeps the panel's own buttons.
    expect(render(state({}), 'EN', false)).toContain('>Authorize workflow</button>');
    const s = state({});
    expect(primary(s)).toBe('<button type="button" class="primary editor-run-authorize">Authorize workflow</button>');
    expect(primary(state({ phase: 'authorizing' }))).toContain('disabled="" aria-busy="true">Preparing your wallet request…</button>');
    expect(primary(state({ review: null, phase: 'idle' }))).toBe('<button type="button" class="primary">Review whole workflow</button>');
    expect(primary(state({ review: null, phase: 'reviewing' }))).toContain('disabled="" aria-busy="true">Reviewing the whole workflow…</button>');
    // Expired prices or a Review that cannot be grouped: the one action reviews again (Authorize would only be refused).
    expect(primary(state({ review: swapBridgeReview({ validUntil: '2020-01-01T00:01:00.000Z' }) }))).toContain('>Review again</button>');
    expect(primary(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) }), 'PT')).toContain('>Revisar novamente</button>');
    expect(primary(state({ canReview: false }))).toBe('');
  });
  it('states what invalidates it in ONE amber line at the top; a missing native fee is board 07 instead', () => {
    const expired = visible(render(state({ review: swapBridgeReview({ validUntil: '2020-01-01T00:01:00.000Z' }) })));
    expect(expired).toMatch(/^<section[^>]*data-review-state="attention"><p class="review-block-alert" role="alert">Expired at [^<]+: review again to refresh them before authorizing\.<\/p><p class="eyebrow">/);
    const refused = visible(render(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) })));
    expect(refused.match(/review-block-alert/g)).toHaveLength(1);
    expect(refused).toContain('step 2 would fail on chain now');
    const evidence = { kind: 'NATIVE_FEE_SHORTFALL' as const, chainId: 'eip155:8453', owner: '0x' + 'ab'.repeat(20), unit: 'wei' as const, balance: '1000', maxFee: '454000000000000',
      nativeSpend: '0', required: '454000000000000', shortfall: '453999999999000' };
    const blocked = render(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'USER_FUNDED_NATIVE_FEE_SHORTFALL', step: null, evidence } }) }));
    expect(blocked).toContain('data-review-state="blocked"');
    expect(blocked).toContain('BEFORE AUTHORIZING');
    expect(blocked).not.toContain('You are authorizing');
    expect(blocked).toContain('<summary>Technical details, for support</summary>');
  });
  it('while the Review is prepared it says so, in the same block', () => {
    const html = render(state({ review: null, phase: 'reviewing' }));
    expect(html).toContain('<h2>You are authorizing</h2><p class="review-panel-status" role="status">Reviewing the whole workflow…</p>');
    expect(html).not.toContain('<button');
  });
});
