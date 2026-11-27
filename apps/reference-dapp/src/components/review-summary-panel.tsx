// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 approved UX (board 06 "Simulate and review", board 07 "Blocked"): the Review panel beside the simulated canvas, or the blocker panel that
 * replaces it. Presentation only: every value is the existing simulation and Review projections' own (`projectSimulation`, `projectReview`), and
 * the fee-shortfall numbers are the server's own evidence (`NativeFeeShortfall`). It has NO authorize control: on Execute the one primary action
 * is the footer's lifecycle button; on Simulate (BUILD-FLOFI-UX-EDITOR-FINOPS-001, B2) the panel hosts the shell's own Simulate control (`action`),
 * never an authorization. Nothing here quotes, signs, submits or retries; a balance that arrives never re-simulates by itself.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { ELEVATED_SLIPPAGE_WARNING_BPS } from '@defi-workflow-engine/workflow-contracts';
import { useLocale } from '../i18n/locale';
import { TechnicalBody } from './technical-body';
import { TokenAmountText } from './token-amount-text';
import type { Workflow } from '../domain/initial-workflow';
import { projectSimulation, simulationStatusPresentation, type SimulationSource } from '../domain/simulation-presentation';
import { projectReview, type ReviewAuthorization, type ReviewWallet } from '../domain/review-presentation';
import { flightRefusal, FLIGHT_REFUSAL_HREF } from '../domain/flight-refusal';
import { feeShortfallView } from '../domain/approved-ux';
import { circleUnavailableReason } from '../domain/token-fee';
import { isIncludedNetworkFee, paidToPimlicoNote, SIGNATURES_LABEL } from '../domain/gas-payment';
import type { NativeFeeShortfall } from '../user-funded/groups';
import { OperationSummary, StepSummaryCard, WorkflowTechnicalFacts } from './operation-summary';
import { liquidityPositionResultRows, positionWorkflowOf } from '../domain/liquidity-position-summary';

export type ReviewSummaryPanelProps = {
  workflow: Workflow; context: ReviewContext; source: SimulationSource; authorization: ReviewAuthorization; wallet: ReviewWallet;
  invalidWorkflow?: boolean; unavailableReason?: string | null;
  /** The wallet requests the run review counted for this group; null when no review counted them (the row is then omitted, never estimated). */
  walletRequests?: number | null;
  /** The server's numbers for a native-fee shortfall (board 07), when it returned them. */
  feeShortfall?: NativeFeeShortfall | null;
  /** Everything else (the Simulation Summary, Strategy Manifest, spenders, raw values): collapsed under "Technical details". */
  technical?: ReactNode;
  sequenceNote?: string | null;
  /** The Canvas stays whole when the runtime simulates only its current step. */
  canvasWorkflow?: Workflow;
  /**
   * BUILD-FLOFI-UX-EDITOR-FINOPS-001: `simulate` (default) is the B2 Simulate panel — no authorization language, its one primary action inside
   * (`action`); `execute` is the Review the owner authorizes from the Execute stage (C1 valid, C2 expired), whose one action is the footer's.
   */
  stage?: 'simulate' | 'execute';
  action?: ReactNode;
  /** UX-05 (Simulate): the panel's next action once the result is valid — "Continue to authorization" (navigation to Execute only). */
  next?: ReactNode;
};

function useRefreshAtExpiry(until: number | null) {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const timer = window.setTimeout(() => setClock(Date.now()), until - Date.now() + 1);
    return () => window.clearTimeout(timer);
  }, [until]);
}

