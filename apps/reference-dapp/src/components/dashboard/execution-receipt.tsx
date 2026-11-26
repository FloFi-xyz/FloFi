// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (workstream B): a historical execution opens on a simple financial receipt — the operation and its outcome,
 * when, what was sent and received, network, protocol, known network cost, wallet, steps and where to verify the transaction. Read-only and
 * presentation only (`projectExecutionReceipt`); every engineering detail stays one click away under "Technical details" in the run view. It starts
 * nothing: the only action besides the explorer link is the existing "Open current execution" of a run that is still the current one.
 */
import { TokenAmountText } from '../token-amount-text';
import { useLocale } from '../../i18n/locale';
import { CopyValue } from '../copy-value';
import type { DashboardRunView } from '../../lib/dashboard/types';
import { projectExecutionReceipt, receiptDate, shortAddress, type ReceiptLink, type ReceiptValue } from '../../domain/execution-receipt';
import { ActionIcon } from '../action-icon';
import { NetworkBrandIcon } from '../brand-icon';

const ICON: Readonly<Record<string, Parameters<typeof ActionIcon>[0]['action']>> = {
  Swap: 'swap', Bridge: 'bridge', 'Pool / Liquidity': 'pool', 'Prepare liquidity': 'pool', Send: 'transfer', Supply: 'supply', Borrow: 'borrow',
  Repay: 'repay', Withdraw: 'withdraw', Stocks: 'stocks',
};

export function Amount({ row }: { row: ReceiptValue }) {
  const { t } = useLocale();
  // The amount the owner configured stays exactly as set; recorded amounts read at six significant digits with the exact value one tap away.
  if (row.label === 'Configured amount') return <span className="execution-receipt-amount">{t(row.value)}</span>;
  // BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: six significant digits; the exact recorded amount one tap away (and in Technical details).
  return <TokenAmountText className="execution-receipt-amount" value={row.value}/>;
}

export function TransactionLink({ link }: { link: ReceiptLink }) {
  const { t } = useLocale();
  if (!link.explorer) return null;
  return <a className="execution-receipt-link" href={link.explorer} target="_blank" rel="noopener noreferrer">{t('View transaction')}
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
    <span className="sr-only"> ({t('opens in a new tab')})</span></a>;
}

