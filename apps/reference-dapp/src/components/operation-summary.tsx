// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState, type ReactNode } from 'react';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import { useLocale } from '../i18n/locale';
import { CopyValue } from './copy-value';
import type { Workflow } from '../domain/initial-workflow';
import { composerActions, composerSummary } from '../domain/composer-presentation';
import { transferDetails } from '../domain/robinhood-transfer-authoring';
import { ActionIcon } from './action-icon';
import { useNetworkCatalogsVersion } from '../state/network-catalog-version';

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
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (A5/A7): a network as the owner reads it — "Base", "Arbitrum One" — without the chain number some catalog
 * labels carry ("Base (8453)"); the chain identifier stays available under "Technical details" (`WorkflowTechnicalFacts`). Display only.
 */
export const networkName = (label: string) => label.split(' → ').map(part => part.replace(/\s*\(\d+\)$/, '')).join(' → ');
/** The asset a swap step's pair ends in ("USDC → WETH" → "WETH"); null for anything that is not a plain pair. */
const pairTarget = (detail: string | null) => { const parts = (detail ?? '').split(' → '); return parts.length === 2 && parts[1] && !/\s/.test(parts[1]) ? parts[1] : null; };
/** A send to the connected owner's own wallet (`transferDetails` keeps it symbolic until the wallet is known). */
const OWN_WALLET = 'CONNECTED_OWNER';
const usable = (amount: string) => Boolean(amount) && amount !== '—' && amount !== 'Amount not available';

export type OperationStep = { readonly id: string; readonly action: string; readonly amount: string; readonly detail: string | null; readonly network: string;
  readonly recipient: string | null;
  /** The configured provider ("Uniswap", "Token transfer") and the node's chain identifier, for "Technical details" only. */
  readonly provider: string; readonly chainId: string;
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
      positionOperation: summary.position?.management.operation ?? null, provider: summary.provider, chainId: node.chainId };
  });
}

/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (A6, approved reference "Executar — revisão expirada"): one numbered step as a sentence of what the owner
 * configured ("Swap 3 USDC for WETH on Base."), never a quote or a result. Swap and Send have their own sentence; any other action keeps its own name.
 */
function StepSentence({ step }: { step: OperationStep }) {
  const { t } = useLocale();
  const network = t(networkName(step.network)), amount = t(step.amount), target = pairTarget(step.detail);
  if (!usable(step.amount)) return <><strong>{t(step.action)}</strong>{step.detail && <span className="operation-summary-detail"> · {t(step.detail)}</span>}<span className="operation-summary-detail"> · {network}</span></>;
  if (step.action === 'Swap' && target) return <>{t('Swap {0} for {1} on {2}.', amount, target, network)}</>;
  if (step.action === 'Send') return <>{t('Send {0} on {1}.', amount, network)}</>;
  // A position operation names its own action and its position (never a deposit's amounts).
  if (step.positionOperation) return <>{t('{0}: {1} on {2}.', t(step.action), amount, network)}</>;
  const [from, to] = network.split(' → ');
  if (to) return <>{t('{0} {1} from {2} to {3}.', t(step.action), amount, from!, to)}</>;
  return <>{t('{0} {1} on {2}.', t(step.action), amount + (step.detail && !step.amount.includes(step.detail) ? ` · ${t(step.detail)}` : ''), network)}</>;
}

export function OperationSummary({ workflow, context, heading = 'Operation summary', variant = 'numbered' }: { workflow: Workflow; context: ReviewContext;
  heading?: string | null;
  /** `numbered` (C2: the Review's summary) or `icons` (B2: the Simulate panel's list with each step's action icon and network). */
  variant?: 'numbered' | 'icons' }) {
  const { t } = useLocale();
  // BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002: re-rendered once a token catalog registers (the Simulate/Execute Canvas loads the steps' catalogs).
  useNetworkCatalogsVersion();
  const steps = operationSteps(workflow, context);
  if (!steps.length) return null;
  return <section className="operation-summary" data-variant={variant} aria-label={t(heading ?? 'Workflow actions')}>
    {heading && <h3>{t(heading)}</h3>}
    <ol>{steps.map((step, index) => <li key={step.id} data-position-operation={step.positionOperation ?? undefined}>
      {variant === 'icons' ? <span className="operation-summary-icon" aria-hidden="true"><ActionIcon action={ICON[step.action] ?? (step.positionOperation ? 'pool' : 'action')}/></span>
        : <span className="operation-summary-number" aria-hidden="true">{index + 1}</span>}
      <div className="operation-summary-body">
        {variant === 'icons' ? <>
          <strong>{t(step.action)}</strong>
          <span className="operation-summary-line"><span className="operation-summary-amount">{t(step.amount)}</span>{step.detail && <span className="operation-summary-detail">{assetsAfter(step, t)}</span>}</span>
        </> : <span className="operation-summary-sentence"><StepSentence step={step}/></span>}
        {step.recipient && (step.recipient === OWN_WALLET ? <small className="operation-summary-recipient">{t('Recipient')}: {t('Your wallet')}</small>
          : <small className="operation-summary-recipient" title={step.recipient}>{t('Recipient')}: <code aria-hidden="true">{shortRecipient(step.recipient)}</code><span className="sr-only">{step.recipient}</span></small>)}
      </div>
      {variant === 'icons' && <span className="operation-summary-chip">{t(networkName(step.network))}</span>}
    </li>)}</ol>
  </section>;
}

/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (A5/A6): the secondary facts of the workflow as configured — each step's network and chain identifier, its
 * provider and its full recipient — for a collapsed "Technical details" where no simulation or Review states them (before a simulation, an expired
 * Review). Configuration only: never a quote, a fee or a result.
 */
