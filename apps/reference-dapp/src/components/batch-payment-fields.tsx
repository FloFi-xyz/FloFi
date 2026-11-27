// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the Batch Payment card's own fields, the one new visual component of this build. It reuses
 * the Canvas card's existing design system (the Send card's address field, the amount form's buttons and notes): one network, one asset, 2..8
 * recipients each with its own exact amount, the recipient count and the exact total. Nothing here signs, simulates or executes: Apply hands the
 * draft to the Editor's existing authoring command (`ADD_BATCH_PAYMENT` / `SET_BATCH_PAYMENT`), which validates it again, and the shared Review and
 * execution surfaces take it from there.
 */
import { useEffect, useId, useRef, useState } from 'react';
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
  /** The card is a saved step (its draft is an edit of that step); false for a brand-new card, which has no step yet. */
  readonly saved: boolean;
  /**
   * FE-BATCH-10: a new card nobody has edited yet: its problem is not announced until the person edits it or tries to apply it (an edited card, or a
   * saved step's draft, states its problem at once).
   */
  readonly fresh?: boolean;
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
  const form = useRef<HTMLFormElement>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const announce = touched || !batch.fresh;
  const problem = refusal ?? (batch.changed && announce ? batch.check.problem : null);
  const problemId = `${id}-problem`;
  // FE-BATCH-10: after a row is removed, focus stays in the list: on the address of the row that took its place (or the new last row).
  const [focusRow, setFocusRow] = useState<number | null>(null);
  useEffect(() => {
    if (focusRow === null) return;
    const row = Math.min(focusRow, batch.rows.length - 1);
    form.current?.querySelector<HTMLInputElement>(`[data-batch-row="${row + 1}"] .batch-payment-recipient`)?.focus();
    setFocusRow(null);
  }, [focusRow, batch.rows.length]);
  /** Every edit, and an attempt to apply, makes the card state its problem from then on. */
  const edited = (change: () => void) => { setRefusal(null); setTouched(true); change(); };
  function apply() { setTouched(true); setRefusal(batch.onApply()); }
  const invalid = (index: number, field: 'recipient' | 'amount') => Boolean(announce && batch.changed && problem && batch.check.rows?.[index]?.[field]);
  const describedBy = (index: number, field: 'recipient' | 'amount') => invalid(index, field) ? problemId : undefined;
  return <form ref={form} className="composer-amount-form batch-payment-fields nodrag nopan" aria-label={tr('Batch Payment recipients')} aria-describedby={problem ? problemId : undefined}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      // F3: Escape cancels a saved step's draft (the step keeps what it had), as on every other card editor, and a brand-new card still untouched
      // (nothing edited or applied yet, so nothing typed is lost). An edited new card is never thrown away by a key press (its recipients could not be
      // brought back): its explicit Cancel does.
      if (event.key === 'Escape' && batch.changed && batch.onCancel && (batch.saved || batch.fresh === true && !touched)) {
        event.preventDefault(); setRefusal(null); batch.onCancel();
      }
    }}
    onSubmit={event => { event.preventDefault(); if (batch.check.valid) apply(); else setTouched(true); }}>
    <div className="batch-payment-selects">
      <label className="composer-recipient" htmlFor={`${id}-network`}><span>{tr('Network')}</span>
        <select id={`${id}-network`} className="composer-recipient-input" value={batch.network} onChange={event => edited(() => batch.onNetwork(event.target.value))}>
          {batch.networks.map(network => <option key={network} value={network}>{tr(network)}</option>)}
        </select></label>
      <label className="composer-recipient" htmlFor={`${id}-asset`}><span>{tr('Asset')}</span>
        {/* FE-BATCH-07: the options always hold the draft's own asset; with none chosen (a network that does not offer it) the select says so. */}
        <select id={`${id}-asset`} className="composer-recipient-input" value={batch.asset} aria-invalid={announce && !batch.asset || undefined}
          aria-describedby={announce && !batch.asset && problem ? problemId : undefined} onChange={event => edited(() => batch.onAsset(event.target.value))}>
          {!batch.asset && <option value="" disabled>{tr('Choose an asset')}</option>}
          {batch.assets.map(asset => <option key={asset} value={asset}>{asset}</option>)}
        </select></label>
    </div>
    <ol className="batch-payment-rows">
      {batch.rows.map((row, index) => <li key={index} className="batch-payment-row" data-batch-row={index + 1}>
        <span className="batch-payment-index numeric" aria-hidden="true">{index + 1}</span>
        <input className="composer-recipient-input numeric batch-payment-recipient" type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={128}
          aria-label={tr('Recipient {0} address', index + 1)} placeholder="0x…" value={row.recipient} title={row.recipient || undefined}
          aria-invalid={invalid(index, 'recipient') || undefined} aria-describedby={describedBy(index, 'recipient')}
          onChange={event => edited(() => batch.onRow(index, 'recipient', event.target.value))}/>
        <input className="composer-recipient-input numeric batch-payment-amount" type="text" inputMode="decimal" autoComplete="off" maxLength={40}
          aria-label={batch.asset ? tr('Recipient {0} amount ({1})', index + 1, batch.asset) : tr('Recipient {0} amount', index + 1)} placeholder="0.00" value={row.amount}
          aria-invalid={invalid(index, 'amount') || undefined} aria-describedby={describedBy(index, 'amount')}
          onChange={event => edited(() => batch.onRow(index, 'amount', event.target.value))}/>
        <button type="button" className="composer-amount-cancel batch-payment-remove" aria-label={tr('Remove recipient {0}', index + 1)}
          disabled={batch.rows.length <= batch.minRecipients} onClick={() => edited(() => { batch.onRemove(index); setFocusRow(index); })}>×</button>
      </li>)}
    </ol>
    <div className="composer-amount-actions batch-payment-row-actions">
      <button type="button" className="composer-amount-review" disabled={batch.rows.length >= batch.maxRecipients} onClick={() => edited(batch.onAdd)}>{tr('Add recipient')}</button>
      <button type="button" className="composer-amount-cancel" disabled={!batch.rows[0]?.amount} onClick={() => edited(batch.onSameAmount)}>{tr('Same amount for all')}</button>
    </div>
    {/* FE-BATCH-11: the exact total whenever every amount is valid, whatever the recipients say. */}
    <p className="composer-quote-note batch-payment-summary" role="status" data-batch-recipients={batch.rows.length}>
      {tr('{0} recipients', batch.rows.length)}{tr(' · ')}{batch.check.total !== null ? tr('Total: {0} {1}', batch.check.total, batch.asset)
        : !batch.asset ? tr('Total: choose an asset') : tr('Total: enter every amount')}
    </p>
    <p className="composer-quote-note">{tr('All payments run together in one wallet approval, or none of them run.')}</p>
    {problem && <span id={problemId} className="composer-amount-error" role="alert">{tr(problem)}</span>}
    {batch.changed && <div className="composer-amount-actions">
      <button type="submit" className="composer-amount-apply" disabled={!batch.check.valid}>{tr(batch.applyLabel)}</button>
      {batch.onCancel && <button type="button" className="composer-amount-cancel" onClick={() => { setRefusal(null); batch.onCancel!(); }}>{tr('Cancel')}</button>}
    </div>}
  </form>;
}
