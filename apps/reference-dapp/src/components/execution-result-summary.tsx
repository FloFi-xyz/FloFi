// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * Execution UX regression fixes: the run's result, compact, inside the Execute status panel beside the Canvas (never only in the long "Execution
 * details" below it): amount sent, amount received (the reconciled amount once the record observed it, replacing the pre-execution estimate on
 * the card), verified network fees, the transaction to verify, and each step's status. The step count and the status line stay in the panel.
 * Amounts read at six significant digits with the exact recorded value one tap away (`TokenAmountText`). Presentation only
 * (`projectLiveExecutionResult`): nothing is fetched, estimated or rounded to zero; it starts nothing.
 */
import { useLocale } from '../i18n/locale';
import type { ExecutionLifecycle } from '../domain/execution-lifecycle';
import { projectLiveExecutionResult } from '../domain/execution-receipt';
import { Amount, TransactionLink } from './dashboard/execution-receipt';

const SENT = ['You sent', 'You supplied', 'Configured amount'];

export function ExecutionResultSummary({ live }: { live: ExecutionLifecycle }) {
  const { t } = useLocale();
  const result = projectLiveExecutionResult(live);
  if (!result.values.length && !result.fees.length && !result.transaction && !result.steps.length) return null;
  const sent = result.values.filter(row => SENT.includes(row.label)), results = result.values.filter(row => !SENT.includes(row.label));
  return <div className="execution-result-compact" data-execution-result="compact">
    {result.values.length > 0 && <dl className="execution-receipt-amounts">
      {[...sent, ...results].map(row => <div key={`${row.label}:${row.value}`} data-observed={row.observed || undefined}>
        <dt>{t(row.label, ...row.args ?? [])}</dt><dd><Amount row={row}/></dd></div>)}
    </dl>}
    {result.steps.length > 0 && <ol className="execution-receipt-steps" aria-label={t('Steps')}>{result.steps.map(step => <li key={step.number} data-tone={step.tone}>
      <span className="execution-receipt-step-number" aria-hidden="true">{step.number}</span>
      <div className="execution-receipt-step-body">
        <p className="execution-receipt-step-head"><strong>{t(step.action)}</strong><span className="execution-receipt-step-network"> · {t(step.network)}</span>
          <span className="execution-receipt-step-status" data-tone={step.tone}>{t(step.status)}</span></p>
        {step.values.length > 0 && <dl className="execution-receipt-step-values">{step.values.map(row => <div key={`${row.label}:${row.value}`} data-observed={row.observed || undefined}>
          <dt>{t(row.label, ...row.args ?? [])}</dt><dd><Amount row={row}/></dd></div>)}</dl>}
        {step.transaction && <TransactionLink link={step.transaction}/>}
      </div>
    </li>)}</ol>}
    {result.fees.length > 0 && <dl className="execution-receipt-facts">
      {result.fees.map(fee => <div key={`${fee.label}:${fee.args?.join() ?? ''}`}><dt>{t(fee.label, ...fee.args ?? [])}</dt><dd><Amount row={fee}/></dd></div>)}
    </dl>}
    {result.transaction?.explorer && <div className="execution-receipt-actions"><TransactionLink link={result.transaction}/></div>}
  </div>;
}
