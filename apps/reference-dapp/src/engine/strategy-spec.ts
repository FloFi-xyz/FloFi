// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: the typed strategy contract of the deterministic engine facade (`strategy-engine.ts`).
 *
 * A strategy spec is structured intent — action, network names, asset symbols or whole catalog names, decimal amounts and the user's own
 * parameters. It never carries a chain id, contract or token address, adapter, calldata, nonce, signature or key: FloFi
 * resolves every network and asset to its registered profile, exactly as chat and canvas authoring do. The schema is
 * closed (no additional properties anywhere) and versioned (`version: 1`); a client carries the spec between calls and
 * FloFi re-derives the canonical Semantic Workflow IR from it each time.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Ajv, type ErrorObject } from 'ajv';

/** Networks by stable MCP identifier. Chain ids come from the registries (see `capability-catalog.ts`). */
/** BUILD-RH-002: `robinhood` is Robinhood Chain mainnet (4663, real funds); its assets are the official catalog's (USDG, WETH, Stock Tokens).
 *  BUILD-BASE-001: `base` is Base mainnet (8453, real funds), likewise a catalog network (pinned ETH/USDC/WETH plus the validated token list). */
export const NETWORK_IDS = ['base', 'base-sepolia', 'arbitrum-one', 'ethereum', 'arbitrum-sepolia', 'ethereum-sepolia', 'solana', 'solana-devnet', 'robinhood', 'robinhood-testnet'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the test networks. The engine composes them (CI and engineering certification), but the public product's
 * schema never offers them and every public surface refuses them (`platform/strategy.ts`, `domain/network-scope.ts`).
 */
export const TEST_NETWORK_IDS: readonly NetworkId[] = Object.freeze(['base-sepolia', 'arbitrum-sepolia', 'ethereum-sepolia', 'solana-devnet', 'robinhood-testnet']);
/** The networks a public client may name: every mainnet, in `NETWORK_IDS` order. */
export const PUBLIC_NETWORK_IDS: readonly NetworkId[] = Object.freeze(NETWORK_IDS.filter(id => !TEST_NETWORK_IDS.includes(id)));
export const STRATEGY_ACTIONS = ['bridge', 'swap', 'supply', 'borrow', 'repay', 'withdraw', 'add_liquidity', 'lending_composition', 'transfer'] as const;
export type StrategyAction = (typeof STRATEGY_ACTIONS)[number];
/** The public actions: the lending composition exists only on Base Sepolia, so the Mainnet-only product has none. */
export const PUBLIC_STRATEGY_ACTIONS: readonly StrategyAction[] = Object.freeze(STRATEGY_ACTIONS.filter(action => action !== 'lending_composition'));
export const ASSET_SYMBOLS = ['USDC', 'WETH', 'WBTC', 'SOL', 'USDT', 'devUSDC'] as const;
/** `devUSDC` is the Solana Devnet test token. */
const PUBLIC_ASSET_SYMBOLS = ASSET_SYMBOLS.filter(symbol => symbol !== 'devUSDC');

const enumOf = <T extends readonly string[]>(values: T, description: string) =>
  Type.Union(values.map(value => Type.Literal(value)) as never, { description }) as unknown as TSchema & { static: T[number] };
const Decimal = (description: string) => Type.String({ pattern: '^(0|[1-9][0-9]{0,29})(\\.[0-9]{1,18})?$', maxLength: 48, description });
const EvmAddress = (description: string) => Type.String({ pattern: '^0x[0-9a-fA-F]{40}$', minLength: 42, maxLength: 42, description });
/** BUILD-SOLANA-TRANSFER-UX-001: a base58 Solana public key (case-sensitive); decoded to exactly 32 bytes at composition. */
const SolanaAddress = (description: string) => Type.String({ pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$', minLength: 32, maxLength: 44, description });
const Slippage = Type.Integer({ minimum: 0, maximum: 10_000, description: 'Maximum slippage in basis points. Omit to use FloFi\'s documented default for the action; each action enforces its own maximum.' });
const Version = Type.Literal(1, { description: 'Strategy contract version. Omit or 1.' });
/**
 * An asset symbol or whole name resolves only in the selected network's validated catalog at composition.
 * Unknown, ambiguous, unloaded and foreign-chain references are refused, never guessed. Never an address.
 */
const CatalogSymbol = Type.String({ pattern: '^(?!0[xX][0-9a-fA-F])[^\\x00-\\x1f\\x7f]{1,160}$', maxLength: 160,
  description: 'A symbol or whole name of the selected network\'s validated official catalog, matched case-insensitively; unknown, ambiguous and foreign-chain references are refused. Never a contract address.' });
const strict = { additionalProperties: false } as const;

const Bridge = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('bridge'),
  sourceNetwork: enumOf(['base-sepolia', 'base', 'arbitrum-one', 'robinhood', 'ethereum'] as const, 'Source network. base-sepolia pairs with arbitrum-sepolia (test USDC); base and ' +
    'arbitrum-one pair both ways (real funds); base or arbitrum-one USDC bridges into robinhood as USDG, and robinhood USDG bridges out to base or arbitrum-one as USDC (real funds).'),
  destinationNetwork: enumOf(['arbitrum-sepolia', 'arbitrum-one', 'robinhood', 'base', 'ethereum'] as const, 'Destination network; only the pairs above are supported.'),
  asset: CatalogSymbol,
  amount: Decimal('Source token amount as a decimal string, e.g. "5".'),
  routing: Type.Optional(enumOf(['auto', 'lifi', 'across'] as const, 'Provider policy. auto = LI.FI first, direct Across if LI.FI has no reconcilable route (a preference order, not a best-price search). Default auto.')),
  slippageBps: Type.Optional(Slippage),
  recipient: Type.Optional(EvmAddress('Destination recipient. Omit to deliver to the wallet that signs in the FloFi app (bound at Review).')),
}, strict);
const Swap = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('swap'),
  network: enumOf(['base', 'base-sepolia', 'ethereum-sepolia', 'solana', 'solana-devnet', 'robinhood', 'arbitrum-one', 'ethereum'] as const,
    'Swap network. Assets, protocols and runtime support are validated against the shared registries; mainnet uses real funds.'),
  inputAsset: Type.Union([enumOf(ASSET_SYMBOLS, 'Asset spent.'), CatalogSymbol]), outputAsset: Type.Union([enumOf(ASSET_SYMBOLS, 'Asset received.'), CatalogSymbol]),
  amount: Decimal('Exact input amount as a decimal string.'), slippageBps: Type.Optional(Slippage),
}, strict);
const Lending = (action: 'supply' | 'borrow' | 'repay', who: string) => Type.Object({
  version: Type.Optional(Version), action: Type.Literal(action),
  network: enumOf(['base-sepolia', 'ethereum-sepolia', 'base', 'arbitrum-one', 'ethereum'] as const, 'Aave V3 network: base-sepolia lends test USDC, ethereum-sepolia lends test WBTC, base and arbitrum-one lend native USDC (real funds).'),
  asset: CatalogSymbol,
  amount: Decimal('Amount as a decimal string.'),
  beneficiary: EvmAddress(who),
}, strict);
const Withdraw = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('withdraw'),
  network: enumOf(['base-sepolia', 'ethereum-sepolia', 'base', 'arbitrum-one', 'ethereum'] as const, 'Aave V3 network (base and arbitrum-one: real funds).'), asset: CatalogSymbol,
  amount: Decimal('Amount as a decimal string. The recipient is always the wallet that signs.'),
}, strict);
const Bound = Type.String({ pattern: '^-?(0|[1-9][0-9]{0,29})(\\.[0-9]{1,18})?$', maxLength: 48 });
const Liquidity = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('add_liquidity'),
  network: enumOf(['base-sepolia', 'ethereum-sepolia', 'solana', 'solana-devnet', 'robinhood', 'base', 'arbitrum-one', 'ethereum'] as const, 'Uniswap v3 USDC/WETH on base-sepolia or ethereum-sepolia; Orca ' +
    'SOL/USDC on solana (real funds), SOL/devUSDC on solana-devnet; on catalog networks, Uniswap v3 on two catalog ERC-20 assets at feeTier (real funds), only when the factory pool exists.'),
  maxAmounts: Type.Record(CatalogSymbol, Decimal('Maximum deposit of this asset.'),
    { minProperties: 2, maxProperties: 2, description: 'Maximum deposit of each pool asset (limits, not amounts to spend); exactly the pool\'s two assets by symbol or whole catalog name: ' +
      'USDC and WETH, SOL and devUSDC, or two official catalog symbols on a supported catalog network.' }),
  range: Type.Union([
    Type.Object({ unit: enumOf(['price', 'tick'] as const, 'price: quote per base asset (USDC per WETH, devUSDC per SOL); tick: aligned tick indexes.'),
      lower: Bound, upper: Bound }, strict),
    Type.Object({ unit: Type.Literal('full', { description: 'Catalog networks: the widest usable range of the selected fee tier.' }) }, strict)]),
  feeTier: Type.Optional(Type.Union([Type.Literal(100), Type.Literal(500), Type.Literal(3000), Type.Literal(10000)],
    { description: 'Catalog networks: the Uniswap v3 fee tier in hundredths of a basis point (3000 = 0.3%). Default 3000; a missing pool is refused.' })),
  slippageBps: Type.Optional(Slippage),
}, strict);
const LendingComposition = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('lending_composition'),
  network: Type.Literal('base-sepolia', { description: 'The composition runs on Base Sepolia only.' }),
  asset: Type.Literal('USDC', { description: 'Supplied and borrowed asset (Aave V3 test USDC).' }),
  supplyAmount: Decimal('USDC supplied to Aave.'), borrowAmount: Decimal('USDC borrowed from Aave; exactly this amount is swapped.'),
  outputAsset: Type.Literal('WETH', { description: 'The borrowed USDC is swapped to WETH on Uniswap v3.' }),
  slippageBps: Type.Optional(Slippage),
  owner: EvmAddress('The wallet that supplies, borrows and receives WETH. Debt remains after the swap.'),
}, strict);

