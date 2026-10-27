// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: route discovery — every routing provider asked about one pair, every answer classified honestly.
 *
 *  EXECUTABLE               a live route FloFi verified and can execute: the universal router (Relay's Depository, verified byte for
 *                           byte) or the certified BUILD-ROUTER-001 Router (its USDC/USDG pairs through Across).
 *  LIVE_QUOTE               a live provider quote FloFi cannot execute yet (the reason is stated: no independent verifier for that
 *                           bridge's transactions, or a step shape FloFi refuses).
 *  SUPPORTED_BY_PROVIDER    the provider lists the route but returned no quote for this amount (minimums, limits).
 *  TEMPORARILY_UNAVAILABLE  the provider could not be reached or rate-limited us.
 *  NO_ROUTE                 the provider has no compatible bridge or liquidity for the pair.
 *
 * Discovery is read-only and informational: execution re-quotes, re-verifies and simulates everything (service.ts). Quotes need
 * addresses; without a connected wallet, fixed public quote subjects are used (no key exists for either), and the Review always
 * re-quotes for the real owner and recipient.
 */
import { UNIVERSAL_NETWORKS, UNIVERSAL_QUOTE_SUBJECTS, type UniversalNetwork, type UniversalRoutingProvider, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { UNIVERSAL_ROUTER_DEPLOYMENT } from '@defi-workflow-engine/action-registry';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { providerHttpError, providerRefusalCode, type UniversalHttp } from './http.ts';
import { normalizeRelayQuote, relayCurrency, relayQuoteBody, relayRefusal, RELAY_API, type UniversalQuoteRequest } from './relay-provider.ts';

export type DiscoveryStatus = 'EXECUTABLE' | 'LIVE_QUOTE' | 'SUPPORTED_BY_PROVIDER' | 'TEMPORARILY_UNAVAILABLE' | 'NO_ROUTE' | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'INSUFFICIENT_LIQUIDITY' | 'INTERNAL_ERROR';
export type DiscoveryFee = { readonly label: string; readonly amount: string; readonly symbol: string; readonly decimals: number; readonly included: boolean; readonly chainId: string };
export type DiscoveryCandidate = {
  readonly provider: UniversalRoutingProvider; readonly bridge: string; readonly status: DiscoveryStatus;
  readonly executableBy: 'UNIVERSAL_ROUTER' | 'CERTIFIED_ROUTER' | null;
  readonly expectedOutput: string | null; readonly minimumOutput: string | null; readonly estimatedDurationSeconds: number | null;
  readonly fees: readonly DiscoveryFee[]; readonly reason: string | null; readonly quoteId: string | null; readonly expiresAt?: string };
export type DiscoveryRequest = { readonly source: UniversalNetwork; readonly destination: UniversalNetwork; readonly inputToken: UniversalToken; readonly outputToken: UniversalToken;
  readonly amount: string; readonly slippageBps: number; readonly owner?: string; readonly recipient?: string; readonly inputTokenProgram?: string | null };
export type DiscoveryResult = { readonly format: 'flofi.universal-discovery.v1'; readonly sourceChain: string; readonly destinationChain: string;
  readonly inputToken: UniversalToken; readonly outputToken: UniversalToken; readonly amount: string; readonly observedAt: string;
  readonly quoteSubjects: 'OWNER' | 'PUBLIC_QUOTE_SUBJECT'; readonly candidates: readonly DiscoveryCandidate[];
  /** Index of the executable candidate with the highest guaranteed minimum (the automatic choice), or null. */ readonly recommended: number | null;
  readonly status: DiscoveryStatus };
export const QUOTE_SUBJECTS = UNIVERSAL_QUOTE_SUBJECTS;
const UNITS = /^(0|[1-9][0-9]{0,77})$/;
const AVAILABILITY = /_(HTTP_\d+|RATE_LIMITED|UNAVAILABLE|RESPONSE_TOO_LARGE|RESPONSE_INVALID|URL_INVALID)$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const units = (v: unknown) => typeof v === 'string' && UNITS.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const seconds = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(86_400, Math.round(v)) : null;
const label = (v: unknown, fallback: string) => typeof v === 'string' && v.length ? v.slice(0, 80) : fallback;
const codeOf = (cause: unknown) => cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'PROVIDER_FAILED';
const candidate = (provider: UniversalRoutingProvider, bridge: string, status: DiscoveryStatus, patch: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate =>
  ({ provider, bridge, status, executableBy: null, expectedOutput: null, minimumOutput: null, estimatedDurationSeconds: null, fees: [], reason: null, quoteId: null, ...patch });
const failed = (provider: UniversalRoutingProvider, bridge: string, cause: unknown): DiscoveryCandidate => {
  const code = codeOf(cause);
  return candidate(provider, bridge, code === 'PROVIDER_FAILED' ? 'INTERNAL_ERROR' : 'TEMPORARILY_UNAVAILABLE', { reason: code });
};
const refusalStatus = (code: string): DiscoveryStatus => AVAILABILITY.test(code) ? 'TEMPORARILY_UNAVAILABLE'
  : code.endsWith('_AMOUNT_TOO_LOW') ? 'BELOW_MINIMUM' : code.endsWith('_AMOUNT_TOO_HIGH') ? 'ABOVE_MAXIMUM'
    : code.endsWith('_INSUFFICIENT_LIQUIDITY') ? 'INSUFFICIENT_LIQUIDITY' : 'NO_ROUTE';
const positiveQuote = (expected: unknown, minimum: unknown) => { const e = units(expected), m = units(minimum); return !!e && !!m && BigInt(m) > 0n && BigInt(e) >= BigInt(m); };
const sameAddress = (network: UniversalNetwork, a: unknown, b: string) => typeof a === 'string' && (network.ecosystem === 'EVM' ? a.toLowerCase() === b.toLowerCase() : a === b);
const tokenKey = (n: UniversalNetwork, t: UniversalToken, native: string) => t.kind === 'NATIVE' ? native : t.address!;

// --- Relay -------------------------------------------------------------------------------------------------------------
async function discoverRelay(http: UniversalHttp, api: string, r: UniversalQuoteRequest, headers?: Record<string, string>): Promise<DiscoveryCandidate> {
  let raw: unknown;
  try { raw = await http.post(`${api}/quote/v2`, relayQuoteBody(r), headers); } catch (cause) { return failed('relay', 'relay-depository', cause); }
  const refused = providerHttpError(raw);
  if (refused) {
    const code = [401, 403, 408, 425, 429].includes(refused.status) || refused.status >= 500 ? providerRefusalCode('RELAY', refused) : relayRefusal(refused.message);
    return candidate('relay', 'relay-depository', refusalStatus(code), { reason: code });
  }
  try {
    const route = normalizeRelayQuote(raw, r);
    return candidate('relay', 'relay-depository', 'EXECUTABLE', { executableBy: 'UNIVERSAL_ROUTER', expectedOutput: route.expectedOutput, minimumOutput: route.minimumOutput,
      expiresAt: route.quote.expiresAt,
      estimatedDurationSeconds: route.quote.estimatedDurationSeconds, quoteId: route.quote.id,
      fees: route.fees.map(f => ({ label: f.label, amount: f.amount, symbol: f.symbol, decimals: f.decimals, included: f.included, chainId: f.chainId })) });
  } catch (cause) {
    // A real quote FloFi refused to execute (e.g. an origin swap through a router contract): shown with its reason, never executed.
    const details = isObject(raw) && isObject(raw.details) ? raw.details : {}, out = isObject(details.currencyOut) ? details.currencyOut : {};
    const inp = isObject(details.currencyIn) ? details.currencyIn : {}, it = isObject(inp.currency) ? inp.currency : {}, ot = isObject(out.currency) ? out.currency : {};
    const matches = inp.amount === r.amount && it.chainId === r.source.providers.relay.chainId && ot.chainId === r.destination.providers.relay.chainId &&
      sameAddress(r.source, it.address, relayCurrency(r.source, r.inputToken)) && sameAddress(r.destination, ot.address, relayCurrency(r.destination, r.outputToken)) &&
      it.decimals === r.inputToken.decimals && ot.decimals === r.outputToken.decimals &&
      (details.sender === undefined || sameAddress(r.source, details.sender, r.owner)) && (details.recipient === undefined || sameAddress(r.destination, details.recipient, r.recipient));
    const valid = matches && positiveQuote(out.amount, out.minimumAmount) && !/MISMATCH|INVALID|EXPIRED/.test(codeOf(cause));
    return candidate('relay', 'relay-depository', valid ? 'LIVE_QUOTE' : 'NO_ROUTE', { reason: codeOf(cause), expectedOutput: valid ? units(out.amount) : null, minimumOutput: valid ? units(out.minimumAmount) : null,
      estimatedDurationSeconds: seconds(details.timeEstimate) });
  }
}

// --- LI.FI -------------------------------------------------------------------------------------------------------------
async function discoverLifi(http: UniversalHttp, api: string, r: DiscoveryRequest, owner: string, recipient: string, headers?: Record<string, string>): Promise<DiscoveryCandidate[]> {
  const S = r.source, D = r.destination, native = (n: UniversalNetwork) => n.ecosystem === 'EVM' ? '0x0000000000000000000000000000000000000000' : '11111111111111111111111111111111';
  let raw: unknown;
  try {
    raw = await http.post(`${api}/advanced/routes`, { fromChainId: S.providers.lifi.chainId, toChainId: D.providers.lifi.chainId, fromTokenAddress: tokenKey(S, r.inputToken, native(S)),
      toTokenAddress: tokenKey(D, r.outputToken, native(D)), fromAmount: r.amount, fromAddress: owner, toAddress: recipient,
      options: { slippage: r.slippageBps / 10_000, order: 'CHEAPEST', integrator: UNIVERSAL_ROUTER_DEPLOYMENT.providers.lifi.integrator, allowSwitchChain: false } }, headers);
  } catch (cause) { return [failed('lifi', 'lifi', cause)]; }
  const refused = providerHttpError(raw);
  if (refused) { const code = providerRefusalCode('LIFI', refused); return [candidate('lifi', 'lifi', refusalStatus(code), { reason: code })]; }
  if (!isObject(raw) || !Array.isArray(raw.routes)) return [candidate('lifi', 'lifi', 'TEMPORARILY_UNAVAILABLE', { reason: 'LIFI_RESPONSE_INVALID' })];
  const routes = isObject(raw) && Array.isArray(raw.routes) ? raw.routes.filter(isObject).slice(0, 12) : [];
  if (!routes.length) return [candidate('lifi', 'lifi', 'NO_ROUTE', { reason: 'LIFI_NO_ROUTE' })];
  return routes.map(route => {
    const steps = Array.isArray(route.steps) ? route.steps.filter(isObject) : [];
    const bridge = steps.map(s => label(s.tool, 'lifi')).join('>');
    const fees: DiscoveryFee[] = steps.flatMap(s => isObject(s.estimate) && Array.isArray(s.estimate.feeCosts) ? s.estimate.feeCosts.filter(isObject).flatMap(f => {
      const t = isObject(f.token) ? f.token : {}, amount = units(f.amount);
      return amount && amount !== '0' ? [{ label: label(f.name, 'LI.FI fee'), amount, symbol: label(t.symbol, 'TOKEN').slice(0, 24), decimals: Number.isSafeInteger(t.decimals) ? t.decimals as number : 0,
        included: f.included === true, chainId: t.chainId === D.providers.lifi.chainId ? D.chain : S.chain }] : [];
    }) : []);
    const duration = steps.reduce((sum, s) => sum + (isObject(s.estimate) ? seconds(s.estimate.executionDuration) ?? 0 : 0), 0);
    const input = isObject(route.fromToken) ? route.fromToken : {}, output = isObject(route.toToken) ? route.toToken : {};
    const matches = route.fromChainId === S.providers.lifi.chainId && route.toChainId === D.providers.lifi.chainId && route.fromAmount === r.amount &&
      sameAddress(S, input.address, tokenKey(S, r.inputToken, native(S))) && sameAddress(D, output.address, tokenKey(D, r.outputToken, native(D))) &&
      input.decimals === r.inputToken.decimals && output.decimals === r.outputToken.decimals;
    if (!matches || !positiveQuote(route.toAmount, route.toAmountMin)) return candidate('lifi', bridge, 'NO_ROUTE', { reason: 'LIFI_QUOTE_MISMATCH' });
    // A tool name is not proof that the certified Router can verify the provider's transaction.
    return candidate('lifi', bridge, 'LIVE_QUOTE', { expectedOutput: units(route.toAmount),
      minimumOutput: units(route.toAmountMin), estimatedDurationSeconds: duration, fees, reason: bridge === 'across' ? 'LIFI_REQUIRES_CERTIFIED_ROUTER_VALIDATION' : 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED',
      quoteId: typeof route.id === 'string' ? route.id.slice(0, 80) : null });
  });
}

// --- Mayan -------------------------------------------------------------------------------------------------------------
async function discoverMayan(http: UniversalHttp, api: string, r: DiscoveryRequest, sdkVersion: string): Promise<DiscoveryCandidate[]> {
  const S = r.source, D = r.destination;
  if (!S.providers.mayan || !D.providers.mayan) return [candidate('mayan', 'mayan', 'NO_ROUTE', { reason: 'MAYAN_NETWORK_UNSUPPORTED' })];
  // Mayan encodes every native coin (SOL included) as the zero address.
  const token = (t: UniversalToken) => t.kind === 'NATIVE' ? '0x0000000000000000000000000000000000000000' : t.address!;
  const params = new URLSearchParams({ amountIn64: r.amount, fromToken: token(r.inputToken), fromChain: S.providers.mayan, toToken: token(r.outputToken), toChain: D.providers.mayan,
    slippageBps: String(r.slippageBps), gasDrop: '0', swift: 'true', mctp: 'true', fastMctp: 'true', wormhole: 'true', gasless: 'false', onlyDirect: 'false', fullList: 'true', sdkVersion });
  let raw: unknown;
  try { raw = await http.get(`${api}/quote?${params}`); } catch (cause) { return [failed('mayan', 'mayan', cause)]; }
  const refused = providerHttpError(raw);
  // An API version refusal is Mayan's availability to this FloFi build, never a statement about the route.
  if (refused && /SDK_VERSION/i.test(refused.message)) return [candidate('mayan', 'mayan', 'TEMPORARILY_UNAVAILABLE', { reason: 'MAYAN_API_VERSION_REJECTED' })];
  if (refused) { const code = providerRefusalCode('MAYAN', refused); return [candidate('mayan', 'mayan', refusalStatus(code), { reason: code })]; }
  if (!isObject(raw) || !Array.isArray(raw.quotes)) return [candidate('mayan', 'mayan', 'TEMPORARILY_UNAVAILABLE', { reason: 'MAYAN_RESPONSE_INVALID' })];
  const quotes = isObject(raw) && Array.isArray(raw.quotes) ? raw.quotes.filter(isObject).slice(0, 6) : [];
  if (!quotes.length) return [candidate('mayan', 'mayan', 'NO_ROUTE', { reason: 'MAYAN_NO_ROUTE' })];
  return quotes.map(q => {
    const fromToken = isObject(q.fromToken) ? q.fromToken : {}, toToken = isObject(q.toToken) ? q.toToken : {};
    const sameOutput = q.fromChain === S.providers.mayan && q.toChain === D.providers.mayan &&
      sameAddress(S, fromToken.contract, token(r.inputToken)) && sameAddress(D, toToken.contract, token(r.outputToken)) &&
      fromToken.decimals === r.inputToken.decimals && toToken.decimals === r.outputToken.decimals && positiveQuote(q.expectedAmountOutBaseUnits, q.minAmountOutBaseUnits);
    return candidate('mayan', `mayan-${label(q.type, 'route').toLowerCase()}`, sameOutput ? 'LIVE_QUOTE' : 'NO_ROUTE', {
      expectedOutput: sameOutput ? units(q.expectedAmountOutBaseUnits) : null, minimumOutput: sameOutput ? units(q.minAmountOutBaseUnits) : null, estimatedDurationSeconds: seconds(q.etaSeconds),
      // Mayan prices its relayer and protocol fees into the quoted output; FloFi lists no separate amount it cannot verify.
      reason: sameOutput ? 'MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED' : 'MAYAN_OUTPUT_MISMATCH' });
  });
}

// --- Across ------------------------------------------------------------------------------------------------------------
async function discoverAcross(http: UniversalHttp, api: string, r: DiscoveryRequest, owner: string, recipient: string): Promise<DiscoveryCandidate> {
  const S = r.source, D = r.destination;
  if (S.providers.across === null || D.providers.across === null) return candidate('across', 'across', 'NO_ROUTE', { reason: 'ACROSS_NETWORK_UNSUPPORTED' });
  // Across names native ETH by the chain's wrapped token with exact-input semantics; FloFi asks only for ERC-20 pairs here.
  if (r.inputToken.kind === 'NATIVE' || r.outputToken.kind === 'NATIVE') return candidate('across', 'across', 'SUPPORTED_BY_PROVIDER', { reason: 'ACROSS_NATIVE_NOT_QUOTED' });
  const params = new URLSearchParams({ tradeType: 'exactInput', amount: r.amount, inputToken: r.inputToken.address!, outputToken: r.outputToken.address!,
    originChainId: String(S.providers.across), destinationChainId: String(D.providers.across), depositor: owner, recipient, refundAddress: owner, refundOnOrigin: 'true',
    slippage: String(r.slippageBps / 10_000) });
  let raw: unknown;
  try { raw = await http.get(`${api}/swap/approval?${params}`); } catch (cause) { return failed('across', 'across', cause); }
  const refused = providerHttpError(raw);
  if (refused) { const code = providerRefusalCode('ACROSS', refused); return candidate('across', 'across', refusalStatus(code), { reason: code }); }
  if (!isObject(raw)) return candidate('across', 'across', 'TEMPORARILY_UNAVAILABLE', { reason: 'ACROSS_RESPONSE_INVALID' });
  const input = isObject(raw.inputToken) ? raw.inputToken : {}, output = isObject(raw.outputToken) ? raw.outputToken : {};
  if (raw.inputAmount !== r.amount || input.chainId !== S.providers.across || output.chainId !== D.providers.across ||
    !sameAddress(S, input.address, r.inputToken.address!) || !sameAddress(D, output.address, r.outputToken.address!) ||
    input.decimals !== r.inputToken.decimals || output.decimals !== r.outputToken.decimals) return candidate('across', 'across', 'NO_ROUTE', { reason: 'ACROSS_QUOTE_MISMATCH' });
  if (!positiveQuote(raw.expectedOutputAmount, raw.minOutputAmount)) return candidate('across', 'across', 'TEMPORARILY_UNAVAILABLE', { reason: 'ACROSS_RESPONSE_INVALID' });
  return candidate('across', 'across', 'LIVE_QUOTE', {
    expectedOutput: units(raw.expectedOutputAmount), minimumOutput: units(raw.minOutputAmount), estimatedDurationSeconds: seconds(raw.expectedFillTime),
    reason: 'ACROSS_REQUIRES_CERTIFIED_ROUTER_VALIDATION', quoteId: typeof raw.id === 'string' ? raw.id.slice(0, 80) : null });
}

const RANK: Readonly<Record<DiscoveryStatus, number>> = { EXECUTABLE: 0, LIVE_QUOTE: 1, SUPPORTED_BY_PROVIDER: 2, BELOW_MINIMUM: 3, ABOVE_MAXIMUM: 4, INSUFFICIENT_LIQUIDITY: 5, TEMPORARILY_UNAVAILABLE: 6, NO_ROUTE: 7, INTERNAL_ERROR: 8 };
export function createUniversalDiscovery(config: { readonly http: UniversalHttp; readonly now?: () => Date; readonly reviewTtlSeconds?: number;
  readonly correlationId?: string;
  readonly apis?: { readonly relay?: string; readonly lifi?: string; readonly mayan?: string; readonly across?: string };
  readonly keys?: { readonly relay?: string; readonly lifi?: string } }) {
  const now = config.now ?? (() => new Date()), P = UNIVERSAL_ROUTER_DEPLOYMENT.providers;
  const apis = { relay: config.apis?.relay ?? RELAY_API, lifi: config.apis?.lifi ?? P.lifi.api, mayan: config.apis?.mayan ?? P.mayan.api, across: config.apis?.across ?? P.across.api };
  return {
    async discover(r: DiscoveryRequest, providers: readonly UniversalRoutingProvider[] = ['relay', 'lifi', 'mayan', 'across']): Promise<DiscoveryResult> {
      const subject = (n: UniversalNetwork) => n.ecosystem === 'EVM' ? QUOTE_SUBJECTS.EVM : QUOTE_SUBJECTS.SOLANA;
      const owner = r.owner ?? subject(r.source), recipient = r.recipient ?? subject(r.destination);
      const relayRequest: UniversalQuoteRequest = { source: r.source, destination: r.destination, inputToken: r.inputToken, outputToken: r.outputToken, amount: r.amount, owner,
        recipient, slippageBps: r.slippageBps, nowMs: now().getTime(), reviewTtlSeconds: config.reviewTtlSeconds ?? UNIVERSAL_ROUTER_DEPLOYMENT.reviewTtlSeconds,
        inputTokenProgram: r.inputTokenProgram ?? (r.source.ecosystem === 'SOLANA' && r.inputToken.kind === 'TOKEN' ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : null) };
      const relayHeaders = config.keys?.relay ? { 'x-api-key': config.keys.relay } : undefined, lifiHeaders = config.keys?.lifi ? { 'x-lifi-api-key': config.keys.lifi } : undefined;
      const tasks: Promise<DiscoveryCandidate[]>[] = providers.map(p => p === 'relay' ? discoverRelay(config.http, apis.relay, relayRequest, relayHeaders).then(c => [c])
        : p === 'lifi' ? discoverLifi(config.http, apis.lifi, r, owner, recipient, lifiHeaders) : p === 'mayan' ? discoverMayan(config.http, apis.mayan, r, P.mayan.sdkVersion)
          : discoverAcross(config.http, apis.across, r, owner, recipient).then(c => [c]));
      const candidates = (await Promise.all(tasks)).flat().sort((a, b) => RANK[a.status] - RANK[b.status] ||
        (BigInt(b.minimumOutput ?? '0') > BigInt(a.minimumOutput ?? '0') ? 1 : BigInt(b.minimumOutput ?? '0') < BigInt(a.minimumOutput ?? '0') ? -1 : 0));
      for (const c of candidates) createLogger({ service: 'flofi-quotes' }).info('quote.provider_result', {
        correlation_id: config.correlationId, source_chain: r.source.chain, destination_chain: r.destination.chain,
        provider: c.provider, status: c.status, code: c.reason });
      // The automatic choice is the universal router's best guaranteed minimum (the certified Router pairs are chosen on their own flow).
      const recommended = candidates.findIndex(c => c.executableBy === 'UNIVERSAL_ROUTER');
      const status = candidates.length ? candidates[0]!.status : 'NO_ROUTE';
      return { format: 'flofi.universal-discovery.v1', sourceChain: r.source.chain, destinationChain: r.destination.chain, inputToken: r.inputToken, outputToken: r.outputToken,
        amount: r.amount, observedAt: now().toISOString(), quoteSubjects: r.owner && r.recipient ? 'OWNER' : 'PUBLIC_QUOTE_SUBJECT', candidates,
        recommended: recommended >= 0 ? recommended : null, status };
    },
  };
}
export type UniversalDiscovery = ReturnType<typeof createUniversalDiscovery>;
export { UNIVERSAL_NETWORKS, relayCurrency };
