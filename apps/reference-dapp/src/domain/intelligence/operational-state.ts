// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the typed operational state of one conversation, derived — never stored separately — from FloFi's canonical
 * state: the conversation engine's open request (its draft, validated evidence, carried values and FloFi's own questions), the canonical
 * workflow and its revision, the visible pending proposal, the proposals FloFi showed, and the connected wallets' public network context.
 *
 *   validated   a value the user's own words in the open request state (amount, network, token with its chain-scoped identity)
 *   carried     a value FloFi took from a step or proposal the user already authored or saw (previously confirmed)
 *   corrected   a field the user changed in this request ("make it 2", "USDT on the destination instead")
 *   missing     what FloFi still asks for; `asked` counts each question so a settled field is never asked again unnoticed
 *   awaiting    an asset whose network catalog is not loaded yet: named, but not verified
 *
 * The transcript is context for the model only; financial values come from this state and the user's validated words. The `contextCard` is
 * the sanitized part a model may read through a tool: step kinds, networks and FloFi's own step summaries, never node ids, chain ids, wallet
 * addresses or recipients. Pure.
 */
import type { CopilotConversation, CopilotEnvironment } from '../copilot-conversation';
import { stepSummary } from '../copilot-answers';
import { workflowSteps } from '../workflow-steps';
import { networkIdentity } from '../network-registry';
import { officialCatalogLoaded } from '../asset-catalogs';
import { validatedDraftFields } from '../copilot-draft';

export const CONTEXT_CARD_VERSION = 1;
export const CONTEXT_CARD_LIMITS = Object.freeze({ maxSteps: 8, maxSummaryLength: 160, maxFields: 24, maxValueLength: 60, maxBytes: 6_000 });
export type FieldStatus = 'VALIDATED' | 'CARRIED' | 'CORRECTED' | 'MISSING';
export type OperationalField = { readonly step: number; readonly field: string; readonly value: string | null; readonly status: FieldStatus;
  readonly verification: 'VERIFIED' | 'AWAITING_VERIFICATION' | 'NOT_APPLICABLE' };