/** BUILD-RH-002: a transfer on Robinhood Chain (real funds): native ETH or an official catalog asset, to the signing wallet or a recipient. BUILD-BASE-001: and Base. */
const Transfer = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('transfer'),
  network: enumOf(['robinhood', 'base', 'arbitrum-one', 'ethereum', 'solana', 'solana-devnet', 'ethereum-sepolia', 'robinhood-testnet'] as const, 'The network of this same-chain transfer. ' +
    'robinhood, base, arbitrum-one, ethereum and solana move real funds; solana-devnet moves valueless test tokens. ethereum-sepolia and robinhood-testnet support native test-ETH self-transfers only.'),
  asset: Type.Union([Type.Literal('ETH'), Type.Literal('SOL'), CatalogSymbol], { description: 'EVM: native ETH, or a symbol or whole name of the selected network\'s ' +
    'validated official catalog. Solana: SOL, USDC or USDT (solana-devnet: SOL or devUSDC), or an SPL token mint address together with decimals and tokenProgram.' }),
  amount: Decimal('Amount as a decimal string.'),
  recipient: Type.Optional(Type.Union([EvmAddress('EVM recipient.'), SolanaAddress('Solana recipient wallet address.')], { description: 'Recipient. EVM: omit to transfer ' +
    'to the wallet that signs in the FloFi app (bound at Review). Solana: required — the destination wallet; FloFi never substitutes the signing wallet.' })),
  decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 18, description: 'Solana SPL mint transfers only: the token\'s decimals (verified on chain).' })),
  tokenProgram: Type.Optional(enumOf(['spl-token', 'token-2022'] as const, 'Solana SPL mint transfers only: the token program (verified on chain).')),
}, strict);
const BRANCHES = Object.freeze({ bridge: Bridge, swap: Swap, supply: Lending('supply', 'Account credited with the supplied position.'),
  borrow: Lending('borrow', 'Account whose debt the borrow creates (onBehalfOf).'), repay: Lending('repay', 'Account whose debt is repaid (onBehalfOf).'),
  withdraw: Withdraw, add_liquidity: Liquidity, lending_composition: LendingComposition, transfer: Transfer }) satisfies Readonly<Record<StrategyAction, TSchema>>;
