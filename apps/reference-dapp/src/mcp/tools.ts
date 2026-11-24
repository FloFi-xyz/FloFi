// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the FloFi MCP tools (names follow Master Spec §14.7). One `McpServer` per HTTP request, built for one
 * authenticated principal. Every tool is read-only with respect to funds and authority:
 *
 *   discovery      get_supported_networks, get_supported_assets, get_capabilities   (registries + deployment enablement)
 *   authoring      compose_strategy, validate_strategy, review_strategy               (pure deterministic facade, no state)
 *   planning       plan_strategy (BUILD-FLOFI-INTELLIGENCE-001: FloFi's goal planner, the same as its own chat, composed by the engine)
 *   preview        simulate_strategy                                                  (the flow's own simulation, nothing persisted)
 *   observation    get_execution_status, get_evidence                                 (owner-scoped durable reads)
 *   education      explain_concept, explain_strategy, get_platform_help              (FloFi's general knowledge and product guide; never live data)
 *   automations    list_automation_types (static), get_automation_status             (read-only; owner-scoped, as each linked wallet)
 *
 * No automation tool creates, pauses, resumes, archives, replaces or approves anything: automations are managed by their owner in the FloFi app.
 *
 * There is no tool that submits, signs, authorizes a Review, begins/hands off/reports an attempt, invalidates, recovers or
 * accepts calldata, contract addresses, keys or seed phrases. Inputs are closed schemas; outputs pass `assertSafeOutput`.
 * A FloFi-owned model is never called: the client's own model interprets language, FloFi only computes.
 *
 * BUILD-WORKFLOW-VISUAL-PRESENTATION-001: `compose_strategy` and `request_user_approval` also present the workflow to a person. Their
 * first content block (the JSON text) and `structuredContent` keep every existing field; `structuredContent.visual` adds the shared
 * presentation model and a short readable summary follows the JSON. The approval — the one moment the owner is asked to act — also
 * carries the workflow picture as standard MCP image content (composition, which a model may repeat while iterating, stays text-only
 * and cheap), and the in-chat panel receives the same layout in `_meta['flofi/visual']` (UI-only). Presentation never changes the
 * canonical workflow, its hash or any authority, and a picture that cannot be drawn is simply omitted.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import { supportedAssets, supportedNetworks } from '../engine/capability-catalog';
import { compileSchema, MAX_WORKFLOW_STEPS, NETWORK_IDS, PUBLIC_NETWORK_IDS, PUBLIC_STRATEGY_ACTIONS, PublicStrategyInputSchema, STRATEGY_ACTIONS, strategyInputIssues,
  StrategyInputSchema } from '../engine/strategy-spec';
import type { NetworkScope } from '../domain/network-scope';
import { networkScope } from '../server/network-scope.ts';
import { solanaAuthoringCatalog } from '../server/solana-asset-catalog.ts';
import { prepareNetworkCatalogs } from '../platform/catalogs.ts';
import { robinhoodAuthoringCatalog } from '../server/robinhood-mainnet.ts';
import { ethereumAuthoringCatalog } from '../server/ethereum-mainnet.ts';
import { arbitrumAuthoringCatalog } from '../server/arbitrum-mainnet.ts';
import { baseAuthoringCatalog } from '../server/base-mainnet.ts';
import { approvalForRequester, approvalProgress, approvalStatus, capabilityFacts, composeWorkflowOrRefuse, evidenceView, executionStatusView, findOwnedRun,
  openApprovalSession, PlatformRefusal, refuse, requestApproval, requesterScope, reviewWorkflow, simulatePreview, stepViews, validateStrategy, type ApprovalDeps,
  type ApprovalRequester } from '../platform/index.ts';
import { principalOwners, principalScopes, type McpOAuthPrincipal, type McpPrincipal } from './config.ts';
import { GOAL_PREFERENCES, GOAL_USES, planGoal, type Goal } from '../domain/intelligence/goal-planner';
import { goalStrategy } from '../domain/intelligence/goal-strategy';
import { networkIdentity } from '../domain/network-registry';
import { canonicalNetworkFields } from './network-aliases.ts';
import type { CopilotLiquidityAction } from '../domain/copilot-intent';
import { simulateWorkflowPreview } from '../platform/preview.ts';
import { LEGACY_PANEL_URI, PANEL_MIME, PANEL_URI, panelHtml, panelResourceMeta } from './app/panel.ts';
import { MCP_HANDOFF_RULES, mcpApprovalLinkScheme } from './approval-profile.ts';
import { readHandoffPolicy, workflowPlan, type HandoffPolicy } from './execution.ts';
import type { McpScope, OAuthConfig } from './oauth/config.ts';
import type { McpState } from './oauth/state.ts';
import { observeRuntime, type McpRuntime } from './runtime.ts';
import { isPixApproval, pixApprovalProgress } from './pix-approval-status.ts';
import { assertSafeOutput, strategyFlow } from './simulation.ts';
import type { PublishedStudioIntegration } from '../platform/studio-catalog.ts';
import { workflowVisualModel, type WorkflowVisualModel } from '../platform/workflow-visual.ts';
import { workflowVisualLayout, workflowVisualText } from '../platform/workflow-visual-layout.ts';
import { workflowVisualPngOrNull } from '../server/workflow-visual-image.ts';
import { FLOFI_PRODUCTION_ORIGIN, publicApprovalUrl } from '../platform/navigation.ts';
import { DeadlineError, isDeadlineError, MCP_TOOL_TIMEOUTS, toolCap, withinBudget, type DeadlineCode, type RequestBudget } from './deadline.ts';
import { CONCEPT_IDS, CONCEPT_LEVELS, CONCEPT_PROTOCOLS } from '../domain/intelligence/concepts';
import { matchPlatformTopic, platformAnswer, platformGuide, type PlatformTopic } from '../domain/intelligence/platform-guide';
import { explainConcept, explainWorkflow } from '../platform/explain.ts';
import { AUTOMATION_MANAGEMENT, AUTOMATION_RULE_ID, automationStatus, automationTypes, type AutomationReadPort } from './automations.ts';
import { accountView, historyView, linkedOwners, MAX_ACCOUNT_WALLETS, omittedOwners, portfolioOwners, portfolioView, positionsView, type PortfolioReadPort } from './account.ts';
import { approvalState, authoringState, conversationState, executionState, simulationState, userFacingError, validationState } from '../platform/conversation-state.ts';

/** BUILD-DEVELOPER-001: the deep links moved to the shared approval service; re-exported for existing importers. */
export { walletDeepLinks } from '../platform/index.ts';

export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_TOOL_NAMES = Object.freeze(['get_supported_networks', 'get_supported_assets', 'get_capabilities', 'compose_strategy', 'validate_strategy',
  'simulate_strategy', 'review_strategy', 'get_execution_status', 'get_evidence', 'plan_strategy', 'explain_concept', 'explain_strategy', 'get_platform_help',
  'list_automation_types', 'get_automation_status', 'get_account', 'get_portfolio', 'list_executions'] as const);
export const MCP_INSTRUCTIONS = `FloFi's official production website is ${FLOFI_PRODUCTION_ORIGIN}; its MCP endpoint is ${FLOFI_PRODUCTION_ORIGIN}/api/mcp. ` +
  'FloFi is not Flo Finance or any alternate brand. Never recommend an alternate domain as the official FloFi website. ' +
  'Use only FloFi navigation URLs supplied by genuine successful MCP tool results, on this server\'s trusted origin. ' +
  'Never invent an official website, approval link, financial quote, approval ID or transaction status. ' +
  'When approval is requested, call compose_strategy, review_strategy and request_user_approval with the resulting strategy and workflowHash. ' +
  'Quote only the public nonsecret approvalUrl returned by that successful request_user_approval result, verbatim; never construct or rewrite it. ' +
  'Private approval capabilities and wallet links in tool-result _meta belong only to the approved FloFi UI; never quote them in chat. ' +
  'If a real tool call is unavailable or fails, disclose that and provide no approval CTA. Use actual simulation/status tool results for quotes and status. ' +
  'Server instructions cannot enforce arbitrary free-form text or hyperlinks independently generated by a third-party host without MCP tool calls. ' +
  'FloFi composes, validates, previews and explains DeFi strategies with its deterministic engine. You interpret the user; ' +
  'FloFi computes. Nothing here moves funds or authorizes anything: no tool signs, submits or approves. Execution needs a real owner wallet and the FloFi signing surface (inside MCP Apps where the host and wallet support it), ' +
  'a fresh simulation, Strategy Manifest review and wallet confirmation. Do not present an external-page fallback as completion inside chat. Carry the `strategy` and `workflowHash` from compose_strategy into later calls. ' +
  'Never ask the user for a private key or seed phrase. ' +
  'explain_concept, explain_strategy and get_platform_help give FloFi\'s general knowledge and product guidance, not live data: live prices, rates, ' +
  'balances, health factor or LTV come only from simulate_strategy and the owner\'s Review in FloFi; never present an explanation as a quote. ' +
  'list_automation_types and get_automation_status are read-only: creating, changing, pausing, resuming or archiving an automation happens only in the ' +
  'FloFi app with the owner\'s own confirmation, never through MCP. FloFi never moves funds or signs from MCP. ' +
  'Account questions: get_account (linked wallets; a new wallet is linked only on the FloFi Connections link it returns), get_portfolio (balances and ' +
  'positions of linked wallets) and list_executions (their history). To continue after the person says they signed or asks whether it completed, read ' +
  'get_approval_status (list_approvals finds earlier requests); report only its conversationState — CONFIRMED is the only completed state, and STATUS_UNKNOWN or ' +
  'NEEDS_ATTENTION is never "not run". To change a step before signing, compose again and request a new approval; a changed workflow does not replace the older ' +
  'request, so offer cancel_approval for the older one (only with the person\'s consent). Steps already confirmed are never repeated. When a tool fails, tell the person its userMessage, not the code.';
/** BUILD-FLOFI-MAINNET-PRODUCT-001: what the public product adds to the instructions. */
export const MCP_MAINNET_INSTRUCTIONS = ' FloFi runs on mainnets only: every strategy uses real funds. Test networks (Sepolia, Devnet, testnets) are not available; ' +
  'never move a request to a mainnet on your own — ask the user which mainnet and amount they want.';

/**
 * TypeBox + Ajv (the repo's strict schema stack) behind the Standard Schema interface the SDK consumes. Issues name paths and
 * rules only, never values; a `strategy` is reported against its own action's schema rather than every union branch.
 */
function standard<T>(schema: TSchema, networks: readonly string[] = PUBLIC_NETWORK_IDS,
  networksFor: (action: unknown) => readonly string[] = () => networks): StandardSchemaWithJSON<T, T> {
  const compiled = compileSchema<T>(schema), json = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  // P0 catalog reliability: a network field naming a network of this scope by its registry name, alias or CAIP-2 id is read as that network's id.
  // A refused network names the ids its own action accepts (a bridge field: bridge networks; a filter without an action: every network), once.
  const NETWORK_FIELD = /(?:^|\/)(network|sourceNetwork|destinationNetwork|targetNetwork)$/;
  const hintFor = (value: unknown, path: string) => {
    const segments = path.split('/').filter(Boolean);
    segments.pop();
    let parent: unknown = value;
    for (const segment of segments) parent = parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[segment] : undefined;
    // The field's own action (a bridge strategy's source/destination are bridge networks; a planning goal has no action and takes every network).
    const action = parent && typeof parent === 'object' ? (parent as { action?: unknown }).action : undefined;
    const accepted = action === undefined ? networks : networksFor(action);
    return ` (one of: ${(accepted.length ? accepted : networks).join(', ')})`;
  };
  const issuesOf = (value: unknown) => {
    const all = compiled.issues(value), strategy = value && typeof value === 'object' ? (value as { strategy?: unknown }).strategy : undefined;
    const inStrategy = (i: { path: string }) => i.path === '/strategy' || i.path.startsWith('/strategy/');
    if (strategy === undefined || !all.some(inStrategy)) return all;
    const detailed = strategyInputIssues(strategy).map(i => ({ path: '/strategy' + (i.path === '/' ? '' : i.path), rule: i.rule }));
    // BUILD-FLOFI-MAINNET-PRODUCT-001: valid under the full contract but not the public one: it names a test network (or the Base Sepolia composition).
    return [...all.filter(i => !inStrategy(i)), ...detailed.length ? detailed : [{ path: '/strategy', rule: 'mainnetOnly' }]];
  };
  return { '~standard': { version: 1, vendor: 'flofi',
    validate: raw => {
      const value = canonicalNetworkFields(raw, networks);
      if (compiled.check(value)) return { value: value as T };
      const hinted = new Set<string>();
      return { issues: issuesOf(value).map(i => {
        // A refused network names the accepted ids, so the caller can correct it (values are still never echoed).
        const hint = NETWORK_FIELD.test(i.path) && /const|anyOf|enum/.test(i.rule) && !hinted.has(i.path) ? (hinted.add(i.path), hintFor(value, i.path)) : '';
        return { message: `${i.path} ${i.rule}${hint}`, path: i.path.split('/').filter(Boolean) };
      }) };
    },
    jsonSchema: { input: () => json, output: () => json } } };
}
const strict = { additionalProperties: false } as const;
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const Hash = Type.String({ pattern: '^0x[0-9a-f]{64}$', description: 'The workflowHash returned by compose_strategy.' });
const ExecutionId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', description: 'A FloFi execution (run) id. It is a lookup key, not an access grant.' });
const Language = Type.Optional(Type.Union([Type.Literal('EN'), Type.Literal('PT')], { description: 'Answer language: EN (default) or PT (Portuguese).' }));
/** A short phrase in the user's own words (never echoed back): letters, digits, spaces and ordinary punctuation, no control characters. */
const Phrase = (maxLength: number, description: string) => Type.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$', description });
/** The platform guide topics this surface offers (`platformGuide(…, 'MCP')`: web-only topics are not listed). */
const MCP_PLATFORM_TOPICS: readonly PlatformTopic[] = Object.freeze(platformGuide('EN', 'MCP').map(entry => entry.topic));
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the tool schemas of a network scope. The public product offers and accepts mainnets only (the public
 * strategy contract); engineering certification keeps the full contract. The same strategy composes to the same IR and hash under both.
 */
function schemasFor(scope: NetworkScope) {
  const networks = scope === 'ENGINEERING' ? NETWORK_IDS : PUBLIC_NETWORK_IDS, actions = scope === 'ENGINEERING' ? STRATEGY_ACTIONS : PUBLIC_STRATEGY_ACTIONS;
  const StrategyInput = scope === 'ENGINEERING' ? StrategyInputSchema : PublicStrategyInputSchema;
  const NetworkFilter = Type.Union(networks.map(n => Type.Literal(n)), { description: 'Network identifier.' });
  return {
  none: Type.Object({}, strict),
  assets: Type.Object({ network: Type.Optional(NetworkFilter) }, strict),
  capabilities: Type.Object({ network: Type.Optional(NetworkFilter), action: Type.Optional(Type.Union(actions.map(a => Type.Literal(a)))) }, strict),
  compose: Type.Object({ strategy: StrategyInput }, strict),
  bound: Type.Object({ strategy: StrategyInput, workflowHash: Type.Optional(Hash) }, strict),
  request: Type.Object({ strategy: StrategyInput, workflowHash: Hash }, strict),
  simulate: Type.Object({ strategy: StrategyInput, workflowHash: Hash,
    simulationSubject: Type.String({ pattern: '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$',
      description: 'The account whose PUBLIC balances and allowances the read-only simulation uses (EVM address or Solana public key). It is not authenticated, ' +
        'not an owner and grants nothing; nothing is stored for it.' }) }, strict),
  // Education: FloFi's concept catalog, a strategy explained, and the platform guide. General knowledge only.
  concept: Type.Object({ concept: Type.Optional(Type.Union(CONCEPT_IDS.map(id => Type.Literal(id)), { description: 'A concept id from FloFi\'s catalog. Give this or `term`.' })),
    term: Type.Optional(Phrase(80, 'The concept in the user\'s own words (EN or PT, e.g. "health factor", "perda impermanente"). Give this or `concept`.')),
    level: Type.Optional(Type.Union(CONCEPT_LEVELS.map(level => Type.Literal(level)), { description: 'STANDARD (default), SIMPLE, EXAMPLE (illustrative numbers only) or ADVANCED.' })),
    protocol: Type.Optional(Type.Union(CONCEPT_PROTOCOLS.map(protocol => Type.Literal(protocol)), { description: 'Explain it as it works on this protocol.' })),
    language: Language }, strict),
  explain: Type.Object({ strategy: StrategyInput, workflowHash: Type.Optional(Hash), language: Language }, strict),
  help: Type.Object({ topic: Type.Optional(Type.Union(MCP_PLATFORM_TOPICS.map(topic => Type.Literal(topic)), { description: 'A FloFi platform topic. Give this, `question`, or neither for the whole guide.' })),
    question: Type.Optional(Phrase(160, 'A "how / where" question about FloFi in the user\'s words.')), language: Language }, strict),
  language: Type.Object({ language: Language }, strict),
  automationStatus: Type.Object({ ruleId: Type.Optional(Type.String({ pattern: AUTOMATION_RULE_ID, description: 'One automation (rule) id; omit for all of the owner\'s automations. ' +
    'It is a lookup key, not an access grant.' })), language: Language }, strict),
  status: Type.Object({ executionId: ExecutionId, journalAfter: Type.Optional(Type.Integer({ minimum: -1, maximum: 2_147_483_647 })),
    journalLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict),
  evidence: Type.Object({ executionId: ExecutionId }, strict),
  // BUILD-FLOFI-UNIVERSAL-CHANNELS-001: account reads. No input names a wallet: they read the account's own linked wallets only.
  portfolio: Type.Object({ positions: Type.Optional(Type.Boolean({ description: 'Also read protocol positions (Aave, Uniswap, Orca). Default true.' })) }, strict),
  // BUILD-FLOFI-INTELLIGENCE-001: an outcome in the user's own terms; FloFi plans the steps from its registries. Assets are symbols or whole names.
  plan: Type.Object({ goal: Type.Object({
    sourceNetwork: Type.Optional(NetworkFilter), sourceAsset: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9 .&\'-]*$',
      description: 'Asset the user holds or wants to spend, exactly as they named it.' })),
    amount: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]{0,30})(\\.[0-9]{1,18})?$', description: 'Amount the user stated, as a decimal string.' })),
    targetNetwork: Type.Optional(NetworkFilter), targetAsset: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9 .&\'-]*$',
      description: 'Asset the user wants to end up with, only if they named it.' })),
    use: Type.Union(GOAL_USES.map(use => Type.Literal(use)), { description: 'HOLD the asset there, SUPPLY it on Aave V3, or LIQUIDITY.' }),
    preference: Type.Optional(Type.Union(GOAL_PREFERENCES.map(item => Type.Literal(item)), { description: 'Only if the user asked for it.' })),
    cap: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]{0,30})(\\.[0-9]{1,18})?$', description: 'The most a later funded step of another asset may spend, as the user stated.' })),
    beneficiary: Type.Optional(Type.String({ pattern: '^0x[0-9a-fA-F]{40}$', description: 'Supply only: the account Aave credits, exactly as the user gave it. Never invent one.' })),
    liquidity: Type.Optional(Type.Object({
      maxAmounts: Type.Record(Type.String({ minLength: 1, maxLength: 160 }), Type.String({ pattern: '^(0|[1-9][0-9]{0,30})(\\.[0-9]{1,18})?$' }), { minProperties: 2, maxProperties: 2 }),
      range: Type.Union([Type.Object({ unit: Type.Union([Type.Literal('price'), Type.Literal('tick')]), lower: Type.String({ maxLength: 48 }), upper: Type.String({ maxLength: 48 }) }, strict),
        Type.Object({ unit: Type.Literal('full') }, strict)]),
      feeTier: Type.Optional(Type.Union([Type.Literal(100), Type.Literal(500), Type.Literal(3000), Type.Literal(10000)])),
      slippageBps: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }, { ...strict, description: 'For a liquidity goal: the pool assets, maximum deposits and range the user chose. FloFi plans any necessary conversion first.' })),
  }, strict) }, strict),
  };
}
const SCHEMAS = { PUBLIC_MAINNET: schemasFor('PUBLIC_MAINNET'), ENGINEERING: schemasFor('ENGINEERING') } as const;

