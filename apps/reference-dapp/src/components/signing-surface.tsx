// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-SOLANA-TRANSFER-UX-001: the minimal FloFi signing surface a chat, MCP client or channel opens with "Authorize" (`/approve`). It is a
 * second presentation of the same workflow orchestration the Canvas uses (AppShell's runtime routing, Review binding and execution
 * controls), for every network and action: the exact requested action, the wallet that will sign, the fresh simulation's fees and limits,
 * one "Authorize in wallet" action, then the live status and the receipt. It never builds, signs or sends a transaction itself; the wallet's
 * confirmation stays mandatory and the existing runtimes keep every gate. "Open Canvas" explicitly shows the same proposal on the optional Canvas.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import { projectReview } from '../domain/review-presentation';
import { projectSimulation, simulationStatusPresentation } from '../domain/simulation-presentation';
import { isFinalExecutionResult } from '../domain/execution-result';
import type { ExecutionControls, ExecutionControlsState } from '../state/execution-controls';
import { CanvasLifecycleAction } from './canvas-lifecycle-action';
import { NetworkBrandIcon } from './brand-icon';
import { FinancialOutcome } from './financial-outcome';
import { BridgeTimeline } from './bridge-timeline';
import { ExecutionEvidenceDetails } from './execution-evidence-details';
import { ReviewTokenPermissions } from './review-workspace';
import { SimulationOutcome } from './simulation-summary';
import { networkIdentity } from '../domain/network-registry';
import { realFundsTemplate } from '../domain/network-scope';

const short = (value: string) => value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
const SIGNING_LIMITS = ['Max spend', 'Max per action', 'Max total spend', 'Max slippage', 'Minimum received', 'Max network cost', 'Max provider fees', 'Price range', 'Minimum health factor', 'Max loan-to-value'];

export type SigningSurfaceProps = ExecutionControlsState & {
  controls: ExecutionControls; workflowName: string;
  simulate: () => void | Promise<void>; simulationDisabled: boolean;
  /** The proposal is not loaded for the proven wallet yet: no simulation or authorization is offered. */
  gated: boolean;
  /** Why authorization cannot proceed with the connected wallet (e.g. it is not the wallet that loaded the proposal). */
  walletIssue?: string | null;
  connectWallet?: (() => void) | undefined;
  networkAction?: { label: string; request(): void; disabled: boolean } | undefined;
  walletRequestError?: string | null;
  approvalSlot?: ((element: HTMLDivElement | null) => void) | undefined;
  onViewInFloFi?: (() => void) | undefined;
  startNewWorkflow?: (() => void) | undefined;
  footer?: ReactNode;
};

