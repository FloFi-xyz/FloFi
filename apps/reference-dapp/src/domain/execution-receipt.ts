// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (workstream B): the simple financial receipt a historical execution opens on — what was done, whether it
 * succeeded, when, what was sent and received, where, at what known cost and where to verify it. Presentation only: every value is the persisted
 * record's own projection (`projectDashboardRun`, `projectExecutionLifecycle`, `projectExecutionEvidence`); nothing is fetched, computed from prices,
 * rounded to zero or assumed. "You received" (and every completed-result word) appears only for a value the record observed; a value it did not
 * observe is either the owner's configured amount, labelled as such, or said to be unrecorded — never a zero, never a guess.
 */
import { displayAmountText } from './token-amount-display';
import type { DashboardRunView, DashboardStatus } from '../lib/dashboard/types';
import type { ExecutionLifecycle, LifecycleOperation, LifecycleStep } from './execution-lifecycle';
import type { EvidenceValue } from './execution-evidence';
import { shellChainLabel } from './product-shell';

export type ReceiptTone = 'success' | 'attention' | 'progress' | 'failed' | 'neutral';
/** A row of the receipt. `observed`: the record observed this value (an execution effect), as opposed to the configured plan. */
export type ReceiptValue = { readonly label: string; readonly value: string; readonly observed: boolean;
  /** Parameters of a templated label ("Network fee · {0}"), translated by the catalog. */ readonly args?: readonly string[] };
export type ReceiptLink = { readonly hash: string; readonly explorer: string | null; readonly network: string };
export type ReceiptStep = {
  readonly number: number; readonly action: string; readonly network: string; readonly provider: string | null;
  readonly status: string; readonly tone: ReceiptTone;
  readonly values: readonly ReceiptValue[]; readonly transaction: ReceiptLink | null; readonly recipient: string | null;
};
export type ExecutionReceipt = {
  /** The operation ("Swap") for one step; the workflow's name for several. */
  readonly title: string; readonly status: DashboardStatus; readonly tone: ReceiptTone;
  /** The title is the operation (a catalog word, translated) rather than the owner's own workflow name (never translated). */
  readonly titleIsAction: boolean;
  /** When the record last changed (its final state), ISO. */
  readonly at: string | null;
  /** One step: its sent / received / result rows. Several steps: empty (each step carries its own). */
  readonly values: readonly ReceiptValue[];
  readonly network: string | null; readonly protocol: string | null; readonly recipient: string | null;
  /** Known network costs as recorded per network ("Network fee" or "Network fee · Base"); empty when none is recorded (never "0"). */
  readonly fees: readonly ReceiptValue[];
  readonly wallet: string | null;
  readonly completed: number | null; readonly total: number | null;
  /** The main transaction of a one-step execution. */
  readonly transaction: ReceiptLink | null;
  /** Several steps: the ordered list, each with its own result and status. */
  readonly steps: readonly ReceiptStep[];
  /** What happened and what (if anything) needs the owner, for anything but a clean completion. */
  readonly notice: { readonly message: string; readonly items: readonly string[] } | null;
  /**
   * The record's own provenance when it is not a public-chain execution (a local, mocked or fork-reproduced run): said on the receipt itself,
   * never only in Technical details, so a fixture or replay can never read as a real receipt (flofi-wallet-execution review).
   */
  readonly provenance: string | null;
  /** Whether any request of the run reached a network (a hash is recorded): without one, no fee row is shown at all. */
  readonly submitted: boolean;
};

/** Records that are not public-chain executions, by their recorded environment. */
const PROVENANCE: Readonly<Record<string, string>> = { MOCKED: 'Mocked local execution', FORK_REPRODUCED: 'Local fork', LOCAL: 'Local execution' };
const TONE: Readonly<Record<DashboardStatus, ReceiptTone>> = {
  Completed: 'success', 'Completed with attention': 'attention', 'In progress': 'progress', 'Needs attention': 'attention', 'Partially completed': 'attention',
  Failed: 'failed', Unresolved: 'attention', 'Transaction not submitted': 'neutral', 'Not started': 'neutral',
};
/**
 * The record's observed values, renamed for the receipt only where the label proves the owner's own movement of funds. Any other observed value
 * keeps its recorded label (a provider's report, a liquidity position change, a refund) and its own meaning.
 */
const RECEIPT_LABEL: Readonly<Record<string, string>> = {
  'Executed input': 'You sent', Sent: 'You sent', 'Actual transferred': 'You sent', 'Actual supplied': 'You supplied',
  'Actual received': 'You received', 'Actual borrowed': 'You borrowed', 'Recipient received': 'Recipient received', 'Verified refund': 'Refunded',
};
/** Values that are costs, not results (shown among the fees). */
const FEE_LABELS = new Set(['Network fee paid from the swap', 'Account creation cost', 'Account rent paid']);
/** Values that only restate a planned figure or are an interim observation, never a result of their own. */
const SKIPPED = new Set(['Source debit confirmed · awaiting finality', 'Destination amount observed · awaiting reconciliation', 'Current allowance', 'Observed allowance']);
const SENT_FIRST = ['You sent', 'You supplied'];