export type OperationalState = {
  readonly version: typeof CONTEXT_CARD_VERSION; readonly revision: number;
  readonly request: { readonly open: boolean; readonly kind: string | null; readonly operations: readonly string[]; readonly fields: readonly OperationalField[];
    readonly missing: readonly string[]; readonly asked: Readonly<Record<string, number>>; readonly repeatedQuestions: number; readonly clarifications: number };
  readonly pending: { readonly summary: string } | null;
  readonly steps: readonly { readonly index: number; readonly kind: string; readonly network: string | null; readonly summary: string }[];
  readonly wallet: { readonly evm: { readonly connected: boolean; readonly network: string | null }; readonly solana: { readonly connected: boolean } };
  readonly proposalsShown: number;
};
/** Wallet addresses, Solana public keys and node ids never leave FloFi in a context card. */
export const redactCard = (text: string): string => text.replace(/0x[0-9a-fA-F]{40}/g, '[address]').replace(/(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g, '[address]')
  .replace(/node-\d+/g, 'step').replace(/eip155:\d+|solana:[A-Za-z0-9]+/g, '').slice(0, CONTEXT_CARD_LIMITS.maxSummaryLength);

const OPERATION: Readonly<Record<string, string>> = { SWAP: 'swap', BRIDGE: 'bridge', SUPPLY: 'supply', BORROW: 'borrow', REPAY: 'repay', WITHDRAW: 'withdraw',
  LIQUIDITY: 'add_liquidity', TRANSFER: 'transfer' };
const ASSET_FIELDS = new Set(['asset', 'inputAsset', 'outputAsset']);
const NETWORK_FIELDS: Readonly<Record<string, string>> = { asset: 'network', inputAsset: 'network', outputAsset: 'destinationNetwork' };

/** The operational state of `conversation` against `env`, now. */
export function operationalState(conversation: CopilotConversation, env: CopilotEnvironment): OperationalState {
  const draft = conversation.draft, intent = draft?.intent ?? null, text = conversation.segment.join('\n');
  const actions = intent?.kind === 'ACTION' ? [intent.action] : intent?.kind === 'COMPOSITION' ? intent.actions : [];
  const validated = intent ? validatedDraftFields(intent, text) : [];
  const corrected = new Set(conversation.ledger?.corrected ?? []), carried = new Set(draft?.extras?.carried ?? []);
  const fields: OperationalField[] = [];
  for (const [step, action] of actions.entries()) for (const [field, value] of Object.entries(action)) {
    if (typeof value !== 'string' || fields.length >= CONTEXT_CARD_LIMITS.maxFields) continue;
    const evidence = validated.find(item => item.step === step && item.field === field);
    const status: FieldStatus | null = corrected.has(field) ? 'CORRECTED' : evidence ? 'VALIDATED' : carried.has(field as never) ? 'CARRIED' : null;
    if (!status) continue;
    const network = (action as Record<string, unknown>)[action.type === 'BRIDGE' ? (field === 'outputAsset' ? 'destinationNetwork' : 'sourceNetwork') : NETWORK_FIELDS[field] ?? 'network'];
    const chain = typeof network === 'string' ? networkIdentity(network)?.chain ?? null : null;
    const verification = !ASSET_FIELDS.has(field) ? 'NOT_APPLICABLE' : evidence?.identity ? 'VERIFIED' : chain && !officialCatalogLoaded(chain) ? 'AWAITING_VERIFICATION' : 'NOT_APPLICABLE';
    fields.push({ step, field, value: value.slice(0, CONTEXT_CARD_LIMITS.maxValueLength), status, verification });
  }
  const missing = draft?.expected?.filter(field => field !== 'target') ?? [];
  for (const field of missing) if (!fields.some(item => item.field === field)) fields.push({ step: 0, field, value: null, status: 'MISSING', verification: 'NOT_APPLICABLE' });
  const asked = Object.fromEntries((conversation.ledger?.asked ?? []).map(item => [item.field, item.count]));
  const steps = workflowSteps(env.workflow, env.context).filter(step => step.kind !== 'TEMPLATE').slice(0, CONTEXT_CARD_LIMITS.maxSteps).map(step => {
    const node = env.workflow.nodes.find(item => item.nodeId === step.nodeId);
    return { index: step.index, kind: step.kind, network: node ? networkIdentity(node.chainId)?.name ?? null : null, summary: redactCard(stepSummary(step, 'EN')) };
  });
  const pending = env.pending ? conversation.referents.find(referent => referent.command === env.pending!.command) : undefined;
  const evmNetwork = env.walletChainId ? networkIdentity(env.walletChainId)?.name ?? null : null;
  return { version: CONTEXT_CARD_VERSION, revision: env.workflow.revision,
    request: { open: Boolean(draft) || conversation.segment.length > 0, kind: intent?.kind ?? null,
      operations: [...new Set(actions.map(action => OPERATION[action.type] ?? action.type.toLowerCase()))], fields, missing,
      asked, repeatedQuestions: conversation.ledger?.repeats ?? 0, clarifications: conversation.clarifications },
    pending: env.pending ? { summary: redactCard(pending?.sentence ?? env.pending.command.type) } : null,
    steps, wallet: { evm: { connected: Boolean(env.wallet), network: env.wallet ? evmNetwork : null }, solana: { connected: Boolean(env.verified?.solanaOwner) } },
    proposalsShown: conversation.referents.length };
}

/** The sanitized context a model may read through `get_workflow_context` / `get_wallet_context`: the operational state minus counters. */
export type CopilotContextCard = Pick<OperationalState, 'version' | 'revision' | 'pending' | 'steps' | 'wallet'> & {
  readonly request: Pick<OperationalState['request'], 'open' | 'kind' | 'operations' | 'fields' | 'missing'> };
export function contextCard(state: OperationalState): CopilotContextCard {
  const { open, kind, operations, fields, missing } = state.request;
  let card: CopilotContextCard = { version: state.version, revision: state.revision, pending: state.pending, steps: state.steps, wallet: state.wallet,
    request: { open, kind, operations, fields: fields.map(field => ({ ...field, value: field.value === null ? null : redactCard(field.value) })), missing } };
  // Bounded: past the size limit the oldest steps, then the open request's fields, are left out (never the revision, pending proposal or wallet).
  while (JSON.stringify(card).length > CONTEXT_CARD_LIMITS.maxBytes && (card.steps.length > 1 || card.request.fields.length))
    card = card.steps.length > 1 ? { ...card, steps: card.steps.slice(1) } : { ...card, request: { ...card.request, fields: card.request.fields.slice(0, -1) } };
  return card;
}
/** A short, stable fingerprint of a card: the server echoes it, and a turn whose context changed meanwhile never applies the answer. */
export function contextKey(card: CopilotContextCard): string {
  const text = JSON.stringify(card);
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) { a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0; b = Math.imul(b ^ text.charCodeAt(i), 0x5bd1e995) >>> 0; }
  return `c${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}
