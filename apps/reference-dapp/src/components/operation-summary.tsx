// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { useLocale } from '../i18n/locale';
import type { Workflow } from '../domain/initial-workflow';
import { composerActions, composerSummary } from '../domain/composer-presentation';
import { transferDetails } from '../domain/robinhood-transfer-authoring';
import { ActionIcon } from './action-icon';

const ICON: Readonly<Record<string, Parameters<typeof ActionIcon>[0]['action']>> = {
  Swap: 'swap', Bridge: 'bridge', 'Pool / Liquidity': 'pool', 'Prepare liquidity': 'pool', Send: 'transfer', Supply: 'supply', Borrow: 'borrow',
  Repay: 'repay', Withdraw: 'withdraw', Stocks: 'stocks',
};
/** "2 USDC" with "USDC → WETH" reads "2 USDC → WETH": the pair's source asset is the amount's own, so only the rest is added. */
function assetsAfter(step: OperationStep, t: (text: string) => string): string {
  const [from, ...rest] = (step.detail ?? '').split(' → ');
  return from && rest.length && step.amount.endsWith(` ${from}`) ? ` → ${rest.join(' → ')}` : ` · ${t(step.detail ?? '')}`;
}
const shortRecipient = (address: string) => address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;

export type OperationStep = { readonly id: string; readonly action: string; readonly amount: string; readonly detail: string | null; readonly network: string;
  readonly recipient: string | null;
  /** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the operation a position-management step makes (COLLECT, DECREASE, EXIT); null for any other step. */
  readonly positionOperation: string | null };
/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (B2/C2): the workflow's operations in order, read only from what the owner configured on the Canvas — the action,
 * the amount it spends, its assets, its network and a recipient where it sends. It never shows a quote, an estimate or a result, so it can stand in
 * for an expired simulation or Review without presenting a stale figure as current.
 */
export function operationSteps(workflow: Workflow, context: ReviewContext): OperationStep[] {
  return composerActions(workflow).map(node => {
    const summary = composerSummary(workflow, node, context);
    let recipient: string | null;
    try { recipient = transferDetails(node as Parameters<typeof transferDetails>[0])?.recipient ?? null; } catch { recipient = null; }
    // A position-management step reads as its operation and position (never the pool node's descriptive maxima as a deposit).
    return { id: node.nodeId, action: summary.action, amount: summary.amount, detail: summary.bridgePair ?? summary.detail ?? null, network: summary.chain, recipient,
      positionOperation: summary.position?.management.operation ?? null };
  });
}

export function OperationSummary({ workflow, context, heading = 'Operation summary', variant = 'numbered' }: { workflow: Workflow; context: ReviewContext;
  heading?: string | null;
  /** `numbered` (C2: the Review's summary) or `icons` (B2: the Simulate panel's list with each step's action icon and network). */
  variant?: 'numbered' | 'icons' }) {
  const { t } = useLocale();
  const steps = operationSteps(workflow, context);
  if (!steps.length) return null;
  return <section className="operation-summary" data-variant={variant} aria-label={t(heading ?? 'Workflow actions')}>
    {heading && <h3>{t(heading)}</h3>}
    <ol>{steps.map((step, index) => <li key={step.id} data-position-operation={step.positionOperation ?? undefined}>
      {variant === 'icons' ? <span className="operation-summary-icon" aria-hidden="true"><ActionIcon action={ICON[step.action] ?? (step.positionOperation ? 'pool' : 'action')}/></span>
        : <span className="operation-summary-number" aria-hidden="true">{index + 1}</span>}
      <div className="operation-summary-body">
        <strong>{t(step.action)}</strong>
        <span className="operation-summary-line"><span className="numeric">{t(step.amount)}</span>{step.detail && <span className="operation-summary-detail">{assetsAfter(step, t)}</span>}</span>
        {variant === 'numbered' && <span className="operation-summary-network">{t(step.network)}</span>}
        {step.recipient && <small className="operation-summary-recipient" title={step.recipient}>{t('Recipient')}: <code>{shortRecipient(step.recipient)}</code></small>}
      </div>
      {variant === 'icons' && <span className="operation-summary-chip">{t(step.network)}</span>}
    </li>)}</ol>
  </section>;
}