export const StrategySpecSchema = Type.Union(Object.values(BRANCHES), { description: 'A FloFi strategy: structured intent only. FloFi maps it to registered profiles.' });
export type StrategySpec = Static<typeof StrategySpecSchema>;

/**
 * BUILD-MCP-002: the step-list contract (`version: 2`). A workflow is an ordered list of 1–8 steps, each a single-action strategy.
 * One step is exactly the v1 strategy (same normalization, same workflow hash): a single transaction is a one-step workflow.
 * Each step keeps its own isolated IR (FloFi's authoring rules keep every publicly executable capability alone in its workflow);
 * the workflow hash of several steps covers their ordered step hashes. Which sequences execute is an execution-plan fact (BUILD-CHAT-E2E-001:
 * `SEQUENTIAL`, run step by step by a workflow run), never a schema change.
 */
export const MAX_WORKFLOW_STEPS = 8;
/**
 * BUILD-CHAT-E2E-001: a typed dependency between two steps. The step's own amount becomes a cap; the amount used is
 * min(cap, the actual reconciled amount of the step's input asset that the earlier step delivered to the owner).
 */
export const WorkflowBindingSchema = Type.Object({
  step: Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_STEPS - 1, description: 'The dependent step (0-based index). Its amount is a cap.' }),
  amountFrom: Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_STEPS - 2, description: 'An earlier step (0-based index) whose actual reconciled output of the ' +
    'dependent step\'s input asset funds it: min(cap, received). Never an estimate.' }),
}, strict);
export const StrategyWorkflowSchema = Type.Object({
  version: Type.Literal(2, { description: 'Step-list workflow contract.' }),
  steps: Type.Array(Type.Union(Object.values(BRANCHES)), { minItems: 1, maxItems: MAX_WORKFLOW_STEPS,
    description: 'Ordered steps, each one single-action strategy (the same objects as version 1). Executed in this order; each step starts only after the previous one reconciled.' }),
  bindings: Type.Optional(Type.Array(WorkflowBindingSchema, { minItems: 1, maxItems: MAX_WORKFLOW_STEPS - 1,
    description: 'Optional typed dependencies: a step spends what an earlier step actually delivered (capped by its own amount). The input asset must be exactly the earlier step\'s output token.' })),
}, strict);
export type StrategyWorkflow = Static<typeof StrategyWorkflowSchema>;
/** What a client may send: a v1 single-action strategy or a v2 step list. */
export const StrategyInputSchema = Type.Union([...Object.values(BRANCHES), StrategyWorkflowSchema],
  { description: 'A FloFi strategy (version 1, one action) or workflow (version 2, ordered steps): structured intent only.' });