export function SigningSurface(props: SigningSurfaceProps) {
  const { t: tr } = useLocale();
  const { workflow, context, source, authorization, wallet, controls: c } = props;
  const [clock, setClock] = useState(() => Date.now());
  const review = projectReview(workflow, context, source, authorization, wallet, Math.max(clock, Date.now()), props.invalidWorkflow);
  const simulation = projectSimulation(workflow, context, source, Math.max(clock, Date.now()));
  const live = c.live, result = c.result;
  // A one-second clock only while a validity window is open, so the countdown and expiry stay truthful.
  useEffect(() => {
    if (review.expiresAt === null || review.expiresAt <= Date.now() || live) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review.expiresAt, live]);
  const seconds = review.expiresAt === null ? null : Math.max(0, Math.round((review.expiresAt - clock) / 1000));
  const networks = [...new Set(review.steps.flatMap(step => step.network.split(' → ')))].filter(Boolean);
  // Funds belong to the reviewed network, including while the wallet is on the wrong network.
  const requiredNetwork = networkIdentity(authorization.chain ?? review.manifest?.owner.chainId);
  const limits = review.limits.filter(line => SIGNING_LIMITS.includes(line.label)).filter((line, index, all) => all.findIndex(other => other.label === line.label && other.value === line.value) === index);
  const operations = live?.steps.flatMap(step => step.operations.filter(operation => operation.hash || operation.explorer).map(operation => ({ step, operation }))) ?? [];
  let status: { label: string; message: string; tone: string };
  if (props.gated) status = { label: 'Connect your wallet', message: 'Connect the wallet that will sign. Nothing is authorized until you confirm in your wallet.', tone: 'neutral' };
  else if (live) status = { label: result?.label ?? live.label, message: result?.message ?? live.message, tone: result?.tone ?? (live.state === 'complete' ? 'ready' : live.state === 'active' ? 'neutral' : 'attention') };
  else if (props.walletIssue) status = { label: 'Wallet changed', message: props.walletIssue, tone: 'blocked' };
  else if (!authorization.key) { const s = simulationStatusPresentation(simulation, Boolean(props.invalidWorkflow), source.state.busy); status = { label: s.label, message: s.message, tone: s.tone }; }
  else status = { label: c.view.canExecute || review.canApprove ? 'Ready to authorize' : c.view.label, message: c.view.canExecute || review.canApprove
    ? 'Check the details, then authorize. Your wallet shows the exact transaction for your confirmation.' : c.view.message, tone: c.view.canExecute || review.canApprove ? 'ready' : 'blocked' };
  const final = isFinalExecutionResult(live);
  return <main id="workspace" className="main signing-surface" tabIndex={-1} aria-label={tr('Authorize with your wallet')}>
    <div className="signing-column">
      {props.approvalSlot && <div className="signing-proposal" ref={props.approvalSlot}/>}
      <section className="signing-card panel" aria-label={tr('Transaction to authorize')}>
        <header className="signing-head">
          <p className="eyebrow">{tr(review.steps.length > 1 ? '{0} actions' : 'Action', String(review.steps.length))}</p>
          <h1>{props.workflowName}</h1>
          {networks.length > 0 && <p className="signing-networks">{networks.map(network => <span key={network} className="simulation-summary-network"><NetworkBrandIcon network={network.replace(/ \(\d+\)$/, '')}/>{tr(network)}</span>)}</p>}
        </header>
        <ol className="signing-actions" aria-label={tr('Requested actions')}>
          {review.steps.map(step => {
            const outcome = !live && simulation.steps.find(value => value.id === step.id);
            return <li key={step.id}><strong>{tr(step.action)}</strong><span>{tr(step.input)}</span>
              {step.pair && <span>{tr(step.pair)}</span>}<small>{tr([step.network, step.provider].filter(Boolean).join(' · '))}</small>
              {outcome && (outcome.result || outcome.minimum) && <div className="signing-outcome"><SimulationOutcome step={outcome}/></div>}
            </li>;
          })}
        </ol>
        <dl className="signing-facts simulation-summary-values">
          <div><dt>{tr('Wallet')}</dt><dd>{wallet.account ?? tr('Connect your wallet')}</dd></div>
          {authorization.owner && authorization.owner !== wallet.account && <div><dt>{tr('Reviewed sender')}</dt><dd>{authorization.owner}</dd></div>}
          {requiredNetwork && <div><dt>{tr('Network')}</dt><dd>{tr(requiredNetwork.environment === 'MAINNET' ? 'Mainnet · Real funds' : 'Public testnet · Test funds')}</dd></div>}
          {Array.from(new Set((authorization.policy as { allowlists?: { recipients?: { address: string }[] } } | null)?.allowlists?.recipients?.map(recipient => recipient.address) ?? []))
            .map(address => <div key={address}><dt>{tr('Recipient')}</dt><dd>{address}</dd></div>)}

          {simulation.fees.map((line, index) => <div key={`fee-${index}`}><dt>{tr(line.label)}</dt><dd>{tr(line.value)}{line.note && <small>{tr(line.note)}</small>}</dd></div>)}
          {limits.map((line, index) => <div key={`limit-${index}`}><dt>{tr(line.label)}</dt><dd>{tr(line.value)}{line.note && <small>{tr(line.note)}</small>}</dd></div>)}
          {!live && seconds !== null && authorization.key && <div><dt>{tr('Valid for')}</dt><dd>{seconds > 0 ? tr('{0}s', String(seconds)) : tr('Expired')}</dd></div>}
        </dl>
        {authorization.tokens.length > 0 && <details className="signing-contract-details"><summary>{tr('Token contracts')}</summary><dl className="simulation-summary-values">{authorization.tokens.map(token => <div key={`${token.chain}:${token.address}`}><dt>{tr(token.chain.startsWith('solana:') ? 'Token mint' : 'Token contract')}</dt><dd>{token.symbol} · {token.address}</dd></div>)}</dl></details>}
        {realFundsTemplate(requiredNetwork?.chain) && <p className="signing-real-funds">{tr(...realFundsTemplate(requiredNetwork?.chain)!)}</p>}
        <ReviewTokenPermissions review={review}/>
        <div className={`signing-status simulation-validity simulation-tone-${status.tone}`} role="status" aria-live="polite"><strong><span className="simulation-status-dot" aria-hidden="true"/>{tr(status.label)}</strong><p>{tr(status.message)}</p></div>
        {!live && review.warnings.filter(w => w.message !== status.message).map((warning, index) => <p key={index} className={warning.severity === 'blocking' ? 'simulation-warning-blocking' : 'signing-risk'}>{tr(warning.message)}</p>)}
        {operations.length > 0 && <ul className="signing-receipt" aria-label={tr('Transactions')}>
          {operations.map(({ step, operation }) => <li key={operation.id}><span>{tr(step.action)} · {tr(operation.label)}</span>
            {operation.explorer ? <a href={operation.explorer} target="_blank" rel="noreferrer">{tr('View transaction')}</a> : operation.hash && <code title={operation.hash}>{short(operation.hash)}</code>}</li>)}
        </ul>}
        {live && <FinancialOutcome progress={live}/>}
        {live?.bridgeStages && <BridgeTimeline stages={live.bridgeStages} local={live.local} evidence={live.evidence}/>}
        {live && <details><summary>{tr('Transaction and reconciliation evidence')}</summary><ExecutionEvidenceDetails progress={live}/>
          {live.runKey && <a href={`/app/dashboard/runs/${encodeURIComponent(live.runKey)}`}>{tr('View receipt and evidence')}</a>}
        </details>}
        {final && <p className="signing-return">{tr('You can return to your conversation. Its status follows this result when status sharing is on.')}</p>}
        <div className="signing-actions-row">
          {!props.gated && !final && props.connectWallet && (!wallet.account || props.walletIssue) ? <button type="button" className="primary" onClick={props.connectWallet}>{tr(props.walletIssue ? 'Use another wallet' : 'Connect Wallet')}</button>
            : !props.gated && !final && props.networkAction ? <button type="button" className="primary" disabled={props.networkAction.disabled} onClick={props.networkAction.request}>{tr(props.networkAction.label)}</button>
            : !props.gated && !final && <CanvasLifecycleAction {...props} controls={c} simulate={props.simulate} simulationDisabled={props.simulationDisabled || Boolean(props.walletIssue)}/>}
          {final && props.startNewWorkflow && <button type="button" className="secondary" onClick={props.startNewWorkflow}>{tr('Create new workflow')}</button>}
        </div>
        {props.walletRequestError && <p className="simulation-warning-blocking" role="status">{tr(props.walletRequestError)}</p>}
        {(c.requestFailed || live && source.state.error) && <p className="simulation-warning-blocking" role="status">{tr('The last request could not complete. Check the recorded status before taking another action.')}</p>}
      </section>
      {props.onViewInFloFi && <p className="signing-foot"><button type="button" className="quiet" onClick={props.onViewInFloFi}>{tr('Open Canvas')}</button></p>}
      {props.footer}
    </div>
  </main>;
}
