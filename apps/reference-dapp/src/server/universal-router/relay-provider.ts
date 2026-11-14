// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: Relay as a routing provider of the universal router — every directed pair of the five FloFi
 * mainnets (Relay `/chains`, 2026-10-25), same-asset and cross-asset (the solver delivers the destination asset; the order binds its
 * guaranteed minimum).
 *
 * The quote is a claim; FloFi proves it before anything reaches a wallet:
 *  - `orderId` recomputed from `orderData` and the order checked field by field against the intent (`verifyRelayOrder`): one input of
 *    the exact amount and currency, one payment to the recipient in the destination currency, no destination calls, no order fees,
 *    refunds only to the owner or the recipient, the owner's slippage bound, a future deadline;
 *  - the source step rebuilt by FloFi (EVM `depositErc20`/`depositNative` calldata on the Depository; Solana `deposit_token`/
 *    `deposit_native` with every account derived) and required to equal Relay's byte for byte; any other step shape is refused;
 *  - the quote summary (`details`, `fees`) consistent with the order and the request (tokens, decimals, amounts, fee assets).
 * The route carries the verified order and FloFi's own transaction; Relay's approval and lookup tables are never used.
 * Server-side and read-only: nothing here can sign or send.
 */
import { createHash } from 'node:crypto';
import { canonicalizeUniversalRoute, EVM_ZERO_ADDRESS, SOLANA_SYSTEM_PROGRAM, type UniversalNetwork, type UniversalRoute, type UniversalRouteFee,
  type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { encodeErc20ApproveExact, encodeRelayDepositErc20, encodeRelayDepositNative, relaySolanaDepositInstruction, verifyRelayOrder, RELAY_EVM_DEPOSITORY,
  RELAY_SOLANA_DEPOSITORY_PROGRAM, type RelayOrderData } from '@defi-workflow-engine/reference-compiler';
import { ARBITRUM_BASE_ASSETS, BASE_BASE_ASSETS, ETHEREUM_BASE_ASSETS, ROBINHOOD_BASE_ASSETS } from '@defi-workflow-engine/action-registry';
import { providerHttpError, providerRefusalCode, type UniversalHttp } from './http.ts';

export const RELAY_API = 'https://api.relay.link';
export type UniversalQuoteRequest = {
  readonly source: UniversalNetwork; readonly destination: UniversalNetwork;
  /** Tokens as FloFi resolved them; decimals are the on-chain or catalog-verified values. */
  readonly inputToken: UniversalToken; readonly outputToken: UniversalToken;
  readonly amount: string; readonly owner: string; readonly recipient: string; readonly slippageBps: number;
  readonly nowMs: number; readonly reviewTtlSeconds: number;
  /** Solana token source: the mint's owning token program, read on chain. */ readonly inputTokenProgram?: string | null;
};
export type ProviderStatus = 'WAITING' | 'PENDING' | 'FILLED' | 'REFUNDED' | 'FAILED' | 'DELAYED' | 'NOT_FOUND' | 'UNKNOWN';
/** A provider's settlement claim. Never settlement proof: FloFi verifies every referenced transaction on chain. */
export type ProviderStatusHint = { readonly source: 'relay.status'; readonly status: ProviderStatus; readonly sourceTxHashes: readonly string[];
  readonly destinationTxHashes: readonly string[]; readonly refundTxHashes: readonly string[]; readonly failReason: string | null; readonly rawHash: string };
export type UniversalProviderAdapter = { readonly id: 'relay'; readonly quote: (request: UniversalQuoteRequest) => Promise<UniversalRoute>;
  readonly status: (route: UniversalRoute) => Promise<ProviderStatusHint> };

const fail = (code: string): never => { throw new Error(code); };
const rec = (value: unknown, code: string): Record<string, unknown> => !value || typeof value !== 'object' || Array.isArray(value) ? fail(code) : value as Record<string, unknown>;
const list = (value: unknown, code: string): unknown[] => Array.isArray(value) ? value : fail(code);
const UNITS = /^(0|[1-9][0-9]{0,77})$/, HASH32 = /^0x[0-9a-f]{64}$/;
const units = (value: unknown, code: string): string => typeof value === 'string' && UNITS.test(value) ? value : fail(code);
const rawHash = (raw: unknown) => '0x' + createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
/** A token in Relay's currency encoding: EVM lowercase hex (native = zero address), Solana base58 (native = System Program id). */
export const relayCurrency = (network: UniversalNetwork, token: UniversalToken) => token.kind === 'NATIVE'
  ? network.ecosystem === 'EVM' ? EVM_ZERO_ADDRESS : SOLANA_SYSTEM_PROGRAM : token.address!;
const sameCurrency = (network: UniversalNetwork, a: unknown, b: string) => typeof a === 'string' && (network.ecosystem === 'EVM' ? a.toLowerCase() === b.toLowerCase() : a === b);
const vmOf = (slug: string) => slug === 'solana' ? 'solana-vm' as const : 'ethereum-vm' as const;
/** Each EVM mainnet's pinned wrapped-native token (WETH9), as `chain:address`. */
const WRAPPED_NATIVE: ReadonlyMap<string, string> = new Map([BASE_BASE_ASSETS, ARBITRUM_BASE_ASSETS, ETHEREUM_BASE_ASSETS, ROBINHOOD_BASE_ASSETS]
  .flatMap(catalog => catalog.assets.filter(asset => asset.assetClass === 'WRAPPED_NATIVE' && asset.address).map(asset => [`${asset.chain}:${asset.address!.toLowerCase()}`, asset.symbol] as const)));
/** The quote body FloFi sends: exact input, FloFi's slippage, refunds to the owner, no app fee, no deposit-address flow. */
export function relayQuoteBody(r: UniversalQuoteRequest): Record<string, unknown> {
  return { user: r.owner, recipient: r.recipient, originChainId: r.source.providers.relay.chainId, destinationChainId: r.destination.providers.relay.chainId,
    originCurrency: relayCurrency(r.source, r.inputToken), destinationCurrency: relayCurrency(r.destination, r.outputToken), amount: r.amount, tradeType: 'EXACT_INPUT',
    refundTo: r.owner, slippageTolerance: String(r.slippageBps), useDepositAddress: false };
}
/** Relay's "no route" answers, mapped to stable codes (the provider message is kept only as a bounded note). */
export function relayRefusal(message: string): string {
  return /insufficient liquidity|not enough liquidity/i.test(message) ? 'RELAY_INSUFFICIENT_LIQUIDITY'
    : /no (?:available )?routes?|not supported|unsupported/i.test(message) ? 'RELAY_NO_ROUTE'
    : /amount.*(?:too (?:low|small)|minimum)|below.*minimum/i.test(message) ? 'RELAY_AMOUNT_TOO_LOW'
      : /amount.*(?:too (?:high|large)|maximum)|exceeds/i.test(message) ? 'RELAY_AMOUNT_TOO_HIGH' : /invalid address/i.test(message) ? 'RELAY_ADDRESS_REFUSED' : 'RELAY_QUOTE_REFUSED';
}

export function normalizeRelayQuote(raw: unknown, r: UniversalQuoteRequest): UniversalRoute {
  const refused = providerHttpError(raw);
  if (refused) fail([401, 403, 408, 425, 429].includes(refused.status) || refused.status >= 500 ? providerRefusalCode('RELAY', refused) : relayRefusal(refused.message));
  const q = rec(raw, 'RELAY_RESPONSE_INVALID'), protocol = rec(rec(q.protocol, 'RELAY_PROTOCOL_UNSUPPORTED').v2, 'RELAY_PROTOCOL_UNSUPPORTED');
  const requestId = typeof q.requestId === 'string' ? q.requestId.toLowerCase() : fail('RELAY_RESPONSE_INVALID');
  if (!HASH32.test(requestId)) fail('RELAY_RESPONSE_INVALID');
  const orderId = typeof protocol.orderId === 'string' ? protocol.orderId.toLowerCase() : fail('RELAY_PROTOCOL_UNSUPPORTED');
  const orderData = rec(protocol.orderData, 'RELAY_PROTOCOL_UNSUPPORTED') as unknown as RelayOrderData;
  if (protocol.hubType !== undefined && protocol.hubType !== 'onchain') fail('RELAY_PROTOCOL_UNSUPPORTED');
  const S = r.source, D = r.destination, inputCurrency = relayCurrency(S, r.inputToken), outputCurrency = relayCurrency(D, r.outputToken);
  const depository = S.ecosystem === 'EVM' ? RELAY_EVM_DEPOSITORY : RELAY_SOLANA_DEPOSITORY_PROGRAM;
  const payment = rec(protocol.paymentDetails, 'RELAY_PROTOCOL_UNSUPPORTED');
  // The payment Relay asks for: on the source chain, to the Depository, exactly the requested amount, in `currency` (the check is unchanged).
  const pays = (currency: string) => payment.chainId === S.providers.relay.slug && sameCurrency(S, payment.depository, depository) &&
    sameCurrency(S, payment.currency, currency) && payment.amount === r.amount;
  // P0 hotfix (production 2026-11-13, every Base WETH → Arbitrum One quote refused as RELAY_PAYMENT_MISMATCH): for a wrapped-native token input
  // (WETH) Relay answers with a NATIVE-asset order — `paymentDetails.currency` and the order's input are the native asset — funded through its own
  // approval proxy and router, which pull the token, unwrap it and deposit native ETH.
  // BUILD-FLOFI-MAINNET-EXEC-002: FloFi pays that verified native order itself, without Relay's proxy or router: the owner unwraps exactly the
  // amount on the network's pinned wrapped-native contract (WETH9 `withdraw`), then deposits exactly that native value into the Depository
  // (`depositNative(owner, orderId)`, rebuilt by FloFi). Only for the network's pinned WETH, with everything else about the payment matching
  // exactly; any other token answered in the native asset stays a mismatch. Relay's own steps for this order are never used.
  const unwrapping = !pays(inputCurrency) && r.inputToken.kind === 'TOKEN' && S.ecosystem === 'EVM' && WRAPPED_NATIVE.has(`${S.chain}:${inputCurrency.toLowerCase()}`) &&
    pays(EVM_ZERO_ADDRESS);
  if (!pays(inputCurrency) && !unwrapping) fail('RELAY_PAYMENT_MISMATCH');
  const paidCurrency = unwrapping ? EVM_ZERO_ADDRESS : inputCurrency;
  const order = verifyRelayOrder(orderData, { orderId, sourceSlug: S.providers.relay.slug, destinationSlug: D.providers.relay.slug, inputCurrency: paidCurrency, outputCurrency,
    amount: r.amount, owner: r.owner, recipient: r.recipient, slippageBps: r.slippageBps, nowSeconds: Math.floor(r.nowMs / 1000), vmOf });

  // The summary must agree with the order and with FloFi's token facts.
  const details = rec(q.details, 'RELAY_RESPONSE_INVALID'), cin = rec(details.currencyIn, 'RELAY_RESPONSE_INVALID'), cout = rec(details.currencyOut, 'RELAY_RESPONSE_INVALID');
  const tin = rec(cin.currency, 'RELAY_RESPONSE_INVALID'), tout = rec(cout.currency, 'RELAY_RESPONSE_INVALID');
  // The summary names the requested token (or, for the order paid in native ETH, the native coin of the same decimals).
  if (tin.chainId !== S.providers.relay.chainId || !(sameCurrency(S, tin.address, inputCurrency) || unwrapping && sameCurrency(S, tin.address, paidCurrency)) ||
      tin.decimals !== r.inputToken.decimals || cin.amount !== r.amount) fail('RELAY_INPUT_MISMATCH');
  if (tout.chainId !== D.providers.relay.chainId || !sameCurrency(D, tout.address, outputCurrency) || tout.decimals !== r.outputToken.decimals) fail('RELAY_OUTPUT_MISMATCH');
  if (units(cout.amount, 'RELAY_OUTPUT_MISMATCH') !== order.expectedOutput || units(cout.minimumAmount, 'RELAY_OUTPUT_MISMATCH') !== order.minimumOutput) fail('RELAY_OUTPUT_MISMATCH');
  const ownerKey = S.ecosystem === 'EVM' ? r.owner.toLowerCase() : r.owner, recipientKey = D.ecosystem === 'EVM' ? r.recipient.toLowerCase() : r.recipient;
  if (details.sender !== undefined && !sameCurrency(S, details.sender, ownerKey) || details.recipient !== undefined && !sameCurrency(D, details.recipient, recipientKey))
    fail('RELAY_PARTY_MISMATCH');

  // The source step: rebuilt by FloFi, Relay's must match exactly. Anything beyond approve + deposit (EVM) or one deposit (Solana) is refused.
  const steps = list(q.steps, 'RELAY_STEPS_UNSUPPORTED').map(s => rec(s, 'RELAY_STEPS_UNSUPPORTED'));
  const ids = steps.map(s => s.id), allowed = S.ecosystem === 'EVM' && r.inputToken.kind === 'TOKEN' ? [['approve', 'deposit'], ['deposit']] : [['deposit']];
  if (!unwrapping && (!allowed.some(a => a.length === ids.length && a.every((id, i) => id === ids[i])) || steps.some(s => s.kind !== 'transaction'))) fail('RELAY_STEPS_UNSUPPORTED');
  if (unwrapping && (steps.length < 1 || steps.some(s => s.kind !== 'transaction'))) fail('RELAY_STEPS_UNSUPPORTED');
  const item = (s: Record<string, unknown>) => { const items = list(s.items, 'RELAY_STEPS_UNSUPPORTED'); if (items.length !== 1) fail('RELAY_STEPS_UNSUPPORTED');
    return rec(rec(items[0], 'RELAY_STEPS_UNSUPPORTED').data, 'RELAY_STEPS_UNSUPPORTED'); };
  const amount = BigInt(r.amount);
  let source: UniversalRoute['source'];
  if (S.ecosystem === 'EVM' && unwrapping) {
    // FloFi's own payment of the native order: the unwrap (verified on chain at Simulate) and the exact native deposit. Relay's proxy steps are ignored.
    const owner = r.owner.toLowerCase(), weth = inputCurrency.toLowerCase();
    source = { ecosystem: 'EVM', chainId: S.chain, approval: null, deposit: { to: RELAY_EVM_DEPOSITORY, data: encodeRelayDepositNative(owner, orderId), value: r.amount },
      unwrap: { token: weth, amount: r.amount } };
  } else if (S.ecosystem === 'EVM') {
    const owner = r.owner.toLowerCase(), token = r.inputToken.kind === 'TOKEN' ? r.inputToken.address! : null;
    const data = token ? encodeRelayDepositErc20(owner, token, amount, orderId) : encodeRelayDepositNative(owner, orderId);
    const value = token ? '0' : r.amount;
    for (const s of steps) {
      const d = item(s), expected = s.id === 'approve' ? { to: token, data: encodeErc20ApproveExact(RELAY_EVM_DEPOSITORY, amount), value: '0' } : { to: RELAY_EVM_DEPOSITORY, data, value };
      if (d.chainId !== S.evmChainId || typeof d.from !== 'string' || d.from.toLowerCase() !== owner || typeof d.to !== 'string' || d.to.toLowerCase() !== expected.to ||
          typeof d.data !== 'string' || d.data.toLowerCase() !== expected.data || String(d.value ?? '0') !== expected.value) fail('RELAY_TRANSACTION_MISMATCH');
    }
    source = { ecosystem: 'EVM', chainId: S.chain, approval: token ? { token, spender: RELAY_EVM_DEPOSITORY, amount: r.amount } : null, deposit: { to: RELAY_EVM_DEPOSITORY, data, value } };
  } else {
    const built = relaySolanaDepositInstruction({ owner: r.owner, mint: r.inputToken.kind === 'TOKEN' ? r.inputToken.address : null,
      tokenProgram: r.inputToken.kind === 'TOKEN' ? r.inputTokenProgram ?? fail('RELAY_TOKEN_PROGRAM_UNKNOWN') : null, amount, orderId });
    const instructions = list(item(steps[0]!).instructions, 'RELAY_TRANSACTION_MISMATCH');
    if (instructions.length !== 1) fail('RELAY_TRANSACTION_MISMATCH');
    const ix = rec(instructions[0], 'RELAY_TRANSACTION_MISMATCH'), keys = list(ix.keys, 'RELAY_TRANSACTION_MISMATCH');
    if (ix.programId !== built.programId || ix.data !== Buffer.from(built.data).toString('hex') || keys.length !== built.accounts.length ||
        built.accounts.some((a, i) => { const k = rec(keys[i], 'RELAY_TRANSACTION_MISMATCH'); return k.pubkey !== a.pubkey || k.isSigner !== a.isSigner || k.isWritable !== a.isWritable; }))
      fail('RELAY_TRANSACTION_MISMATCH');
    source = { ecosystem: 'SOLANA', chainId: S.chain, instruction: { programId: built.programId, accounts: built.accounts, data: '0x' + Buffer.from(built.data).toString('hex') } };
  }

  // Fees, as Relay itemizes them. The app fee must be zero (FloFi requests none); relayer fees are inside the quote; origin gas is paid separately.
  const fees = rec(q.fees, 'RELAY_FEES_INVALID'), lines: UniversalRouteFee[] = [];
  const line = (key: string, kind: UniversalRouteFee['kind'], label: string, included: boolean) => {
    const v = fees[key]; if (v === undefined) return;
    const f = rec(v, 'RELAY_FEES_INVALID'), c = rec(f.currency, 'RELAY_FEES_INVALID'), value = units(f.amount, 'RELAY_FEES_INVALID');
    if (value === '0') return;
    const network = c.chainId === S.providers.relay.chainId ? S : c.chainId === D.providers.relay.chainId ? D : fail('RELAY_FEE_ASSET_UNSUPPORTED');
    const nativeCurrency = network.ecosystem === 'EVM' ? EVM_ZERO_ADDRESS : SOLANA_SYSTEM_PROGRAM;
    const token = typeof c.address !== 'string' ? fail('RELAY_FEES_INVALID') : sameCurrency(network, c.address, nativeCurrency) ? 'native'
      : network.ecosystem === 'EVM' ? c.address.toLowerCase() : c.address;
    if (!Number.isSafeInteger(c.decimals) || typeof c.symbol !== 'string') fail('RELAY_FEES_INVALID');
    lines.push({ kind, label, chainId: network.chain, token, decimals: c.decimals as number, symbol: String(c.symbol).slice(0, 24).replace(/[^A-Za-z0-9.$+_-]/g, '') || 'TOKEN',
      amount: value, included, recipient: null });
  };
  const app = fees.app === undefined ? '0' : units(rec(fees.app, 'RELAY_FEES_INVALID').amount, 'RELAY_FEES_INVALID');
  if (app !== '0') fail('RELAY_APP_FEE_UNEXPECTED');
  line('relayerService', 'RELAYER_SERVICE', 'Relay service fee', true);
  line('relayerGas', 'RELAYER_DESTINATION_GAS', 'Relay destination network fee', true);
  line('gas', 'SOURCE_NETWORK_FEE', `${S.name} network fee (estimate)`, false);
  const sourceFee = lines.find(l => l.kind === 'SOURCE_NETWORK_FEE');
  if (sourceFee && (sourceFee.chainId !== S.chain || sourceFee.token !== 'native')) fail('RELAY_FEES_INVALID');

  const duration = typeof details.timeEstimate === 'number' && Number.isFinite(details.timeEstimate) ? Math.max(0, Math.min(86_400, Math.round(details.timeEstimate))) : 0;
  // A quote is FloFi-reviewable for at most `reviewTtlSeconds`, and never close to the order deadline.
  const expiresMs = Math.min(r.nowMs + r.reviewTtlSeconds * 1000, (order.deadline - 600) * 1000);
  if (expiresMs <= r.nowMs) fail('RELAY_QUOTE_EXPIRED');
  const symbol = (value: unknown, fallback: string) => typeof value === 'string' && /^[A-Za-z0-9.$+_-]{1,24}$/.test(value) ? value : fallback;
  // The owner's asset keeps its own name: an order paid in native ETH for a WETH input still shows WETH (the catalog's symbol).
  const inputSymbol = unwrapping ? WRAPPED_NATIVE.get(`${S.chain}:${inputCurrency.toLowerCase()}`)! : symbol(tin.symbol, r.inputToken.symbol);
  const inputToken = { ...r.inputToken, symbol: inputSymbol }, outputToken = { ...r.outputToken, symbol: symbol(tout.symbol, r.outputToken.symbol) };
  const key = (t: UniversalToken) => t.address ?? 'native';
  return canonicalizeUniversalRoute({ format: 'flofi.universal-route.v1', provider: 'relay', protocol: 'relay-depository', sourceChain: S.chain, destinationChain: D.chain,
    inputToken, outputToken, inputAmount: r.amount, expectedOutput: order.expectedOutput, minimumOutput: order.minimumOutput, slippageBps: r.slippageBps,
    depositor: r.owner, recipient: r.recipient, refundAddress: r.owner,
    steps: [...unwrapping ? [{ kind: 'SOURCE_UNWRAP' as const, protocol: 'weth9', fromChain: S.chain, toChain: S.chain, fromToken: key(inputToken), toToken: 'native',
      amountIn: r.amount, amountOut: r.amount }] : [],
      { kind: 'BRIDGE', protocol: 'relay', fromChain: S.chain, toChain: D.chain, fromToken: unwrapping ? 'native' : key(inputToken), toToken: key(outputToken), amountIn: r.amount,
      amountOut: order.expectedOutput }],
    fees: lines, source, order: { kind: 'RELAY_V2', orderId, orderData: orderData as unknown as Record<string, unknown>, solver: order.solver, deadline: order.deadline,
      depository, refunds: order.refunds },
    destination: { additionalAuthorization: 'NONE' },
    quote: { id: requestId, rawHash: rawHash(raw), quotedAt: iso(r.nowMs), expiresAt: iso(expiresMs), estimatedDurationSeconds: duration } });
}

export function normalizeRelayStatus(raw: unknown): ProviderStatusHint {
  const refused = providerHttpError(raw);
  if (refused) return { source: 'relay.status', status: refused.status === 404 ? 'NOT_FOUND' : 'UNKNOWN', sourceTxHashes: [], destinationTxHashes: [], refundTxHashes: [],
    failReason: null, rawHash: rawHash(raw) };
  const v = rec(raw, 'RELAY_STATUS_INVALID');
  const hashes = (x: unknown) => Array.isArray(x) ? x.filter((h): h is string => typeof h === 'string' && /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.test(h)).slice(0, 8)
    .map(h => h.startsWith('0x') ? h.toLowerCase() : h) : [];
  const s = String(v.status ?? '');
  const status: ProviderStatus = s === 'success' ? 'FILLED' : s === 'refund' || s === 'refunded' ? 'REFUNDED' : s === 'failure' ? 'FAILED' : s === 'delayed' ? 'DELAYED'
    : s === 'waiting' ? 'WAITING' : s === 'pending' || s === 'submitted' ? 'PENDING' : 'UNKNOWN';
  const out = hashes(v.txHashes);
  return { source: 'relay.status', status, sourceTxHashes: hashes(v.inTxHashes), destinationTxHashes: status === 'FILLED' ? out : [], refundTxHashes: status === 'REFUNDED' ? out : [],
    failReason: typeof v.failReason === 'string' && v.failReason !== 'N/A' ? v.failReason.slice(0, 120) : null, rawHash: rawHash(raw) };
}

export function createRelayProvider(config: { readonly http: UniversalHttp; readonly api?: string; readonly apiKey?: string }): UniversalProviderAdapter {
  const api = config.api ?? RELAY_API, headers = config.apiKey ? { 'x-api-key': config.apiKey } : undefined;
  return Object.freeze({ id: 'relay',
    quote: async request => normalizeRelayQuote(await config.http.post(`${api}/quote/v2`, relayQuoteBody(request), headers), request),
    status: async route => normalizeRelayStatus(await config.http.get(`${api}/intents/status/v3?${new URLSearchParams({ requestId: route.quote.id })}`, headers)) });
}