export function WorkflowTechnicalFacts({ workflow, context, expiredAt = null }: { workflow: Workflow; context: ReviewContext; expiredAt?: string | null }) {
  const { t } = useLocale();
  const steps = operationSteps(workflow, context);
  if (!steps.length && !expiredAt) return null;
  return <div className="workflow-technical-facts">
    {expiredAt && <p className="workflow-technical-expired">{t('The previous review expired at {0}; its values are no longer current and are not shown.', expiredAt)}</p>}
    {steps.map((step, index) => <dl key={step.id} role="group" aria-label={t('Step {0}: {1}', index + 1, t(step.action))}>
      <div><dt>{t('Step')}</dt><dd>{index + 1}. {t(step.action)}</dd></div>
      <div><dt>{t('Network')}</dt><dd>{t(networkName(step.network))} <code>{step.chainId}</code></dd></div>
      {step.provider && <div><dt>{t('Provider')}</dt><dd>{t(step.provider)}</dd></div>}
      {step.recipient && <div><dt>{t('Recipient')}</dt><dd>{step.recipient === OWN_WALLET ? t('Your wallet') : <code className="workflow-technical-address">{step.recipient}</code>}</dd></div>}
    </dl>)}
  </div>;
}

/** The icon of a step, by the Canvas action name or a whole-workflow Review's action code. */
export function stepIcon(action: string): Parameters<typeof ActionIcon>[0]['action'] {
  const code: Readonly<Record<string, Parameters<typeof ActionIcon>[0]['action']>> = { swap: 'swap', bridge: 'bridge', transfer: 'transfer', supply: 'supply',
    borrow: 'borrow', repay: 'repay', withdraw: 'withdraw', add_liquidity: 'pool' };
  return ICON[action] ?? code[action] ?? 'action';
}

/**
 * UX-01 (Simulate, owner guidelines of 21-11-2026): a recipient shortened in a summary ("0x2820…912edc"), its full address one click away (a
 * disclosure with a copy control); the accessible name starts with the visible short form (WCAG 2.5.3) and states the full address. Display only.
 */
export function RecipientShort({ address, own = false }: { address: string; own?: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (own) return <small className="operation-summary-recipient">{t('Recipient')}: {t('Your wallet')}</small>;
  const short = shortRecipient(address);
  return <small className="operation-summary-recipient step-recipient" data-open={open || undefined}>{t('Recipient')}:{' '}
    {short === address ? <code>{address}</code> : <>
      <button type="button" className="step-recipient-toggle" aria-expanded={open} aria-label={t('{0}, show the full address {1}', short, address)}
        onClick={() => setOpen(value => !value)}><code>{short}</code></button>
      {open && <span className="step-recipient-full" role="group" aria-label={t('Full address')}><CopyValue value={address} shown={address} label="Recipient"/></span>}
    </>}</small>;
}
/**
 * UX-03 (Execute, flofi-security review): the Review the owner authorizes shows a transfer's recipient IN FULL as visible text, with its copy
 * control — a shortened address on the decision surface invites look-alike (address-poisoning) mistakes. The owner's own wallet is named as such
 * and still shown in full.
 */
export function RecipientFull({ address, own = false }: { address: string; own?: boolean }) {
  const { t } = useLocale();
  return <small className="operation-summary-recipient step-recipient step-recipient-visible">{t('Recipient')}{own ? ` (${t('Your wallet')})` : ''}:{' '}
    <CopyValue value={address} shown={address} label="Recipient"/></small>;
}

export type StepSummaryItem = { readonly key: string; readonly action: string; readonly title: string;
  /** The step's amounts as the panel words them (exact values one click away), or null when the Review has none for it. */
  readonly amount: ReactNode | null; readonly network: string | null;
  readonly recipient?: { readonly address: string; readonly own: boolean } | null };
/**
 * UX-01 (Simulate, `icons`) and UX-03 (Execute, `numbered`): the steps of the simulated or reviewed workflow in ONE rounded card — each step on its
 * own row with its action icon (or its number in a circle and the icon beside its name), its amounts on their own line, its network in a small
 * pill and its recipient (shortened on Simulate, in full on the Execute Review) — the same look as the Simulate panel before the simulation (`OperationSummary` `icons`). Presentation only.
 */
export function StepSummaryCard({ items, variant = 'icons', label = 'Steps' }: { items: readonly StepSummaryItem[]; variant?: 'icons' | 'numbered'; label?: string }) {
  const { t } = useLocale();
  if (!items.length) return null;
  return <div className="operation-summary step-summary-card" data-variant={variant}>
    <ol aria-label={t(label)}>{items.map((item, index) => <li key={item.key}>
      {variant === 'icons' ? <span className="operation-summary-icon" aria-hidden="true"><ActionIcon action={stepIcon(item.action)}/></span>
        : <span className="operation-summary-number" aria-hidden="true">{index + 1}</span>}
      <div className="operation-summary-body">
        <strong className="step-summary-title">{t(item.title)}
          {variant === 'numbered' && <span className="step-summary-title-icon" aria-hidden="true"><ActionIcon action={stepIcon(item.action)}/></span>}</strong>
        {item.amount && <span className="operation-summary-line step-summary-amount">{item.amount}</span>}
        {item.recipient && (variant === 'numbered' ? <RecipientFull address={item.recipient.address} own={item.recipient.own}/>
          : <RecipientShort address={item.recipient.address} own={item.recipient.own}/>)}
      </div>
      {item.network && <span className="operation-summary-chip">{t(networkName(item.network))}</span>}
    </li>)}</ol>
  </div>;
}
