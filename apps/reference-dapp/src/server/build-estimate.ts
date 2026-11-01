// SPDX-License-Identifier: AGPL-3.0-only
import { hashArtifactBytes, UNIVERSAL_QUOTE_SUBJECTS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import { JUPITER_SOLANA_MAINNET, ORCA_WHIRLPOOLS_DEVNET } from '@defi-workflow-engine/action-registry';
import { jupiterIntent, jupiterBuildQuery, parseJupiterBuild, simulateOrcaDevnetSwap } from '@defi-workflow-engine/reference-compiler';
import { cloudPreview } from './flow-runtime.ts';
import { quoteFailure } from './quote-failure.ts';
import { readBridgeBuildEstimate } from './bridge-build-estimate.ts';
import { isHostedDeployment } from './deployment.ts';
import type { readBridgeDiscovery } from './bridge-discovery.ts';
import type { FlowResult } from './cloud-api-client.ts';
import type { FlowName } from '../../backend/flows.ts';
import { NATIVE_ETH, publicSwapProfile } from '../domain/public-testnet-swap.ts';
import { cryptoSelectionOf } from '../domain/crypto-action-picker.ts';
import { simulationAmount } from '../domain/simulation-presentation.ts';
import type { BuildEstimateResult } from '../domain/build-estimate.ts';
import { createPublicSwapQuoteReader, type CatalogSwapRuntime, type Rpc } from './public-testnet-service.ts';
import { catalogNetworkOfChain, localCatalogNetworkMode, type CatalogNetworkId } from './catalog-networks.ts';
import { baseSepoliaSwapRpc, ethereumSepoliaSwapRpc } from './public-testnet-rpc.ts';
import { createSolanaRpc, solanaRpcOverride } from './solana-rpc.ts';
import { createJupiterHttp } from './jupiter-http.ts';
import { deploymentPriceSource } from '../automations/config.ts';
import type { PriceSource } from '../automations/price-source.ts';
import { priceAssetOf, usdAmount, type PriceAsset, type UsdEstimate } from '../domain/usd-estimate.ts';

type Env = Readonly<Record<string, string | undefined>>;
type QuoteReader = ReturnType<typeof createPublicSwapQuoteReader>;
// UX-007: per catalog network and mode, one reused read client, swap runtime and process-wide validated catalog (stable metadata that
// need not be rebuilt on every keystroke). Quote outputs are never cached here: every request reads the chain again.
const catalogReaders = new Map<string, QuoteReader>();
function catalogReader(id: CatalogNetworkId, mode: 'live' | 'harness', build: () => QuoteReader): QuoteReader {
  const key = `${id}:${mode}`;
  let reader = catalogReaders.get(key);
  if (!reader) { reader = build(); catalogReaders.set(key, reader); }
  return reader;
}

// BUILD-FIX-UX-001: the deployment's price source, built once per process (its Chainlink feed verification is cached per instance).
let processPrices: PriceSource | null | undefined;
const USD_WAIT_MS = 2_500;
type QuoteSide = { readonly symbol: string; readonly units: string; readonly decimals: number };
/**
 * USD equivalents of a MAINNET quote's two sides — each only for an asset the verified price source observes freshly (a stale, failed or
 * slow observation gives none). Bounded, so a price read never delays the token estimate itself.
 */
type PriceObservation = Awaited<ReturnType<PriceSource['observe']>> | null;
type Observe = (asset: PriceAsset) => Promise<PriceObservation>;
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: one price observation per asset per request, started as soon as the node names its assets, so the optional
 * USD read runs alongside the quote instead of after it. Display only; a failed or slow observation still gives no USD.
 */
function priceObserver(prices: PriceSource | null, now: Date, symbols: readonly (string | null | undefined)[]): Observe | null {
  if (!prices) return null;
  const started = new Map<PriceAsset, Promise<PriceObservation>>();
  const observe: Observe = asset => {
    let pending = started.get(asset);
    if (!pending) { pending = prices.observe(asset, now).catch(() => null); started.set(asset, pending); }
    return pending;
  };
  for (const symbol of symbols) { const asset = symbol ? priceAssetOf(symbol) : null; if (asset && prices.assets.includes(asset)) void observe(asset); }
  return observe;
}
async function usdOf(prices: PriceSource | null, now: Date, sides: readonly [QuoteSide, QuoteSide], observeAsset?: Observe | null): Promise<UsdEstimate | null> {
  if (!prices) return null;
  const assets = [...new Set(sides.map(side => priceAssetOf(side.symbol)).filter((asset): asset is PriceAsset => asset !== null && prices.assets.includes(asset)))];
  if (!assets.length) return null;
  const observe = observeAsset ?? ((asset: PriceAsset) => prices.observe(asset, now).catch(() => null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([Promise.all(assets.map(async asset => [asset, await observe(asset)] as const)),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), USD_WAIT_MS); })]).finally(() => clearTimeout(timer));
  const fresh = new Map((observed ?? []).flatMap(([asset, result]) => result?.ok ? [[asset, result.observation] as const] : []));
  const value = (side: QuoteSide) => { const o = fresh.get(priceAssetOf(side.symbol)!); return o ? usdAmount(side.units, side.decimals, o.priceUsd) : null; };
  const input = value(sides[0]), output = value(sides[1]), first = [...fresh.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0];
  return first && (input || output) ? { input, output, source: first.source, evidence: first.evidence, observedAt: first.observedAt } : null;
}