const networkName = (label: string) => label.split(' → ').map(part => part.replace(/\s*\(\d+\)$/, '')).join(' → ');
/** The transaction the owner's wallet sent (a bridge's deposit, never the provider's fill or refund), else the last recorded one. */
const mainOperation = (operations: readonly LifecycleOperation[]) => [...operations].reverse().find(op => op.wallet && !op.approval && op.hash)
  ?? [...operations].reverse().find(op => !op.approval && op.hash)
  ?? [...operations].reverse().find(op => op.hash) ?? null;
const link = (operation: LifecycleOperation | null): ReceiptLink | null => operation?.hash
  ? { hash: operation.hash, explorer: operation.explorer, network: networkName(operation.chain ? shellChainLabel(operation.chain) : '') } : null;

function stepTone(step: LifecycleStep): { status: string; tone: ReceiptTone } {
  if (step.state === 'confirmed') return { status: 'Completed', tone: 'success' };
  if (step.state === 'waiting') return { status: 'Not run', tone: 'neutral' };
  // A refund, an expiry and a cancellation keep their own word (never "Failed"); a failure is "Failed" only once something was sent.
  if (step.operations.some(op => op.label === 'Refunded')) return { status: 'Refunded', tone: 'attention' };
  if (step.state === 'expired') return { status: 'Expired', tone: 'neutral' };
  if (step.state === 'cancelled') return { status: 'Cancelled', tone: 'neutral' };
  if (step.state === 'failed') return { status: step.operations.some(op => op.hash) ? 'Failed' : 'Not submitted', tone: step.operations.some(op => op.hash) ? 'failed' : 'neutral' };
  if (step.state === 'not-submitted') return { status: 'Not submitted', tone: 'neutral' };
  if (['uncertain', 'partial'].includes(step.state)) return { status: 'Unresolved', tone: 'attention' };
  return { status: 'In progress', tone: 'progress' };
}

/** An observed value with the operation that recorded it. */
type Observed = EvidenceValue & { readonly operation: string };
/**
 * The receipt's label for an observed value. A bridge's destination delivery goes to the reviewed recipient — not necessarily the owner — so it
 * reads "Delivered" (flofi-workflow review); every other "Actual received" is the owner's own wallet's observed effect.
 */
const receiptLabel = (value: Observed) => value.label === 'Actual received' && value.operation === 'destination' ? 'Delivered' : RECEIPT_LABEL[value.label] ?? value.label;

/** One step's rows: what was sent (observed, else the configured amount), what was received (observed only) and any other observed result. */
function stepValues(step: LifecycleStep, observed: readonly Observed[], status: DashboardStatus): ReceiptValue[] {
  const rows: ReceiptValue[] = [];
  const seen = new Set<string>();
  for (const value of observed) {
    if (SKIPPED.has(value.label) || FEE_LABELS.has(value.label)) continue;
    const label = receiptLabel(value);
    const key = `${label}:${value.value}`;
    if (seen.has(key)) continue;
    seen.add(key); rows.push({ label, value: value.value, observed: true });
  }
  rows.sort((a, b) => Number(SENT_FIRST.includes(b.label)) - Number(SENT_FIRST.includes(a.label)));
  // Nothing observed was sent: the owner's configured amount, labelled as configured (it never reads as an executed movement).
  if (step.input && step.input !== '—' && !rows.some(row => SENT_FIRST.includes(row.label))) rows.unshift({ label: 'Configured amount', value: step.input, observed: false });
  // A completed swap-like step whose received amount the record did not observe says so (never a zero, never the quote).
  const receives = /→/.test(step.pair ?? '') || ['Swap', 'Stocks', 'Bridge'].includes(step.action);
  if (receives && step.state === 'confirmed' && (status === 'Completed' || status === 'Completed with attention') && !rows.some(row => row.observed && /received|Refunded|Delivered/i.test(row.label)))
    rows.push({ label: 'Received amount', value: 'Not recorded in this history', observed: false });
  return rows;
}

/** A send authored to the connected owner's own wallet is recorded symbolically; the receipt names the wallet that executed it. */
const ownRecipient = (recipient: string | null, wallet: string | null) => recipient === 'CONNECTED_OWNER' ? wallet : recipient;

