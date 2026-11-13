// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: after an automatic in-place re-quote, only the material values that moved (before → now). The fresh Review
 * itself is the run's own Review; this list never authorizes anything.
 */
import { useLocale } from '../i18n/locale';
import type { BridgeReviewChange } from '../domain/bridge-review-recovery';

export function BridgeRequoteChanges({ changes }: { readonly changes: readonly BridgeReviewChange[] }) {
  const { t: tr } = useLocale();
  return <section className="bridge-requote" aria-label={tr('Fresh quote')} role="status">
    <strong>{tr('What changed since your Review')}</strong>
    {changes.length === 0 ? <p>{tr('Nothing material changed. Authorize the fresh Review to continue.')}</p>
      : <dl>{changes.map(change => <div key={change.label}>
        <dt>{tr(change.label)}</dt>
        <dd><span aria-label={tr('Before')}><s>{change.before}</s></span> → <span aria-label={tr('Now')}>{change.after}</span></dd>
      </div>)}</dl>}
  </section>;
}