export type StrategyInput = StrategySpec | StrategyWorkflow;
export const isStrategyWorkflow = (value: StrategyInput): value is StrategyWorkflow => (value as { version?: unknown }).version === 2;

/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the same contract as the public product offers it (MCP tools, the Developer API): the identical fields and
 * rules, with every network a mainnet (real funds). A public strategy is always a valid strategy of the full contract, so it composes to the
 * same canonical IR and workflow hash; the test networks and the Base Sepolia lending composition are simply not offered.
 */
const PUBLIC_EVM_LENDING = ['base', 'arbitrum-one', 'ethereum'] as const;
const PublicBridge = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('bridge'),
  sourceNetwork: enumOf(['base', 'arbitrum-one', 'robinhood', 'ethereum'] as const, 'Source network (real funds). The Cross-chain Router moves USDC between base, ' +
    'arbitrum-one and ethereum, and into or out of robinhood as USDG (WETH also bridges to and from robinhood); get_capabilities lists the routes this deployment enables.'),
  destinationNetwork: enumOf(['arbitrum-one', 'robinhood', 'base', 'ethereum'] as const, 'Destination network; a different network of the same route list.'),
  asset: CatalogSymbol,
  amount: Decimal('Source token amount as a decimal string, e.g. "5".'),
  routing: Type.Optional(enumOf(['auto', 'lifi', 'across'] as const, 'Provider policy. auto = LI.FI first, direct Across if LI.FI has no reconcilable route (a preference order, not a best-price search). Default auto.')),
  slippageBps: Type.Optional(Slippage),
  recipient: Type.Optional(EvmAddress('Destination recipient. Omit to deliver to the wallet that signs in the FloFi app (bound at Review).')),
}, strict);
const PublicSwap = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('swap'),
  network: enumOf(['base', 'solana', 'robinhood', 'arbitrum-one', 'ethereum'] as const,
    'Swap network (real funds). Assets, protocols and runtime support are validated against the shared registries.'),
  inputAsset: Type.Union([enumOf(PUBLIC_ASSET_SYMBOLS, 'Asset spent.'), CatalogSymbol]), outputAsset: Type.Union([enumOf(PUBLIC_ASSET_SYMBOLS, 'Asset received.'), CatalogSymbol]),
  amount: Decimal('Exact input amount as a decimal string.'), slippageBps: Type.Optional(Slippage),
}, strict);
const PublicLending = (action: 'supply' | 'borrow' | 'repay', who: string) => Type.Object({
  version: Type.Optional(Version), action: Type.Literal(action),
  network: enumOf(PUBLIC_EVM_LENDING, 'Aave V3 network (real funds): native USDC on base, arbitrum-one and ethereum.'),
  asset: CatalogSymbol,
  amount: Decimal('Amount as a decimal string.'),
  beneficiary: EvmAddress(who),
}, strict);
const PublicWithdraw = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('withdraw'),
  network: enumOf(PUBLIC_EVM_LENDING, 'Aave V3 network (real funds).'), asset: CatalogSymbol,
  amount: Decimal('Amount as a decimal string. The recipient is always the wallet that signs.'),
}, strict);
const PublicLiquidity = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('add_liquidity'),
  network: enumOf(['solana', 'robinhood', 'base', 'arbitrum-one', 'ethereum'] as const, 'Real funds. Orca SOL/USDC on solana; on the catalog networks (base, arbitrum-one, ' +
    'ethereum, robinhood), Uniswap v3 on two catalog ERC-20 assets at feeTier, only when the factory pool exists.'),
  maxAmounts: Type.Record(CatalogSymbol, Decimal('Maximum deposit of this asset.'),
    { minProperties: 2, maxProperties: 2, description: 'Maximum deposit of each pool asset (limits, not amounts to spend); exactly the pool\'s two assets by symbol or whole catalog name: ' +
      'SOL and USDC on solana, or two official catalog symbols on a catalog network.' }),
  range: Type.Union([
    Type.Object({ unit: enumOf(['price', 'tick'] as const, 'price: USDC per SOL (solana only); tick: aligned tick indexes.'),
      lower: Bound, upper: Bound }, strict),
    Type.Object({ unit: Type.Literal('full', { description: 'Catalog networks: the widest usable range of the selected fee tier.' }) }, strict)]),
  feeTier: Type.Optional(Type.Union([Type.Literal(100), Type.Literal(500), Type.Literal(3000), Type.Literal(10000)],
    { description: 'Catalog networks: the Uniswap v3 fee tier in hundredths of a basis point (3000 = 0.3%). Default 3000; a missing pool is refused.' })),
  slippageBps: Type.Optional(Slippage),
}, strict);
const PublicTransfer = Type.Object({
  version: Type.Optional(Version), action: Type.Literal('transfer'),
  network: enumOf(['robinhood', 'base', 'arbitrum-one', 'ethereum', 'solana'] as const, 'The network of this same-chain transfer (real funds).'),
  asset: Type.Union([Type.Literal('ETH'), Type.Literal('SOL'), CatalogSymbol], { description: 'EVM: native ETH, or a symbol or whole name of the selected network\'s ' +
    'validated official catalog. Solana: SOL, USDC or USDT, or an SPL token mint address together with decimals and tokenProgram.' }),
  amount: Decimal('Amount as a decimal string.'),
  recipient: Type.Optional(Type.Union([EvmAddress('EVM recipient.'), SolanaAddress('Solana recipient wallet address.')], { description: 'Recipient. EVM: omit to transfer ' +
    'to the wallet that signs in the FloFi app (bound at Review). Solana: required — the destination wallet; FloFi never substitutes the signing wallet.' })),
  decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 18, description: 'Solana SPL mint transfers only: the token\'s decimals (verified on chain).' })),
  tokenProgram: Type.Optional(enumOf(['spl-token', 'token-2022'] as const, 'Solana SPL mint transfers only: the token program (verified on chain).')),
}, strict);
const PUBLIC_BRANCHES = Object.freeze({ bridge: PublicBridge, swap: PublicSwap, supply: PublicLending('supply', 'Account credited with the supplied position.'),
  borrow: PublicLending('borrow', 'Account whose debt the borrow creates (onBehalfOf).'), repay: PublicLending('repay', 'Account whose debt is repaid (onBehalfOf).'),
  withdraw: PublicWithdraw, add_liquidity: PublicLiquidity, transfer: PublicTransfer });
