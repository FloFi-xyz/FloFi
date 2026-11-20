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
import { OperationSummary, WorkflowTechnicalFacts } from './operation-summary';
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
function usePanelFocus(): PanelRoot {
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
  if (blocked && !expired) return <BlockerPanel message={props.unavailableReason ?? status.message} title={status.label} error={source.state.error ?? null}
    owner={wallet.account} feeShortfall={props.feeShortfall ?? null} technical={technical} simulation={stage === 'simulate'} action={action} root={root}/>;
  const ready = !busy && sim.status !== 'blocked' && (review.status === 'ready' || review.status === 'approved');
  const step = sim.steps[sim.steps.length - 1];
  const canvas = props.canvasWorkflow ?? workflow;
  const until = review.expiresAt !== null && review.expiresAt > now ? new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : null;
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a position-management workflow (its canonical node's marker) states its operation's own rows — liquidity
  // removed and remaining, principal and its enforced minimum, owed tokens and fees as lower bounds, the position NFT — never a deposit's amounts.
  // The step the runtime simulates and reviews (a sequence's current step, or the whole one-step workflow) decides, never the rest of the Canvas.
  const position = positionWorkflowOf(workflow);
  const positionRows = (rowsFor: 'simulate' | 'execute') => step ? liquidityPositionResultRows(step, rowsFor).map(row =>
    <div key={row.label} data-position-row={row.label}><dt>{t(row.label)}</dt><dd className="numeric">{row.amount ? <TokenAmountText value={row.value} rounding={row.amount}/> : t(row.value)}</dd></div>) : null;
  // The rows every valid result states: each step's spend and expected result, the minimum, and the network fee; the Review adds the permissions.
  const resultRows = <>
    {position ? positionRows(stage) : <>
      {sim.steps.map(s => <div key={s.id}><dt>{t(s.action)}{s.provider && <small className="review-block-qualifier">{t(s.provider)}</small>}</dt><dd><TokenAmountText value={s.input} rounding="up" marker/>{s.result ? <>{' → '}<TokenAmountText className="numeric" value={s.result}/></> : null}</dd></div>)}
      {step?.minimum && <div><dt>{t('Minimum you receive')}</dt><dd className="numeric"><TokenAmountText value={step.minimum} rounding="down"/></dd></div>}
    </>}
    {sim.fees.filter(line => line.treatment === 'CEILING' || line.treatment === 'ADDITIONAL').map(line => {
      // ADR-0010 §4 review UX6: a fee paid in a token to Pimlico says so beside its amount (who is paid, in which token).
      const paidTo = paidToPimlicoNote(line);
      return <div key={`${line.label}:${line.value}`}><dt>{t(line.treatment === 'CEILING' ? 'Network fee, at most' : line.label)}</dt>{paidTo
        ? <dd><TokenAmountText className="numeric" value={line.value} rounding="up"/><small className="review-block-qualifier">{t(paidTo)}</small></dd>
        : <dd className="numeric"><TokenAmountText value={line.value} rounding={line.treatment === 'CEILING' ? 'up' : 'nearest'}/></dd>}</div>;
    })}
    {/* ADR-0010: a network fee 0x takes out of the swap is shown as such, in the swap's token (never "free", never added on top). */}
    {sim.fees.filter(isIncludedNetworkFee).map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd className="numeric"><TokenAmountText value={line.value} rounding="up"/></dd></div>)}
  </>;
  const warnings = sim.warnings.filter(warning => !warning.technical).map((warning, index) => <p className="review-panel-note review-panel-warning" key={index}>{t(warning.message)}</p>);
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
      {until && <p className="review-panel-validity" data-tone="ready"><span className="simulation-status-dot" aria-hidden="true"/>{t('Review valid until {0}', until)}</p>}
      <p className="eyebrow">{t('REVIEW')}</p>
      {/* BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (EXE-01): a valid Review before any wallet request is reviewed, not yet being authorized. */}
      <h2>{t('Review before authorizing')}</h2>
      <dl className="review-panel-rows">
        {resultRows}
        {step?.details.filter(line => line.label === SIGNATURES_LABEL).map(line => <div key={line.label}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
        {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.address}`}><dt>{t('Token permission')}</dt>
          <dd>{approval.unlimited ? t('This allowance has no spending cap. It remains available to the spender until changed or revoked.')
            : t('{0} uses up to {1}', t(approval.spender), t(approval.value))}</dd></div>)}
        {/* A position operation asks for no token permission (its rows already state its one wallet request). */}
        {position && !review.approvals.length && <div data-position-row="Token permission"><dt>{t('Token permission')}</dt><dd>{t('None — this operation needs no token permission')}</dd></div>}
        {!position && typeof props.walletRequests === 'number' && <div><dt>{t('Wallet requests')}</dt><dd>{props.walletRequests}</dd></div>}
      </dl>
      <p className="review-panel-note">{t(sim.fees.some(isIncludedNetworkFee) ? 'You sign; 0x sends the swap and takes the network fee out of it. FloFi never signs or pays for you.'
        : 'Your wallet pays the network fee. FloFi never signs or sends for you.')}</p>
      {warnings}
      {technical}
    </section>;
  }
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (B2): the Simulate contextual panel. Before the simulation it lists the operations, says what a simulation does
  // and holds the ONE primary action (Simulate workflow); a valid result states the expected outcome and costs with no authorization language
  // (the footer's "Review operation" leads to Execute, where the Review is authorized); an expired result shows no stale figure.
  const awaiting = !busy && !ready && !expired;
  return <section {...root} className="review-panel-approved simulation-context-panel" aria-label={t(ready ? 'Simulation result' : 'Simulation')} data-review-state={busy ? 'busy' : expired ? 'expired' : ready ? 'ready' : 'pending'} data-position-operation={position?.management.operation}>
    <SimulationPanelHead title={ready ? 'Simulation result' : expired ? 'Simulation expired' : 'Simulate workflow'}
      subtitle={ready ? until ? t('Valid until {0}. Nothing has been signed or sent.', until) : t('Nothing has been signed or sent.')
        : expired ? t('Simulate again to refresh the expected result and costs. The previous values are no longer current.')
        : t('Check the expected result, costs and possible risks.')}/>
    {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
    {ready ? <dl className="review-panel-rows simulation-result-rows">{resultRows}</dl> : <OperationSummary workflow={canvas} context={context} heading={null} variant="icons"/>}
    {ready && warnings}
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
