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
  return <section className="conversation-review" aria-label={t('Workflow review')}>
    <ol className="conversation-review-steps">{review.steps.map(step => <li key={step.number}>
      <strong>{step.number}. {t(step.action)}</strong>
      <span className="conversation-review-route">{[t(step.input), step.pair && t(step.pair), step.networks, step.provider].filter(Boolean).join(' · ')}</span>
      <dl>
        <div><dt>{t(step.resultLabel)}</dt><dd>{step.result ?? t('Not provided by this simulation')}</dd></div>
        {step.minimum && <div><dt>{t('Minimum received')}</dt><dd>{step.minimum}</dd></div>}
        {step.slippage && <div><dt>{t('Max slippage')}</dt><dd>{step.slippage}</dd></div>}
        {step.priceImpact && <div><dt>{t('Price impact')}</dt><dd>{step.priceImpact}</dd></div>}
        {step.details.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
      </dl>
    </li>)}</ol>
    <dl className="conversation-review-lines" aria-label={t('Fees and limits')}>
      {review.fees.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{line.value}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
      {review.unknown.map(name => <div key={name} data-unknown="true"><dt>{t(name)}</dt><dd>{t('Not provided by this simulation')}</dd></div>)}
      {review.limits.map(line => <div key={`${line.label}:${line.value}:${line.note ?? ''}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
      {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.spender}`}><dt>{t('Token approval')}</dt><dd>{t(approval.value)} · {approval.symbol} · {t(approval.spender)} · {approval.network}</dd></div>)}
      {review.account && <div><dt>{t('Wallet')}</dt><dd title={review.account}>{short(review.account)}</dd></div>}
      {review.network && <div><dt>{t('Network')}</dt><dd>{review.network}</dd></div>}
      {review.expiresAt !== null && <div><dt>{t('Valid until')}</dt><dd><time dateTime={new Date(review.expiresAt).toISOString()}>{new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US')}</time></dd></div>}
    </dl>
    {review.warnings.length > 0 && <ul className="conversation-review-warnings" aria-label={t('Risks and warnings')}>{review.warnings.map((warning, index) =>
      <li key={index} data-severity={warning.severity}>{t(warning.message)}</li>)}</ul>}
    <p className="conversation-review-note">{t('Estimates from this simulation, not executed results. Your wallet shows every request before you sign it.')}</p>
  </section>;
}
/** The current run as its durable record reports it, re-read on every render: never what the chat said earlier. */
export function ConversationExecutionCard({ execution, language }: { execution: ConversationExecution; language: ConversationLanguage }) {
  const t = (value: string, ...parameters: (string | number)[]) => translate(language, value, ...parameters);
  return <section className="conversation-execution" aria-label={t('Execution status')} data-phase={execution.phase}>
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