export const PublicStrategyWorkflowSchema = Type.Object({
  version: Type.Literal(2, { description: 'Step-list workflow contract.' }),
  steps: Type.Array(Type.Union(Object.values(PUBLIC_BRANCHES)), { minItems: 1, maxItems: MAX_WORKFLOW_STEPS,
    description: 'Ordered steps, each one single-action strategy (the same objects as version 1). Executed in this order; each step starts only after the previous one reconciled.' }),
  bindings: Type.Optional(Type.Array(WorkflowBindingSchema, { minItems: 1, maxItems: MAX_WORKFLOW_STEPS - 1,
    description: 'Optional typed dependencies: a step spends what an earlier step actually delivered (capped by its own amount). The input asset must be exactly the earlier step\'s output token.' })),
}, strict);
/** What a public client may send: a mainnet v1 strategy or v2 step list. */
export const PublicStrategyInputSchema = Type.Union([...Object.values(PUBLIC_BRANCHES), PublicStrategyWorkflowSchema],
  { description: 'A FloFi strategy (version 1, one action) or workflow (version 2, ordered steps) on mainnets (real funds): structured intent only.' });

const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, ownProperties: true });
/** A schema violation as a path and a rule; never the offending value. */
export type SchemaIssue = { readonly path: string; readonly rule: string };
// An unexpected key is named only when it looks like a plain field name, so a secret pasted as a key is never echoed.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
function issueOf(error: ErrorObject): SchemaIssue {
  // `additionalProperty` comes from the input (named only when it looks like a field); `missingProperty` comes from the schema.
  const key = error.keyword === 'additionalProperties' ? (error.params as { additionalProperty?: unknown }).additionalProperty
    : error.keyword === 'required' ? (error.params as { missingProperty?: unknown }).missingProperty : undefined;
  return { path: (error.instancePath || '') + (typeof key === 'string' && FIELD_NAME.test(key) ? `/${key}` : '') || '/', rule: error.keyword };
}
const unique = (issues: readonly SchemaIssue[]) => [...new Map(issues.map(i => [`${i.path}\0${i.rule}`, i])).values()];
/** One compiled validator per schema object, shared by the facade and the MCP tool adapters. */
export function compileSchema<T>(schema: TSchema): { readonly check: (value: unknown) => value is T; readonly issues: (value: unknown) => readonly SchemaIssue[] } {
  const validate = ajv.compile<T>(schema);
  return { check: (value): value is T => validate(value), issues: value => validate(value) ? [] : unique((validate.errors ?? []).map(issueOf)) };
}
const union = compileSchema<StrategySpec>(StrategySpecSchema);
const inputUnion = compileSchema<StrategyInput>(StrategyInputSchema);
const branches = Object.fromEntries(Object.entries(BRANCHES).map(([action, schema]) => [action, compileSchema<StrategySpec>(schema)])) as
  Readonly<Record<StrategyAction, ReturnType<typeof compileSchema<StrategySpec>>>>;
