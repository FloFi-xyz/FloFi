// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the Copilot's read-only tools (shared platform: FloFi's chat and Channel Core run the same contracts) — the only platform functions a model may ask FloFi to run, each over FloFi's own
 * production registries, catalogs, engine and read-only route discovery:
 *
 *   get_capabilities    the Capability API profile of a network (or all), in this deployment's network scope
 *   resolve_asset       a written token on one network → canonical identity, ambiguity, currency (FIAT) or a closed failure
 *   find_routes         the universal router's read-only discovery for a pair and amount (every provider classified) + certified-route facts
 *   get_quote           the recommended executable route of that discovery, with provider provenance and observation time
 *   get_workflow_context / get_wallet_context  FloFi's sanitized context card the client sent (steps, pending proposal, public network context)
 *   validate_strategy   the deterministic validation of a typed strategy (the MCP contract), with its workflow hash
 *   plan_goal           FloFi's goal planner (registry-driven steps, reasons and alternatives) composed by the engine
 *   explain_failure     FloFi's own explanation of a closed failure code
 *
 * Every name is allowlisted, every argument object is validated strictly here (exact keys, closed vocabularies, bounded strings) whatever the
 * model sent, every output is bounded and carries no secret, no wallet address and no executable data. Nothing here can author, simulate,
 * sign, submit or reach an arbitrary endpoint: route discovery is the platform's own fixed, read-only pipeline with public quote subjects.
 */