export function projectExecutionReceipt(view: DashboardRunView): ExecutionReceipt {
  const progress: ExecutionLifecycle | null = view.progress;
  const steps = progress?.steps ?? [];
  const evidence = progress?.evidence;
  const observed = (step: LifecycleStep): Observed[] => step.operations.flatMap(op => (evidence?.operations[op.id]?.values ?? []).map(value => ({ ...value, operation: op.id })));
  const single = steps.length === 1 && !progress?.planUnavailable ? steps[0]! : null;
  const fees: ReceiptValue[] = (evidence?.knownCosts ?? []).map(cost => {
    const network = cost.label.replace(/^Known network cost · /, '');
    return (evidence?.knownCosts.length ?? 0) > 1 ? { label: 'Network fee · {0}', args: [networkName(network)], value: cost.value, observed: true }
      : { label: 'Network fee', value: cost.value, observed: true };
  });
  // A fee the swap itself paid (0x) is a cost the record observed, in the swap's token: listed with the fees, never added to them.
  for (const step of steps) for (const value of observed(step)) if (FEE_LABELS.has(value.label)) fees.push({ label: value.label, value: value.value, observed: true });
  const networks = [...new Set(steps.map(step => networkName(step.network)).filter(Boolean))];
  const protocols = [...new Set(steps.map(step => step.provider).filter((provider): provider is string => Boolean(provider)))];
  const status = view.status;
  const clean = status === 'Completed' && !view.attention.length;
  return {
    title: single ? single.action : view.title, titleIsAction: Boolean(single), status, tone: TONE[status],
    at: view.run.updatedAt ?? view.run.createdAt,
    values: single ? stepValues(single, observed(single), status) : [],
    network: networks.length ? networks.join(' · ') : view.networks.length ? view.networks.map(networkName).join(' · ') : null,
    protocol: protocols.length ? protocols.join(' · ') : null,
    recipient: ownRecipient(single?.recipient ?? null, evidence?.wallet ?? view.run.ownerAccount ?? null),
    fees,
    wallet: evidence?.wallet ?? view.run.ownerAccount ?? null,
    completed: view.completed, total: view.total,
    transaction: single ? link(mainOperation(single.operations)) : null,
    steps: single ? [] : steps.map(step => ({ number: step.number, action: step.action, network: networkName(step.network), provider: step.provider,
      ...stepTone(step), values: stepValues(step, observed(step), status), transaction: link(mainOperation(step.operations)), recipient: ownRecipient(step.recipient ?? null, evidence?.wallet ?? view.run.ownerAccount ?? null) })),
    // A saved record never calls itself the current execution record (the wording the former run summary also rewrote).
    notice: clean ? null : { message: view.current ? view.message : view.message.replaceAll('current execution record', 'saved execution record'),
      items: view.attention.filter(item => item !== view.message) },
    provenance: progress?.local ? 'Local execution · no public-chain transactions'
      : PROVENANCE[view.run.provenance] ?? null,
    submitted: steps.some(step => step.operations.some(op => op.hash)) || Boolean(view.run.attempts?.some(attempt => attempt.transactionHash)),
  };
}

/** "19 nov. 2026 · 10:26 UTC" / "19 Nov 2026 · 10:26 UTC": the receipt's date, always in UTC (the exact instant stays in Technical details). */
export function receiptDate(value: string | null, language: 'EN' | 'PT'): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
    .formatToParts(Date.parse(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')} · ${part('hour')}:${part('minute')} UTC`;
}

/** A wallet or address as "0x4b212a…20b3ce" (the full value stays one copy away). */
export const shortAddress = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

/**
 * A recorded amount ("0.000003724947756 ETH") made readable without ever rounding a non-zero amount to zero: the locale's separators, and at most
 * `digits` significant decimals (cut, never rounded, marked "…"). `full` keeps every recorded digit for the tooltip, copy and Technical details.
 * Anything that is not "<number> <unit>" (a word, a position, "Not recorded…") is returned unchanged.
 */
export function readableAmount(value: string, language: 'EN' | 'PT', digits = 12): { text: string; full: string; cut: boolean } {
  // BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: a recorded "<number> <unit>" reads at six significant digits (the global rule), marked
  // "≈" when it is not exact; `full` keeps every recorded digit (tooltip, disclosure, copy). `digits` (legacy cut) applies to nothing else.
  const short = displayAmountText(value, { language });
  if (short) return { text: short.text, full: short.exactText, cut: short.approximate };
  // Only "<number> <one unit>": a value with several amounts ("0.3 WETH + 1,008 USDC") is left exactly as recorded.
  const match = /^(-?)(\d+)(?:\.(\d+))?(\s\S+)?$/.exec(value);
  if (!match) return { text: value, full: value, cut: false };
  const [, sign = '', whole = '0', fraction = '', rest = ''] = match;
  const group = language === 'PT' ? '.' : ',', decimal = language === 'PT' ? ',' : '.';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const leading = /^0*/.exec(fraction)![0].length;
  const keep = whole !== '0' ? Math.max(0, digits - whole.length) : leading + digits;
  const shown = fraction.slice(0, Math.max(keep, whole === '0' ? leading + 1 : 0));
  const cut = shown.length < fraction.length;
  const format = (part: string) => `${sign}${grouped}${part ? `${decimal}${part}` : ''}`;
  return { text: `${format(shown)}${cut ? '…' : ''}${rest}`, full: `${format(fraction)}${rest}`, cut };
}