/** The props every root layout of the panel carries, so the panel (not one of its layouts) owns the owner's focus. */
type PanelRoot = { ref: RefObject<HTMLElement | null>; onFocus: () => void; onBlur: (event: FocusEvent<HTMLElement>) => void };
/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (post-merge red on main dc09621, brand-ux-001 at 320 px): the panel switches between its waiting, blocker,
 * result and expired layouts as the simulation and the runtime's availability change, and each switch re-creates its root element. Focus the owner
 * had given the panel (the phone's "Review" shortcut focuses it) then fell back to the page. When the panel held focus and a switch removed the
 * focused element, focus returns to the panel's new root. Focus the owner moved elsewhere is never pulled back. Presentation only.
 */
export function usePanelFocus(): PanelRoot {
  const ref = useRef<HTMLElement | null>(null);
  const held = useRef(false);
  useLayoutEffect(() => {
    const panel = ref.current, active = document.activeElement;
    if (!held.current || !panel || (active && active !== document.body && active.isConnected)) return;
    if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
  });
  return { ref, onFocus: () => { held.current = true; },
    // A blur to another element, or to the page while the panel is still on screen, is the owner's own move; a removed layout's blur is not.
    onBlur: event => { if (event.currentTarget.isConnected && !event.currentTarget.contains(event.relatedTarget as Node | null)) held.current = false; } };
}

export function ReviewSummaryPanel(props: ReviewSummaryPanelProps) {
  const { t, language } = useLocale();
  const { workflow, context, source, authorization, wallet, invalidWorkflow = false } = props;
  const stage = props.stage ?? 'simulate';
  const root = usePanelFocus();
  const now = Date.now();
  const sim = projectSimulation(workflow, context, source, now);
  const status = simulationStatusPresentation(sim, invalidWorkflow, source.state.busy);
  const review = projectReview(workflow, context, source, authorization, wallet, now, invalidWorkflow);
  useRefreshAtExpiry(review.expiresAt);
  const busy = Boolean(source.state.busy);
  const expired = !busy && review.status === 'expired';
  const blocked = !busy && sim.status === 'blocked';
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (post-merge red on main 0ea35d5): the owner's open/closed choice belongs to the panel, not to whichever
  // layout is on screen. The panel switches between its blocker, waiting, result and expired layouts as the simulation changes; an uncontrolled
  // <details> was re-created closed on every switch, hiding what the owner had just opened.
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const disclosure = (content: ReactNode, label = 'Technical details') => <details className="review-panel-technical" open={technicalOpen} onToggle={event => setTechnicalOpen(event.currentTarget.open)}>
    <summary>{t(label)}</summary><TechnicalBody label={label}>{content}</TechnicalBody></details>;
  const technical = props.technical ? disclosure(<>{blocked && source.state.error && <p className="review-panel-code"><code>{source.state.error}</code></p>}{props.technical}</>,
    blocked ? 'Technical details, for support' : 'Technical details') : null;
  const action = props.action ? <div className="simulation-panel-action">{props.action}</div> : null;
  // A run already underway keeps its way to Execute beside the blocker's own action (secondary: the blocker's action stays the primary one).
  const next = stage === 'simulate' && props.next ? <div className="simulation-panel-action" data-secondary="">{props.next}</div> : null;
  if (blocked && !expired) return <BlockerPanel message={props.unavailableReason ?? status.message} title={status.label} error={source.state.error ?? null}
    owner={wallet.account} feeShortfall={props.feeShortfall ?? null} technical={technical} simulation={stage === 'simulate'} action={<>{action}{next}</>} root={root}/>;
  const ready = !busy && sim.status !== 'blocked' && (review.status === 'ready' || review.status === 'approved');
  const step = sim.steps[sim.steps.length - 1];
  const quote = source.kind === 'public' ? source.state.run?.quote : null;
  const nativeSwap = stage === 'simulate' && quote?.native === 'OUTPUT' && !quote.conversion && quote.inputSymbol === 'USDC' && step?.result ? step : null;
  const poolQuote = !busy && !expired && !invalidWorkflow && review.status !== 'invalidated' && nativeSwap?.poolQuoteOnly && (!quote?.ownerReview || ready);
  const showResult = ready || poolQuote;
  const approvalFeeOnly = Boolean(poolQuote && quote?.ownerReview?.step === 'approval');
  const canvas = props.canvasWorkflow ?? workflow;
  const until = review.expiresAt !== null && review.expiresAt > now ? new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : null;
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a position-management workflow (its canonical node's marker) states its operation's own rows — liquidity
  // removed and remaining, principal and its enforced minimum, owed tokens and fees as lower bounds, the position NFT — never a deposit's amounts.
  // The step the runtime simulates and reviews (a sequence's current step, or the whole one-step workflow) decides, never the rest of the Canvas.
  const position = positionWorkflowOf(workflow);
  const positionRows = (rowsFor: 'simulate' | 'execute') => step ? liquidityPositionResultRows(step, rowsFor).map(row =>
    <div key={row.label} data-position-row={row.label}><dt>{t(row.label)}</dt><dd className="numeric">{row.amount ? <TokenAmountText value={row.value} rounding={row.amount}/> : t(row.value)}</dd></div>) : null;
  // UX-03: the owner's wallet pays the network fee unless 0x takes it out of the swap (said beside the fee, not in a separate paragraph).
  const walletPays = !sim.fees.some(isIncludedNetworkFee);
  const walletFeeRow = sim.fees.some(line => line.treatment === 'CEILING' && !paidToPimlicoNote(line));
  // UX-01 / UX-03: each simulated step in the shared step card — its action, the amount the owner configured exactly as set (never reformatted)
  // and its simulated result, its network in a pill and a shortened recipient (full address one click away and under Technical details).
  const stepCard = (variant: 'icons' | 'numbered') => <StepSummaryCard variant={variant} items={sim.steps.map(s => ({ key: s.id, action: s.action, title: s.action,
    amount: s === nativeSwap ? null : <>{t(s.input)}{s.result ? <>{' → '}<TokenAmountText className="numeric" value={s.result}/></> : null}</>,
    network: s.networks.length ? s.networks.join(' → ') : null,
    recipient: s.destination ? { address: s.destination, own: Boolean(s.destinationOwned) } : null }))}/>;
  // The rows every valid result states: each step's spend and expected result, the minimum, and the network fee; the Review adds the permissions.
  // A position-management workflow keeps its own rows; any other workflow states its steps in the step card above these rows (`stepCard`).
  const resultRows = <>
    {nativeSwap?.result && <>
      <div><dt>{t('You swap')}</dt><dd className="numeric">{t(nativeSwap.input)}</dd></div>
      <div><dt>{t('Estimated receipt')}</dt><dd className="numeric"><TokenAmountText value={`≈ ${nativeSwap.result}`}/></dd></div>
    </>}
    {position ? positionRows(stage) : <>
      {step?.minimum && <div><dt>{t(poolQuote ? 'Estimated minimum' : 'Minimum you receive')}</dt><dd className="numeric"><TokenAmountText value={step.minimum} rounding="down"/></dd></div>}
    </>}
    {sim.fees.filter(line => line.treatment === 'CEILING' || line.treatment === 'ADDITIONAL').map(line => {
      // ADR-0010 §4 review UX6: a fee paid in a token to Pimlico says so beside its amount (who is paid, in which token).
      const paidTo = paidToPimlicoNote(line);
      if (line.treatment === 'CEILING' && !paidTo && !approvalFeeOnly) return <MaximumFeeRow key={`${line.label}:${line.value}`} walletPays={walletPays} priced={false}
        value={<TokenAmountText value={line.value} rounding="up"/>}/>;
      return <div key={`${line.label}:${line.value}`}><dt>{t(approvalFeeOnly ? 'Max network fee for token approval' : line.treatment === 'CEILING' ? 'Network fee, at most' : line.label)}</dt>{paidTo
        ? <dd><TokenAmountText className="numeric" value={line.value} rounding="up"/><small className="review-block-qualifier">{t(paidTo)}</small></dd>
        : <dd className="numeric"><TokenAmountText value={line.value} rounding={line.treatment === 'CEILING' ? 'up' : 'nearest'}/></dd>}</div>;
    })}
    {/* ADR-0010: a network fee 0x takes out of the swap is shown as such, in the swap's token (never "free", never added on top). */}
    {sim.fees.filter(isIncludedNetworkFee).map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd className="numeric"><TokenAmountText value={line.value} rounding="up"/></dd></div>)}
  </>;
  const warnings = sim.warnings.filter(warning => !warning.technical && !(poolQuote && warning.message === 'This is a pool quote. Network fees and exact transaction simulation are not available yet.'))
    .map((warning, index) => <p className="review-panel-note review-panel-warning" key={index}>{t(warning.message)}</p>);
  const elevatedSlippage = workflow.nodes.some(node => (node.actionType === 'asset.swap.exact-input' || node.actionType === 'asset.bridge') &&
    node.userConstraints.some(constraint => constraint.kind === 'MAXIMUM_SLIPPAGE_BPS' && constraint.maximumBps > ELEVATED_SLIPPAGE_WARNING_BPS));
  if (stage === 'execute') {
    // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (C2): an expired Review keeps the workflow's summary (only what the owner configured) and marks the fee and
    // the permissions as needing a refreshed Review; no stale figure is shown as current and nothing can be authorized from it.
    if (expired) return <section {...root} className="review-panel-approved review-panel-execute" aria-label={t('Review')} data-review-state="expired" data-position-operation={position?.management.operation}>
      {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
      <ExpiredReviewAlert/>
      {/* BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (approved reference, expired review): one white card — the operations as configured, the fee and
          permission marked for the refreshed Review, the wallet requests only when counted, and the collapsed technical details. */}
      <div className="review-expired-card">
        <OperationSummary workflow={canvas} context={context}/>
        <dl className="review-panel-rows">
          <div><dt>{t('Network fee')}</dt><dd><RefreshBadge text="Needs to be refreshed" hint="The network fee is calculated again when you refresh the review."/></dd></div>
          {/* A position operation is one Position Manager (or Whirlpools) request that spends no token: structurally no permission and one wallet
              request, whatever the refreshed figures; every amount is marked for the refreshed Review. */}
          <div><dt>{t('Token permission')}</dt><dd>{position ? t('None — this operation needs no token permission') : <RefreshBadge text="Depends on the updated review" hint="The token permission is confirmed again by the refreshed review."/>}</dd></div>
          {position ? <div><dt>{t('Wallet requests')}</dt><dd>1</dd></div>
            : typeof props.walletRequests === 'number' && <div><dt>{t('Wallet requests')}</dt><dd>{props.walletRequests}</dd></div>}
        </dl>
        {/* Only the configured workflow's facts: never the expired Review's manifest, limits or approvals (flofi-workflow review). */}
        {disclosure(<WorkflowTechnicalFacts workflow={canvas} context={context}
          expiredAt={review.expiresAt !== null ? new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : null}/>)}
      </div>
    </section>;
    if (!ready) return <section {...root} className="review-panel-approved review-panel-execute" aria-label={t('Simulation')} data-review-state={busy ? 'busy' : 'pending'} data-position-operation={position?.management.operation}>
      {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
      <h2>{t('Workflow simulation')}</h2>
      <p className="review-panel-status" role="status">{t(busy ? 'Simulating workflow…' : props.unavailableReason ?? 'Simulation checks expected outcomes and costs before anything is signed or sent.')}</p>
      <OperationSummary workflow={canvas} context={context}/>
      {technical}
    </section>;
    // C1: the valid Review — what the owner authorizes, its costs and permissions, before any wallet request. The ONE action is the footer's.
    return <section {...root} className="review-panel-approved review-panel-execute" aria-label={t('Review')} data-review-state="ready" data-position-operation={position?.management.operation}>
      {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
      {/* UX-03: the status first ("Review ready", until when), then the decision title; never "authorized" before the wallet signs. */}
      {until && <p className="review-panel-validity review-ready-status" data-tone="ready"><span className="simulation-status-dot" aria-hidden="true"/>{t('Review ready · valid until {0}', until)}</p>}
      {/* BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (EXE-01): a valid Review before any wallet request is reviewed, not yet being authorized. */}
      <h2>{t('Check your operation')}</h2>
      {!position && stepCard('numbered')}
      <dl className="review-panel-rows review-decision-rows">
        {resultRows}
        {step?.details.filter(line => line.label === SIGNATURES_LABEL).map(line => <div key={line.label}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
        {/* UX-03: each token approval as "Access to <token>" — its limit and who may spend it — visible before anything is signed. */}
        {review.approvals.map((approval, index) => <div key={`${index}:${approval.symbol}:${approval.address}`} className="review-access-row" data-review-access={approval.symbol}><dt>{t('Access to {0}', approval.symbol)}</dt>
          <dd>{approval.unlimited ? t('This allowance has no spending cap. It remains available to the spender until changed or revoked.')
            : <span className="numeric">{t(approval.value)}</span>}<small className="review-block-qualifier">{t('{0} can use it', t(approval.spender))}</small></dd></div>)}
        {/* A position operation asks for no token permission (its rows already state its one wallet request). */}
        {position && !review.approvals.length && <div data-position-row="Token permission"><dt>{t('Token permission')}</dt><dd>{t('None — this operation needs no token permission')}</dd></div>}
        {!position && typeof props.walletRequests === 'number' && <div><dt>{t('Expected wallet confirmations')}</dt><dd>{props.walletRequests}</dd></div>}
      </dl>
      {/* UX-03: "Paid by your wallet" sits beside the fee; only 0x's included fee keeps its own sentence (it changes who sends and pays). */}
      {!walletPays && <p className="review-panel-note">{t('You sign; 0x sends the swap and takes the network fee out of it. FloFi never signs or pays for you.')}</p>}
      {/* Without a fee ceiling row to carry "Paid by your wallet", who pays stays said in its own sentence (flofi-security review). */}
      {walletPays && !walletFeeRow && <p className="review-panel-note">{t('Your wallet pays the network fee. FloFi never signs or sends for you.')}</p>}
      {elevatedSlippage && <p className="review-panel-note review-panel-warning">{t('Above 3%, the price can move substantially against you before the operation stops.')}</p>}
      {warnings}
      {technical}
    </section>;
  }
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (B2): the Simulate contextual panel. Before the simulation it lists the operations, says what a simulation does
  // and holds the ONE primary action (Simulate workflow); a valid result states the expected outcome and costs with no authorization language
  // (the footer's "Review operation" leads to Execute, where the Review is authorized); an expired result shows no stale figure.
  const awaiting = !busy && !showResult && !expired;
  const title = poolQuote ? 'Pool quote' : ready ? 'Simulation result' : expired ? 'Simulation expired' : 'Simulate workflow';
  return <section {...root} className="review-panel-approved simulation-context-panel" aria-label={t(poolQuote || ready ? title : 'Simulation')} data-review-state={busy ? 'busy' : expired ? 'expired' : ready ? 'ready' : 'pending'} data-position-operation={position?.management.operation}>
    <SimulationPanelHead title={title}
      subtitle={poolQuote ? t('The swap transaction still needs to be simulated.') : ready ? until ? t('Valid until {0}. Nothing has been signed or sent.', until) : t('Nothing has been signed or sent.')
        : expired ? t('Simulate again to refresh the expected result and costs. The previous values are no longer current.')
        : t('Check the expected result, costs and possible risks.')}/>
    {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
    {/* UX-01: the result in the same card language as before the simulation (icons, amounts on their own line, network pill), then its costs. */}
    {showResult ? <>{!position && stepCard('icons')}<dl className="review-panel-rows simulation-result-rows review-decision-rows">{resultRows}</dl></>
      : <OperationSummary workflow={canvas} context={context} heading={null} variant="icons"/>}
    {showResult && nativeSwap && (approvalFeeOnly || !sim.fees.some(line => line.treatment === 'CEILING' || isIncludedNetworkFee(line))) &&
      <p className="review-panel-note">{t('The network fee is not yet available. Check it before authorizing.')}</p>}
    {showResult && warnings}
    {/* UX-05: the ONE next action of a valid result, in this panel (navigation to Execute; nothing is signed or accepted here). */}
    {/* With its own action on screen (Simulate again, a wallet or network step), the way to Execute is secondary: one primary per moment. */}
    {props.next && !busy && <div className="simulation-panel-action" data-secondary={!ready && props.action ? '' : undefined}>{props.next}</div>}
    {/* The panel's action states its own reason when it is closed; the status line covers a run in progress and a reason with no action here. */}
    {!ready && (busy || props.unavailableReason && !props.action) && <p className="review-panel-status" role="status">{t(busy ? 'Simulating workflow…' : props.unavailableReason!)}</p>}
    {awaiting && <SimulationExplainer/>}
    {!ready && action}
    {technical}
  </section>;
}

/** B2: the Simulate panel's title row (a flask mark, the title and one line under it). */
export function SimulationPanelHead({ title, subtitle }: { title: string; subtitle: string }) {
  const { t } = useLocale();
  return <div className="simulation-panel-head"><span className="simulation-panel-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/></svg></span>
    <div><h2>{t(title)}</h2><p>{subtitle}</p></div></div>;
}
/** B2: what a simulation does, before the owner runs it. */
export function SimulationExplainer() {
  const { t } = useLocale();
  return <div className="simulation-explainer" role="note"><span aria-hidden="true">i</span><div><strong>{t('What does the simulation do?')}</strong>
    <p>{t('It estimates the result of your operation and shows the expected costs, without moving your funds.')}</p></div></div>;
}
/** C2: the Review expired — said first, in its own surface, with what to do. */
export function ExpiredReviewAlert() {
  const { t } = useLocale();
  // BUILD-FLOFI-UX-REFINEMENT-HISTORY-001: a soft-orange notice with a discreet warning triangle — an expiry is not a loss of funds (never alarm red).
  return <div className="review-expired-alert" role="alert"><span className="review-expired-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2.8c.7 0 1.3.4 1.7 1l8.6 15c.7 1.2-.2 2.7-1.6 2.7H3.3c-1.4 0-2.3-1.5-1.6-2.7l8.6-15c.4-.6 1-1 1.7-1Z"/><path d="M12 8.6v5.6M12 17.2v.1" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round"/></svg></span>
    <div><strong>{t('Your review expired.')}</strong><p>{t('Refresh the simulation and check the new values before authorizing.')}</p></div></div>;
}
/**
 * UX-03 (owner guidelines of 21-11-2026): a short contextual help beside a label — an "i" button whose text opens under it on click, tap or
 * keyboard (never a hover-only tooltip) and is part of its accessible name. Presentation only.
 */
export function InfoHint({ text }: { text: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  // Closes with Escape (consumed only while open), and when focus leaves the hint; the text is in the button's name, never a hover-only title.
  return <span className="info-hint" data-open={open || undefined} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button type="button" className="info-hint-button" aria-expanded={open} aria-label={t('More information: {0}', t(text))} onClick={() => setOpen(value => !value)}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1" strokeLinecap="round"/></svg></button>
    {open && <span className="info-hint-text" role="note">{t(text)}</span>}</span>;
}
/**
 * UX-03: the network-fee row of a Review or a simulation result — "Max network fee" on the left, its ceiling on the right (rounded UP by its
 * producer), and under it who pays it when that is the owner's wallet, with the pricing caveat as contextual help. Never a USD figure without a
 * verified price (none reaches this panel).
 */
export function MaximumFeeRow({ value, walletPays, priced, valueTitle }: { value: ReactNode; walletPays: boolean; priced: boolean; valueTitle?: string | undefined }) {
  const { t } = useLocale();
  return <div className="review-fee-row"><dt>{t('Max network fee')}</dt>
    <dd><span className="review-fee-value" title={valueTitle}>{value}</span>{(walletPays || priced) && <small className="review-block-qualifier review-fee-note">
      {/* The pricing caveat stays visible ("at today's prices"); the hint says the wallet sets the final fee (flofi-security review). */}
      <span>{walletPays && priced ? t('Paid by your wallet · at today\'s prices') : walletPays ? t('Paid by your wallet') : t('At today\'s prices')}</span>
      {priced && <InfoHint text="At today's prices; your wallet sets the final fee."/>}</small>}</dd></div>;
}
/** C2: a value that only a refreshed Review can state (never a stale figure); `hint` says why, on hover and to assistive technology. */
export function RefreshBadge({ text, hint = null }: { text: string; hint?: string | null }) {
  const { t } = useLocale();
  return <span className="review-refresh-badge" title={hint ? t(hint) : undefined}>{t(text)}{hint && <>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1" strokeLinecap="round"/></svg>
    <span className="sr-only">. {t(hint)}</span></>}</span>;
}

/** Board 07: what blocks the simulation, the server's own numbers when it has them, and the one next action (the footer keeps "Simulate again"). */
export function BlockerPanel({ title, message, error, owner, feeShortfall, technical, simulation = false, action = null, root }: { title: string; message: string; error: string | null; owner: string | null;
  feeShortfall: NativeFeeShortfall | null; technical: ReactNode; simulation?: boolean;
  /** BUILD-FLOFI-UX-EDITOR-FINOPS-001 (B2): on Simulate, the panel holds the one primary action (Simulate again) after the blocker's own actions. */
  action?: ReactNode;
  /** The owning panel's root props (focus kept across layouts), when the blocker is one of its layouts. */
  root?: PanelRoot }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const fee = feeShortfallView(feeShortfall);
  const flight = flightRefusal(error);
  const href = flight ? FLIGHT_REFUSAL_HREF[flight.action] : null;
  const address = fee?.owner ?? owner;
  const copy = async () => {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setCopied('copied'); } catch { setCopied('failed'); }
  };
  const heading = fee ? t('Not enough {0} on {1} for the network fee', fee.symbol, t(fee.network)) : t(title);
  return <section {...root} className="review-panel-approved review-panel-blocked" aria-label={t(simulation ? 'Simulation' : 'Before authorizing')} data-review-state="blocked">
    {!simulation && <p className="eyebrow">{t('BEFORE AUTHORIZING')}</p>}
    {simulation ? <><h2>{t('Workflow simulation')}</h2><h3>{heading}</h3></> : <h2>{heading}</h2>}
    {fee && <dl className="review-panel-rows">
      <div><dt>{t('You have')}</dt><dd className="numeric">{fee.balance} {fee.symbol}</dd></div>
      <div><dt>{t('The fee can reach')}</dt><dd className="numeric">{fee.fee} {fee.symbol}</dd></div>
      {fee.sends && <div><dt>{t('This request also sends')}</dt><dd className="numeric">{fee.sends} {fee.symbol}</dd></div>}
      {/* KAN-20 (a Solana Batch Payment): the token-account deposits the fee includes at most (labelled as included, so the rows add up), and the SOL
        kept as Solana's minimum balance. */}
      {fee.deposits && <div><dt>{t('Includes token-account deposits, at most')}</dt><dd className="numeric">{fee.deposits} {fee.symbol}</dd></div>}
      {fee.reserve && <div><dt>{t('Kept as Solana\'s minimum balance')}</dt><dd className="numeric">{fee.reserve} {fee.symbol}</dd></div>}
      <div data-emphasis="attention"><dt>{t('Missing, at least')}</dt><dd className="numeric">{fee.missing} {fee.symbol}</dd></div>
    </dl>}
    <p className="review-panel-note">{fee ? t('Send a little {0} on the {1} network to this wallet, from an exchange or another wallet. Nothing was sent.', fee.symbol, t(fee.network)) : t(message)}</p>
    {/* ADR-0010: paying this fee in USDC through Circle was considered for this request; why it was not available, in plain words. */}
    {fee?.alternatives?.length ? <p className="review-panel-note">{t('Paying this fee in USDC through Circle is not available: {0}.', t(circleUnavailableReason(fee.alternatives[0]!)))}</p> : null}
    <div className="review-panel-actions">
      {address && (fee || /network fee/i.test(message)) && <button type="button" className="secondary" onClick={() => void copy()}>{t('Copy address')} <span className="numeric">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span></button>}
      {href && <a className="secondary" href={href}>{t(flight!.action === 'LINK_WALLET' ? 'Open Credentials' : flight!.action === 'SIGN_IN' ? 'Sign in' : 'Open Board')}</a>}
      <span role="status" className={copied ? undefined : 'sr-only'}>{copied ? t(copied === 'copied' ? 'Address copied.' : 'Address could not be copied.') : ''}</span>
    </div>
    {action}
    {technical}
  </section>;
}
