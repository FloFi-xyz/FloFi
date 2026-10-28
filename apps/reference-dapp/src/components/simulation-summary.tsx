// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useEffect, useState } from 'react';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from '../domain/initial-workflow';
import { projectSimulation, simulationInputLabel, simulationStatusPresentation, type SimulationSource, type SimulationLine, type SimulationStep } from '../domain/simulation-presentation';
import { NetworkBrandIcon, TokenBrandIcon } from './brand-icon';

function Lines({ lines }: { lines: SimulationLine[] }) {
  const { t: tr } = useLocale();
  return <dl className="simulation-summary-values">{lines.map((line, index) => <div key={`${line.label}-${index}`}>
    <dt>{tr(line.label)}</dt><dd>{tr(line.value)}{line.note && <small>{tr(line.note)}</small>}</dd>
  </div>)}</dl>;
}
function TokenAmount({ value }: { value: string }) {
  const { t: tr } = useLocale();
  // Reuse supported original-color assets; descriptive outcomes retain plain text.
  const symbol = value.match(/ (USDC\.e|USDC|devUSDC|WETH|ETH|SOL|WSOL|USDT)$/)?.[1];
  return <span className="simulation-token-amount">{symbol && <TokenBrandIcon symbol={symbol}/>}<span>{tr(value)}</span></span>;
}
export function SimulationSummary({ workflow, context, source, invalidWorkflow = false, unavailableReason }: {
  workflow: Workflow; context: ReviewContext; source?: SimulationSource | undefined; invalidWorkflow?: boolean; unavailableReason?: string | null | undefined;
}) {
  const { t: tr, language } = useLocale();
  const [clock, setClock] = useState(() => Date.now());
  // Also evaluate now on ordinary renders, so an old clock cannot revive an expired record.
  const details = projectSimulation(workflow, context, source, Math.max(clock, Date.now()));
  const expiresAt = details.expiresAt;
  useEffect(() => {
    if (expiresAt === null || expiresAt <= Date.now()) return;
    const update = () => setClock(Date.now());
    const timer = window.setTimeout(update, Math.min(expiresAt - Date.now() + 1, 2_147_483_647));
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [expiresAt]);
  const status = simulationStatusPresentation(details, invalidWorkflow, source?.state.busy);
  const message = unavailableReason && details.steps.length > 0 && details.status !== 'ready' && !source?.state.busy ? unavailableReason : status.message;
  const networks = [...new Set(details.steps.flatMap(step => step.networks))];
  const multiple = details.steps.length > 1;
  const markets = details.steps.filter(step => step.configuredSlippage || step.slippage || step.priceImpact);
  return <>
    <div className="simulation-summary-heading"><h2>{tr("Simulation Summary")}</h2><p>{tr("What is expected to happen.")}</p></div>
    <div className={`simulation-validity simulation-tone-${status.tone}`} role="status" aria-live="polite">
      <strong><span aria-hidden="true" className="simulation-status-dot"/>{tr(status.label)}</strong>
      {!details.warnings.some(warning => warning.message === message) && <p>{tr(message)}</p>}
      {expiresAt !== null && expiresAt > Math.max(clock, Date.now()) && !invalidWorkflow && <small>{tr("Valid until ")}<time dateTime={new Date(expiresAt).toISOString()}>{tr(new Date(expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time></small>}
    </div>
    <section className="simulation-summary-section" aria-label={tr("Expected result")}>
      <h3>{tr("Expected result")}</h3>
      {details.steps.length ? <ol className="simulation-results">{details.steps.map(step => <li key={step.id}>
        <div className="simulation-step-title">{multiple && <span className="simulation-step-number">{tr(step.number)}</span>}<strong>{tr(step.action)}</strong></div>
        <div className="simulation-money-pair">
          <div className="simulation-money-source"><span className="simulation-result-label">{tr(simulationInputLabel(step.action))}</span><div className="simulation-input"><TokenAmount value={step.input}/></div><span className="simulation-money-network">{step.networks[0]}</span></div>
          <div className="simulation-money-destination"><SimulationOutcome step={step}/><span className="simulation-money-network">{step.networks.at(-1)}</span></div>
        </div>
        <p className="simulation-estimate-note">{tr('Estimate only. No funds have moved.')}{step.provider && <> · {step.provider}</>}</p>
      </li>)}</ol> : <p className="simulation-empty-value">—</p>}
    </section>
    <section className="simulation-summary-section" aria-label={tr("Fees")}><h3>{tr("Fees")}</h3>
      {details.fees.length ? <Lines lines={details.fees}/> : <p className="simulation-empty-value">—</p>}
    </section>
    <section className="simulation-summary-section" aria-label={tr("Market impact")}><h3>{tr("Market impact")}</h3>
      {markets.length ? markets.map(step => <div key={step.id}>
        {multiple && <p className="simulation-market-step">{tr("Step ")}{tr(step.number)} · {tr(step.action)}</p>}
        <Lines lines={[
          { label: 'Slippage', value: step.slippage ?? step.configuredSlippage ?? '—', note: step.slippage ? 'Execution limit' : 'Configured limit' },
          ...(step.slippage && step.configuredSlippage && step.slippage !== step.configuredSlippage ? [{ label: 'Configured limit', value: step.configuredSlippage }] : []),
          { label: 'Price impact', value: step.priceImpact ?? '—' },
        ]}/>
      </div>) : <Lines lines={[{ label: 'Slippage', value: '—' }, { label: 'Price impact', value: '—' }]}/>}
    </section>
    {details.warnings.length > 0 && <section className="simulation-summary-section" aria-label={tr("Risk and attention")}><h3>{tr("Risk / attention")}</h3>
      <ul className="simulation-attention">{details.warnings.map((warning, index) => <li className={`simulation-warning-${warning.severity}`} key={index}>
        <span className="simulation-warning-label">{tr(warning.severity === 'blocking' ? 'Blocking' : warning.severity === 'attention' ? 'Attention' : 'Informational')}</span>
        {tr(warning.message)}
      </li>)}</ul>
    </section>}
    <details className="simulation-summary-section simulation-route-details" aria-label={tr("Route")}><summary>{tr("Route details")}</summary>
      {!details.steps.length && <p className="simulation-empty-value">—</p>}
      <ol className="simulation-route">{details.steps.map(step => <li key={step.id}>
        <span className="simulation-route-context">{tr(multiple ? `${step.number}. ${step.action}` : step.action)}{step.pair && <small>{tr(step.pair)}</small>}</span>
        <strong>{tr(step.provider ?? '—')}</strong>
        {step.networks.length > 1 && <small>{tr(step.networks.join(' → '))}</small>}
      </li>)}</ol>
      <dl className="simulation-summary-values simulation-network"><div><dt>{tr("Workflow network")}</dt><dd>{networks.length ? networks.map(network => <span className="simulation-summary-network" key={network}>
        <NetworkBrandIcon network={network.replace(/ \(\d+\)$/, '').replace('Robinhood Chain Testnet', 'Robinhood Chain')}/>{network}
      </span>) : '—'}</dd></div></dl>
    </details>
  </>;
}

/** The same simulated outcome and execution minimum in Canvas and the chat signing review. */
export function SimulationOutcome({ step }: { step: SimulationStep }) {
  const { t: tr } = useLocale();
  return <>
    <span className="simulation-result-label">{tr(step.resultLabel)}</span>
    <div className="simulation-result"><span aria-hidden="true">→</span><TokenAmount value={step.result ?? '—'}/></div>
    {step.minimum && <p className="simulation-minimum">{tr('Minimum received · ')}{tr(step.minimum)}</p>}
    {step.details.length > 0 && <Lines lines={step.details}/>}
  </>;
}
