// SPDX-License-Identifier: AGPL-3.0-only
import type { CopilotAction, CopilotNetwork } from './copilot-intent';
import type { CopilotIntentV2 } from './copilot-intent-v2';
import { groundedAddress, groundedAmount, groundedBps, groundedSigned } from './copilot-authoring';
import { copilotNetworksMentioned, networkIdentity, networkOfCopilot } from './network-registry';
import { resolveAssetReference } from './asset-catalogs';
import { resolveUniversalAsset, universalAssetReference } from './universal-bridge-authoring';
import { UNIVERSAL_NETWORKS, type UniversalAssetRef, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import type { CanonicalAsset } from '@defi-workflow-engine/action-registry';

export type DraftField = 'amount' | 'inputAsset' | 'outputAsset' | 'asset' | 'network' | 'sourceNetwork' | 'destinationNetwork'
  | 'protocol' | 'range' | 'slippage' | 'beneficiary' | 'recipient' | 'routing' | 'target' | 'deposits' | 'time' | 'side' | 'spendAsset' | 'condition' | 'threshold' | 'percent' | 'schedule' | 'kind'
  /** BUILD-FLOFI-INTELLIGENCE-001: the cap of a goal plan's funded step. */ | 'cap';
/** Validation evidence is scoped to a slot and chain. A symbol alone is never an identity or execution authority. */
export type ValidatedDraftField = { readonly step: number; readonly field: DraftField; readonly value: string; readonly chain?: string; readonly identity?: UniversalAssetRef | CanonicalAsset };
const EVIDENCE_FIELDS: readonly DraftField[] = ['amount', 'asset', 'inputAsset', 'outputAsset', 'network', 'sourceNetwork', 'destinationNetwork', 'recipient', 'beneficiary'];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const words = (text: string, value: string) => text.toLowerCase().includes(value.toLowerCase()) &&
  new RegExp(`(?<![\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
function stated(field: string, value: unknown, text: string): boolean {
  if (typeof value !== 'string') return false;
  if (['network', 'sourceNetwork', 'destinationNetwork'].includes(field)) return copilotNetworksMentioned(text).includes(value as Exclude<CopilotNetwork, 'OTHER'>);
  if (field === 'lower' || field === 'upper') return groundedSigned(text, value);
  if (['amount', 'threshold', 'percent'].includes(field)) return groundedAmount(text, value);
  if (field === 'slippageBps') return groundedBps(text, value);
  if (field === 'recipient' || field === 'beneficiary') return groundedAddress(text, value) || words(text, value);
  if (field === 'time') return text.includes(value) || (value.endsWith(':00') && new RegExp(`\\b${Number(value.slice(0, 2))}h?\\b`, 'i').test(text));
  return words(text, value.replaceAll('_', ' ')) || words(text, value);
}
const record = (value: object) => value as Record<string, unknown>;
function mergeFields(before: object, interpreted: object, text: string): Record<string, unknown> {
  const out = { ...record(interpreted) };
  for (const [field, value] of Object.entries(before)) {
    if (field === 'deposits' && Array.isArray(value) && Array.isArray(out[field])) {
      const updated = out[field] as { asset: string; maxAmount: string }[];
      const prior = value as { asset: string; maxAmount: string }[];
      out[field] = [...prior.map(d => updated.find(n => n.asset.toLowerCase() === d.asset.toLowerCase() && words(text, n.asset) && groundedAmount(text, n.maxAmount)) ?? d),
        ...updated.filter(n => !prior.some(d => n.asset.toLowerCase() === d.asset.toLowerCase()) && words(text, n.asset) && groundedAmount(text, n.maxAmount))];
      continue;
    }
    if (value === null || value === undefined || Array.isArray(value) && !value.length) continue;
    if (!equal(value, out[field]) && !stated(field, out[field], text)) out[field] = value;
    if (out[field] === null || out[field] === undefined) out[field] = value;
  }
  return out;
}
/** An explicitly named side and one named network change only that side of the active bridge.
 * The interpreter still handles unrestricted corrections; no network identities are invented here. */
function bridgeNetworkCorrection(before: CopilotAction, after: CopilotAction, text: string): CopilotAction {
  if (before.type !== 'BRIDGE' || after.type !== 'BRIDGE') return after;
  const source = /\b(?:source|origem)\b/i.test(text), destination = /\b(?:destination|destino)\b/i.test(text);
  if (source === destination) return after;
  const networks = copilotNetworksMentioned(text);
  if (networks.length !== 1) return after;
  return { ...after, sourceNetwork: source ? networks[0]! : before.sourceNetwork,
    destinationNetwork: destination ? networks[0]! : before.destinationNetwork };
}
/** An active request supplies context. Values from completed/unrelated requests never enter here. Every result is re-planned and validated. */
export function mergeDraftIntent(before: CopilotIntentV2 | null, interpreted: CopilotIntentV2, latest: string): CopilotIntentV2 {
  if (before?.kind === 'ACTION' && interpreted.kind === 'EDIT') {
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(interpreted.changes)) {
      if (value === null || Array.isArray(value) && !value.length) continue;
      const key = field === 'inputAsset' && before.action.type !== 'SWAP' ? 'asset' : field === 'network' && before.action.type === 'BRIDGE' ? 'sourceNetwork' : field;
      if (key in before.action || key === 'outputAsset' && before.action.type === 'BRIDGE') patch[key] = value;
    }
    return { ...before, language: interpreted.language, action: bridgeNetworkCorrection(before.action, { ...before.action, ...patch } as CopilotAction, latest) };
  }
  if (interpreted.kind === 'ACTION') {
    const action = before?.kind === 'ACTION' && before.action.type === interpreted.action.type
      ? mergeFields(before.action, interpreted.action, latest) as CopilotAction : interpreted.action;
    return { ...interpreted, action: before?.kind === 'ACTION' ? bridgeNetworkCorrection(before.action, action, latest) : action };
  }
  if (before?.kind === 'COMPOSITION' && interpreted.kind === 'COMPOSITION' && before.actions.length === interpreted.actions.length &&
    before.actions.every((a, i) => a.type === interpreted.actions[i]!.type)) return { ...interpreted, actions: interpreted.actions.map((action, i) =>
      mergeFields(before.actions[i]!, action, latest) as CopilotAction) };
  if (before?.kind === 'AUTOMATION' && interpreted.kind === 'AUTOMATION') return { ...interpreted,
    draft: mergeFields(before.draft, interpreted.draft, latest) as typeof interpreted.draft };
  // BUILD-FLOFI-INTELLIGENCE-001: an open goal keeps every value already settled unless the latest message states a different one.
  if (before?.kind === 'GOAL' && interpreted.kind === 'GOAL') return { ...interpreted, goal: { ...interpreted.goal,
    source: mergeFields(before.goal.source, interpreted.goal.source, latest) as typeof interpreted.goal.source,
    target: { ...mergeFields(before.goal.target, interpreted.goal.target, latest) as typeof interpreted.goal.target, use: interpreted.goal.target.use },
    preference: interpreted.goal.preference ?? before.goal.preference, cap: interpreted.goal.cap ?? before.goal.cap,
    recipient: interpreted.goal.recipient ?? before.goal.recipient ?? null,
    liquidity: interpreted.goal.liquidity && before.goal.liquidity ? mergeFields(before.goal.liquidity, interpreted.goal.liquidity, latest) as typeof interpreted.goal.liquidity
      : interpreted.goal.liquidity ?? before.goal.liquidity ?? null } };
  return interpreted;
}
/** A short reply to one typed slot; arbitrary sentences and corrections still go through the model. */
export function answerDraftField(intent: CopilotIntentV2, expected: readonly DraftField[], text: string): CopilotIntentV2 | null {
  const networks = expected.filter(field => ['network', 'sourceNetwork', 'destinationNetwork'].includes(field));
  const assets = expected.filter(field => ['asset', 'inputAsset', 'outputAsset'].includes(field));
  const field = expected.length === 1 ? expected[0] : networks.length === 1 && networkIdentity(text) ? networks[0]
    : assets.length === 1 && !/^\d+(?:[.,]\d+)*$/.test(text) && !networkIdentity(text) ? assets[0] : null;
  if (!field) return null;
  if (intent.kind === 'AUTOMATION' && field === 'time') {
    const match = /^(\d{1,2})(?::([0-5]\d)|h)?[.!]?$/.exec(text);
    if (!match || Number(match[1]) > 23) return null;
    return { ...intent, draft: { ...intent.draft, time: `${match[1]!.padStart(2, '0')}:${match[2] ?? '00'}` } };
  }
  const put = (key: string, value: string): CopilotIntentV2 | null => {
    if (intent.kind === 'ACTION') return { ...intent, action: { ...intent.action, [key]: value } as CopilotAction };
    if (intent.kind === 'EDIT' || intent.kind === 'REPEAT') {
      const changed = key === 'asset' ? 'inputAsset' : key === 'sourceNetwork' ? 'network' : key;
      return { ...intent, changes: { ...intent.changes, [changed]: value } };
    }
    return null;
  };
  if (['network', 'sourceNetwork', 'destinationNetwork'].includes(field)) {
    const network = networkIdentity(text.replace(/[.!?]+$/, ''))?.copilot;
    return network ? put(field, network) : null;
  }
  if (!['asset', 'inputAsset', 'outputAsset'].includes(field)) return null;
  const value = text.trim().replace(/^(?:(?:no|não|nao)[,!]?\s*)?(?:I want|quero|prefiro)\s+/i, '').replace(/[!?]+$/, '');
  if (value.length > 160 || !/^[\p{L}\p{N}$][\p{L}\p{N} .&'@_+*-]*$/u.test(value) ||
    /\b(?:want|quero|change|muda|troca|instead|not|não|nao|on|na|no|para|to|bridge|swap|send)\b/i.test(value)) return null;
  // A multiword token name must actually be a name in this slot's catalog. Questions and ordinary prose go to the interpreter.
  if (/\s/.test(value)) {
    if (intent.kind !== 'ACTION') return null;
    const action = intent.action, network = action.type === 'BRIDGE' ? field === 'outputAsset' ? action.destinationNetwork : action.sourceNetwork : action.network;
    if (!network || network === 'OTHER') return null;
    const identity = networkOfCopilot(network), key = Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === identity.chain)?.key;
    if (key === 'solana') { try { universalAssetReference(key, value); } catch { return null; } }
    else if (!['FOUND', 'AMBIGUOUS'].includes(resolveAssetReference(identity.chain, value).kind)) return null;
  }
  return put(field, value);
}
export function validatedDraftFields(intent: CopilotIntentV2, text: string): readonly ValidatedDraftField[] {
  const actions = intent.kind === 'ACTION' ? [intent.action] : intent.kind === 'COMPOSITION' ? intent.actions : [];
  return actions.flatMap((action, step) => Object.entries(action).flatMap(([field, value]): ValidatedDraftField[] => {
    if (!EVIDENCE_FIELDS.includes(field as DraftField) || typeof value !== 'string' || !stated(field, value, text)) return [];
    const slot = field as DraftField;
    const network = action.type === 'BRIDGE' ? field === 'outputAsset' ? action.destinationNetwork : action.sourceNetwork : action.network;
    if (['asset', 'inputAsset', 'outputAsset'].includes(field)) {
      if (!network || network === 'OTHER') return [];
      const identity = networkOfCopilot(network), key = Object.values(UNIVERSAL_NETWORKS).find(n => n.chain === identity.chain)?.key as UniversalNetworkKey | undefined;
      try {
        const found = resolveAssetReference(identity.chain, value);
        const asset = key ? resolveUniversalAsset(key, universalAssetReference(key, value)).asset : found.kind === 'FOUND' ? found.asset : null;
        return asset ? [{ step, field: slot, value, chain: identity.chain, identity: asset }] : [];
      } catch { return []; }
    }
    return [{ step, field: slot, value }];
  }));
}
