// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import type { ExecutionLifecycle } from '../domain/execution-lifecycle';

/** Canonical receipt values only, shared by Execute, History and conversational signing. */
export function FinancialOutcome({ progress, compact = false }: { progress: ExecutionLifecycle; compact?: boolean }) {
  const { t } = useLocale();
  const facts = progress.steps.map(step => ({ step, values: step.operations.flatMap(operation => progress.evidence?.operations[operation.id]?.values ?? []).filter(value => !value.label.startsWith('Orderbook reports')) }));
  const known = facts.some(item => item.values.length);
  return <section className={`financial-outcome${compact ? ' financial-outcome-compact' : ''}`} aria-label={t('Financial outcome')}>
    {!compact && <h2>{t('Financial outcome')}</h2>}
    {facts.map(({ step, values }) => <div className="financial-outcome-step" key={step.id}>
      <p className="financial-outcome-route">{t(step.action)} · {step.network}</p>
      {values.length > 0 && <dl>{values.map((value, index) => <div key={`${value.label}-${index}`}><dt>{t(value.label === 'Executed input' ? 'Confirmed source debit' : value.label)}</dt><dd>{t(value.value)}</dd></div>)}</dl>}
      {!compact && step.operations.some(op => op.id === 'destination') && !values.some(value => value.label === 'Actual received') && <p className="financial-unknown">{t(values.some(value => value.label === 'Destination amount observed · awaiting reconciliation') ? 'Final destination amount awaits reconciliation' : 'Destination amount not confirmed')}</p>}
    </div>)}
    {!known && <p className="financial-unknown">{t('Actual amounts are not confirmed in this record.')}</p>}
    {!compact && <>
      <h3>{t('Known financial costs')}</h3>
      {progress.evidence?.knownCosts.length ? <dl>{progress.evidence.knownCosts.map(cost => <div key={cost.label}><dt>{t(cost.label)}</dt><dd>{t(cost.value)}</dd></div>)}</dl> : <p className="financial-unknown">{t('Network costs are not recorded here.')}</p>}
      <p className="financial-unknown">{t('Unrecorded amounts and costs are unknown, never zero.')}</p>
      {progress.evidence?.attention.map(message => <p className="execution-recovery-attention" key={message}>{t(message)}</p>)}
    </>}
  </section>;
}
