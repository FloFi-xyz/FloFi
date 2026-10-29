// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { translate } from '../i18n/locale';
import type { ConversationExecution, ConversationLanguage, ConversationReview } from '../domain/conversation-lifecycle';

const short = (value: string) => value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the Review the chat presents, in the language FloFi answered in. Every value is the existing simulation and Review
 * projection's own (no quote, price, fee or result is computed here); a value the simulation does not provide is labelled as not provided.
 */
export function ConversationReviewCard({ review, language }: { review: ConversationReview; language: ConversationLanguage }) {
  const t = (value: string, ...parameters: (string | number)[]) => translate(language, value, ...parameters);
  const sequence = review.sequence, simulated = review.steps[0];
  const details = (step: ConversationReview['steps'][number]) => <dl>
    <div><dt>{t(step.resultLabel)}</dt><dd>{step.result ?? t('Not provided by this simulation')}</dd></div>
    {step.minimum && <div><dt>{t('Minimum received')}</dt><dd>{step.minimum}</dd></div>}
    {step.slippage && <div><dt>{t('Max slippage')}</dt><dd>{step.slippage}</dd></div>}
    {step.priceImpact && <div><dt>{t('Price impact')}</dt><dd>{step.priceImpact}</dd></div>}
    {step.details.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
  </dl>;
  return <section className="conversation-review" aria-label={t('Workflow review')}>
    {/* BUILD-FLOFI-CHAT-E2E-FIX-002: a sequence lists every canonical action in order; only the current step is simulated now. */}
    {sequence ? <ol className="conversation-review-steps" aria-label={t('Workflow actions')}>{sequence.steps.map(step => <li key={step.number} data-sequence-state={step.state}>
      <strong>{step.number}. {t(step.action)}</strong>
      <span className="conversation-review-route">{[step.amount && t(step.amount), step.detail && !step.amount?.includes(step.detail) ? t(step.detail) : null, step.network].filter(Boolean).join(' · ')}</span>
      <span className="conversation-review-state">{step.state === 'COMPLETED' ? step.delivered ? t('Completed and reconciled · delivered {0}', step.delivered) : t('Completed and reconciled')
        : step.state === 'CURRENT' ? t('Simulated now') : t('Simulated with a fresh quote after step {0} reconciles; you confirm it separately', step.number - 1)}</span>
      {step.funding && <span className="conversation-review-funding">{step.funding.bound ? t('Funded by step {0}: spends {1} (what step {0} delivered, at most {2})', step.funding.from, step.funding.bound, step.funding.cap)
        : t('Funded by step {0}: spends the smaller of {1} and what step {0} actually delivers', step.funding.from, step.funding.cap)}</span>}
      {step.state === 'CURRENT' && simulated && details(simulated)}
    </li>)}</ol>
    : <ol className="conversation-review-steps">{review.steps.map(step => <li key={step.number}>
      <strong>{step.number}. {t(step.action)}</strong>
      <span className="conversation-review-route">{[t(step.input), step.pair && t(step.pair), step.networks, step.provider].filter(Boolean).join(' · ')}</span>
      {details(step)}
    </li>)}</ol>}
    <dl className="conversation-review-lines" aria-label={t('Costs')}>
      {review.fees.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{line.value}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
      {review.unknown.map(name => <div key={name} data-unknown="true"><dt>{t(name)}</dt><dd>{t('Not provided by this simulation')}</dd></div>)}
      <div className="conversation-review-total"><dt>{t('Estimated total cost')}</dt><dd>{review.totals.known.length ? review.totals.known.join(' + ') : t('Not available from this simulation')}
        {review.totals.excludes.length > 0 && <small>{t('Excludes: {0}', review.totals.excludes.map(item => t(item.text, ...item.parameters)).join('; '))}</small>}</dd></div>
      {review.account && <div><dt>{t('Wallet')}</dt><dd title={review.account}>{short(review.account)}</dd></div>}
      {review.network && <div><dt>{t('Network')}</dt><dd>{review.network}</dd></div>}
      {review.expiresAt !== null && <div><dt>{t('Valid until')}</dt><dd><time dateTime={new Date(review.expiresAt).toISOString()}>{new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US')}</time></dd></div>}
    </dl>
    {(review.warnings.length > 0 || sequence) && <ul className="conversation-review-warnings" aria-label={t('Risks and warnings')}>
      {sequence && <li data-severity="attention">{t('This workflow runs as {0} separate wallet transactions, one step at a time. If a later step fails or you stop, the earlier steps stay executed and their assets stay in your wallet.', sequence.total)}</li>}
      {review.warnings.map((warning, index) => <li key={index} data-severity={warning.severity}>{t(warning.message)}</li>)}</ul>}
    {(review.limits.length > 0 || review.approvals.length > 0) && <details className="conversation-review-details"><summary>{t('Approvals and limits')}</summary><dl className="conversation-review-lines">
      {review.limits.map(line => <div key={`${line.label}:${line.value}:${line.note ?? ''}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
      {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.spender}`}><dt>{t('Token approval')}</dt><dd>{t(approval.value)} · {approval.symbol} · {t(approval.spender)} · {approval.network}</dd></div>)}
    </dl></details>}
    <p className="conversation-review-note">{t('Estimates from this simulation, not executed results. Your wallet shows every request before you sign it.')}</p>
  </section>;
}
/** The current run as its durable record reports it, re-read on every render: never what the chat said earlier. */
export function ConversationExecutionCard({ execution, language }: { execution: ConversationExecution; language: ConversationLanguage }) {
  const t = (value: string, ...parameters: (string | number)[]) => translate(language, value, ...parameters);
  return <section className="conversation-execution" aria-label={t('Execution status')} data-phase={execution.phase}>
    {execution.sequenceStep && <p className="conversation-execution-step"><strong>{t('Step {0} of {1}: {2}', execution.sequenceStep.current, execution.sequenceStep.total, t(execution.sequenceStep.action))}</strong>
      {' · '}{t('{0} of {1} workflow steps completed', execution.sequenceStep.completed, execution.sequenceStep.total)}</p>}
    <p role="status" aria-live="polite"><strong>{t(execution.label)}</strong> {t(execution.message)}</p>
    <p className="conversation-execution-count">{t('{0} of {1} steps confirmed', execution.completed, execution.total)}{execution.current && !execution.final ? ` · ${t('Current step')}: ${t(execution.current)}` : ''}</p>
    <ul className="conversation-execution-operations">{execution.operations.map(operation => <li key={operation.id} data-state={operation.state}>
      <span>{t(operation.title)}</span> · <span>{t(operation.label)}</span> · <span>{operation.network}</span>
      {operation.hash && <> · {operation.explorer ? <a href={operation.explorer} target="_blank" rel="noreferrer" title={operation.hash}>{short(operation.hash)}</a> : <code title={operation.hash}>{short(operation.hash)}</code>}</>}
    </li>)}</ul>
    {(execution.received.length > 0 || execution.costs.length > 0) && <dl className="conversation-review-lines">
      {execution.received.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{line.value}</dd></div>)}
      {execution.costs.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{line.value}</dd></div>)}
    </dl>}
  </section>;
}
