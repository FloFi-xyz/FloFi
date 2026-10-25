// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the FloFi MCP tools (names follow Master Spec §14.7). One `McpServer` per HTTP request, built for one
 * authenticated principal. Every tool is read-only with respect to funds and authority:
 *
 *   discovery      get_supported_networks, get_supported_assets, get_capabilities   (registries + deployment enablement)
 *   authoring      compose_strategy, validate_strategy, review_strategy               (pure deterministic facade, no state)
 *   preview        simulate_strategy                                                  (the flow's own simulation, nothing persisted)
 *   observation    get_execution_status, get_evidence                                 (owner-scoped durable reads)
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
import { prepareNetworkCatalogs } from '../platform/catalogs.ts';
import { robinhoodAuthoringCatalog } from '../server/robinhood-mainnet.ts';
import { ethereumAuthoringCatalog } from '../server/ethereum-mainnet.ts';
import { arbitrumAuthoringCatalog } from '../server/arbitrum-mainnet.ts';
import { baseAuthoringCatalog } from '../server/base-mainnet.ts';
import { approvalForRequester, approvalProgress, capabilityFacts, composeWorkflowOrRefuse, evidenceView, executionStatusView, findOwnedRun,
  openApprovalSession, PlatformRefusal, refuse, requestApproval, reviewWorkflow, simulatePreview, stepViews, validateStrategy, type ApprovalDeps,
  type ApprovalRequester } from '../platform/index.ts';
import { principalScopes, type McpOAuthPrincipal, type McpPrincipal } from './config.ts';
import { LEGACY_PANEL_URI, PANEL_MIME, PANEL_URI, panelHtml, panelResourceMeta } from './app/panel.ts';
import { MCP_HANDOFF_RULES, mcpApprovalLinkScheme } from './approval-profile.ts';
import { readHandoffPolicy, workflowPlan, type HandoffPolicy } from './execution.ts';
import type { McpScope, OAuthConfig } from './oauth/config.ts';
import type { McpState } from './oauth/state.ts';
import type { McpRuntime } from './runtime.ts';
import { assertSafeOutput, strategyFlow } from './simulation.ts';
import { workflowVisualModel, type WorkflowVisualModel } from '../platform/workflow-visual.ts';
import { workflowVisualLayout, workflowVisualText } from '../platform/workflow-visual-layout.ts';
import { workflowVisualPngOrNull } from '../server/workflow-visual-image.ts';
import { FLOFI_PRODUCTION_ORIGIN, publicApprovalUrl } from '../platform/navigation.ts';

/** BUILD-DEVELOPER-001: the deep links moved to the shared approval service; re-exported for existing importers. */
export { walletDeepLinks } from '../platform/index.ts';

export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_TOOL_NAMES = Object.freeze(['get_supported_networks', 'get_supported_assets', 'get_capabilities', 'compose_strategy', 'validate_strategy',
  'simulate_strategy', 'review_strategy', 'get_execution_status', 'get_evidence'] as const);
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
  'Never ask the user for a private key or seed phrase.';
/** BUILD-FLOFI-MAINNET-PRODUCT-001: what the public product adds to the instructions. */
export const MCP_MAINNET_INSTRUCTIONS = ' FloFi runs on mainnets only: every strategy uses real funds. Test networks (Sepolia, Devnet, testnets) are not available; ' +
  'never move a request to a mainnet on your own — ask the user which mainnet and amount they want.';

/**
 * TypeBox + Ajv (the repo's strict schema stack) behind the Standard Schema interface the SDK consumes. Issues name paths and
 * rules only, never values; a `strategy` is reported against its own action's schema rather than every union branch.
 */
function standard<T>(schema: TSchema): StandardSchemaWithJSON<T, T> {
  const compiled = compileSchema<T>(schema), json = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const issuesOf = (value: unknown) => {
    const all = compiled.issues(value), strategy = value && typeof value === 'object' ? (value as { strategy?: unknown }).strategy : undefined;
    const inStrategy = (i: { path: string }) => i.path === '/strategy' || i.path.startsWith('/strategy/');
    if (strategy === undefined || !all.some(inStrategy)) return all;
    const detailed = strategyInputIssues(strategy).map(i => ({ path: '/strategy' + (i.path === '/' ? '' : i.path), rule: i.rule }));
    // BUILD-FLOFI-MAINNET-PRODUCT-001: valid under the full contract but not the public one: it names a test network (or the Base Sepolia composition).
    return [...all.filter(i => !inStrategy(i)), ...detailed.length ? detailed : [{ path: '/strategy', rule: 'mainnetOnly' }]];
  };
  return { '~standard': { version: 1, vendor: 'flofi',
    validate: value => compiled.check(value) ? { value: value as T } : { issues: issuesOf(value).map(i => ({ message: `${i.path} ${i.rule}`, path: i.path.split('/').filter(Boolean) })) },
    jsonSchema: { input: () => json, output: () => json } } };
}
const strict = { additionalProperties: false } as const;
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const Hash = Type.String({ pattern: '^0x[0-9a-f]{64}$', description: 'The workflowHash returned by compose_strategy.' });
const ExecutionId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$', description: 'A FloFi execution (run) id. It is a lookup key, not an access grant.' });
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
  status: Type.Object({ executionId: ExecutionId, journalAfter: Type.Optional(Type.Integer({ minimum: -1, maximum: 2_147_483_647 })),
    journalLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict),
  evidence: Type.Object({ executionId: ExecutionId }, strict),
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
export const APPROVAL_TOOL_NAMES = Object.freeze(['request_user_approval', 'get_approval_status', 'open_approval_session', 'get_execution_progress'] as const);
export const APP_ONLY_TOOLS: readonly ToolName[] = Object.freeze(['open_approval_session', 'get_execution_progress']);
export type ToolName = (typeof MCP_TOOL_NAMES)[number] | (typeof APPROVAL_TOOL_NAMES)[number];
export const TOOL_SCOPES: Readonly<Record<ToolName, McpScope>> = Object.freeze({
  get_supported_networks: 'flofi.strategy', get_supported_assets: 'flofi.strategy', get_capabilities: 'flofi.strategy', compose_strategy: 'flofi.strategy',
  validate_strategy: 'flofi.strategy', simulate_strategy: 'flofi.strategy', review_strategy: 'flofi.strategy', get_execution_status: 'flofi.runs', get_evidence: 'flofi.runs',
  request_user_approval: 'flofi.approval', get_approval_status: 'flofi.approval', open_approval_session: 'flofi.approval', get_execution_progress: 'flofi.approval' });

export type ToolEvent = { readonly tool: string; readonly outcome: string; readonly durationMs: number };
export type ToolContext = { readonly principal: McpPrincipal; readonly runtime: McpRuntime; readonly onTool?: (event: ToolEvent) => void; readonly now?: () => number;
  /** BUILD-MCP-002: present for OAuth deployments. */
  readonly oauth?: OAuthConfig; readonly state?: McpState;
  /** BUILD-MCP-002: the MCP handoff policy (default: test funds only, every mainnet off). */
  readonly policy?: HandoffPolicy;
  /** BUILD-MCP-002: the in-chat MCP App panel attached to request_user_approval, when enabled. */
  readonly ui?: { readonly resourceUri: string; readonly inFrameProbeHosts: readonly string[] } | null;
  /** BUILD-FLOFI-MAINNET-PRODUCT-001: the deployment's network scope (default: this server's, `server/network-scope.ts`). */
  readonly scope?: NetworkScope };
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

export function createFlofiMcpServer(ctx: ToolContext): McpServer {
  const scope = ctx.scope ?? networkScope(), Schemas = SCHEMAS[scope];
  const deploymentInstructions = ctx.oauth && ctx.oauth.origin !== FLOFI_PRODUCTION_ORIGIN
    ? ` This is a deliberately configured non-production FloFi environment at ${ctx.oauth.origin}; its MCP endpoint is ${ctx.oauth.resource}. ` +
      'Preserve the exact URLs returned by its tools for this preview; do not substitute the production origin into its OAuth or approval flow.' : '';
  const server = new McpServer({ name: 'flofi', title: 'FloFi', version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS + deploymentInstructions + (scope === 'ENGINEERING' ? '' : MCP_MAINNET_INSTRUCTIONS) });
  const now = ctx.now ?? (() => performance.now());
  const register = <S extends TSchema>(name: ToolName, title: string, description: string, schema: S, annotations: ToolAnnotations,
    run: (args: Static<S>) => Promise<Output> | Output, toolMeta: Record<string, unknown> = {}) => {
    const scope = TOOL_SCOPES[name];
    // OAuth clients read `securitySchemes` to know which scope to request before calling (ChatGPT reads the `_meta` mirror).
    const security = ctx.oauth ? { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] } : {};
    const meta = Object.keys(security).length || Object.keys(toolMeta).length ? { _meta: { ...security, ...toolMeta } } : {};
    server.registerTool(name, { title, description, inputSchema: standard<Static<S>>(schema), annotations: { title, ...annotations }, ...meta }, async (args: Static<S>): Promise<CallToolResult> => {
      const started = now();
      let result: CallToolResult, outcome = 'OK';
      try {
        if (!principalScopes(ctx.principal).includes(scope)) failWith('MCP_INSUFFICIENT_SCOPE');
        // BUILD-RH-002: a strategy naming Robinhood Chain composes against the validated official catalog (where this deployment enables it);
        // BUILD-BASE-001: so does one naming Base (its validated token list).
        if (args && typeof args === 'object' && 'strategy' in args) await prepareNetworkCatalogs((args as { strategy: unknown }).strategy, {
          ethereum: async () => ethereumAuthoringCatalog(await ctx.runtime.mode('ethereum-swap')),
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
          ? await presentation(visible.visual, visible, name === 'request_user_approval').catch(() => null) : null;
        const meta = { ...privateLinks && typeof approvalUrl === 'string' ? { 'flofi/approval': { approvalUrl, walletLinks } } : {}, ...presented?.meta };
        result = { content: [{ type: 'text', text: JSON.stringify(visible) }, ...presented?.content ?? []], structuredContent: visible,
          ...Object.keys(meta).length ? { _meta: meta } : {} };
      } catch (error) {
        outcome = error instanceof Error && CODE.test(error.message) ? mcpCode(error.message) : 'MCP_INTERNAL_ERROR';
        const body = { ok: false, code: outcome, ...error instanceof PlatformRefusal ? error.extra : {} };
        result = { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
      }
      ctx.onTool?.({ tool: name, outcome, durationMs: Math.round(now() - started) });
      return result;
    });
  };

  register('get_supported_networks', 'Supported networks', 'Networks FloFi can author strategies for, with CAIP-2 ids, network class and the actions available. ' +
    'Derived from FloFi\'s registries.', Schemas.none, pure, () => ({ ok: true, networks: supportedNetworks(scope) }));

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
          'Where the owner enrolled delegated Credentials and this deployment can sign delegated steps, ONE passkey authorization can cover the whole ' +
          'workflow instead (request_user_approval reports the authorizations each mode needs). One authorization is not one transaction and not zero gas.',
        bindings: 'A step may spend what an earlier step actually delivered: {step, amountFrom}; its own amount is then a cap. Resolved from reconciled ' +
          'received amounts in both confirm-each-step and delegated modes (min(cap, received)).' },
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
        executionPlan: { kind: plan.kind, reason: plan.reason }, visual,
        nextSteps: ['validate_strategy or review_strategy with this strategy and workflowHash', 'simulate_strategy for a read-only preview (optional)',
          'request_user_approval to hand it to its owner in FloFi (when available); nothing executes from MCP.'] };
    }
    const plan = workflowPlan(w);
    return { ok: true, strategy: w.strategy, workflowHash: w.workflowHash, fundsClass: w.fundsClass, stepCount: w.steps.length,
      executionPlan: { kind: plan.kind, reason: plan.reason, mode: 'STEP_BY_STEP', bindings: w.bindings.map(b => ({ step: b.step, amountFrom: b.amountFrom })) },
      workflowSteps: w.steps.map((c, index) => ({ index, action: c.strategy.action, strategy: c.strategy, workflowHash: c.workflowHash, revision: c.workflow.revision,
        fundsClass: c.fundsClass, workflow: c.workflow, steps: stepViews(c), summary: c.summary, explanation: c.explanation, flow: plan.steps[index]?.flow ?? null })),
      notes: w.notes, authority: AUTHORITY, visual,
      nextSteps: ['review_strategy for every step\'s findings', 'simulate_strategy one step at a time (pass that step as a version 1 strategy)',
        'request_user_approval to hand the whole workflow to its owner: it reports how many authorizations each mode needs. Each step runs only after the previous one reconciled.'] };
  });

  register('validate_strategy', 'Validate strategy', 'Check a strategy against FloFi\'s authoring rules (networks, assets, amounts, limits) and, when given, the workflowHash ' +
    'from compose_strategy (a mismatch means the strategy changed or FloFi\'s rules changed: compose again).', Schemas.bound, pure, args => {
    return { ok: true, ...validateStrategy(args.strategy, args.workflowHash, scope) };
  });

  register('review_strategy', 'Review strategy', 'FloFi\'s deterministic Strategy Review: linter findings, capability blockers for the network\'s public environment and ' +
    'strategy warnings, as BLOCK / WARNING / INFORMATION. It explains; it never approves or authorizes.', Schemas.bound, { ...pure, idempotentHint: false }, async args => {
    const w = composeWorkflowOrRefuse(args.strategy, args.workflowHash, scope), reviewed = reviewWorkflow(w);
    if (w.steps.length > 1) {
      const plan = workflowPlan(w);
      return { ok: true, workflowHash: w.workflowHash, reviewKind: 'DETERMINISTIC_STRATEGY_REVIEW', authority: AUTHORITY, stepCount: w.steps.length,
        summary: reviewed.summary, executionPlan: { kind: plan.kind, reason: plan.reason, mode: 'STEP_BY_STEP' }, workflowSteps: reviewed.steps,
        nextSteps: ['Each step gets a fresh simulation and the owner\'s Review in FloFi before it runs, in order, after the previous step reconciled.'] };
    }
    const c = w.steps[0]!, review = reviewed.steps[0]!, flow = strategyFlow(c.strategy);
    const mode = flow ? await ctx.runtime.mode(flow) : null;
    return { ok: true, workflowHash: c.workflowHash, reviewKind: 'DETERMINISTIC_STRATEGY_REVIEW', authority: AUTHORITY, environment: review.environment,
      summary: review.summary,
      findings: review.findings, capability: review.capability,
      deployment: { flow, mode: mode ?? 'UNKNOWN_IN_LOCAL_RUNTIME' },
      nextSteps: ['A fresh simulation (simulate_strategy previews it; the FloFi app runs the authoritative one).',
        'The owner reviews the route-bound Strategy Manifest in the FloFi app and signs with their own wallet. MCP cannot do either.'] };
  });

  register('simulate_strategy', 'Simulate strategy (read-only preview)', 'Run FloFi\'s own simulation for this exact workflow — live quotes, chain reads and transaction ' +
    'simulation where the flow supports it — as a read-only preview. Nothing is stored, nothing is signed or sent, and the result cannot be authorized. ' +
    '`simulationSubject` is only the account whose public balances the simulation reads. Calldata and transactions are never returned.',
  Schemas.simulate, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }, async args => {
    // BUILD-MCP-002: an OAuth account also has an hourly simulation budget (they reach public chains and providers).
    const account = ctx.principal.kind === 'mcp-oauth' ? ctx.principal.accountId : null, state = ctx.state;
    const { composition: c, plan, view, simulationSubject } = await simulatePreview(ctx.runtime, args, { scope, ...account && state
      ? { budget: () => state.oauth.allow(`simulate:account:${account}`, SIMULATIONS_PER_ACCOUNT_HOUR, 3_600, new Date()) } : {} });
    return { ok: true, workflowHash: c.workflowHash, flow: plan.flow, kind: view.kind, provenance: view.provenance, observedAt: view.observedAt, expiresAt: view.expiresAt,
      simulationSubject, subjectRole: 'SIMULATION_SUBJECT_ONLY_NOT_AN_OWNER_OR_AUTHORIZATION',
      preview: true, persisted: false, authorizable: false, evidenceLevel: view.provenance === 'MOCKED' ? 'MOCKED_SIMULATION_PREVIEW' : 'SIMULATION_PREVIEW_NOT_EXECUTION',
      facts: view.facts, canonicalArtifacts: view.canonicalArtifacts, authority: AUTHORITY,
      notes: ['Amounts are integer native units of the named tokens.', 'Quotes and state expire; the FloFi app re-simulates before any Review.',
        'A simulation is evidence of what would happen at the observed block, not a guarantee and not an execution.'] };
  });

  register('get_execution_status', 'Execution status', 'Status, attempts and journal page of one FloFi execution, read from FloFi\'s durable state. Visible only when its ' +
    'owner wallet is one the deployment owner granted to this MCP credential; otherwise it is reported as not found.', Schemas.status, { ...pure, idempotentHint: false }, async args => {
    const found = await findOwnedRun(ctx.runtime, ctx.principal.wallets, args.executionId);
    return { ok: true, ...await executionStatusView(ctx.runtime, found, args.executionId, accessBasis(ctx), { after: args.journalAfter, limit: args.journalLimit }),
      notes: ['FloFi\'s canonical durable state; a partner or agent display is only a projection of it.'] };
  });

  register('get_evidence', 'Execution evidence', 'The reconciled Evidence Bundle of one FloFi execution with its own environment (MOCKED, TESTNET_EXECUTED, …) and outcome, ' +
    'exactly as FloFi recorded them. Owner-scoped like get_execution_status.', Schemas.evidence, { ...pure, idempotentHint: false }, async args => {
    const found = await findOwnedRun(ctx.runtime, ctx.principal.wallets, args.executionId);
    const view = await evidenceView(ctx.runtime, found, args.executionId, accessBasis(ctx));
    return view.evidence ? { ok: true, ...view, notes: ['Environment and outcome are copied from the Evidence Bundle; MCP never upgrades them.'] } : { ok: true, ...view };
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
};
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
  const ui = ctx.ui ?? null, appOnly = { ui: { visibility: ['app'] } };

  register('request_user_approval', 'Request the owner\'s approval', 'Request approval for the exact composed strategy and workflowHash. The MCP App can present the existing signing surface inside chat when the host and wallet support it. ' +
    'FloFi re-composes and re-checks it, then returns an approval link with authority NONE. Nothing is authorized, signed or sent by this request: the owner must use the signing surface, ' +
    'connect their wallet if needed, check FloFi\'s fresh simulation and choose Authorize in wallet. Their own wallet confirmation is mandatory. Canvas is optional. ' +
    'First call compose_strategy and review_strategy. Quote only this successful tool result\'s public nonsecret approvalUrl verbatim (or show the FloFi panel); ' +
    'never invent an approval URL or ID. If this call fails or is unavailable, disclose it and provide no approval CTA. ' +
    'Mainnet may be disabled by policy. A multi-step workflow is one approval: tell the user how many authorizations `authorizationPlan` reports (one wallet ' +
    'confirmation per step, or ONE passkey authorization when delegated Credentials cover every step); each step runs only after the previous one reconciled. ' +
    'The same approvalUrl reopens the next step for the owner.', SCHEMAS[ctx.scope ?? networkScope()].request,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async args => {
    const result = await requestApproval(deps(), requester, args.strategy, args.workflowHash);
    if (!result.ok) return failWith(result.code, result.extra ?? {});
    // The picture of exactly the workflow the handoff holds: the same canonical composition, bound to the same hash.
    const visual = workflowVisualModel(composeWorkflowOrRefuse(args.strategy, result.value.workflowHash, ctx.scope ?? networkScope()));
    return { ok: true, ...result.value, visual, message: 'Use the FloFi MCP App to authorize in chat when your host and wallet support it. Connect your wallet, check the fresh simulation and choose Authorize in wallet. ' +
      'Confirm the exact transaction in your wallet. Opening the FloFi signing link is an optional external fallback, not in-chat completion. Canvas is optional. Nothing is executed until chain confirmation and reconciliation. Retrieve get_approval_status for shared status and the verified receipt URL.' };
  }, ui ? { ui: { resourceUri: ui.resourceUri }, 'openai/outputTemplate': ui.resourceUri, 'openai/toolInvocation/invoking': 'Preparing approval…',
    'openai/toolInvocation/invoked': 'Approval ready' } : {});

  register('get_approval_status', 'Approval status', 'The status of an approval request this account created: PENDING, CLAIMED, APPLIED, EXPIRED, SUPERSEDED, ' +
    'REVOKED or STALE. When the owner shares status, includes run status and the verified receipt URL after reconciliation. A multi-step approval also returns ' +
    '`workflowRun`: every step\'s state, the next action (e.g. OWNER_SIGNS_STEP: share the approvalUrl again), and — when the owner shares status — each step\'s ' +
    'transaction hashes, explorer links, reconciled amounts and evidence; HALTED means partially completed. Poll this tool when asked; no callback or push is promised. ' +
    'It never reveals the claiming wallet or authorizes anything.', ApprovalSchemas.byId, { ...pure, idempotentHint: false },
  async args => ({ ok: true, ...await approvalProgress(await owned(args.approvalId), ctx.runtime, state.handoffs, oauth.origin, state.workflowRuns) }));

  register('open_approval_session', 'Open FloFi approval', 'App-only: a fresh, short-lived FloFi link for this approval (for the signing window or a wallet ' +
    'in-app browser). The link only shows the proposal; it authorizes nothing.', ApprovalSchemas.byId, { readOnlyHint: false, destructiveHint: false,
    idempotentHint: false, openWorldHint: false }, async args => ({ ok: true, ...await openApprovalSession(deps(), requester, args.approvalId) }), appOnly);

  register('get_execution_progress', 'Execution progress', 'App-only: the approval\'s state and, when its owner shares it, the status of the runs started from it.',
    ApprovalSchemas.byId, { ...pure, idempotentHint: false }, async args => ({ ok: true, ...await approvalProgress(await owned(args.approvalId), ctx.runtime, state.handoffs, oauth.origin,
      state.workflowRuns) }), appOnly);
}