/**
 * BUILD-MCP-002: the OAuth scope each tool needs. The gateway enforces it at the HTTP level (403 `insufficient_scope`); each
 * handler checks it again. A static developer credential holds `flofi.strategy` and `flofi.runs` (BUILD-MCP-001's surface).
 */
/**
 * BUILD-MCP-002: the approval tools, registered only for an OAuth account (a static credential has no account to hand anything to).
 * `open_approval_session` and `get_execution_progress` are app-only (MCP Apps visibility `["app"]`): the in-chat panel calls them,
 * the model never sees them.
 */
export const APPROVAL_TOOL_NAMES = Object.freeze(['request_user_approval', 'get_approval_status', 'open_approval_session', 'get_execution_progress',
  'list_approvals', 'cancel_approval'] as const);
export const APP_ONLY_TOOLS: readonly ToolName[] = Object.freeze(['open_approval_session', 'get_execution_progress']);
export type ToolName = (typeof MCP_TOOL_NAMES)[number] | (typeof APPROVAL_TOOL_NAMES)[number];
export const TOOL_SCOPES: Readonly<Record<ToolName, McpScope>> = Object.freeze({
  get_supported_networks: 'flofi.strategy', get_supported_assets: 'flofi.strategy', get_capabilities: 'flofi.strategy', compose_strategy: 'flofi.strategy', plan_strategy: 'flofi.strategy',
  validate_strategy: 'flofi.strategy', simulate_strategy: 'flofi.strategy', review_strategy: 'flofi.strategy', get_execution_status: 'flofi.runs', get_evidence: 'flofi.runs',
  explain_concept: 'flofi.strategy', explain_strategy: 'flofi.strategy', get_platform_help: 'flofi.strategy', list_automation_types: 'flofi.strategy',
  get_automation_status: 'flofi.runs', get_account: 'flofi.runs', get_portfolio: 'flofi.runs', list_executions: 'flofi.runs',
  request_user_approval: 'flofi.approval', get_approval_status: 'flofi.approval', open_approval_session: 'flofi.approval', get_execution_progress: 'flofi.approval',
  list_approvals: 'flofi.approval', cancel_approval: 'flofi.approval' });

