// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { useLocale } from '../i18n/locale';

/**
 * HOTFIX-PHANTOM-LIGHTHOUSE-001: what the owner's wallet appended before signing, after FloFi verified it. Presentation only; the
 * verification and the evidence live in the run.
 */
export function SolanaWalletGuardNote({ guard }: { guard: SolanaWalletGuard | undefined }) {
  const { t: tr } = useLocale();
  if (!guard) return null;
  return <p role="note" data-solana-wallet-guard={guard.instructions.length}>{tr('Your wallet added {0} protection check(s) (Lighthouse) before signing. FloFi verified that they only check the result and change nothing you reviewed: if the result is worse than your wallet expects, the whole transaction fails and only the network fee is spent.', String(guard.instructions.length))}</p>;
}

/**
 * HOTFIX-WORKFLOW-CONCURRENCY-001: a transaction that is still being confirmed never blocks another workflow. This says so, and that the
 * earlier one keeps being tracked, so a second, separate execution is a deliberate choice.
 */
export function PendingExecutionNote({ pending }: { pending: boolean }) {
  const { t: tr } = useLocale();
  if (!pending) return null;
  return <p role="note" data-pending-execution-note="true">{tr('This transaction is still being confirmed, and FloFi keeps tracking it. You can simulate another, separate transaction meanwhile: it needs its own Review and wallet signature. Every execution stays listed in Dashboard.')}</p>;
}
