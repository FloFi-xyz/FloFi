// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * The FloFi platform fee of a completed execution as ONE row of the result summary: "FloFi fee (0.80%)", its amount, and a small Pay button only
 * while collection is active and the fee is due (or a collection failed and may be retried). While collection is not active it renders nothing.
 * Paying is the owner's explicit wallet action (`usePlatformFeeSettlement`); this row never signs or submits by itself.
 */
import { useLocale } from '../i18n/locale';
import { platformFeeDisclosure } from '../platform-fee/disclosure';
import { platformFeeExecutionOf } from '../domain/platform-fee-execution';
import { usePlatformFeeSettlement } from '../state/platform-fee-settlement';

export function PlatformFeeLine({ runKey }: { runKey: string | null }) {
  const { language, t } = useLocale();
  // A run key is a run id or a workflow run id; anything else (a mock or composition id the ledger cannot know) gets no row.
  const execution = runKey ? platformFeeExecutionOf(/^wfr_/.test(runKey) ? { workflowRunId: runKey } : { runId: runKey }) : null;
  const { status, busy, error, pay } = usePlatformFeeSettlement(execution);
  if (!status?.collection.active) return null;
  const lines = status.ledger?.lines.length ? status.ledger.lines : status.authorized?.status === 'FEEABLE' ? status.authorized.lines : [];
  const disclosure = lines.length ? platformFeeDisclosure({ status: 'FEEABLE', lines }, language, true) : null;
  if (!disclosure) return null;
  const state = status.ledger?.state, paid = state === 'COLLECTED';
  const due = (state === 'DUE' || state === 'COLLECTION_FAILED') && status.ledger?.attention !== true;
  return <dl className="execution-receipt-facts" data-platform-fee={paid ? 'paid' : due ? 'due' : 'pending'}>
    <div><dt>{disclosure.label}</dt>
      <dd>{disclosure.value}{paid && <> · {language === 'PT' ? 'Paga' : 'Paid'}</>}
        {due && <> <button type="button" disabled={busy} onClick={() => void pay()}>{t('Pay')}</button></>}
        {error && <span role="alert" data-platform-fee-error={error}> {error}</span>}</dd></div>
  </dl>;
}