export type ToolEvent = { readonly tool: string; readonly outcome: string; readonly durationMs: number };
export type ToolContext = { readonly principal: McpPrincipal; readonly runtime: McpRuntime; readonly onTool?: (event: ToolEvent) => void; readonly now?: () => number;
  /** BUILD-MCP-002: present for OAuth deployments. */
  readonly oauth?: OAuthConfig; readonly state?: McpState;
  /** BUILD-FLOFI-STUDIO-UNIVERSAL-002: PUBLIC Studio metadata only. MCP account ids are not FloFi accounts, so PRIVATE audiences never apply. */
  readonly publicStudioIntegrations?: () => Promise<readonly PublishedStudioIntegration[]>;
  /** BUILD-MCP-002: the MCP handoff policy (default: test funds only, every mainnet off). */
  readonly policy?: HandoffPolicy;
  /** BUILD-MCP-002: the in-chat MCP App panel attached to request_user_approval, when enabled. */
  readonly ui?: { readonly resourceUri: string; readonly inFrameProbeHosts: readonly string[] } | null;
  /** BUILD-FLOFI-MAINNET-PRODUCT-001: the deployment's network scope (default: this server's, `server/network-scope.ts`). */
  readonly scope?: NetworkScope;
  /** The request's deadline (`deadline.ts`): a tool stops waiting at its tool deadline and answers with a classified timeout. */
  readonly budget?: RequestBudget;
  /** The read-only automation port of `get_automation_status` (the gateway injects the deployment's; absent: automations are not offered). */
  readonly automations?: AutomationReadPort;
  /** BUILD-FLOFI-UNIVERSAL-CHANNELS-001: the read-only portfolio port of `get_portfolio` (the gateway injects the deployment's; absent: not offered). */
  readonly portfolio?: PortfolioReadPort };
type Output = Record<string, unknown>;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
// BUILD-DEVELOPER-001: the engine operations live in the shared platform (`src/platform`); this file is the MCP surface over them.
const failWith = (code: string, extra: Output = {}): never => refuse(code, extra);
/** BUILD-DEVELOPER-001: the platform reports its own limits neutrally; MCP keeps the codes its clients already know. */
const MCP_CODES: Readonly<Record<string, string>> = Object.freeze({ SIMULATION_BUSY: 'MCP_SIMULATION_BUSY', SIMULATION_RATE_LIMITED: 'MCP_SIMULATION_RATE_LIMITED',
  HANDOFF_RATE_LIMITED: 'MCP_HANDOFF_RATE_LIMITED', HANDOFF_PENDING_LIMIT: 'MCP_HANDOFF_LIMIT' });
const mcpCode = (code: string) => Object.hasOwn(MCP_CODES, code) ? MCP_CODES[code]! : code;
const AUTHORITY = 'NONE: this result authorizes nothing. Only the owner, in the FloFi app, can review the Strategy Manifest and sign with their own wallet.';

const DEFAULT_POLICY = readHandoffPolicy({});

/**
 * What a tool that ran out of time may say about its effects. A timeout only means FloFi stopped waiting:
 *   READ_ONLY        the tool has no durable effect at all (discovery, authoring, preview): its answer is simply missing
 *   STATUS_READ      it reads an execution or approval: the STATUS is unknown — never "nothing was submitted", "failed" or "done"
 *   EFFECT_UNKNOWN   it may have written an approval request or replaced an approval link: the outcome is UNKNOWN, and it is
 *                    never repeated automatically (a duplicate approval still needs the owner's own wallet; nothing executes from MCP)
 */
type TimeoutClass = 'READ_ONLY' | 'STATUS_READ' | 'EFFECT_UNKNOWN';
const TIMEOUT_CLASS: Readonly<Partial<Record<ToolName, TimeoutClass>>> = Object.freeze({ get_execution_status: 'STATUS_READ', get_evidence: 'STATUS_READ',
  get_automation_status: 'STATUS_READ', list_executions: 'STATUS_READ', list_approvals: 'STATUS_READ', cancel_approval: 'EFFECT_UNKNOWN',
  get_approval_status: 'STATUS_READ', get_execution_progress: 'STATUS_READ', request_user_approval: 'EFFECT_UNKNOWN', open_approval_session: 'EFFECT_UNKNOWN' });
const DEADLINE_CODES: ReadonlySet<string> = new Set<DeadlineCode>(['MCP_REQUEST_TIMEOUT', 'MCP_UPSTREAM_TIMEOUT', 'MCP_REQUEST_CANCELLED']);
const TIMEOUT_CODES = new Set([...DEADLINE_CODES, 'CLOUD_API_DEADLINE_EXCEEDED', 'CLOUD_PREVIEW_TIMEOUT']);
/** The classified answer of a tool that ran out of time (`code`: the request's or one upstream read's deadline). */
export function timeoutResult(tool: ToolName, code: string, requestId: string | null): Output {
  const kind = TIMEOUT_CLASS[tool] ?? 'READ_ONLY', id = requestId ? { requestId } : {};
  if (kind === 'EFFECT_UNKNOWN') return { ok: false, code, ...id, outcome: 'UNKNOWN', retryable: false, automaticRetry: false, authority: AUTHORITY,
    conversationState: conversationState('STATUS_UNKNOWN', 'REQUEST_TIMEOUT'),
    message: tool === 'cancel_approval'
      ? 'FloFi did not finish this request in time. Whether the approval request was cancelled is UNKNOWN. Read get_approval_status for this approvalId ' +
        'before telling the user it was or was not cancelled; do not retry automatically. Nothing is signed or sent by cancelling.'
      : tool === 'request_user_approval'
      ? 'FloFi did not finish this request in time. Whether an approval request was created is UNKNOWN. Do not tell the user that nothing was created, ' +
        'and do not request approval again automatically: ask the user first (a new request for the same workflow supersedes an older pending one). ' +
        'Any approval request still needs the owner to review it and confirm in their own wallet; nothing executes from MCP.'
      : 'FloFi did not finish this request in time. Whether the previous approval link was replaced is UNKNOWN. Read get_approval_status for this approvalId ' +
        'before opening another link; do not retry automatically.',
    // A timed-out approval request delivered no approvalId, so no status can be read for it: the next step is asking the user.
    next: tool === 'request_user_approval' ? [] : ['get_approval_status'] };
  if (kind === 'STATUS_READ') return { ok: false, code, ...id, outcome: 'STATUS_UNKNOWN', retryable: true, authority: AUTHORITY,
    conversationState: conversationState('STATUS_UNKNOWN', 'REQUEST_TIMEOUT'),
    message: 'FloFi could not read this status in time. The status is UNKNOWN: this is not evidence that nothing was submitted, that anything failed or that it completed. ' +
      `Read it again with ${tool}.`, next: [tool] };
  return { ok: false, code, ...id, outcome: 'NOT_COMPLETED', retryable: true, authority: AUTHORITY,
    message: 'FloFi did not finish this read-only request in time. This tool never signs, submits or approves anything; call it again for its result.' };
}
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: what a person can read about a failed tool call, as a second text block (EN and PT). The structured
 * error (`ok`, `code`, extras) stays exactly as clients already parse it; the code is for clients, the message is for the person.
 */
export const userMessageContent = (code: string): Content => {
  const plain = userFacingError(code);
  return { type: 'text', text: `userMessage (EN): ${plain.EN}\nuserMessage (PT): ${plain.PT}` };
};
/** The tools whose result presents a workflow to a person (BUILD-WORKFLOW-VISUAL-PRESENTATION-001). */
const VISUAL_TOOLS: ReadonlySet<ToolName> = new Set(['compose_strategy', 'request_user_approval']);
const isVisualModel = (value: unknown): value is WorkflowVisualModel => !!value && typeof value === 'object' && (value as WorkflowVisualModel).version === 1
  && Array.isArray((value as WorkflowVisualModel).steps) && (value as WorkflowVisualModel).steps.length > 0;
type Content = CallToolResult['content'][number];
/**
 * The person-facing presentation of a workflow result: a readable summary (EN) — with the public Open in FloFi link when it is an
 * approval — and, with `picture`, the PNG as image content (meant for the user; a host may also show it to its model) and the layout
 * the MCP App panel paints. The JSON text and `structuredContent` stay first and unchanged; nothing here can fail the tool.
 */
async function presentation(model: WorkflowVisualModel, visible: Output, picture: boolean): Promise<{ content: Content[]; meta: Record<string, unknown> }> {
  const text = workflowVisualText(model, 'EN'), link = typeof visible.approvalUrl === 'string' ? visible.approvalUrl : null;
  const summary = link ? `${text.alt}\nOpen in FloFi: ${link}` : text.alt;
  if (!picture) return { content: [{ type: 'text', text: summary }], meta: {} };
  const image = await workflowVisualPngOrNull(model, 'EN');
  const content: Content[] = [{ type: 'text', text: summary },
    ...image ? [{ type: 'image', data: Buffer.from(image.bytes).toString('base64'), mimeType: image.mimeType, annotations: { audience: ['user'], priority: 0.8 } } as Content] : []];
  const layout = workflowVisualLayout(model, 'EN');
  const meta = { 'flofi/visual': { tree: layout.tree, width: layout.width, height: layout.height, alt: layout.alt, title: layout.title } };
  assertSafeOutput(meta);
  return { content, meta };
}
/** BUILD-MCP-002: why this principal may read a run: an operator grant (static credential) or a wallet the account linked on FloFi. */
const accessBasis = (ctx: ToolContext) => ctx.principal.kind === 'mcp-oauth' ? 'ACCOUNT_LINKED_WALLET' : 'OPERATOR_GRANTED_WALLET';
/** BUILD-MCP-002: an approval handoff needs an OAuth account with the `flofi.approval` scope (a static credential has no account). */
const canRequestApproval = (ctx: ToolContext) => ctx.principal.kind === 'mcp-oauth' && ctx.principal.scopes.includes('flofi.approval') && Boolean(ctx.state);

