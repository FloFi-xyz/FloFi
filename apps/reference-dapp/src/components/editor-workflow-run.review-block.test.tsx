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
vi.mock('./user-funded-browser', () => ({ evmWalletKind: () => 'INJECTED', batchHandout: () => undefined, batchSponsorshipOf: () => null, keepBatchHandout: () => undefined, sendWalletBatch: vi.fn(), signSolanaGroup: vi.fn(), signUserOperation: vi.fn(), walletBatchHashes: vi.fn(), walletProfile: vi.fn() }));
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
  it('UX-03: shows only the status, "Check your operation", the steps card, the decision rows and the wallet line; the rest is collapsed', () => {
    const html = render(state({}));
    const shown = visible(html);
    // UX-03 (owner guidelines of 21-11-2026, intentional change): the status first, then the decision title; never "authorized" before the wallet signs.
    expect(shown).toMatch(/<p class="review-panel-validity review-ready-status" data-tone="ready"><span class="simulation-status-dot" aria-hidden="true"><\/span>Review ready · valid until [^<]+<\/p><h3>Check your operation<\/h3>/);
    expect(shown).not.toMatch(/authorized|You are authorizing|REVIEW</);
    // One card: numbered steps with their icon, amounts on their own line (exact value one click away) and the network pill.
    expect(shown).toContain('<div class="operation-summary step-summary-card" data-variant="numbered"><ol aria-label="Steps">');
    expect(shown).toMatch(/<span class="operation-summary-number" aria-hidden="true">1<\/span><div class="operation-summary-body"><strong class="step-summary-title">Swap<span class="step-summary-title-icon"/);
    expect(shown).toContain('2 USDC → <span class="token-amount"><button type="button" class="token-amount-short" title="0.000800123456789 WETH" aria-label="≈ 0.000800123 WETH, Show exact value" aria-expanded="false">≈ 0.000800123 WETH</button></span>');
    // A refused Review never reads "ready" (flofi-frontend-ux review): only its validity is stated.
    const refused = visible(render(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) })));
    expect(refused).not.toContain('Review ready');
    expect(shown).toContain('title="0.000796123456789123 WETH" aria-label="0.000796124 WETH, Show exact value" aria-expanded="false">0.000796124 WETH</button>');
    expect(shown).toContain('<span class="operation-summary-chip">Base</span>');
    expect(shown).toContain('<span class="operation-summary-chip">Base → Arbitrum One</span>');
    expect(shown).toContain('<dt>Minimum you receive</dt><dd title="0.000790555555555555 WETH"><span><span class="numeric">0.000790555 WETH</span></span></dd>');
    // The fee ceiling aligned on its row, who pays it beside it and the pricing caveat as contextual help (never dropped).
    expect(shown).toContain('<div class="review-fee-row"><dt>Max network fee</dt><dd><span class="review-fee-value"><span class="numeric">0.000454 ETH</span></span><small class="review-block-qualifier review-fee-note"><span>Paid by your wallet · at today&#x27;s prices</span><span class="info-hint"><button type="button" class="info-hint-button" aria-expanded="false" aria-label="More information: At today&#x27;s prices; your wallet sets the final fee.">');
    // Every token approval stays visible before signing: the token, its limit (rounded up; exact in the title) and who may spend it.
    expect(shown).toContain('<div class="review-access-row" data-review-access="USDC"><dt>Access to USDC</dt><dd><span class="numeric">Up to 2 USDC</span><small class="review-block-qualifier">Uniswap can use it</small></dd></div>');
    expect(shown).toContain('<div class="review-access-row" data-review-access="WETH"><dt>Access to WETH</dt><dd><span class="numeric" title="0.000796123456789123 WETH">Up to 0.000796124 WETH</span><small class="review-block-qualifier">Across can use it</small></dd></div>');
    expect(shown).toContain('<dt>Expected wallet confirmations</dt><dd><span><span class="numeric">1</span></span></dd>');
    // The repeated "your wallet pays… FloFi never signs" paragraph is gone from the summary; it stays in the technical details.
    expect(shown).not.toContain('FloFi never signs or sends for you.');
    expect(html).toContain('Your wallet pays every network fee. FloFi never pays, advances or reimburses gas, and never signs or sends for you.');
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
    expect(shown).toMatch(/Revisão pronta · válida até [^<]+<\/p><h3>Confira sua operação<\/h3>/);
    expect(shown).toMatch(/<strong class="step-summary-title">Trocar<span/);
    expect(shown).toContain('<dt>Mínimo que você recebe</dt>');
    expect(shown).toContain('<dt>Taxa de rede máxima</dt>');
    expect(shown).toContain('<small class="review-block-qualifier review-fee-note"><span>Paga pela sua carteira · nos preços de agora</span><span class="info-hint">');
    expect(shown).toContain('<dt>Acesso ao USDC</dt><dd><span class="numeric">Até 2 USDC</span><small class="review-block-qualifier">Uniswap pode usar</small></dd>');
    expect(shown).toContain('<dt>Confirmações previstas na carteira</dt>');
    expect(render(state({}), 'PT')).toContain('<summary>Detalhes técnicos</summary>');
  });
  it('has no action button of its own in the chat-first Editor: the footer hosts the ONE primary action, with the same handlers', () => {
    const html = render(state({}));
    // Before the collapsed details: only disclosures (an exact value, a hint), never an action. "Review again" stays reachable, as a quiet control
    // under Technical details only.
    const visibleButtons = visible(html).match(/<button[^>]*>/g) ?? [];
    for (const button of visibleButtons) expect(button, button).toMatch(/aria-expanded="false"/);
    expect(visible(html)).not.toMatch(/Authorize|Review again|Refresh review/);
    expect(html.match(/class="quiet review-block-again"/g)).toHaveLength(1);
    expect(html).toContain('<button type="button" class="quiet review-block-again">Review again</button>');
    // Expired: the footer offers "Refresh review" (BUILD-FLOFI-UX-EDITOR-FINOPS-001, C2), so the block has no second one.
    expect(render(state({ review: swapBridgeReview({ validUntil: '2020-01-01T00:01:00.000Z' }) }))).not.toContain('<button');
    // A refusal asks for a fresh quote: the quiet control sits beside the amber line.
    expect(visible(render(state({ error: 'SWAP_MINIMUM_NOT_MET' })))).toMatch(/class="review-block-alert" role="alert">[^<]*<button type="button" class="quiet review-block-again">Review again<\/button><\/p>/);
    // The engineering workspace (no footer) keeps the panel's own buttons.
    expect(render(state({}), 'EN', false)).toContain('>Authorize workflow</button>');
    const s = state({});
    expect(primary(s)).toBe('<button type="button" class="primary editor-run-authorize">Authorize workflow</button>');
    expect(primary(state({ phase: 'authorizing' }))).toContain('disabled="" aria-busy="true">Preparing your wallet request…</button>');
    expect(primary(state({ review: null, phase: 'idle' }))).toBe('<button type="button" class="primary">Review whole workflow</button>');
    expect(primary(state({ review: null, phase: 'reviewing' }))).toContain('disabled="" aria-busy="true">Reviewing the whole workflow…</button>');
    // Expired prices or a Review that cannot be grouped: the one action reviews again (Authorize would only be refused).
    expect(primary(state({ review: swapBridgeReview({ validUntil: '2020-01-01T00:01:00.000Z' }) }))).toContain('>Refresh review</button>');
    expect(primary(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) }), 'PT')).toContain('>Revisar novamente</button>');
    expect(primary(state({ canReview: false }))).toBe('');
  });
  it('states what invalidates it in ONE amber line at the top; a missing native fee is board 07 instead', () => {
    // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (C2, intentional change): an expired Review says so first in its own surface, keeps the workflow's summary as
    // configured and marks the fee and permissions as needing a refreshed Review — never a stale figure, never authorization copy.
    const expired = render(state({ review: swapBridgeReview({ validUntil: '2020-01-01T00:01:00.000Z' }) }));
    expect(expired).toMatch(/^<section[^>]*data-review-state="attention"><div class="review-expired-alert" role="alert">/);
    expect(expired).toContain('Your review expired');
    expect(expired).toContain('Refresh the simulation and check the new values before authorizing.');
    // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001: each badge also says why (tooltip and assistive text), inside the expired Review's one card.
    expect(expired).toMatch(/<div class="review-expired-card">[\s\S]*<span class="review-refresh-badge" title="The network fee is calculated again when you refresh the review.">Needs to be refreshed/);
    expect(expired).toMatch(/<span class="review-refresh-badge" title="The token permission is confirmed again by the refreshed review.">Depends on the updated review/);
    expect(expired).toMatch(/<details class="review-panel-technical review-block-technical"><summary>Technical details<\/summary>/);
    expect(expired).not.toMatch(/<details[^>]* open/);
    expect(expired).not.toMatch(/Review before authorizing|Check your operation|You are authorizing|Network fee, at most|Max network fee|Minimum you receive/);
    const refused = visible(render(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'SIMULATION_REVERTED', step: 1 } }) })));
    expect(refused.match(/review-block-alert/g)).toHaveLength(1);
    expect(refused).toContain('step 2 would fail on chain now');
    const evidence = { kind: 'NATIVE_FEE_SHORTFALL' as const, chainId: 'eip155:8453', owner: '0x' + 'ab'.repeat(20), unit: 'wei' as const, balance: '1000', maxFee: '454000000000000',
      nativeSpend: '0', required: '454000000000000', shortfall: '453999999999000' };
    const blocked = render(state({ grouped: false, review: swapBridgeReview({ refusal: { code: 'USER_FUNDED_NATIVE_FEE_SHORTFALL', step: null, evidence } }) }));
    expect(blocked).toContain('data-review-state="blocked"');
    expect(blocked).toContain('BEFORE AUTHORIZING');
    expect(blocked).not.toContain('You are authorizing'); expect(blocked).not.toContain('Review before authorizing'); expect(blocked).not.toContain('Check your operation');
    expect(blocked).toContain('<summary>Technical details, for support</summary>');
  });
  it('a step-by-step Review says each step asks the wallet on its own; a smart-account upgrade and every network switch are said', () => {
    const steps = visible(render(state({ grouped: false, stepByStep: true, review: swapBridgeReview({ mode: 'STEP_BY_STEP' }) }), 'EN', false));
    expect(steps).toContain('This workflow needs a confirmation in your wallet for each step on its own.');
    const upgrade = visible(render(state({ review: swapBridgeReview({ counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 4,
      networkSwitches: 1, oneTimeSetup: ['EVM_SMART_ACCOUNT_UPGRADE'] } }) }), 'PT'));
    expect(upgrade).toContain('<span class="numeric">1</span> + <span class="numeric">1</span> troca(s) de rede');
    expect(upgrade).toContain('inclui uma atualização única desta conta para conta inteligente');
  });
  it('review round 2 (ADR-0009): who pays each network fee follows its sponsorship — REQUIRED is not in "Network fee, at most"; OFFERED says when the wallet pays', () => {
    const base = swapBridgeReview(), g = base.groups[0]!;
    const sponsored = (sponsorship: 'OFFERED' | 'REQUIRED') => swapBridgeReview({ groups: [{ ...g, fee: { ...g.fee!, sponsorship } }] });
    const required = render(state({ review: sponsored('REQUIRED') }));
    // UX-03: no "Paid by your wallet" and no pricing hint for a fee FloFi must sponsor; its own sentence stays.
    expect(visible(required)).toContain('<div class="review-fee-row"><dt>Max network fee</dt><dd><span class="review-fee-value">None from your wallet: FloFi offers to pay it</span></dd></div>');
    expect(visible(required)).toContain('<p class="review-panel-note">FloFi offers to pay the network fee; your wallet must support sponsored fees on Base. FloFi never signs or sends for you.</p>');
    expect(visible(required)).not.toContain('Your wallet pays the network fees');
    expect(required).toContain('one atomic transaction from your own wallet; FloFi offers to pay its network fee (your wallet must support sponsored fees on this network).');
    // The technical note no longer points "below" (the sponsored fee is listed above it).
    expect(required).toContain('FloFi offers to sponsor the network fee marked &quot;Sponsored network fee&quot;; every other fee is paid by your wallet.');
    expect(required).not.toContain('network fee below');
    const offered = render(state({ review: sponsored('OFFERED') }));
    expect(visible(offered)).toContain('<dt>Max network fee</dt><dd><span class="review-fee-value"><span class="numeric">0.000454 ETH</span></span><small class="review-block-qualifier review-fee-note"><span>At today&#x27;s prices</span><span class="info-hint">');
    expect(visible(offered)).not.toContain('Paid by your wallet');
    expect(visible(offered)).toContain('FloFi offers to pay the network fee; your wallet pays it only if it does not support sponsored fees. FloFi never signs or sends for you.');
    expect(offered).toContain('one atomic transaction from your own wallet; FloFi offers to pay its network fee, and your wallet pays it only if it does not support sponsored fees.');
    // Two groups: the sponsored one is named; the wallet pays the other one's fee.
    const grouped = visible(render(state({ review: swapBridgeReview({ mode: 'GROUPED', groups: [{ ...g, steps: [0, 0], fee: { ...g.fee!, sponsorship: 'REQUIRED' } },
      { ...g, index: 1, steps: [1, 1], fee: { ...g.fee!, maxWei: '1000000000000000' } }] }) })));
    expect(grouped).toContain('<span class="numeric">0.001 ETH</span>');
    expect(grouped).toContain('FloFi offers to pay the network fee of group 1; your wallet must support sponsored fees on Base. Your wallet pays every other network fee. FloFi never signs or sends for you.');
    const pt = visible(render(state({ review: sponsored('REQUIRED') }), 'PT'));
    expect(pt).toContain('Nada da sua carteira: a FloFi se oferece para pagá-la');
    expect(pt).toContain('A FloFi se oferece para pagar a taxa de rede; sua carteira precisa oferecer suporte a taxas patrocinadas na Base. A FloFi nunca assina nem envia por você.');
    expect(render(state({ review: sponsored('OFFERED') }), 'PT')).toContain('A FloFi se oferece para patrocinar a taxa de rede marcada como &quot;Taxa de rede patrocinada&quot;');
  });
  it('while the Review is prepared it says so, in the same block', () => {
    const html = render(state({ review: null, phase: 'reviewing' }));
    expect(html).toContain('<h3>Workflow simulation</h3><p class="review-panel-status" role="status">Reviewing the whole workflow…</p>');
    expect(html).not.toContain('<button');
  });
});
