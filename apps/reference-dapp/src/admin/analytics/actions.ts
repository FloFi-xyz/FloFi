// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the actions a run executes and their networks, read from the run's own canonical record — the semantic workflow it
 * was simulated, reviewed and executed with (`nodes[].actionType`, `nodes[].chainId`; a bridge's destination is its `asset-out` input).
 * Presentation-free and address-free: only action kinds, action types and CAIP-2 chains leave this module. A Solana composition also
 * names its step runs (`producerRunId`, `consumerRunIds`), so those runs are counted inside it, never twice.
 */
export type ActionKind = 'SWAP' | 'BRIDGE' | 'LIQUIDITY' | 'LENDING' | 'TRANSFER' | 'PAYMENT' | 'OTHER';
export const ACTION_KINDS: readonly ActionKind[] = ['SWAP', 'BRIDGE', 'LIQUIDITY', 'LENDING', 'TRANSFER', 'PAYMENT', 'OTHER'];
export const ACTION_LABELS: Readonly<Record<ActionKind, string>> = { SWAP: 'Swap', BRIDGE: 'Bridge', LIQUIDITY: 'Liquidity / Pools', LENDING: 'Lending',
  TRANSFER: 'Transfers', PAYMENT: 'Payments', OTHER: 'Other' };
/** One action of a run: its position, kind, exact action type, network, a bridge's destination network, and (compositions) its step runs. */
export type FactAction = { readonly i: number; readonly kind: ActionKind; readonly type: string; readonly chain: string; readonly to?: string;
  readonly runs?: readonly string[] };
/** `skipped`: workflow nodes the record holds that name no recognizable action type or network (or exceed the bound): reported, never guessed. */
export type RecordFacts = { readonly ok: true; readonly actions: readonly FactAction[]; readonly children: readonly string[]; readonly skipped: number }
  | { readonly ok: false; readonly code: string };

const CHAIN = /^[a-z0-9-]{3,8}:[A-Za-z0-9_-]{1,64}$/, TYPE = /^[a-z][a-z0-9.-]{0,63}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ACTIONS = 16;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function actionKind(type: string): ActionKind {
  if (type.startsWith('asset.swap.')) return 'SWAP';
  if (type === 'asset.bridge') return 'BRIDGE';
  if (type.startsWith('asset.liquidity.')) return 'LIQUIDITY';
  if (['supply', 'borrow', 'repay', 'withdraw'].includes(type)) return 'LENDING';
  if (type === 'asset.transfer') return 'TRANSFER';
  if (type.startsWith('payment.')) return 'PAYMENT';
  return 'OTHER';
}

/**
 * Template nodes (`mock-*`) and the derived liquidity preparation move nothing: they are neither actions nor missing actions. Mirrors the
 * engine's own financial-node rule (`action-registry` execution capabilities).
 */
const nonFinancial = (node: unknown) => object(node) && typeof node.actionType === 'string' &&
  (node.actionType.startsWith('mock-') || node.actionType === 'asset.liquidity.prepare');

function nodeAction(node: unknown, i: number): FactAction | null {
  if (!object(node) || typeof node.actionType !== 'string' || !TYPE.test(node.actionType)) return null;
  if (typeof node.chainId !== 'string' || !CHAIN.test(node.chainId)) return null;
  const kind = actionKind(node.actionType);
  let to: string | undefined;
  if (kind === 'BRIDGE' && Array.isArray(node.inputs)) {
    const out = node.inputs.find(input => object(input) && input.name === 'asset-out') as { value?: { chainId?: unknown } } | undefined;
    if (typeof out?.value?.chainId === 'string' && CHAIN.test(out.value.chainId)) to = out.value.chainId;
  }
  return { i, kind, type: node.actionType, chain: node.chainId, ...to ? { to } : {} };
}

/** The canonical workflow a record executes, wherever the flow's record format keeps it. */
function workflowOf(record: Record<string, unknown>): unknown {
  const review = object(record.review) ? record.review : null, reviews = Array.isArray(record.reviews) ? record.reviews : null;
  const prepared = object(record.prepared) ? record.prepared : null;
  const candidate = record.workflow ?? review?.workflow ?? (reviews && object(reviews.at(-1)) ? (reviews.at(-1) as Record<string, unknown>).workflow : undefined)
    ?? prepared?.workflow;
  if (candidate !== undefined) return candidate;
  return object(record.node) ? { nodes: [record.node] } : undefined; // Stablecoin → Pix: the payment node itself
}

export function recordFacts(flow: string, record: unknown): RecordFacts {
  if (!object(record)) return { ok: false, code: 'RUN_RECORD_INVALID' };
  const workflow = workflowOf(record);
  if (!object(workflow) || !Array.isArray(workflow.nodes) || workflow.nodes.length === 0) return { ok: false, code: 'RUN_WORKFLOW_MISSING' };
  const actions: FactAction[] = [], financial = workflow.nodes.filter(node => !nonFinancial(node));
  for (const node of financial.slice(0, MAX_ACTIONS)) {
    const action = nodeAction(node, actions.length);
    if (action) actions.push(action);
  }
  if (!actions.length) return { ok: false, code: 'RUN_ACTIONS_UNRECOGNIZED' };
  const skipped = financial.length - actions.length;
  if (flow !== 'solana-devnet-composition') return { ok: true, actions, children: [], skipped };
  // The composition record names its step runs exactly: the swap (producer) and the liquidity run(s) that consumed its output.
  const producer = typeof record.producerRunId === 'string' && RUN.test(record.producerRunId) ? [record.producerRunId] : [];
  const consumers = Array.isArray(record.consumerRunIds) ? record.consumerRunIds.filter((id): id is string => typeof id === 'string' && RUN.test(id)).slice(0, 8) : [];
  const steps = actions.map(action => action.kind === 'SWAP' ? { ...action, runs: producer } : action.kind === 'LIQUIDITY' ? { ...action, runs: consumers } : action);
  return { ok: true, actions: steps, children: [...producer, ...consumers], skipped };
}

/** The last complete JSONL record of a run log (the projection reads the same line). */
export function lastRecordLine(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd();
  const line = text.slice(text.lastIndexOf('\n') + 1);
  return JSON.parse(line);
}
