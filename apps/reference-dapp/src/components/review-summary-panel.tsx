// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 approved UX (board 06 "Simulate and review", board 07 "Blocked"): the Review panel beside the simulated canvas, or the blocker panel that
 * replaces it. Presentation only: every value is the existing simulation and Review projections' own (`projectSimulation`, `projectReview`), and
 * the fee-shortfall numbers are the server's own evidence (`NativeFeeShortfall`). It has NO authorize control: the one primary action is the
 * footer's lifecycle button. Nothing here quotes, signs, submits or retries; a balance that arrives never re-simulates by itself.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { useLocale } from '../i18n/locale';
import type { Workflow } from '../domain/initial-workflow';
import { projectSimulation, simulationStatusPresentation, type SimulationSource } from '../domain/simulation-presentation';
import { projectReview, type ReviewAuthorization, type ReviewWallet } from '../domain/review-presentation';
import { flightRefusal, FLIGHT_REFUSAL_HREF } from '../domain/flight-refusal';
import { feeShortfallView } from '../domain/approved-ux';
import { circleUnavailableReason } from '../domain/token-fee';
import { isIncludedNetworkFee, SIGNATURES_LABEL } from '../domain/gas-payment';
import type { NativeFeeShortfall } from '../user-funded/groups';

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
};

function useNow(until: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return Math.max(now, Date.now());
}

export function ReviewSummaryPanel(props: ReviewSummaryPanelProps) {
  const { t } = useLocale();
  const { workflow, context, source, authorization, wallet, invalidWorkflow = false } = props;
  const sim = projectSimulation(workflow, context, source, Date.now());
  const now = useNow(sim.expiresAt);
  const status = simulationStatusPresentation(sim, invalidWorkflow, source.state.busy);
  const review = projectReview(workflow, context, source, authorization, wallet, now, invalidWorkflow);
  const busy = Boolean(source.state.busy);
  const blocked = !busy && sim.status === 'blocked';
  const technical = props.technical ? <details className="review-panel-technical"><summary>{t(blocked ? 'Technical details, for support' : 'Technical details')}</summary>
    {blocked && source.state.error && <p className="review-panel-code"><code>{source.state.error}</code></p>}{props.technical}</details> : null;
  if (blocked) return <BlockerPanel message={props.unavailableReason ?? status.message} title={status.label} error={source.state.error ?? null}
    owner={wallet.account} feeShortfall={props.feeShortfall ?? null} technical={technical}/>;
  const ready = review.status === 'ready' || review.status === 'approved';
  const step = sim.steps[sim.steps.length - 1];
  return <section className="review-panel-approved" aria-label={t('Review')} data-review-state={busy ? 'busy' : ready ? 'ready' : 'pending'}>
    {props.sequenceNote && <p className="review-panel-sequence" role="note">{props.sequenceNote}</p>}
    <p className="eyebrow">{t('REVIEW')}</p>
    <h2>{t('You are authorizing')}</h2>
    {!ready || busy ? <p className="review-panel-status" role="status">{t(busy ? 'Simulating workflow…' : props.unavailableReason ?? status.message)}</p> : <>
      <dl className="review-panel-rows">
        {sim.steps.map(s => <div key={s.id}><dt>{t(s.action)}</dt><dd>{t(s.input)}{s.result ? <>{' → '}<span className="numeric">{t(s.result)}</span></> : null}</dd></div>)}
        {step?.minimum && <div><dt>{t('Minimum you receive')}</dt><dd className="numeric">{t(step.minimum)}</dd></div>}
        {sim.fees.filter(line => line.treatment === 'CEILING' || line.treatment === 'ADDITIONAL').map(line =>
          <div key={`${line.label}:${line.value}`}><dt>{t(line.treatment === 'CEILING' ? 'Network fee, at most' : line.label)}</dt><dd className="numeric">{t(line.value)}</dd></div>)}
        {/* ADR-0010: a network fee 0x takes out of the swap is shown as such, in the swap's token (never "free", never added on top). */}
        {sim.fees.filter(isIncludedNetworkFee).map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd className="numeric">{t(line.value)}</dd></div>)}
        {step?.details.filter(line => line.label === SIGNATURES_LABEL).map(line => <div key={line.label}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
        {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.address}`}><dt>{t('Token permission')}</dt>
          <dd>{approval.unlimited ? t('This allowance has no spending cap. It remains available to the spender until changed or revoked.')
            : t('{0} uses up to {1}', t(approval.spender), t(approval.value))}</dd></div>)}
        {typeof props.walletRequests === 'number' && <div><dt>{t('Wallet requests')}</dt><dd>{props.walletRequests}</dd></div>}
      </dl>
      <p className="review-panel-note">{t(sim.fees.some(isIncludedNetworkFee) ? 'You sign; 0x sends the swap and takes the network fee out of it. FloFi never signs or pays for you.'
        : 'Your wallet pays the network fee. FloFi never signs or sends for you.')}</p>
    </>}
    {technical}
  </section>;
}

/** Board 07: what blocks the simulation, the server's own numbers when it has them, and the one next action (the footer keeps "Simulate again"). */
export function BlockerPanel({ title, message, error, owner, feeShortfall, technical }: { title: string; message: string; error: string | null; owner: string | null;
  feeShortfall: NativeFeeShortfall | null; technical: ReactNode }) {
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
  return <section className="review-panel-approved review-panel-blocked" aria-label={t('Before authorizing')} data-review-state="blocked">
    <p className="eyebrow">{t('BEFORE AUTHORIZING')}</p>
    <h2>{fee ? t('Not enough {0} on {1} for the network fee', fee.symbol, t(fee.network)) : t(title)}</h2>
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
    {technical}
  </section>;
}