export const isStrategySpec = union.check;
/** Every violation of a strategy spec, reported against its own action's schema (not the whole union). */
export function strategySpecIssues(value: unknown): readonly SchemaIssue[] {
  if (union.check(value)) return [];
  const action = value && typeof value === 'object' && !Array.isArray(value) ? (value as { action?: unknown }).action : undefined;
  if (typeof action !== 'string' || !Object.hasOwn(branches, action)) return [{ path: '/action', rule: 'enum' }];
  return branches[action as StrategyAction].issues(value);
}

export const isStrategyInput = inputUnion.check;
/** Every violation of a v1 strategy or a v2 workflow; a step is reported against its own action's schema at `/steps/<i>`. */
export function strategyInputIssues(value: unknown): readonly SchemaIssue[] {
  if (inputUnion.check(value)) return [];
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as { version?: unknown; steps?: unknown } : null;
  if (record?.version !== 2) return strategySpecIssues(value);
  const extra = Object.keys(record).filter(k => k !== 'version' && k !== 'steps' && k !== 'bindings');
  if (extra.length) return [{ path: '/', rule: 'additionalProperties' }];
  if (!Array.isArray(record.steps)) return [{ path: '/steps', rule: 'type' }];
  if (record.steps.length < 1 || record.steps.length > MAX_WORKFLOW_STEPS) return [{ path: '/steps', rule: record.steps.length < 1 ? 'minItems' : 'maxItems' }];
  const steps = record.steps.flatMap((step, i) => strategySpecIssues(step).map(issue => ({ path: `/steps/${i}` + (issue.path === '/' ? '' : issue.path), rule: issue.rule })));
  const raw = (record as { bindings?: unknown }).bindings;
  if (raw === undefined) return steps;
  if (!Array.isArray(raw)) return [...steps, { path: '/bindings', rule: 'type' }];
  if (raw.length < 1 || raw.length > MAX_WORKFLOW_STEPS - 1) return [...steps, { path: '/bindings', rule: raw.length < 1 ? 'minItems' : 'maxItems' }];
  return [...steps, ...raw.flatMap((b, i) => bindingIssues(b).map(issue => ({ path: `/bindings/${i}` + (issue.path === '/' ? '' : issue.path), rule: issue.rule })))];
}
const binding = compileSchema<Static<typeof WorkflowBindingSchema>>(WorkflowBindingSchema);
const bindingIssues = (value: unknown): readonly SchemaIssue[] => binding.issues(value);