export function ExecutionReceipt({ view, execute }: { view: DashboardRunView; execute(): void }) {
  const { t, language } = useLocale();
  const receipt = projectExecutionReceipt(view);
  // An operation's name is a catalog word; a workflow's name is the owner's own and is never translated (flofi-frontend-ux review).
  const title = receipt.titleIsAction ? t(receipt.title) : receipt.title;
  const when = receiptDate(receipt.at, language === 'PT' ? 'PT' : 'EN');
  const sent = receipt.values.filter(row => ['You sent', 'You supplied', 'Configured amount'].includes(row.label));
  const results = receipt.values.filter(row => !sent.includes(row));
  return <section className="panel execution-receipt" aria-labelledby="execution-receipt-title" data-tone={receipt.tone} data-steps={receipt.steps.length || 1}>
    <header className="execution-receipt-head">
      <span className="execution-receipt-icon" aria-hidden="true"><ActionIcon action={receipt.titleIsAction ? ICON[receipt.title] ?? 'action' : 'action'}/></span>
      <div className="execution-receipt-heading">
        <h1 id="execution-receipt-title"><span className="execution-receipt-title" title={title}>{title}</span>{' '}
          <span className="execution-receipt-status" data-tone={receipt.tone}>— {t(receipt.status)}</span></h1>
        {when && <p className="execution-receipt-date"><time dateTime={receipt.at!}>{when}</time></p>}
        {receipt.provenance && <p className="execution-receipt-provenance">{t(receipt.provenance)}</p>}
      </div>
    </header>
    {receipt.notice && <div className="execution-receipt-notice" data-tone={receipt.tone} role="status">
      <p>{t(receipt.notice.message)}</p>
      {receipt.notice.items.length > 0 && <ul>{receipt.notice.items.map(item => <li key={item}>{t(item)}</li>)}</ul>}
      {!view.current && receipt.tone !== 'success' && <p className="execution-receipt-readonly">{t('This saved view does not retry or continue execution.')}</p>}
    </div>}
    {receipt.values.length > 0 && <dl className="execution-receipt-amounts">
      {[...sent, ...results].map(row => <div key={`${row.label}:${row.value}`} data-observed={row.observed || undefined}>
        <dt>{t(row.label, ...row.args ?? [])}</dt><dd><Amount row={row}/></dd></div>)}
    </dl>}
    {receipt.steps.length > 0 && <ol className="execution-receipt-steps" aria-label={t('Steps')}>{receipt.steps.map(step => <li key={step.number} data-tone={step.tone}>
      <span className="execution-receipt-step-number" aria-hidden="true">{step.number}</span>
      <div className="execution-receipt-step-body">
        <p className="execution-receipt-step-head"><strong>{t(step.action)}</strong><span className="execution-receipt-step-network"> · {t(step.network)}</span>
          <span className="execution-receipt-step-status" data-tone={step.tone}>{t(step.status)}</span></p>
        {step.values.length > 0 && <dl className="execution-receipt-step-values">{step.values.map(row => <div key={`${row.label}:${row.value}`} data-observed={row.observed || undefined}>
          <dt>{t(row.label, ...row.args ?? [])}</dt><dd><Amount row={row}/></dd></div>)}</dl>}
        {step.recipient && <p className="execution-receipt-step-recipient">{t('Recipient')}: <CopyValue value={step.recipient} shown={shortAddress(step.recipient)} label="Recipient" step={step.number}/></p>}
        {step.transaction && <TransactionLink link={step.transaction}/>}
      </div>
    </li>)}</ol>}
    <dl className="execution-receipt-facts">
      {receipt.network && <div><dt>{t('Network')}</dt><dd className="execution-receipt-networks">{receipt.network.split(' · ').map(network => <span key={network}>
        {network.split(' → ').map((part, index) => <span key={part} className="execution-receipt-network">{index > 0 && <><span aria-hidden="true">→ </span><span className="sr-only">{t('to')} </span></>}<NetworkBrandIcon network={part}/>{t(part)}</span>)}</span>)}</dd></div>}
      {receipt.protocol && <div><dt>{t('Protocol')}</dt><dd>{t(receipt.protocol)}</dd></div>}
      {receipt.recipient && <div><dt>{t('Recipient')}</dt><dd><CopyValue value={receipt.recipient} shown={shortAddress(receipt.recipient)} label="Recipient"/></dd></div>}
      {receipt.fees.length ? receipt.fees.map(fee => <div key={`${fee.label}:${fee.args?.join() ?? ''}`}><dt>{t(fee.label, ...fee.args ?? [])}</dt><dd><Amount row={fee}/></dd></div>)
        : receipt.submitted && <div><dt>{t('Network fee')}</dt><dd className="execution-receipt-unrecorded">{t('Not recorded in this history')}</dd></div>}
      {receipt.wallet && <div><dt>{t('Wallet')}</dt><dd><CopyValue value={receipt.wallet} shown={shortAddress(receipt.wallet)} label="Wallet"/></dd></div>}
      {receipt.total !== null && <div><dt>{t('Steps completed')}</dt><dd>{t('{0} of {1}', String(receipt.completed ?? 0), String(receipt.total))}</dd></div>}
    </dl>
    {(receipt.transaction?.explorer || view.current) && <div className="execution-receipt-actions">
      {receipt.transaction && <TransactionLink link={receipt.transaction}/>}
      {view.current && <button type="button" className="dashboard-primary" onClick={execute}>{t(view.status === 'Completed' || view.status === 'Completed with attention' ? 'View execution result' : 'Open current execution')}</button>}
    </div>}
  </section>;
}