/** BUILD-MCP-002: an OAuth account's hourly simulation budget (on top of the platform's shared per-instance concurrency cap). */
export const SIMULATIONS_PER_ACCOUNT_HOUR = 30;
/** BUILD-FLOFI-UNIVERSAL-CHANNELS-001: an OAuth account's hourly portfolio reads (each one reads several public networks and protocol positions). */
export const PORTFOLIO_READS_PER_ACCOUNT_HOUR = 30;
/** BUILD-FLOFI-UNIVERSAL-CHANNELS-001: an OAuth account's hourly history reads (one cross-flow API read per linked wallet each). */
export const HISTORY_READS_PER_ACCOUNT_HOUR = 60;

export function createFlofiMcpServer(ctx: ToolContext): McpServer {
  const scope = ctx.scope ?? networkScope(), Schemas = SCHEMAS[scope];
  const deploymentInstructions = ctx.oauth && ctx.oauth.origin !== FLOFI_PRODUCTION_ORIGIN
    ? ` This is a deliberately configured non-production FloFi environment at ${ctx.oauth.origin}; its MCP endpoint is ${ctx.oauth.resource}. ` +
      'Preserve the exact URLs returned by its tools for this preview; do not substitute the production origin into its OAuth or approval flow.' : '';
  // One stateless server per request can never deliver a list-changed notification, so it does not claim to: a 2026-07-28
  // `subscriptions/listen` is then acknowledged and completed at once instead of holding an SSE stream open until the platform kills it.
  const panel = Boolean(ctx.principal.kind === 'mcp-oauth' && ctx.state && ctx.oauth && ctx.ui);
  const server = new McpServer({ name: 'flofi', title: 'FloFi', version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS + deploymentInstructions + (scope === 'ENGINEERING' ? '' : MCP_MAINNET_INSTRUCTIONS),
      capabilities: { tools: { listChanged: false }, ...panel ? { resources: { listChanged: false } } : {} } });
  const now = ctx.now ?? (() => performance.now());
  const scopeNetworks = scope === 'ENGINEERING' ? NETWORK_IDS : PUBLIC_NETWORK_IDS, discovered = supportedNetworks(scope);
  // The networks discovery advertises for an action (engine/catalog-schema-parity.test.ts proves this equals what the public schema accepts).
  const networksFor = (action: unknown) => discovered.filter(network => (network.actions as readonly unknown[]).includes(action)).map(network => network.id);
  const register = <S extends TSchema>(name: ToolName, title: string, description: string, schema: S, annotations: ToolAnnotations,
    run: (args: Static<S>) => Promise<Output> | Output, toolMeta: Record<string, unknown> = {}) => {
    const scope = TOOL_SCOPES[name];
    // OAuth clients read `securitySchemes` to know which scope to request before calling (ChatGPT reads the `_meta` mirror).
    const security = ctx.oauth ? { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } : {};
    const meta = Object.keys(security).length || Object.keys(toolMeta).length ? { _meta: { ...security, ...toolMeta } } : {};
    server.registerTool(name, { title, description, inputSchema: standard<Static<S>>(schema, scopeNetworks, networksFor), annotations: { title, ...annotations }, ...meta }, async (args: Static<S>): Promise<CallToolResult> => {
      const started = now();
      let result: CallToolResult, outcome = 'OK';
      try {
        // The whole tool — catalog preparation, runtime reads, presentation — waits at most until the request's tool deadline.
        result = await withinBudget(ctx.budget, toolCap(ctx.budget, TIMEOUT_CLASS[name] === 'EFFECT_UNKNOWN' ? MCP_TOOL_TIMEOUTS.approvalWrite : MCP_TOOL_TIMEOUTS.default), async () => {
        if (!principalScopes(ctx.principal).includes(scope)) failWith('MCP_INSUFFICIENT_SCOPE');
        // BUILD-RH-002: a strategy naming Robinhood Chain composes against the validated official catalog (where this deployment enables it);
        // BUILD-BASE-001: so does one naming Base (its validated token list).
        const named = args && typeof args === 'object' ? 'strategy' in args ? (args as { strategy: unknown }).strategy : 'goal' in args
          ? { sourceNetwork: (args as { goal: { sourceNetwork?: string } }).goal.sourceNetwork, destinationNetwork: (args as { goal: { targetNetwork?: string } }).goal.targetNetwork } : undefined : undefined;
        if (named !== undefined) await prepareNetworkCatalogs(named, {
          solana: () => solanaAuthoringCatalog(), ethereum: async () => ethereumAuthoringCatalog(await ctx.runtime.mode('ethereum-swap')),
          robinhood: async () => robinhoodAuthoringCatalog(await ctx.runtime.mode('robinhood-swap')), base: async () => baseAuthoringCatalog(await ctx.runtime.mode('base-swap')),
          'arbitrum-one': async () => arbitrumAuthoringCatalog(await ctx.runtime.mode('arbitrum-swap')) });
        const output = await run(args);
        assertSafeOutput(output);
        // MCP Apps tool-result _meta is delivered to the UI, outside model context. App visibility alone does not redact results.
        const privateLinks = name === 'request_user_approval' || name === 'open_approval_session';
        const { approvalUrl, walletLinks, ...publicFields } = output;
        const visible = privateLinks && typeof approvalUrl === 'string'
          ? { ...publicFields, approvalUrl: publicApprovalUrl(ctx.oauth!.origin, output.approvalId) }
          : output;
        const presented = VISUAL_TOOLS.has(name) && isVisualModel(visible.visual)
          // BUILD-FLOFI-E2E-RELIABILITY-001 (MCP review): the picture is optional and comes after an approval may already exist, so it is capped
          // (5 s) and dropped on timeout — never the result, and never turning a created approval into an UNKNOWN timeout.
          ? await Promise.race([presentation(visible.visual, visible, name === 'request_user_approval').catch(() => null),
            new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 5_000); timer.unref?.(); })]) : null;
        const meta = { ...privateLinks && typeof approvalUrl === 'string' ? { 'flofi/approval': { approvalUrl, walletLinks } } : {}, ...presented?.meta };
        return { content: [{ type: 'text', text: JSON.stringify(visible) }, ...presented?.content ?? []], structuredContent: visible,
          ...Object.keys(meta).length ? { _meta: meta } : {} } satisfies CallToolResult;
        });
      } catch (error) {
        outcome = error instanceof Error && CODE.test(error.message) ? mcpCode(error.message) : 'MCP_INTERNAL_ERROR';
        // Once the request's budget has ended, whatever failed is reported as the timeout it is, with what the tool may have done.
        const ended = ctx.budget?.ended();
        if (ended || isDeadlineError(error) || TIMEOUT_CODES.has(outcome)) {
          // The gateway's own codes pass through (a bounded read may report the request's deadline a moment before its timer fires);
          // a remote client's deadline or preview timeout is an upstream timeout.
          outcome = ended === 'CLIENT_CLOSED' ? 'MCP_REQUEST_CANCELLED' : ended === 'DEADLINE' ? 'MCP_REQUEST_TIMEOUT' : isDeadlineError(error) ? error.code
            : DEADLINE_CODES.has(outcome) ? outcome : 'MCP_UPSTREAM_TIMEOUT';
          const body = timeoutResult(name, outcome, ctx.budget?.requestId ?? null);
          result = { content: [{ type: 'text', text: JSON.stringify(body) }, userMessageContent(outcome)], structuredContent: body, isError: true };
        } else {
          const body = { ok: false, code: outcome, ...error instanceof PlatformRefusal ? error.extra : {} };
          result = { content: [{ type: 'text', text: JSON.stringify(body) }, userMessageContent(outcome)], structuredContent: body, isError: true };
        }
      }
      ctx.onTool?.({ tool: name, outcome, durationMs: Math.round(now() - started) });
      return result;
    });
  };

  register('get_supported_networks', 'Supported networks', 'Networks FloFi can author strategies for, with CAIP-2 ids, network class and the actions available. ' +
    'Also lists PUBLIC Studio metadata an independent FloFi operator certified. It confers no financial execution capability.', Schemas.none, pure, async () => {
    const publishedIntegrations = await ctx.publicStudioIntegrations?.();
    return { ok: true, networks: supportedNetworks(scope), ...(publishedIntegrations?.length ? { publishedIntegrations } : {}) };
  });

  register('get_supported_assets', 'Supported assets', 'Assets a strategy may name, per network, with the exact token address or mint, decimals and the actions that use ' +
    'each, from the currently loaded validated catalog or the pinned registry assets. Native currencies have a null token address. ' +
    'One symbol can be two different tokens on one network (each entry names its exact address).', Schemas.assets, pure,
  args => ({ ok: true, assets: supportedAssets(scope, args.network) }));

  register('get_capabilities', 'Capabilities', 'For each action × network: what FloFi code supports (from the execution capability registry on the composed IR), the evidence ' +
    'it has actually demonstrated, whether this deployment enables it, whether policy allows handing it to its owner for approval, and what this MCP server can do ' +
    '(compose, validate, review, preview, request the owner\'s approval — never execute). Includes this server\'s trusted website and MCP endpoint; ' +
    'use these exact URLs for FloFi navigation, never an alternate brand/domain. Mainnet may be supported by code yet disabled by policy.',
  Schemas.capabilities, { ...pure, idempotentHint: false }, async args => {
    const approvals = canRequestApproval(ctx);
    const origin = ctx.oauth?.origin ?? FLOFI_PRODUCTION_ORIGIN;
    return { ok: true, navigation: { websiteUrl: origin, mcpEndpoint: `${origin}/api/mcp`, productionWebsiteUrl: FLOFI_PRODUCTION_ORIGIN },
      runtime: ctx.runtime.kind, mcpExecution: 'NOT_AVAILABLE', ownerExecution: 'IN_FLOFI_WITH_THE_OWNER_WALLET_ONLY',
      // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: FloFi's executor paid every step's gas; it is retired on every deployment (invariant S1).
      delegatedExecution: { available: false, reason: 'EXECUTOR_FUNDED_GAS_RETIRED', note: 'Retired: FloFi never pays, advances or reimburses network ' +
          'fees, so it no longer executes steps from its own account. Confirm each step: a fresh simulation, Review and wallet confirmation before every step. ' +
          'User-funded groups (only where request_user_approval reports them available): the owner\'s own wallet authorizes each group of consecutive ' +
          'same-network steps in one wallet interaction and pays every fee.' },
      conversationExecution: { surface: ctx.ui ? 'MCP_APP_EMBEDDED_SIGNING' : 'MCP_APP_UNAVAILABLE',
        signer: 'USER_WALLET_REQUIRED', hostAndWalletVerified: false, canvasRequired: false,
        toolAuthority: 'mcpExecution NOT_AVAILABLE means model tools have no signing or submission authority; wallet-driven MCP Apps use the existing financial runtime.',
        externalFallback: 'OPTIONAL_NOT_IN_CHAT_COMPLETION',
        limitation: 'A host must allow the FloFi signing frame and a compatible wallet must expose its provider there. Phantom does not inject into iframes. No host wallet API or standing mainnet delegation is assumed.' },
      stepLists: { contract: 'strategy version 2: {version: 2, steps: [...], bindings?: [{step, amountFrom}]}', maxSteps: MAX_WORKFLOW_STEPS,
        oneStep: 'identical to version 1 (same strategy, same hash)',
        executableToday: ['every one-action path whose row below can be handed off',
          ...scope === 'ENGINEERING' ? ['supply → borrow → swap on base-sepolia (the lending composition)'] : [],
          'a sequence whose every step has an owner-execution flow, where this deployment runs workflows (request_user_approval says so)'],
        sequences: 'One approval for the whole workflow; the owner confirms each step in their wallet, in order, each after the previous step reconciled. ' +
          'Where request_user_approval reports user-funded groups available, the owner\'s own wallet can instead authorize each group of consecutive ' +
          'same-network steps in one wallet interaction (an atomic batch, a signed operation of their own account, or one Solana signing request) and pays ' +
          'every fee; a workflow on several networks needs at least one interaction per network, and a step through its own flow at least one more. ' +
          'One wallet interaction is not one transaction and never zero gas; FloFi never pays gas.',
        bindings: 'A step may spend what an earlier step actually delivered: {step, amountFrom}; its own amount is then a cap. Confirm each step: resolved from ' +
          'reconciled received amounts (min(cap, received)). User-funded groups: inside one group, the earlier step\'s signed guaranteed minimum; in a later ' +
          'group, the reconciled delivery, signed when due.' },
      capabilities: (await capabilityFacts(ctx.runtime, ctx.policy ?? DEFAULT_POLICY, { network: args.network, action: args.action }, scope)).map(({ row: r, flow, mode, previewable,
        previewUnavailableReason, gates }) => {
        return { action: r.action, network: r.network, destinationNetwork: r.destinationNetwork, funds: r.funds, actionTypes: r.actionTypes, adapters: r.adapters,
          supportedByCode: { publicEnvironment: r.publicEnvironment, dimensions: r.supportedByCode, ownerWalletExecutionImplemented: r.ownerWalletExecutionImplemented,
            registryEnvironments: r.registryEnvironments, execute: gates.supportedByCode.execute, executionPlan: gates.plan.kind, steps: gates.plan.steps.length,
            reason: gates.supportedByCode.reason },
          enabledByDeployment: gates.enabledByDeployment, enabledByPolicy: gates.enabledByPolicy,
          demonstratedEvidence: r.demonstratedEvidence ?? 'NONE_DEMONSTRATED',
          deployment: { flow, mode: mode ?? 'UNKNOWN_IN_LOCAL_RUNTIME', enabled: mode === 'live' || mode === 'harness', mockedHarness: mode === 'harness' },
          mcp: { compose: true, validate: true, review: true, simulate: previewable, simulateUnavailableReason: previewUnavailableReason, execute: false,
            approvalHandoff: approvals && gates.handoff.allowed, approvalHandoffUnavailableReason: !approvals ? 'MCP_ACCOUNT_REQUIRED' : gates.handoff.reason },
          example: r.example };
      }) };
  });

  register('compose_strategy', 'Compose strategy', 'Deterministically turn structured intent into FloFi\'s canonical Semantic Workflow IR (revision 1), using the same ' +
    'authoring rules as the FloFi app. Unsupported or ambiguous input is refused with a code, never guessed. Keep `strategy` (normalized) and `workflowHash` for ' +
    'validate/simulate/review. The model must not invent addresses: use only values the user gave. A multi-step workflow is `{version: 2, steps: [...]}` ' +
    '(one step is the same as version 1); each step keeps its own IR and hash.', Schemas.compose, pure, args => {
    const w = composeWorkflowOrRefuse(args.strategy, undefined, scope), visual = workflowVisualModel(w);
    if (w.steps.length === 1) {
      const c = w.steps[0]!, plan = workflowPlan(w);
      return { ok: true, strategy: c.strategy, workflowHash: c.workflowHash, revision: c.workflow.revision, fundsClass: c.fundsClass, workflow: c.workflow,
        steps: stepViews(c), explanation: c.explanation, summary: c.summary, notes: c.notes, authority: AUTHORITY, stepCount: 1,
        executionPlan: { kind: plan.kind, reason: plan.reason }, visual, conversationState: conversationState('DRAFT_CREATED'),
        nextSteps: ['validate_strategy or review_strategy with this strategy and workflowHash', 'simulate_strategy for a read-only preview (optional)',
          'request_user_approval to hand it to its owner in FloFi (when available); nothing executes from MCP.'] };
    }
    const plan = workflowPlan(w);
    return { ok: true, strategy: w.strategy, workflowHash: w.workflowHash, fundsClass: w.fundsClass, stepCount: w.steps.length,
      executionPlan: { kind: plan.kind, reason: plan.reason, mode: 'STEP_BY_STEP', bindings: w.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom })) },
      workflowSteps: w.steps.map((c, index) => ({ index, action: c.strategy.action, strategy: c.strategy, workflowHash: c.workflowHash, revision: c.workflow.revision,
        fundsClass: c.fundsClass, workflow: c.workflow, steps: stepViews(c), summary: c.summary, explanation: c.explanation, flow: plan.steps[index]?.flow ?? null })),
      notes: w.notes, authority: AUTHORITY, visual, conversationState: conversationState('DRAFT_CREATED'),
      nextSteps: ['review_strategy for every step\'s findings', 'simulate_strategy with this complete strategy and workflowHash for every step\'s preview',
        'request_user_approval to hand the whole workflow to its owner: it reports how many authorizations each mode needs. Each step runs only after the previous one reconciled.'] };
  });

  register('plan_strategy', 'Plan strategy from a goal', 'FloFi\'s goal planner (the same one its own chat uses): from an outcome the user described — the asset and ' +
    'network they hold, the asset or network they want, and whether to hold, supply or provide liquidity — the ordered steps FloFi\'s registries can reach it ' +
    'with, why, and alternatives, composed into one strategy and workflowHash (a later step that spends an earlier step\'s output carries a binding). ' +
    'Or the one field still missing, or why it is not reachable. Use only values the user gave. It authorizes nothing: compose/review/request approval as usual.',
  Schemas.plan, pure, args => {
    const g = args.goal;
    const position = g.liquidity;
    const liquidity: CopilotLiquidityAction | null = position ? { type: 'LIQUIDITY',
      protocol: g.targetNetwork === 'solana' || g.targetNetwork === 'solana-devnet' ? 'ORCA' : 'UNISWAP_V3', network: networkIdentity(g.targetNetwork ?? '')?.copilot ?? null,
      deposits: Object.entries(position.maxAmounts).map(([asset, maxAmount]) => ({ asset, maxAmount })),
      rangeUnit: position.range.unit === 'full' ? 'FULL' : position.range.unit === 'tick' ? 'TICK' : 'PRICE',
      lower: 'lower' in position.range ? position.range.lower : null, upper: 'upper' in position.range ? position.range.upper : null,
      slippageBps: position.slippageBps === undefined ? null : String(position.slippageBps),
      feeTier: position.feeTier === undefined ? null : String(position.feeTier / 10_000) as NonNullable<CopilotLiquidityAction['feeTier']>, funding: 'SWAP_OUTPUT' } : null;
    const goal: Goal = { source: { network: g.sourceNetwork ?? null, asset: g.sourceAsset ?? null, amount: g.amount ?? null },
      target: { network: g.targetNetwork ?? null, asset: g.targetAsset ?? null, use: g.use }, preference: g.preference ?? null, cap: g.cap ?? null, liquidity };
    const plan = planGoal(goal, scope);
    if (plan.kind === 'LIQUIDITY') return { ok: true, kind: 'LIQUIDITY', network: plan.network, authority: AUTHORITY,
      nextSteps: ['compose_strategy with an add_liquidity strategy on this network, naming both pool assets, their maximum deposits and the range the user states.'] };
    if (plan.kind !== 'PLAN') return { ok: true, ...plan, authority: AUTHORITY };
    const strategy = goalStrategy(plan.steps, g.beneficiary ?? null);
    if (!strategy.ok) return { ok: true, kind: 'NEEDS', field: 'beneficiary', options: [], authority: AUTHORITY };
    const w = composeWorkflowOrRefuse(strategy.strategy, undefined, scope);
    return { ok: true, kind: 'PLAN', strategy: w.strategy, workflowHash: w.workflowHash, stepCount: w.steps.length, fundsClass: w.fundsClass, reasons: plan.reasons,
      alternatives: plan.alternatives, bindings: w.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom })),
      steps: w.steps.map((c, index) => ({ index, action: c.strategy.action, strategy: c.strategy, workflowHash: c.workflowHash, summary: c.summary })), notes: w.notes, authority: AUTHORITY,
      nextSteps: ['review_strategy with this strategy and workflowHash', 'request_user_approval to hand it to its owner in FloFi (when available); nothing executes from MCP.'] };
  });

  register('validate_strategy', 'Validate strategy', 'Check a strategy against FloFi\'s authoring rules (networks, assets, amounts, limits) and, when given, the workflowHash ' +
    'from compose_strategy (a mismatch means the strategy changed or FloFi\'s rules changed: compose again).', Schemas.bound, pure, args => {
    const validation = validateStrategy(args.strategy, args.workflowHash, scope);
    return { ok: true, ...validation, conversationState: validationState(validation) };
  });

  register('review_strategy', 'Review strategy', 'FloFi\'s deterministic Strategy Review: linter findings, capability blockers for the network\'s public environment and ' +
    'strategy warnings, as BLOCK / WARNING / INFORMATION. It explains; it never approves or authorizes.', Schemas.bound, { ...pure, idempotentHint: false }, async args => {
    const w = composeWorkflowOrRefuse(args.strategy, args.workflowHash, scope), reviewed = reviewWorkflow(w);
    if (w.steps.length > 1) {
      const plan = workflowPlan(w);
      return { ok: true, workflowHash: w.workflowHash, reviewKind: 'DETERMINISTIC_STRATEGY_REVIEW', authority: AUTHORITY, stepCount: w.steps.length,
        summary: reviewed.summary, executionPlan: { kind: plan.kind, reason: plan.reason, mode: 'STEP_BY_STEP' }, workflowSteps: reviewed.steps,
        conversationState: authoringState('REVIEWED', reviewed.summary.block),
        nextSteps: ['Steps run in order, each after the previous step reconciled. Confirm each step: every step gets a fresh simulation and the owner\'s Review ' +
          'and wallet confirmation before it runs. User-funded groups (where request_user_approval reports them available): the owner\'s own wallet ' +
          'authorizes each group of same-network steps once and pays every fee.'] };
    }
    const c = w.steps[0]!, review = reviewed.steps[0]!, flow = strategyFlow(c.strategy);
    const mode = flow ? await ctx.runtime.mode(flow) : null;
    return { ok: true, workflowHash: c.workflowHash, reviewKind: 'DETERMINISTIC_STRATEGY_REVIEW', authority: AUTHORITY, environment: review.environment,
      summary: review.summary,
      findings: review.findings, capability: review.capability,
      deployment: { flow, mode: mode ?? 'UNKNOWN_IN_LOCAL_RUNTIME' }, conversationState: authoringState('REVIEWED', review.summary.block),
      nextSteps: ['A fresh simulation (simulate_strategy previews it; the FloFi app runs the authoritative one).',
        'The owner reviews the route-bound Strategy Manifest in the FloFi app and signs with their own wallet. MCP cannot do either.'] };
  });

  register('simulate_strategy', 'Simulate strategy (read-only preview)', 'Run FloFi\'s own simulation for this exact workflow — live quotes, chain reads and transaction ' +
    'simulation where the flow supports it — as a read-only preview. Nothing is stored, nothing is signed or sent, and the result cannot be authorized. ' +
    '`simulationSubject` is only the account whose public balances the simulation reads. Calldata and transactions are never returned.',
  Schemas.simulate, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }, async args => {
    // BUILD-MCP-002: an OAuth account also has an hourly simulation budget (they reach public chains and providers).
    const account = ctx.principal.kind === 'mcp-oauth' ? ctx.principal.accountId : null, state = ctx.state;
    const workflow = composeWorkflowOrRefuse(args.strategy, args.workflowHash, scope);
    if (workflow.steps.length > 1) {
      const preview = await simulateWorkflowPreview(ctx.runtime, args, { scope, ...ctx.budget ? { signal: ctx.budget.signal } : {}, ...account && state
        ? { budget: () => state.oauth.allow(`simulate:account:${account}`, SIMULATIONS_PER_ACCOUNT_HOUR, 3_600, new Date()) } : {} });
      return { ok: true, kind: 'WORKFLOW_PREVIEW', ...preview, preview: true, conversationState: simulationState(),
        subjectRole: 'SIMULATION_SUBJECT_ONLY_NOT_AN_OWNER_OR_AUTHORIZATION', authority: AUTHORITY,
        notes: ['Each step uses its own provider simulation against the current chain state.',
          'Dependent balances arrive only after earlier steps reconcile; an awaiting step is explicitly incomplete.',
          'Confirm each step: FloFi re-simulates each actual received amount and presents its Strategy Manifest before the wallet signs that step.',
          'User-funded groups: a dependent step in the same group spends the earlier step\'s signed guaranteed minimum; in a later group, the reconciled delivery.'] };
    }
    const { composition: c, plan, view, simulationSubject } = await simulatePreview(ctx.runtime, args, { scope, ...ctx.budget ? { signal: ctx.budget.signal } : {}, ...account && state
      ? { budget: () => state.oauth.allow(`simulate:account:${account}`, SIMULATIONS_PER_ACCOUNT_HOUR, 3_600, new Date()) } : {} });
    return { ok: true, workflowHash: c.workflowHash, flow: plan.flow, kind: view.kind, provenance: view.provenance, observedAt: view.observedAt, expiresAt: view.expiresAt,
      simulationSubject, subjectRole: 'SIMULATION_SUBJECT_ONLY_NOT_AN_OWNER_OR_AUTHORIZATION',
      preview: true, persisted: false, authorizable: false, evidenceLevel: view.provenance === 'MOCKED' ? 'MOCKED_SIMULATION_PREVIEW' : 'SIMULATION_PREVIEW_NOT_EXECUTION',
      facts: view.facts, canonicalArtifacts: view.canonicalArtifacts, authority: AUTHORITY, conversationState: simulationState(),
      notes: ['Amounts are integer native units of the named tokens.', 'Quotes and state expire; the FloFi app re-simulates before any Review.',
        'A simulation is evidence of what would happen at the observed block, not a guarantee and not an execution.'] };
  });

  register('get_execution_status', 'Execution status', 'Status, attempts and journal page of one FloFi execution, read from FloFi\'s durable state, with its canonical ' +
    'lifecycle (status, final, completed: only a reconciled outcome is completed; a hash or a confirmation never is). Visible only when its ' +
    'owner wallet is one the deployment owner granted to this MCP credential; otherwise it is reported as not found.', Schemas.status, { ...pure, idempotentHint: false }, async args => {
    const found = await findOwnedRun(ctx.runtime, ctx.principal.wallets, args.executionId);
    const view = await executionStatusView(ctx.runtime, found, args.executionId, accessBasis(ctx), { after: args.journalAfter, limit: args.journalLimit });
    return { ok: true, ...view, conversationState: executionState(view.lifecycle),
      notes: ['FloFi\'s canonical durable state; a partner or agent display is only a projection of it.'] };
  });

  register('get_evidence', 'Execution evidence', 'The reconciled Evidence Bundle of one FloFi execution with its own environment (MOCKED, TESTNET_EXECUTED, …) and outcome, ' +
    'exactly as FloFi recorded them. Owner-scoped like get_execution_status.', Schemas.evidence, { ...pure, idempotentHint: false }, async args => {
    const found = await findOwnedRun(ctx.runtime, ctx.principal.wallets, args.executionId);
    const view = await evidenceView(ctx.runtime, found, args.executionId, accessBasis(ctx));
    return view.evidence ? { ok: true, ...view, notes: ['Environment and outcome are copied from the Evidence Bundle; MCP never upgrades them.'] } : { ok: true, ...view };
  });

  // ── Education: FloFi's own general knowledge and product guide (no state, no network, never live data) ────────────────────────────────
  register('explain_concept', 'Explain a DeFi concept', 'FloFi\'s own explanation of a DeFi concept (liquidity pools, collateral, health factor, liquidation, LTV, ' +
    'slippage, impermanent loss, bridges, token approvals, gas, automations…), named by its catalog id (`concept`) or in the user\'s words (`term`), at a ' +
    'level (STANDARD, SIMPLE, EXAMPLE, ADVANCED) and optionally for one protocol. General knowledge, not live data: it never states a price, rate, ' +
    'balance or position; live values come only from simulate_strategy and the owner\'s Review in FloFi. An unknown term is CONCEPT_UNKNOWN with the ' +
    'catalog ids. Read-only; it authorizes nothing.', Schemas.concept, pure,
  args => ({ ok: true, ...explainConcept(args), authority: AUTHORITY }));

  register('explain_strategy', 'Explain strategy', 'Explain a strategy in FloFi\'s own words: each composed step (the same composition and workflowHash as ' +
    'compose_strategy), FloFi\'s deterministic review findings, and the DeFi concepts that apply to its steps — collateral, health factor and liquidation ' +
    'for a borrow, slippage for swaps and bridges, token approvals, impermanent loss for liquidity — each located in this workflow. No live health factor, ' +
    'LTV, price or APY is given: those come only from simulate_strategy and the owner\'s Review in FloFi. An invalid strategy is refused with the same ' +
    'codes as compose_strategy. Read-only; it authorizes nothing.', Schemas.explain, pure, args => {
    const w = composeWorkflowOrRefuse(args.strategy, args.workflowHash, scope);
    return { ok: true, ...explainWorkflow(w, args.language ?? 'EN'), authority: AUTHORITY,
      nextSteps: ['simulate_strategy for a read-only preview with live quotes (optional)', 'request_user_approval to hand it to its owner in FloFi (when available); nothing executes from MCP.'] };
  });

  register('get_platform_help', 'FloFi platform help', 'Where and how things are done in FloFi (connecting a wallet, networks, wallets, automations, ' +
    'authorizations and revocation, notifications, privacy, history, execution status, deleting the account, AI agents): FloFi\'s own guide, by `topic`, ' +
    'by a `question` in the user\'s words, or the whole guide when neither is given. Links are relative paths on FloFi\'s website (`websiteUrl`). ' +
    'Guidance only: changes are made by the owner in the FloFi app; this server never changes a setting. Read-only.', Schemas.help, pure, args => {
    const language = args.language ?? 'EN', websiteUrl = ctx.oauth?.origin ?? FLOFI_PRODUCTION_ORIGIN;
    const common = { websiteUrl, changes: 'Only the owner changes settings, wallets, automations or authorizations, in the FloFi app; this MCP server never applies or prepares a change.',
      authority: AUTHORITY };
    if (args.topic !== undefined && args.question !== undefined) failWith('PLATFORM_HELP_INPUT_INVALID', { issues: [{ path: '/', rule: 'atMostOne(topic, question)' }] });
    if (args.topic === undefined && args.question === undefined) return { ok: true, language, topics: platformGuide(language, 'MCP'), ...common };
    const topic = args.topic ?? matchPlatformTopic(args.question ?? '');
    if (!topic || !MCP_PLATFORM_TOPICS.includes(topic)) return failWith('PLATFORM_TOPIC_UNKNOWN', { topics: [...MCP_PLATFORM_TOPICS] });
    return { ok: true, language, ...platformAnswer(topic, language, 'MCP'), resolvedFrom: args.topic === undefined ? 'QUESTION' : 'TOPIC', ...common };
  });

  // ── Automations: read-only. Managing an automation (create, pause, resume, archive, change) is the owner's, in the FloFi app ───────────────
  register('list_automation_types', 'Automation types', 'The kinds of FloFi automation (SCHEDULED_DCA recurring buy, PRICE_TRIGGER, DAILY_WATCH) in FloFi\'s ' +
    'words, how each occurrence is authorized (CONFIRM_EACH_TIME: the owner confirms every execution in their own wallet), that delegated execution is ' +
    'retired, and FloFi\'s answers to common questions. Static and read-only: creating, activating or changing an automation is done by the owner in the ' +
    'FloFi app; MCP cannot create, pause, resume, archive or approve one.', Schemas.language, pure,
  args => ({ ok: true, language: args.language ?? 'EN', ...automationTypes(args.language ?? 'EN'), authority: AUTHORITY }));

  register('get_automation_status', 'Automation status', 'Read-only status of the owner\'s own automations — every rule, or one `ruleId` with its recorded ' +
    'history: FloFi\'s summary, state, next evaluation, last outcome and why it ran or did not run, as FloFi recorded it. Read as each wallet the account ' +
    'linked on FloFi (`/connections`; a developer credential: its granted wallets); another owner\'s rule and an unknown id are both AUTOMATION_NOT_FOUND. ' +
    'If a wallet cannot be read the result is INCOMPLETE, never an empty list. It never returns balances or approval links, and it cannot create, pause, ' +
    'resume, archive, change or approve an automation: those happen only in the FloFi app with the owner\'s confirmation.', Schemas.automationStatus,
  { ...pure, idempotentHint: false }, async args => {
    const owners = principalOwners(ctx.principal), language = args.language ?? 'EN';
    if (!owners.length) return failWith('MCP_WALLET_LINK_REQUIRED', { accessBasis: accessBasis(ctx), ...ctx.principal.kind === 'mcp-oauth'
      ? { next: 'The owner links a wallet to this account on FloFi\'s Connections page (/connections); automation status is read only for linked wallets.' } : {} });
    if (!ctx.automations) return failWith('AUTOMATIONS_NOT_ENABLED');
    const status = await automationStatus(ctx.automations, owners, args.ruleId, language, ctx.budget);
    return { ok: true, language, ...status, accessBasis: accessBasis(ctx), readOnly: true, management: AUTOMATION_MANAGEMENT[language], authority: AUTHORITY };
  });
  // BUILD-FLOFI-UNIVERSAL-CHANNELS-001: who this connection acts for, what its linked wallets hold and what they ran — so a conversation never needs the Dashboard.
  const origin = ctx.oauth?.origin ?? FLOFI_PRODUCTION_ORIGIN;
  const linkRequired = () => failWith('MCP_WALLET_LINK_REQUIRED', { accessBasis: accessBasis(ctx), ...ctx.principal.kind === 'mcp-oauth'
    ? { linkWalletUrl: `${origin}/connections`, next: 'The person links a wallet on FloFi\'s Connections page (sign-in message only, no transaction), then asks again.' } : {} });
  register('get_account', 'Account and linked wallets', 'Who this FloFi connection acts for: the connected app, its granted scopes and the wallets the account linked on ' +
    'FloFi (each proven by that wallet\'s own sign-in message), plus the FloFi Connections link where the person links another wallet, removes a link or withdraws ' +
    'an approval request. Identity comes only from these proven wallet links, never from an e-mail, username or anything the conversation says. ' +
    'Call it before portfolio, history or approval questions. It reveals no balance and authorizes nothing.', Schemas.none, { ...pure, idempotentHint: false },
  () => ({ ok: true, ...accountView(ctx.principal, origin), authority: AUTHORITY }));

  register('get_portfolio', 'Portfolio and positions', 'Read-only balances of the account\'s linked wallets on the mainnets this deployment enables (validated token ' +
    'catalogs, USD only from FloFi\'s verified price source — an unpriced asset has no value, never an estimate), and, unless positions is false, their Aave, ' +
    'Uniswap and Orca positions. Only linked wallets can be read (get_account); a network that could not be read is reported UNAVAILABLE, never as zero. ' +
    'Each figure carries its observedAt time; it is not a quote. Nothing is stored, signed or sent.', Schemas.portfolio, { readOnlyHint: true, destructiveHint: false,
    idempotentHint: false, openWorldHint: true }, async args => {
    if (!principalOwners(ctx.principal).length) return linkRequired();
    const port = ctx.portfolio;
    if (!port) return failWith('PORTFOLIO_NOT_AVAILABLE');
    // An OAuth account's hourly portfolio budget: each call reads public chains and shares the per-process position limiter with the Dashboard.
    const principal = ctx.principal, state = ctx.state;
    if (principal.kind === 'mcp-oauth' && state && !await state.oauth.allow(`portfolio:account:${principal.accountId}`, PORTFOLIO_READS_PER_ACCOUNT_HOUR, 3_600, new Date()))
      return failWith('PORTFOLIO_RATE_LIMITED');
    // Balances of every wallet in parallel; positions one wallet after another (the shared position limiter admits two scans at a time).
    const readable = portfolioOwners(principal).slice(0, MAX_ACCOUNT_WALLETS);
    // Linked before the Connections page disclosed balance reads: the owner re-links the wallet there to allow them (nothing is read meanwhile).
    if (!readable.length) return failWith('PORTFOLIO_RELINK_REQUIRED', { linkWalletUrl: `${origin}/connections`,
      next: 'The person opens FloFi Connections, links the wallet again (sign-in message only) and agrees to balance and position reads; then ask again.' });
    const balances = await Promise.all(readable.map(wallet => port.balances(wallet).then(value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, code: error instanceof Error && CODE.test(error.message) ? error.message : 'PORTFOLIO_READ_FAILED' }))));
    const wallets: Output[] = [];
    let positionsComplete = true;
    for (const [index, wallet] of readable.entries()) {
      const read = balances[index]!;
      if (!read.ok) { wallets.push({ read: false, wallet: { namespace: wallet.namespace, address: wallet.address }, code: read.code }); continue; }
      let positions: unknown = null;
      if (args.positions !== false && port.positions) {
        positions = await port.positions(wallet).then(positionsView, (error: unknown) =>
          ({ unavailable: error instanceof Error && CODE.test(error.message) ? error.message : 'POSITION_SCAN_UNAVAILABLE' }));
        if (!Array.isArray(positions) || positions.some(scan => scan.status !== 'COMPLETE' && scan.status !== 'UNSUPPORTED')) positionsComplete = false;
      }
      wallets.push({ read: true, ...portfolioView(wallet, read.value), positions });
    }
    const omitted = principalOwners(principal).length - readable.length, complete = wallets.every(w => w.read) && positionsComplete && omitted === 0;
    return { ok: true, readOnly: true, wallets, complete, authority: AUTHORITY, ...omitted ? { walletsOmitted: omitted } : {},
      ...complete ? {} : { note: 'Some balances, positions or wallets could not be read now; they are UNKNOWN (not zero). Try again.' },
      notes: ['Balances are public chain state at observedAt. Before any action FloFi re-reads balances and simulates again in the signing page.'] };
  });

  register('list_executions', 'Execution history', 'The linked wallets\' recent FloFi executions across every action and surface (web app, ChatGPT, Claude, Telegram), ' +
    'newest first, each with FloFi\'s canonical lifecycle and conversationState (only CONFIRMED is completed). Owner-scoped: only wallets the account linked; ' +
    'another owner\'s runs never appear. A wallet that could not be read makes the list INCOMPLETE, never empty. Use get_execution_status / get_evidence for one ' +
    'execution\'s transactions and evidence.', Schemas.none, { ...pure, idempotentHint: false }, async () => {
    if (!principalOwners(ctx.principal).length) return linkRequired();
    const who = ctx.principal, store = ctx.state;
    if (who.kind === 'mcp-oauth' && store && !await store.oauth.allow(`history:account:${who.accountId}`, HISTORY_READS_PER_ACCOUNT_HOUR, 3_600, new Date()))
      return failWith('HISTORY_RATE_LIMITED');
    const history = await historyView(ctx.runtime, linkedOwners(ctx.principal));
    if (!history.available) return failWith('HISTORY_NOT_AVAILABLE');
    const omitted = omittedOwners(ctx.principal);
    return { ok: true, ...history, ...omitted ? { complete: false, walletsOmitted: omitted } : {}, accessBasis: accessBasis(ctx), authority: AUTHORITY };
  });

  if (ctx.principal.kind === 'mcp-oauth' && ctx.state && ctx.oauth) {
    registerApprovalTools(ctx, register);
    if (ctx.ui) {
      const meta = panelResourceMeta(ctx.oauth.origin), html = panelHtml({ origin: ctx.oauth.origin, inFrameProbeHosts: ctx.ui.inFrameProbeHosts });
      // New tool results use a versioned resource so host HTML caches cannot retain the external-only adapter.
      // Keep the old resource readable for existing conversations; no approval or financial API changes.
      for (const uri of [PANEL_URI, LEGACY_PANEL_URI]) server.registerResource(uri === PANEL_URI ? 'flofi-approval-panel' : 'flofi-approval-panel-legacy', uri,
        { title: 'FloFi approval', description: 'The in-chat FloFi approval panel.', mimeType: PANEL_MIME, _meta: meta },
        async () => ({ contents: [{ uri, mimeType: PANEL_MIME, text: html, _meta: meta }] }));
    }
  }
  return server;
}

