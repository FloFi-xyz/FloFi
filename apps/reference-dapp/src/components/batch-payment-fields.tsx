// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the Batch Payment card's own fields, the one new visual component of this build. It reuses
 * the Canvas card's existing design system (the Send card's address field, the amount form's buttons and notes): one network, one asset, 2..8
 * recipients each with its own exact amount, the recipient count and the exact total. Nothing here signs, simulates or executes: Apply hands the
 * draft to the Editor's existing authoring command (`ADD_BATCH_PAYMENT` / `SET_BATCH_PAYMENT`), which validates it again, and the shared Review and
 * execution surfaces take it from there.
 */
import { useId, useState } from 'react';
import { useLocale } from '../i18n/locale';
import type { BatchPaymentDraftCheck } from '../domain/batch-payment-authoring';

export type BatchPaymentCardRow = { readonly recipient: string; readonly amount: string };
export type BatchPaymentCardData = {
  readonly network: string; readonly asset: string;
  readonly networks: readonly string[]; readonly assets: readonly string[];
  readonly rows: readonly BatchPaymentCardRow[]; readonly maxRecipients: number; readonly minRecipients: number;
  readonly check: BatchPaymentDraftCheck;
  /** The draft differs from the saved step (a new card is always a draft). */
  readonly changed: boolean;
  readonly applyLabel: string;
  onNetwork(network: string): void; onAsset(asset: string): void;
  onRow(index: number, field: 'recipient' | 'amount', value: string): void;
  onAdd(): void; onRemove(index: number): void;
  /** Gives every recipient the first recipient's amount (only when the person asks; amounts are otherwise individual). */
  onSameAmount(): void;
  /** Applies the draft through the Editor's authoring command; a plain-words problem when it was refused. */
  onApply(): string | null;
  onCancel?: (() => void) | undefined;
};

export function BatchPaymentFields({ batch }: { batch: BatchPaymentCardData }) {
  const { t: tr } = useLocale();
  const id = useId();
  const [refusal, setRefusal] = useState<string | null>(null);
  const problem = refusal ?? (batch.changed ? batch.check.problem : null);
  function apply() { setRefusal(batch.onApply()); }
  return <form className="composer-amount-form batch-payment-fields nodrag nopan" aria-label={tr('Batch Payment recipients')}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (batch.check.valid) apply(); }}>
    <div className="batch-payment-selects">
      <label className="composer-recipient" htmlFor={`${id}-network`}><span>{tr('Network')}</span>
        <select id={`${id}-network`} className="composer-recipient-input" value={batch.network} onChange={event => { setRefusal(null); batch.onNetwork(event.target.value); }}>
          {batch.networks.map(network => <option key={network} value={network}>{tr(network)}</option>)}
        </select></label>
      <label className="composer-recipient" htmlFor={`${id}-asset`}><span>{tr('Asset')}</span>
        <select id={`${id}-asset`} className="composer-recipient-input" value={batch.asset} onChange={event => { setRefusal(null); batch.onAsset(event.target.value); }}>
          {batch.assets.map(asset => <option key={asset} value={asset}>{asset}</option>)}
        </select></label>
    </div>
    <ol className="batch-payment-rows">
      {batch.rows.map((row, index) => <li key={index} className="batch-payment-row" data-batch-row={index + 1}>
        <span className="batch-payment-index numeric" aria-hidden="true">{index + 1}</span>
        <input className="composer-recipient-input numeric batch-payment-recipient" type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={128}
          aria-label={tr('Recipient {0} address', index + 1)} placeholder="0x…" value={row.recipient} title={row.recipient || undefined}
          onChange={event => { setRefusal(null); batch.onRow(index, 'recipient', event.target.value); }}/>
        <input className="composer-recipient-input numeric batch-payment-amount" type="text" inputMode="decimal" autoComplete="off" maxLength={40}
          aria-label={tr('Recipient {0} amount ({1})', index + 1, batch.asset)} placeholder="0.00" value={row.amount}
          onChange={event => { setRefusal(null); batch.onRow(index, 'amount', event.target.value); }}/>
        <button type="button" className="composer-amount-cancel batch-payment-remove" aria-label={tr('Remove recipient {0}', index + 1)}
          disabled={batch.rows.length <= batch.minRecipients} onClick={() => { setRefusal(null); batch.onRemove(index); }}>×</button>
      </li>)}
    </ol>
    <div className="composer-amount-actions batch-payment-row-actions">
      <button type="button" className="composer-amount-review" disabled={batch.rows.length >= batch.maxRecipients} onClick={() => { setRefusal(null); batch.onAdd(); }}>{tr('Add recipient')}</button>
      <button type="button" className="composer-amount-cancel" disabled={!batch.rows[0]?.amount} onClick={() => { setRefusal(null); batch.onSameAmount(); }}>{tr('Same amount for all')}</button>
    </div>
    <p className="composer-quote-note batch-payment-summary" role="status" data-batch-recipients={batch.rows.length}>
      {tr('{0} recipients', batch.rows.length)}{tr(' · ')}{batch.check.total === null ? tr('Total: enter every amount') : tr('Total: {0} {1}', batch.check.total, batch.asset)}
    </p>
    <p className="composer-quote-note">{tr('All payments run together in one wallet approval, or none of them run.')}</p>
    {problem && <span className="composer-amount-error" role="alert">{tr(problem)}</span>}
    {batch.changed && <div className="composer-amount-actions">
      <button type="submit" className="composer-amount-apply" disabled={!batch.check.valid}>{tr(batch.applyLabel)}</button>
      {batch.onCancel && <button type="button" className="composer-amount-cancel" onClick={() => { setRefusal(null); batch.onCancel!(); }}>{tr('Cancel')}</button>}
    </div>}
  </form>;
}