import { UNIVERSAL_NETWORKS, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { parseTokenAmount, formatTokenAmount } from '../domain/jupiter-authoring';
import { NETWORKS, networkIdentity } from '../domain/network-registry';
import { networkAllowed, type NetworkScope } from '../domain/network-scope';
import { bridgeOffers } from '../domain/authoring-capabilities';
import { copilotRejection } from '../domain/copilot-authoring';
import { failureText } from '../domain/copilot-conversation';
import { STRATEGY_ACTIONS, type StrategyAction } from '../engine/strategy-spec';
import { composeWorkflow } from '../engine/strategy-engine';
import { networkCapabilityProfiles, networkCapabilityProfile, type NetworkCapabilityProfile } from '../domain/intelligence/capability-api';
import { lookupAsset } from '../domain/intelligence/asset-resolution';
import { GOAL_PREFERENCES, GOAL_USES, planGoal, type Goal } from '../domain/intelligence/goal-planner';
import { goalStrategy } from '../domain/intelligence/goal-strategy';
import { COPILOT_V1_PARTS, type CopilotLiquidityAction } from '../domain/copilot-intent';
import type { CopilotContextCard } from '../domain/intelligence/operational-state';
import { validateStrategy } from './strategy';

/** The fields of the platform's universal discovery result the tools read (`server/universal-router/discovery.ts` produces it). */
export type RouteDiscovery = { readonly observedAt: string; readonly status: string; readonly quoteSubjects: string; readonly recommended: number | null;
  readonly candidates: readonly { readonly provider: string; readonly bridge: string; readonly status: string; readonly executableBy: string | null;
    readonly expectedOutput: string | null; readonly minimumOutput: string | null; readonly estimatedDurationSeconds: number | null; readonly reason: string | null;
    readonly fees: readonly { readonly label: string; readonly amount: string; readonly symbol: string; readonly decimals: number; readonly included: boolean }[] }[];
  /** BUILD-FLOFI-EXECUTION-PERFORMANCE-001: PARTIAL when the discovery window closed before every provider answered. */
  readonly completeness?: 'COMPLETE' | 'PARTIAL'; readonly pendingProviders?: readonly string[] };

export const COPILOT_TOOL_NAMES = ['get_capabilities', 'resolve_asset', 'find_routes', 'get_quote', 'get_workflow_context', 'get_wallet_context', 'validate_strategy',
  'plan_goal', 'explain_failure'] as const;
export type CopilotToolName = (typeof COPILOT_TOOL_NAMES)[number];
export type ToolCategory = 'CAPABILITY' | 'ASSET' | 'ROUTE' | 'QUOTE' | 'WORKFLOW' | 'WALLET' | 'VALIDATION' | 'PLANNING' | 'EXPLANATION';
export const TOOL_CATEGORY: Readonly<Record<CopilotToolName, ToolCategory>> = Object.freeze({ get_capabilities: 'CAPABILITY', resolve_asset: 'ASSET', find_routes: 'ROUTE',
  get_quote: 'QUOTE', get_workflow_context: 'WORKFLOW', get_wallet_context: 'WALLET', validate_strategy: 'VALIDATION', plan_goal: 'PLANNING', explain_failure: 'EXPLANATION' });
export const COPILOT_TOOL_LIMITS = Object.freeze({ maxArgumentBytes: 4_096, maxOutputBytes: 8_192, timeoutMs: 8_000, maxCandidates: 6 });

/** Read-only platform ports. Absent: that tool answers with a closed `*_UNAVAILABLE` code (never a substitute). */
export type CopilotToolPorts = {
  /** The platform's read-only universal route discovery (`readBridgeDiscovery`): public quote subjects, no owner, nothing persisted. */
  readonly discover?: (request: unknown) => Promise<{ readonly ok: true; readonly value: RouteDiscovery } | { readonly ok: false; readonly code: string }>;
  /** Registers the validated official catalogs a request names (`authoringCatalogPreparer`); never throws. */
  readonly prepareCatalogs?: (text: string, intent?: unknown) => Promise<void>;
};
export type CopilotToolContext = { readonly scope: NetworkScope; readonly card: CopilotContextCard | null; readonly ports: CopilotToolPorts; readonly language: 'EN' | 'PT' };
export type ToolRun = { readonly name: CopilotToolName | null; readonly category: ToolCategory | null; readonly outcome: string; readonly output: Record<string, unknown> };

const SCHEMA_STRING = (description: string, maxLength = 160) => ({ type: 'string', description, maxLength });
const NULLABLE = (description: string) => ({ type: ['string', 'null'], description });
const NETWORK_TEXT = 'A FloFi network key or name exactly as FloFi lists it (for example "base", "arbitrum-one", "solana", "Arbitrum One").';
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
/** The Responses API function tools, strict: every property is required, nullable where optional. */
export const COPILOT_TOOL_DEFINITIONS: readonly Record<string, unknown>[] = Object.freeze([
  { type: 'function', name: 'get_capabilities', strict: true, description: 'What FloFi can author on a network (or on every network of this deployment): actions, assets, routes, ' +
    'required parameters, code-level simulation/review/execution support and limitations. Registered functionality is not execution certification.',
    parameters: object({ network: NULLABLE(`${NETWORK_TEXT} Null for every network.`), action: { anyOf: [{ type: 'string', enum: [...STRATEGY_ACTIONS] }, { type: 'null' }], description: 'Filter by action, or null.' } }) },
  { type: 'function', name: 'resolve_asset', strict: true, description: 'Resolve a token exactly as the user wrote it on one network: its canonical symbol and whether it is native, ' +
    'several candidates, a currency (not a token) with that network\'s stablecoins, or a closed failure.',
    parameters: object({ network: SCHEMA_STRING(NETWORK_TEXT, 60), reference: SCHEMA_STRING('The token symbol or name exactly as written.') }) },
  { type: 'function', name: 'find_routes', strict: true, description: 'Read-only live route discovery between two networks for an amount: every provider\'s status, expected and ' +
    'guaranteed amounts, fees and durations, observed now. Also says whether a certified Cross-chain Router route exists. Nothing is reserved or executed.',
    parameters: object({ sourceNetwork: SCHEMA_STRING(NETWORK_TEXT, 60), destinationNetwork: SCHEMA_STRING(NETWORK_TEXT, 60), inputAsset: SCHEMA_STRING('Asset spent, as written.'),
      outputAsset: NULLABLE('Asset received, as written; null for the same asset.'), amount: SCHEMA_STRING('Decimal amount the user wrote ("." separator).', 40) }) },
  { type: 'function', name: 'get_quote', strict: true, description: 'The recommended executable route of a live read-only discovery (the one FloFi would pick by guaranteed amount), ' +
    'with provider, fees, expected and guaranteed amount and observation time. Swaps are quoted by the fresh simulation at Review, not here.',
    parameters: object({ sourceNetwork: SCHEMA_STRING(NETWORK_TEXT, 60), destinationNetwork: SCHEMA_STRING(NETWORK_TEXT, 60), inputAsset: SCHEMA_STRING('Asset spent, as written.'),
      outputAsset: NULLABLE('Asset received, as written; null for the same asset.'), amount: SCHEMA_STRING('Decimal amount the user wrote ("." separator).', 40) }) },
  { type: 'function', name: 'get_workflow_context', strict: true, description: 'The user\'s current FloFi workflow (steps in order with FloFi\'s own summaries, revision), the pending ' +
    'proposal and the open request\'s validated, carried, corrected and missing fields. No addresses or identifiers.', parameters: object({}) },
  { type: 'function', name: 'get_wallet_context', strict: true, description: 'Whether an EVM and/or Solana wallet is connected and the EVM wallet\'s network. Never an address or balance.',
    parameters: object({}) },
  { type: 'function', name: 'validate_strategy', strict: true, description: 'Validate a FloFi strategy (the MCP strategy contract, version 1 or 2) deterministically: valid with its ' +
    'workflow hash and review counts, or a closed refusal code with paths. Use only values the user gave; never invent an address.',
    parameters: object({ strategy: SCHEMA_STRING('The strategy as one JSON object text.', 3_000) }) },
  { type: 'function', name: 'plan_goal', strict: true, description: 'FloFi\'s goal planner: the ordered steps (from FloFi\'s registries) that reach an outcome, why, and alternatives; ' +
    'or the one missing field, or why it is not reachable. Only plans; never authors.',
    parameters: object({ sourceNetwork: NULLABLE(NETWORK_TEXT), sourceAsset: NULLABLE('Asset the user holds, as written.'), amount: NULLABLE('Amount the user wrote, or null.'),
      targetNetwork: NULLABLE(NETWORK_TEXT), targetAsset: NULLABLE('Asset the user wants, as written, or null.'), use: { type: 'string', enum: [...GOAL_USES], description: 'What the asset is for.' },
      preference: { anyOf: [{ type: 'string', enum: [...GOAL_PREFERENCES] }, { type: 'null' }], description: 'Only if the user stated one.' },
      cap: NULLABLE('User-stated maximum for the funded destination action, or null.'),
      liquidity: { anyOf: [SCHEMA_STRING('The user-stated LIQUIDITY action as JSON (deposits, range and fee tier).', 3_000), { type: 'null' }],
        description: 'The user-stated LIQUIDITY action as JSON, or null for other goals.' } }) },
  { type: 'function', name: 'explain_failure', strict: true, description: 'FloFi\'s own explanation of a closed failure code returned by FloFi (for example NO_ROUTE, ASSET_UNKNOWN).',
    parameters: object({ code: SCHEMA_STRING('The code exactly as FloFi returned it.', 80) }) },
]);

class ToolInputError extends Error {}
const bad = (): never => { throw new ToolInputError('TOOL_ARGUMENTS_INVALID'); };
function exactArgs(raw: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length > COPILOT_TOOL_LIMITS.maxArgumentBytes) return bad();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return bad();
  const own = Object.keys(value as object);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) return bad();
  return value as Record<string, unknown>;
}
const SAFE = /^[\p{L}\p{N} .,&'@_+$€:()/-]{1,160}$/u;
const str = (value: unknown, max = 160): string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && SAFE.test(value.trim()) ? value.trim() : bad();
const nstr = (value: unknown, max = 160): string | null => value === null ? null : str(value, max);
const choice = <T extends string>(values: readonly T[], value: unknown): T => (values as readonly unknown[]).includes(value) ? value as T : bad();
const AMOUNT = /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/;

/** A network key, name or alias the scope offers, or a closed refusal. */
function scopedNetwork(value: string, scope: NetworkScope): { ok: true; key: string; name: string } | { ok: false; code: string } {
  const wanted = value.trim().toLowerCase();
  const identity = networkIdentity(value) ?? networkIdentity(wanted.replace(/\s+/g, '-')) ??
    NETWORKS.find(network => network.name.toLowerCase() === wanted || network.aliases.some(alias => alias.toLowerCase() === wanted)) ?? null;
  if (!identity) return { ok: false, code: 'NETWORK_UNKNOWN' };
  if (!networkAllowed(identity.key, scope)) return { ok: false, code: 'TEST_NETWORK_NOT_AVAILABLE' };
  return { ok: true, key: identity.key, name: identity.name };
}
/** A profile trimmed for the model: no addresses; bounded lists. */
const profileView = (profile: NetworkCapabilityProfile, action: StrategyAction | null) => ({ network: profile.key, name: profile.name, availability: profile.availability,
  realFunds: profile.realFunds, universalBridge: profile.universalBridge, actions: profile.actions.filter(item => !action || item.action === action).map(item => ({
    action: item.action, assets: item.assets.kind === 'OFFICIAL_CATALOG' ? { source: 'OFFICIAL_CATALOG', loaded: item.assets.loaded, examples: item.assets.examples }
      : { source: 'REGISTRY', symbols: item.assets.symbols.slice(0, 12) }, certifiedRoutes: item.routes.slice(0, 8), requiredParameters: item.requiredParameters,
    supportedByCode: { simulate: item.eligibility.simulate, review: item.eligibility.review, execute: item.eligibility.execute, demonstratedEvidence: item.eligibility.demonstratedEvidence },
    deployment: item.eligibility.deployment, limitations: item.limitations })) });

/** The discovery request for a pair (public quote subjects: no owner), or a closed code. */
async function discoveryRequest(args: Record<string, unknown>, ctx: CopilotToolContext): Promise<{ ok: true; request: Record<string, unknown>; source: string; destination: string;
  outputSymbol: string; decimals: number } | { ok: false; code: string }> {
  const source = scopedNetwork(str(args.sourceNetwork, 60), ctx.scope), destination = scopedNetwork(str(args.destinationNetwork, 60), ctx.scope);
  if (!source.ok) return source;
  if (!destination.ok) return destination;
  if (source.key === destination.key) return { ok: false, code: 'SAME_NETWORK' };
  const keys = Object.keys(UNIVERSAL_NETWORKS);
  if (!keys.includes(source.key) || !keys.includes(destination.key)) return { ok: false, code: 'NO_UNIVERSAL_ROUTE_FOR_NETWORK' };
  const amount = str(args.amount, 40);
  if (!AMOUNT.test(amount)) return { ok: false, code: 'AMOUNT_INVALID' };
  const inputRef = str(args.inputAsset), outputRef = nstr(args.outputAsset) ?? inputRef;
  await ctx.ports.prepareCatalogs?.(`${source.name} ${destination.name}`, { sourceNetwork: networkIdentity(source.key)?.copilot, destinationNetwork: networkIdentity(destination.key)?.copilot });
  const input = lookupAsset(source.key, inputRef), output = lookupAsset(destination.key, outputRef);
  if (input.kind !== 'FOUND') return { ok: false, code: `INPUT_ASSET_${input.kind}` };
  if (output.kind !== 'FOUND') return { ok: false, code: `OUTPUT_ASSET_${output.kind}` };
  const token = (identity: typeof input.identity) => identity.native ? { kind: 'NATIVE' } : { kind: 'TOKEN', address: identity.address!, decimals: identity.decimals, symbol: identity.symbol };
  let units: string;
  try { units = parseTokenAmount(amount, input.identity.decimals); } catch { return { ok: false, code: 'AMOUNT_INVALID' }; }
  if (!/^[1-9]/.test(units)) return { ok: false, code: 'AMOUNT_INVALID' };
  return { ok: true, source: source.key, destination: destination.key, outputSymbol: output.identity.symbol, decimals: output.identity.decimals,
    request: { source: source.key as UniversalNetworkKey, destination: destination.key as UniversalNetworkKey, inputToken: token(input.identity), outputToken: token(output.identity),
      amount: units, slippageBps: Math.min(100, UNIVERSAL_ROUTER_MAXIMUM_SLIPPAGE_BPS) } };
}
const display = (units: string | null, decimals: number) => units === null ? null : (() => { try { return formatTokenAmount(units, decimals); } catch { return null; } })();
function routeView(result: RouteDiscovery, symbol: string, decimals: number) {
  return { provenance: 'FLOFI_UNIVERSAL_DISCOVERY', observedAt: result.observedAt, freshness: 'LIVE_AT_OBSERVATION_RE_QUOTED_AT_REVIEW', status: result.status,
    // PROVISIONAL: some providers had not answered when the discovery window closed (named in notCompared); COMPARED: every provider answered.
    // Either way the quote is re-made for the owner at Review: neither is "ready for Review".
    comparison: result.completeness === 'PARTIAL' ? 'PROVISIONAL' : 'COMPARED', notCompared: (result.pendingProviders ?? []).slice(0, 4),
    quoteSubjects: result.quoteSubjects, receive: symbol,
    candidates: result.candidates.slice(0, COPILOT_TOOL_LIMITS.maxCandidates).map((candidate, index) => ({ provider: candidate.provider, bridge: candidate.bridge.slice(0, 40),
      status: candidate.status, executable: candidate.executableBy !== null, recommended: index === result.recommended,
      expectedOutput: display(candidate.expectedOutput, decimals), guaranteedOutput: display(candidate.minimumOutput, decimals),
      estimatedDurationSeconds: candidate.estimatedDurationSeconds, reason: candidate.reason,
      fees: candidate.fees.slice(0, 6).map(fee => ({ label: fee.label.slice(0, 40), amount: display(fee.amount, fee.decimals), symbol: fee.symbol, includedInAmount: fee.included })) })) };
}
async function withTimeout<T>(run: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([run, new Promise<'TIMEOUT'>(resolve => { timer = setTimeout(() => resolve('TIMEOUT'), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const certifiedOn = (source: string, destination: string) => bridgeOffers().filter(route => route.source.key === source && route.destination.key === destination).map(route => route.asset);
const KNOWN_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

/** Runs one tool call. Never throws; every failure is a closed code in `outcome` and `output`. */
export async function runCopilotTool(name: string, rawArguments: string, ctx: CopilotToolContext): Promise<ToolRun> {
  const known = (COPILOT_TOOL_NAMES as readonly string[]).includes(name) ? name as CopilotToolName : null;
  if (!known) return { name: null, category: null, outcome: 'TOOL_NOT_ALLOWED', output: { ok: false, code: 'TOOL_NOT_ALLOWED' } };
  const done = (output: Record<string, unknown>): ToolRun => {
    const text = JSON.stringify(output);
    const bounded = text.length > COPILOT_TOOL_LIMITS.maxOutputBytes ? { ok: false, code: 'TOOL_OUTPUT_TOO_LARGE' } : output;
    return { name: known, category: TOOL_CATEGORY[known], outcome: bounded.ok === false ? String(bounded.code ?? 'TOOL_FAILED') : 'OK', output: bounded };
  };
  try {
    switch (known) {
      case 'get_capabilities': {
        const args = exactArgs(rawArguments, ['network', 'action']), network = nstr(args.network, 60), action = args.action === null ? null : choice(STRATEGY_ACTIONS, args.action);
        if (network) {
          const scoped = scopedNetwork(network, ctx.scope);
          if (!scoped.ok) return done({ ok: false, code: scoped.code });
          const profile = networkCapabilityProfile(ctx.scope, scoped.key);
          return done(profile ? { ok: true, scope: ctx.scope, networks: [profileView(profile, action)] } : { ok: false, code: 'NO_CAPABILITIES_ON_NETWORK' });
        }
        return done({ ok: true, scope: ctx.scope, networks: networkCapabilityProfiles(ctx.scope).map(profile => ({ ...profileView(profile, action),
          actions: profileView(profile, action).actions.map(item => ({ action: item.action, supportedByCode: item.supportedByCode, limitations: item.limitations })) })) });
      }
      case 'resolve_asset': {
        const args = exactArgs(rawArguments, ['network', 'reference']), scoped = scopedNetwork(str(args.network, 60), ctx.scope);
        if (!scoped.ok) return done({ ok: false, code: scoped.code });
        await ctx.ports.prepareCatalogs?.(scoped.name, { network: networkIdentity(scoped.key)?.copilot });
        const found = lookupAsset(scoped.key, str(args.reference));
        if (found.kind === 'FOUND') return done({ ok: true, kind: 'FOUND', network: scoped.name, symbol: found.identity.symbol, native: found.identity.native,
          decimals: found.identity.decimals, by: found.by, note: found.identity.native ? 'Native coin (not a wrapped token).' : 'Token contract in the official registry.' });
        if (found.kind === 'AMBIGUOUS' || found.kind === 'FIAT') return done({ ok: true, ...found, network: scoped.name });
        return done({ ok: false, code: `ASSET_${found.kind}`, network: scoped.name });
      }
      case 'find_routes': case 'get_quote': {
        const args = exactArgs(rawArguments, ['sourceNetwork', 'destinationNetwork', 'inputAsset', 'outputAsset', 'amount']);
        const prepared = await discoveryRequest(args, ctx);
        if (!prepared.ok) return done({ ok: false, code: prepared.code });
        const certified = certifiedOn(prepared.source, prepared.destination);
        if (!ctx.ports.discover) return done({ ok: false, code: 'ROUTE_DISCOVERY_UNAVAILABLE', certifiedRouteAssets: certified });
        const result = await withTimeout(ctx.ports.discover(prepared.request), COPILOT_TOOL_LIMITS.timeoutMs);
        if (result === 'TIMEOUT') return done({ ok: false, code: 'ROUTE_DISCOVERY_TIMEOUT', certifiedRouteAssets: certified });
        if (!result.ok) return done({ ok: false, code: KNOWN_CODE.test(result.code) ? result.code : 'ROUTE_DISCOVERY_FAILED', certifiedRouteAssets: certified });
        const view = routeView(result.value, prepared.outputSymbol, prepared.decimals);
        if (known === 'find_routes') return done({ ok: true, ...view, certifiedRouteAssets: certified });
        const recommended = view.candidates.find(candidate => candidate.recommended);
        return done(recommended ? { ok: true, provenance: view.provenance, observedAt: view.observedAt, freshness: view.freshness, receive: view.receive, quote: recommended }
          : { ok: false, code: view.status === 'EXECUTABLE' ? 'NO_RECOMMENDED_ROUTE' : view.status, observedAt: view.observedAt });
      }
      case 'get_workflow_context': {
        exactArgs(rawArguments, []);
        if (!ctx.card) return done({ ok: false, code: 'WORKFLOW_CONTEXT_UNAVAILABLE' });
        return done({ ok: true, revision: ctx.card.revision, steps: ctx.card.steps, pending: ctx.card.pending, request: ctx.card.request });
      }
      case 'get_wallet_context': {
        exactArgs(rawArguments, []);
        return done(ctx.card ? { ok: true, wallet: ctx.card.wallet } : { ok: false, code: 'WALLET_CONTEXT_UNAVAILABLE' });
      }
      case 'validate_strategy': {
        const args = exactArgs(rawArguments, ['strategy']);
        if (typeof args.strategy !== 'string' || args.strategy.length > 3_000) return bad();
        let strategy: unknown;
        try { strategy = JSON.parse(args.strategy); } catch { return done({ ok: false, code: 'STRATEGY_JSON_INVALID' }); }
        await ctx.ports.prepareCatalogs?.(JSON.stringify(strategy).slice(0, 2_000), strategy);
        const checked = validateStrategy(strategy, undefined, ctx.scope);
        return done(checked.valid ? { ok: true, valid: true, workflowHash: checked.workflowHash, fundsClass: checked.fundsClass, stepCount: checked.stepCount, reviewSummary: checked.reviewSummary,
          authority: 'NONE: validation authorizes nothing.' } : { ok: true, valid: false, code: checked.code, issues: (checked.issues ?? []).slice(0, 8) });
      }
      case 'plan_goal': {
        let raw: Record<string, unknown>;
        try { raw = JSON.parse(rawArguments) as Record<string, unknown>; } catch { return bad(); }
        const extraKeys = ['cap', 'liquidity'].filter(key => raw && typeof raw === 'object' && Object.hasOwn(raw, key));
        const args = exactArgs(rawArguments, ['sourceNetwork', 'sourceAsset', 'amount', 'targetNetwork', 'targetAsset', 'use', 'preference', ...extraKeys]);
        const network = (value: unknown) => { const text = nstr(value, 60); if (!text) return null; const scoped = scopedNetwork(text, ctx.scope); return scoped.ok ? scoped.key : text; };
        const amount = nstr(args.amount, 40);
        if (amount !== null && !AMOUNT.test(amount)) return done({ ok: false, code: 'AMOUNT_INVALID' });
        const cap = args.cap === undefined ? null : nstr(args.cap, 40);
        if (cap !== null && !AMOUNT.test(cap)) return done({ ok: false, code: 'AMOUNT_INVALID' });
        let liquidity: CopilotLiquidityAction | null = null;
        if (args.liquidity !== undefined && args.liquidity !== null) {
          if (typeof args.liquidity !== 'string' || args.liquidity.length > 3_000) return bad();
          const position = COPILOT_V1_PARTS.parseActionV2(JSON.parse(args.liquidity));
          if (position.type !== 'LIQUIDITY') return bad();
          liquidity = position;
        }
        const goal: Goal = { source: { network: network(args.sourceNetwork), asset: nstr(args.sourceAsset), amount }, target: { network: network(args.targetNetwork),
          asset: nstr(args.targetAsset), use: choice(GOAL_USES, args.use) }, preference: args.preference === null ? null : choice(GOAL_PREFERENCES, args.preference), cap, liquidity };
        const plan = planGoal(goal, ctx.scope);
        if (plan.kind !== 'PLAN') return done({ ok: true, ...plan });
        const strategy = goalStrategy(plan.steps, null), composed = strategy.ok ? composeWorkflow(strategy.strategy) : null;
        return done({ ok: true, kind: 'PLAN', steps: plan.steps.map(({ action, network: from, destinationNetwork, inputAsset, outputAsset, amount: value, fundedBy, routing }) =>
          ({ action, network: from, destinationNetwork, inputAsset, outputAsset, amount: value, fundedBy, routing })), reasons: plan.reasons, alternatives: plan.alternatives,
          composition: composed ? composed.ok ? { valid: true, workflowHash: composed.workflowHash } : { valid: false, code: composed.code } : { valid: false, code: 'GOAL_BENEFICIARY_REQUIRED' },
          authoring: 'FloFi authors each step through its own grammar after your request; nothing is created by this tool.' });
      }
      case 'explain_failure': {
        const args = exactArgs(rawArguments, ['code']), code = str(args.code, 80);
        if (!KNOWN_CODE.test(code)) return done({ ok: false, code: 'CODE_INVALID' });
        const rejection = copilotRejection(code, ctx.language).message, failure = failureText(code, ctx.language);
        return done({ ok: true, code, explanation: /^COPILOT_/.test(code) ? failure : rejection });
      }
    }
  } catch (cause) {
    return done({ ok: false, code: cause instanceof ToolInputError ? cause.message : 'TOOL_FAILED' });
  }
}

/** One tool run as the orchestrator records it: the output goes back to the model; only name, category and outcome reach telemetry. */
export type CopilotToolResult = { readonly name: string | null; readonly category: string | null; readonly outcome: string; readonly output: Record<string, unknown> };
/** The read-only tools of a turn: their definitions and a runner bound to the request's sanitized context. */
export type CopilotToolkit = { readonly definitions: readonly Record<string, unknown>[];
  readonly run: (name: string, args: string, context: { readonly card: CopilotContextCard | null; readonly language: 'EN' | 'PT' }) => Promise<CopilotToolResult> };
/** `FLOFI_COPILOT_TOOLS=off` is the operator's break-glass: no tools are offered and every turn is the single structured request it was before. */
export const copilotToolsEnabled = (env: Readonly<Record<string, string | undefined>>) => env.FLOFI_COPILOT_TOOLS?.trim() !== 'off';
/** The toolkit over `ports` in `scope`. A port that is absent makes its tools answer with a closed `*_UNAVAILABLE` code. */
export function copilotToolkitOf(scope: NetworkScope, ports: CopilotToolPorts): CopilotToolkit {
  return { definitions: COPILOT_TOOL_DEFINITIONS, run: (name, args, context) => runCopilotTool(name, args, { scope, card: context.card, ports, language: context.language }) };
}