type Register = <S extends TSchema>(name: ToolName, title: string, description: string, schema: S, annotations: ToolAnnotations,
  run: (args: Static<S>) => Promise<Output> | Output, toolMeta?: Record<string, unknown>) => void;
const ApprovalId = Type.String({ pattern: '^apr_[a-z2-7]{26}$', description: 'The approvalId returned by request_user_approval.' });
const ApprovalSchemas = {
  byId: Type.Object({ approvalId: ApprovalId }, strict),
  list: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'How many of the most recent approval requests (default 10).' })) }, strict),
};
/**
 * An approval as a list shows it, without reading its runs: an APPLIED one, and a claimed multi-step one (its run starts at the claim and can sign
 * steps while the handoff still reads CLAIMED or later EXPIRED), is UNKNOWN there — get_approval_status reads the runs.
 */
const listedState = (view: { readonly status: string; readonly executionPlan: string; readonly claimed: boolean }) => view.status === 'APPLIED'
  ? conversationState('STATUS_UNKNOWN', 'READ_GET_APPROVAL_STATUS') : approvalState(view);
/** BUILD-MCP-002: the bridge to the owner's own wallet in FloFi. Every result carries authority NONE. */
function registerApprovalTools(ctx: ToolContext, register: Register) {
  const oauth = ctx.oauth!, state = ctx.state!, principal = ctx.principal as McpOAuthPrincipal;
  // BUILD-DEVELOPER-001: the shared approval service sees an MCP account as one requester kind among others, with MCP's own link
  // scheme (the `flofi_hs_` links) and rules.
  const requester: ApprovalRequester = { kind: 'MCP_ACCOUNT', ref: principal.accountId, grantId: principal.id, clientId: principal.clientId, displayName: principal.clientName };
  const deps = (): ApprovalDeps => ({ origin: oauth.origin, scheme: mcpApprovalLinkScheme(oauth), handoffs: state.handoffs,
    allow: (bucket, limit, windowSeconds, now) => state.oauth.allow(bucket, limit, windowSeconds, now), runtime: ctx.runtime, policy: ctx.policy ?? DEFAULT_POLICY,
    rules: MCP_HANDOFF_RULES, now: new Date() });
  const owned = (approvalId: string) => approvalForRequester(state.handoffs, requester, approvalId, new Date());
  /**
   * One of this requester's approvals with its runs (only when the owner shares them). A Pix approval lists its durably bound Pix runs
   * (issue #149, `pix-approval-status.ts`). A run read that failed makes the list INCOMPLETE — said explicitly, never shown as "no runs".
   */
  const progress = async (approvalId: string) => {
    const h = await owned(approvalId), observed = observeRuntime(ctx.runtime);
    const value = isPixApproval(h) ? await pixApprovalProgress(h, observed.runtime, oauth.origin)
      : await approvalProgress(h, observed.runtime, state.handoffs, oauth.origin, state.workflowRuns);
    const failure = observed.failure();
    // The request's own deadline (or a client that left) during a run read: the whole status is UNKNOWN (STATUS_UNKNOWN timeout result).
    if (failure === 'MCP_REQUEST_TIMEOUT' || failure === 'MCP_REQUEST_CANCELLED') throw new DeadlineError(failure);
    if (!failure || !value.runsVisible || 'runsComplete' in value) return value;
    return { ...value, runsComplete: false, runsReadError: failure,
      note: 'Some runs of this approval could not be read now; their state is UNKNOWN (not "not started"). Read get_approval_status again.' };
  };
  const ui = ctx.ui ?? null, appOnly = { ui: { visibility: ['app'] } };

  register('request_user_approval', 'Request the owner\'s approval', 'Request approval for the exact composed strategy and workflowHash. The MCP App can present the existing signing surface inside chat when the host and wallet support it. ' +
    'FloFi re-composes and re-checks it, then returns an approval link with authority NONE. Nothing is authorized, signed or sent by this request: the owner must use the signing surface, ' +
    'connect their wallet if needed, check FloFi\'s fresh simulation and choose Authorize in wallet. Their own wallet confirmation is mandatory. Canvas is optional. ' +
    'First call compose_strategy and review_strategy. Quote only this successful tool result\'s public nonsecret approvalUrl verbatim (or show the FloFi panel); ' +
    'never invent an approval URL or ID. If this call fails or is unavailable, disclose it and provide no approval CTA. ' +
    'Mainnet may be disabled by policy. A multi-step workflow is one approval: tell the user how many wallet interactions `authorizationPlan` reports (one ' +
    'confirmation per step, or — where `userFunded` is available — one interaction per group of same-network steps, `atLeast` when a step runs through its ' +
    'own flow or the owner\'s wallet was not read yet (`userFunded.wallets` ASSUMED): say "at least N" then, never promise a single signature); ' +
    'the owner\'s own wallet pays every fee and FloFi never does; each step or group runs only after the previous one reconciled. ' +
    'The same approvalUrl reopens the next step for the owner.', SCHEMAS[ctx.scope ?? networkScope()].request,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async args => {
    const result = await requestApproval(deps(), requester, args.strategy, args.workflowHash);
    if (!result.ok) return failWith(result.code, result.extra ?? {});
    // The picture of exactly the workflow the handoff holds: the same canonical composition, bound to the same hash.
    const visual = workflowVisualModel(composeWorkflowOrRefuse(args.strategy, result.value.workflowHash, ctx.scope ?? networkScope()));
    return { ok: true, ...result.value, visual, conversationState: approvalState({ status: 'PENDING' }), message: 'Use the FloFi MCP App to authorize in chat when your host and wallet support it. Connect your wallet, check the fresh simulation and choose Authorize in wallet. ' +
      'Confirm each step: confirm each exact transaction in your wallet. User-funded groups: your own wallet authorizes each group of steps on one network and pays every fee. Opening the FloFi signing link is an optional external fallback, not in-chat completion. Canvas is optional. Nothing is executed until chain confirmation and reconciliation. Retrieve get_approval_status for shared status and the verified receipt URL.' };
  }, ui ? { ui: { resourceUri: ui.resourceUri }, 'openai/outputTemplate': ui.resourceUri, 'openai/toolInvocation/invoking': 'Preparing approval…',
    'openai/toolInvocation/invoked': 'Approval ready' } : {});

  register('get_approval_status', 'Approval status', 'The status of an approval request this account created: PENDING, CLAIMED, APPLIED, EXPIRED, SUPERSEDED, ' +
    'REVOKED or STALE. When the owner shares status, includes run status and the verified receipt URL after reconciliation. A multi-step approval also returns ' +
    '`workflowRun`: every step\'s state, the next action (OWNER_SIGNS_STEP or OWNER_SIGNS_GROUP: share the approvalUrl again; OWNER_CONFIRMS_BATCH: the owner ' +
    'reopens FloFi so their wallet reports its batch), and — when the owner shares status — each step\'s ' +
    'transaction hashes, explorer links, reconciled amounts and evidence. HALTED means stopped and the owner decides in FloFi: `workflowRun.halted` says whether ' +
    'steps reconciled (PARTIAL: they stay done; a later step may have been sent and failed, so read the step that stopped), nothing was sent (NOTHING_SENT) or ' +
    'neither is claimed (STOPPED); Resume is possible only while `workflowRun.resumable` is true. A step or group code WALLET_BATCH_OUTCOME_UNKNOWN means a batch ' +
    'handed to the owner\'s wallet may have executed: never report it as not run. Poll this tool when asked; no callback or push is promised. ' +
    'It never reveals the claiming wallet or authorizes anything.', ApprovalSchemas.byId, { ...pure, idempotentHint: false },
  async args => { const value = await progress(args.approvalId); return { ok: true, ...value, conversationState: approvalState(value) }; });

  register('open_approval_session', 'Open FloFi approval', 'App-only: a fresh, short-lived FloFi link for this approval (for the signing window or a wallet ' +
    'in-app browser). The link only shows the proposal; it authorizes nothing.', ApprovalSchemas.byId, { readOnlyHint: false, destructiveHint: false,
    idempotentHint: false, openWorldHint: false }, async args => ({ ok: true, ...await openApprovalSession(deps(), requester, args.approvalId) }), appOnly);

  register('get_execution_progress', 'Execution progress', 'App-only: the approval\'s state and, when its owner shares it, the status of the runs started from it.',
    ApprovalSchemas.byId, { ...pure, idempotentHint: false }, async args => { const value = await progress(args.approvalId); return { ok: true, ...value,
      conversationState: approvalState(value) }; }, appOnly);

  // BUILD-FLOFI-UNIVERSAL-CHANNELS-001: this account's approval requests (from any of its conversations) and withdrawing one before anything is signed.
  register('list_approvals', 'Approval requests', 'This account\'s most recent approval requests, newest first, each with its status (PENDING, CLAIMED, APPLIED, ' +
    'EXPIRED, SUPERSEDED, REVOKED, STALE), workflowHash, expiry, steps and conversationState. Use it when the person asks about earlier requests or wants to continue ' +
    'one ("I\'ve signed", "did it complete?"); then read get_approval_status for that approvalId — it holds the authoritative run status, transactions and receipts. ' +
    'It authorizes nothing and never reveals the claiming wallet.', ApprovalSchemas.list, { ...pure, idempotentHint: false }, async args => {
    const records = await state.handoffs.listForRequester(requesterScope(requester), new Date(), args.limit ?? 10);
    return { ok: true, approvals: records.map(h => { const status = approvalStatus(h); return { ...status, createdAt: h.createdAt.toISOString(),
      conversationState: listedState(status) }; }), authority: AUTHORITY };
  });

  register('cancel_approval', 'Cancel an approval request', 'Withdraw one of this account\'s approval requests before its proposal is in the owner\'s signing flow ' +
    '(PENDING or CLAIMED): its link stops working and nothing can be authorized from it. An APPLIED request is no longer cancellable here — the owner rejects the ' +
    'wallet prompt or stops it in the FloFi signing page; a confirmed transaction can never be undone. An already ended request is reported as it is. Cancelling ' +
    'signs, sends and refunds nothing. Only call it when the person asks to cancel.', ApprovalSchemas.byId,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, async args => {
    const h = await owned(args.approvalId);
    // A multi-step proposal's run starts at the claim and may already have signed steps while the handoff reads CLAIMED: never cancellable here.
    const runOf = async () => h.plan.kind === 'SEQUENTIAL' ? await state.workflowRuns.byHandoff(h.handoffId) : null;
    // Claimed is enough: the run is created right after the claim commits, so a claimed multi-step request is treated as started.
    if ((h.plan.kind === 'SEQUENTIAL' && h.claimed !== null) || await runOf()) return failWith('APPROVAL_NOT_CANCELLABLE', { status: h.status, reason: 'WORKFLOW_RUN_STARTED',
      conversationState: conversationState('STATUS_UNKNOWN', 'READ_GET_APPROVAL_STATUS'),
      next: 'This workflow is already in the owner\'s signing flow. They can reject the wallet prompt or stop it in the FloFi signing page; read get_approval_status.' });
    if (h.status === 'APPLIED') return failWith('APPROVAL_NOT_CANCELLABLE', { status: h.status, conversationState: conversationState('STATUS_UNKNOWN', 'READ_GET_APPROVAL_STATUS'),
      next: 'The proposal is already in the owner\'s signing flow. They can reject the wallet prompt or stop it in the FloFi signing page; read get_approval_status for its state.' });
    if (h.status !== 'PENDING' && h.status !== 'CLAIMED') return { ok: true, approvalId: h.handoffId, status: h.status, cancelled: false, alreadyEnded: true,
      conversationState: approvalState({ status: h.status }), authority: AUTHORITY };
    const ended = await state.handoffs.revokeForRequester(h.handoffId, requesterScope(requester), new Date());
    if (!ended) return failWith('APPROVAL_NOT_FOUND');
    // Re-read after the store's lock: a request applied (or a run claimed) in the meantime is reported as it is, never as cancelled.
    const raced = ended.status === 'APPLIED' || (ended.plan.kind === 'SEQUENTIAL' && ended.claimed !== null) || await runOf() !== null;
    return { ok: true, approvalId: ended.handoffId, status: ended.status, cancelled: ended.status === 'REVOKED' && !raced, authority: AUTHORITY,
      conversationState: raced ? conversationState('STATUS_UNKNOWN', 'READ_GET_APPROVAL_STATUS') : approvalState({ status: ended.status }),
      message: ended.status === 'REVOKED' && !raced ? 'The approval request was cancelled. Its link no longer works; nothing was signed or sent from it.'
        : 'The request was not cancelled as asked: it reached the owner\'s signing flow first. Read get_approval_status.' };
  });
}