/** Adapter/profile selected reads; no execution store, session, Review, signature or submission port. */
async function readBuildEstimateValue(input: unknown, env: Env = process.env,
  seams: { rpc?: Rpc; http?: ReturnType<typeof createJupiterHttp>; now?: () => Date; catalog?: CatalogSwapRuntime; prices?: PriceSource | null;
    discover?: typeof readBridgeDiscovery; correlationId?: string; preview?: (flow: FlowName, args: readonly unknown[], options: Parameters<typeof cloudPreview>[2]) => Promise<FlowResult<unknown> | null> } = {}): Promise<BuildEstimateResult> {
  try {
    const prices = () => seams.prices !== undefined ? seams.prices : env === process.env ? processPrices === undefined ? processPrices = deploymentPriceSource(env) : processPrices : deploymentPriceSource(env);
    if (!input || typeof input !== 'object') throw Error('ESTIMATE_INVALID');
    const { workflow: raw, nodeId, owner, destinationWallet } = input as { workflow?: unknown; nodeId?: unknown; owner?: unknown; destinationWallet?: unknown };
    const workflow = validateArtifact('semantic-workflow', raw) as SemanticWorkflow;
    const node = workflow.nodes.find(n => n.nodeId === nodeId);
    if (!node) throw Error('ESTIMATE_UNSUPPORTED');
    const now = seams.now ?? (() => new Date());
    const workflowHash = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
    if (node.actionType === 'asset.bridge') return await readBridgeBuildEstimate(workflow, node.nodeId, workflowHash,
      typeof owner === 'string' ? owner : null, typeof destinationWallet === 'string' ? destinationWallet : null, env, now, seams.discover, seams.correlationId);
    if (node.actionType !== 'asset.swap.exact-input') throw Error('ESTIMATE_UNSUPPORTED');
    const profile = publicSwapProfile(node.chainId);
    if (isHostedDeployment(env) && (profile || node.chainId === ORCA_WHIRLPOOLS_DEVNET.chain)) throw Error('TEST_NETWORK_NOT_AVAILABLE');
    const uniswap = node.adapterConstraints.protocols.some(protocol => protocol === 'uniswap' || protocol === 'uniswap-v3');
    if (profile && uniswap) {
      const rpc = seams.rpc ?? (profile.chainId === 84532 ? baseSepoliaSwapRpc(env.GRYLOO_BASE_SEPOLIA_RPC_URL) : ethereumSepoliaSwapRpc(env.GRYLOO_ETHEREUM_SEPOLIA_RPC_URL));
      const q = await createPublicSwapQuoteReader(() => rpc, now)(workflow, 'read-only');
      const decimals = q.outputSymbol === 'USDC' ? 6 : 18;
      return { ok: true, estimate: { workflowHash, nodeId: node.nodeId, chain: profile.chainRef, provider: 'Uniswap V3',
        expected: simulationAmount(q.expectedOut, decimals)!, minimum: simulationAmount(q.minimumOut, decimals), symbol: q.outputSymbol,
        slippageBps: q.slippageBps, expiresAt: q.expiresAt } };
    }
    const catalogNetwork = uniswap ? catalogNetworkOfChain(node.chainId) : null;
    // USD is optional, including failure while constructing the configured price source. BUILD-FLOFI-EXECUTION-PERFORMANCE-001: its observations run
    // alongside the quote, and start only on a path that quotes a mainnet asset (after its network gates), right before that quote: never on a refused
    // or unsupported path, and never ahead of the gate that would refuse it.
    const observedAt = now();
    let observer: Observe | null = null;
    const startUsd = () => {
      if (observer) return;
      try { const selection = cryptoSelectionOf(node); observer = priceObserver(prices(), observedAt, [selection?.from, selection?.to]); } catch { observer = null; }
    };
    const quoteUsd = async (sides: readonly [QuoteSide, QuoteSide]) => { try { return await usdOf(prices(), observedAt, sides, observer); } catch { return null; } };
    const solanaMainnet = node.chainId === JUPITER_SOLANA_MAINNET.chain && node.adapterConstraints.protocols.includes('jupiter');
    if ((catalogNetwork || solanaMainnet) && (seams.preview || !seams.rpc && !seams.http)) {
      const flow = catalogNetwork ? catalogNetwork.flows.swap : 'jupiter-swap';
      const subject = typeof owner === 'string' ? owner : UNIVERSAL_QUOTE_SUBJECTS.SOLANA;
      startUsd();
      const preview = await (seams.preview ?? cloudPreview)(flow, catalogNetwork ? [workflow] : [workflow, subject],
        { env, timeoutMs: 30_000, maxAttempts: 1, ...solanaMainnet ? { purpose: 'QUOTE' as const } : {} });
      // A configured hosted runtime never falls back to development transports, even after a failed quote.
      if (preview !== null) {
        if (!preview.ok) return quoteFailure(new Error(preview.code), preview.correlationId);
        const record = preview.value as Record<string, unknown> | null;
        const q = (catalogNetwork ? record?.quote : record) as Record<string, unknown> | null;
        const amount = node.inputs.find(i => i.name === 'amount-in'), output = node.inputs.find(i => i.name === 'asset-out');
        const slip = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
        if (!q || amount?.kind !== 'QUANTITY' || output?.kind !== 'ASSET' || slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS') throw Error('ESTIMATE_RESPONSE_INVALID');
        const inRef = amount.value.asset, outRef = output.value;
        // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07): a catalog network's native ETH side (`nativeId`, no address) is quoted by the runtime
        // under its native sentinel. It matches only that sentinel, never WETH or another token; Solana sides are always mints.
        const expectedToken = (ref: typeof inRef) => 'address' in ref ? ref.address : catalogNetwork ? NATIVE_ETH : null;
        if (expectedToken(inRef) === null || expectedToken(outRef) === null) throw Error('ESTIMATE_RESPONSE_INVALID');
        const input = catalogNetwork ? { address: q.inputToken, decimals: q.inputDecimals, symbol: q.inputSymbol } : q.input as { mint?: unknown; decimals?: unknown; symbol?: unknown } | undefined;
        const out = catalogNetwork ? { address: q.outputToken, decimals: q.outputDecimals, symbol: q.outputSymbol } : q.output as { mint?: unknown; decimals?: unknown; symbol?: unknown } | undefined;
        const tokenAddress = (t: typeof input) => t && ('address' in t ? t.address : t.mint);
        const selection = cryptoSelectionOf(node);
        if (q.workflowHash !== workflowHash || q.nodeId !== node.nodeId || (catalogNetwork ? `eip155:${q.chainId}` : q.chain) !== node.chainId ||
          (catalogNetwork ? q.amountIn : q.amount) !== amount.value.amount || q.slippageBps !== slip.maximumBps || !input || !out ||
          tokenAddress(input) !== expectedToken(inRef) || tokenAddress(out) !== expectedToken(outRef) || input.decimals !== inRef.decimals || out.decimals !== outRef.decimals ||
          typeof input.symbol !== 'string' || typeof out.symbol !== 'string' || selection && (selection.from !== input.symbol || selection.to !== out.symbol) ||
          typeof q.expiresAt !== 'string' || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= now().getTime()) throw Error('ESTIMATE_RESPONSE_MISMATCH');
        const expected = q.expectedOut, minimum = q.minimumOut;
        if (typeof expected !== 'string' || typeof minimum !== 'string' || !/^[1-9][0-9]{0,77}$/.test(expected) || !/^[1-9][0-9]{0,77}$/.test(minimum) ||
          BigInt(minimum) > BigInt(expected) || BigInt(minimum) < BigInt(expected) * BigInt(10_000 - slip.maximumBps) / 10_000n) throw Error('ESTIMATE_MINIMUM_INVALID');
        const usd = await quoteUsd([{ symbol: input.symbol, units: amount.value.amount, decimals: inRef.decimals }, { symbol: out.symbol, units: expected, decimals: outRef.decimals }]);
        return { ok: true, estimate: { workflowHash, nodeId: node.nodeId, chain: node.chainId, provider: catalogNetwork ? 'Uniswap V3' : 'Jupiter',
          expected: simulationAmount(expected, outRef.decimals)!, minimum: simulationAmount(minimum, outRef.decimals), symbol: out.symbol,
          slippageBps: slip.maximumBps, expiresAt: q.expiresAt, usd } };
      }
    }
    if (env.NODE_ENV === 'production' && (catalogNetwork && localCatalogNetworkMode(catalogNetwork, env) === 'off' ||
      solanaMainnet && env.GRYLOO_JUPITER_HARNESS !== 'MOCKED_LOOPBACK_ONLY')) return quoteFailure(new Error('CLOUD_RUNTIME_NOT_CONFIGURED'));
    const catalogEstimate = async (): Promise<BuildEstimateResult> => {
      const mode = catalogNetwork ? localCatalogNetworkMode(catalogNetwork, env) : 'off';
      if (!catalogNetwork || mode === 'off') return quoteFailure(new Error(env.NODE_ENV === 'production' ? 'CLOUD_RUNTIME_NOT_CONFIGURED' : 'ESTIMATE_NETWORK_NOT_ENABLED'));
      const build = () => createPublicSwapQuoteReader(() => seams.rpc ?? catalogNetwork.rpc(mode, env), now,
        seams.catalog ?? catalogNetwork.swapRuntime(mode, env, catalogNetwork.catalogFor(mode)));
      const reader = env === process.env && !seams.rpc && !seams.catalog ? catalogReader(catalogNetwork.id, mode, build) : build();
      startUsd();
      const q = await reader(workflow, 'read-only');
      if (q.outputDecimals === undefined) return { ok: false, code: 'ESTIMATE_UNAVAILABLE' };
      const usd = q.environment === 'MAINNET' && q.inputDecimals !== undefined ? await quoteUsd( [{ symbol: q.inputSymbol, units: q.amountIn, decimals: q.inputDecimals },
        { symbol: q.outputSymbol, units: q.expectedOut, decimals: q.outputDecimals }]) : null;
      return { ok: true, estimate: { workflowHash, nodeId: node.nodeId, chain: node.chainId, provider: 'Uniswap V3',
        expected: simulationAmount(q.expectedOut, q.outputDecimals)!, minimum: simulationAmount(q.minimumOut, q.outputDecimals), symbol: q.outputSymbol,
        slippageBps: q.slippageBps, expiresAt: q.expiresAt, usd } };
    };
    // UX-007: catalog networks (Base, Arbitrum One, Robinhood Chain) quote through the one shared read-only swap quote reader that
    // Simulate uses, under the network's own deployment gate (off: no estimate). No owner binding, approval state or Review is produced.
    if (catalogNetwork) return await catalogEstimate();
    if (node.chainId === JUPITER_SOLANA_MAINNET.chain && typeof owner === 'string') {
      // The taker is an untrusted quote parameter only; this read never binds ownership or grants authority.
      const intent = jupiterIntent(workflow, owner), http = seams.http ?? createJupiterHttp(JUPITER_SOLANA_MAINNET.api + JUPITER_SOLANA_MAINNET.endpoint, env.JUPITER_API_KEY);
      startUsd();
      const q = parseJupiterBuild(await http(jupiterBuildQuery(intent)), intent, now().toISOString()).quote;
      const usd = await quoteUsd( [{ symbol: intent.input.symbol, units: intent.amount, decimals: intent.input.decimals },
        { symbol: intent.output.symbol, units: q.outAmount, decimals: intent.output.decimals }]);
      return { ok: true, estimate: { workflowHash, nodeId: node.nodeId, chain: node.chainId, provider: 'Jupiter',
        expected: simulationAmount(q.outAmount, intent.output.decimals)!, minimum: simulationAmount(q.otherAmountThreshold, intent.output.decimals),
        symbol: intent.output.symbol, slippageBps: intent.slippageBps, expiresAt: new Date(now().getTime() + 30_000).toISOString(), usd } };
    }
    if (node.chainId === ORCA_WHIRLPOOLS_DEVNET.chain && typeof owner === 'string') {
      const rpc = seams.rpc ?? createSolanaRpc(solanaRpcOverride(env.GRYLOO_SOLANA_DEVNET_RPC_URL, 'DEVNET_SWAP_RPC_URL_INVALID') ?? ORCA_WHIRLPOOLS_DEVNET.rpc, false);
      const review = await simulateOrcaDevnetSwap(workflow, owner, async (method, params) => {
        if (!['getGenesisHash', 'getMultipleAccounts', 'getLatestBlockhash', 'simulateTransaction'].includes(method)) throw Error('ESTIMATE_READ_METHOD_DENIED');
        return rpc(method, params);
      }, now().getTime());
      return { ok: true, estimate: { workflowHash, nodeId: node.nodeId, chain: node.chainId, provider: 'Orca Whirlpools',
        expected: simulationAmount(review.quote.outAmount, review.output.decimals)!, minimum: simulationAmount(review.quote.otherAmountThreshold, review.output.decimals),
        symbol: review.output.symbol, slippageBps: review.slippageBps, expiresAt: review.expiresAt } };
    }
    return { ok: false, code: 'ESTIMATE_UNSUPPORTED' };
  } catch (cause) { return quoteFailure(cause); }
}

/** Quote a selected node's declared quantity; retain the full composition as the response binding, never as execution authority. */
export async function readBuildEstimate(input: unknown, env: Env = process.env, seams: Parameters<typeof readBuildEstimateValue>[2] = {}): Promise<BuildEstimateResult> {
  try {
    if (!input || typeof input !== 'object') return await readBuildEstimateValue(input, env, seams);
    const value = input as { workflow?: unknown; nodeId?: unknown };
    const workflow = validateArtifact('semantic-workflow', value.workflow) as SemanticWorkflow;
    const node = workflow.nodes.find(n => n.nodeId === value.nodeId);
    if (!node || node.actionType !== 'asset.swap.exact-input' || workflow.nodes.length === 1 && !node.dependencies.length && !workflow.resourceEdges.length)
      return await readBuildEstimateValue(input, env, seams);
    if (node.inputs.some(i => i.kind === 'OUTPUT_REFERENCE')) return quoteFailure(new Error('ESTIMATE_DEPENDENCY_UNRESOLVED'), seams.correlationId);
    const projection = { ...workflow, nodes: [{ ...node, dependencies: [] }], resourceEdges: [] };
    const result = await readBuildEstimateValue({ ...input, workflow: projection }, env, seams);
    return result.ok ? { ...result, estimate: { ...result.estimate,
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))) } } : result;
  } catch (cause) { return quoteFailure(cause, seams.correlationId); }
}
