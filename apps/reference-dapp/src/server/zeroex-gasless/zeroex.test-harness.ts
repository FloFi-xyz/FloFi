// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 test harness: a deterministic, in-process double of 0x's Gasless API v2 (`ZeroExHttp`) on top of the
 * MOCKED Robinhood Chain (`robinhood-mainnet.test-harness.ts`). Synthetic chain 4663 quotes are built the way 0x builds them (Permit2
 * PermitWitnessTransferFrom for a MetaTxn Settler read from a mock registry, an optional EIP-2612 permit of Permit2), with real EIP-712 hashes,
 * so FloFi's checks run unchanged. `/gasless/submit` verifies the owner's signatures like 0x would and "settles" by mutating the mock chain
 * (a relayer-sent transaction to the Settler with the owner's Transfer logs, the Permit2 nonce consumed). Nothing here reaches a network,
 * holds a real key or signs: the owner's signatures come from a disposable test wallet. Test code only.
 */
import { createHash } from 'node:crypto';
import { eip712 } from '@defi-workflow-engine/reference-compiler';
import type { RobinhoodMockChain } from '../robinhood-mainnet.test-harness.ts';
import { addressWord, APPROVAL_TOPIC, SCALED_TRANSFER_TOPIC, TRANSFER_TOPIC, word } from '../robinhood-mainnet.test-harness.ts';
import type { Rpc } from '../public-testnet-service.ts';
import type { ZeroExAnswer, ZeroExHttp } from './transport.ts';
import { zeroExRawHash } from './transport.ts';
import { EXECUTE_METATXN_SELECTOR, METATXN_TRANSFER_FROM_SELECTOR, OWNER_OF_SELECTOR, PERMIT2, PREV_SELECTOR, SETTLER_REGISTRY } from './quote.ts';

export const MOCK_SETTLER = '0x5ce929ddb01804bff35b2f5c77b735bdb094aac8', MOCK_PREVIOUS_SETTLER = '0x7c39a136ea20b3483e402ea031c1f3c019bab24b';
export const MOCK_RELAYER = '0x0000000000000000000000000000000000000e1e', MOCK_FEE_RECIPIENT = '0x9f6601854dee374b1bfaf6350ffd27a97309d431';
export const MOCK_ZEROX_KEY = 'mock-zeroex-loopback-key';
const MAX = (1n << 256n) - 1n;
const NONCE_BITMAP = '0x4fe02b44';

export type MockTrade = { readonly tradeHash: string; readonly taker: string; readonly sellToken: string; readonly buyToken: string; readonly sellAmount: bigint;
  readonly buyAmount: bigint; readonly minBuyAmount: bigint; readonly gasFee: bigint; readonly feeToken: string; readonly zeroExFee: bigint; readonly nonce: bigint;
  readonly deadline: number; readonly settler: string; readonly approval: { readonly value: bigint } | null };
export type ZeroExDoubleOptions = {
  readonly now: () => number;
  /** Buy-token units per sell-token unit, as a fraction (net of fees). Default 2.6e9 (100 USDG → 0.26 TSLA). */
  readonly price?: { readonly numerator: bigint; readonly denominator: bigint };
};
/** A scripted behaviour of the next answers (each test sets what it needs). */
export type ZeroExScript = {
  chains?: readonly number[]; liquidity?: boolean; gasFee?: bigint | null; feeToken?: 'sell' | 'buy'; zeroExFee?: bigint;
  /** Tokens whose EIP-2612 permit 0x offers as a gasless approval (else `issues.allowance` with no approval). */
  permitTokens?: Set<string>; approvalValue?: bigint | 'unlimited'; approvalType?: string;
  /** The Settler 0x signs the trade for (default the registry's current one). */ settler?: string;
  deadlineSeconds?: number; zeroSlippageStruct?: boolean; quoteError?: { status: number; name: string };
  submit?: 'accept' | 'timeout' | 'already' | { status: number; name: string } | 'wrong-hash';
  /** What the status endpoint says (default follows the settlement); `settle: false` keeps the trade pending. */
  settle?: boolean; status?: { status: 'pending' | 'submitted' | 'succeeded' | 'confirmed' | 'failed'; reason?: string; transactions?: string[] };
  /** The settled output (default the quoted buyAmount) and whether the relayer's transaction reverts. */
  received?: bigint; revert?: boolean; balanceIssue?: boolean; simulationIncomplete?: boolean;
};

/** The mock chain as the gasless path reads it: 0x's registry, the Settler's code and Permit2's nonce bitmap on top of the Robinhood mock. */
export function createZeroExDouble(chain: RobinhoodMockChain, options: ZeroExDoubleOptions) {
  const script: ZeroExScript = {};
  const registry = { current: MOCK_SETTLER as string | null, previous: MOCK_PREVIOUS_SETTLER as string | null };
  const usedNonces = new Map<string, number>();
  const trades = new Map<string, MockTrade>(), submitted: string[] = [], settlements = new Map<string, string>();
  const calls: { readonly method: 'GET' | 'POST'; readonly path: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown }[] = [];
  let nextNonce = 2_241_959_297_937_691_820_908_574_931_991_567n;
  for (const contract of [SETTLER_REGISTRY, MOCK_SETTLER, MOCK_PREVIOUS_SETTLER, PERMIT2]) chain.state.code.set(contract, '0x6080' + contract.slice(2, 6));
  const nonceKey = (owner: string, nonce: bigint) => `${owner.toLowerCase()}:${nonce}`;
  const blockOf = (tag: unknown) => tag === undefined || tag === 'latest' || tag === 'pending' ? chain.state.head : Number(BigInt(tag as string));
  const rpc: Rpc = async (method, params, context) => {
    if (method === 'eth_call') {
      const request = params[0] as { to: string; data: string };
      const to = request.to.toLowerCase(), data = request.data.toLowerCase();
      if (to === SETTLER_REGISTRY) {
        const answer = data.startsWith(OWNER_OF_SELECTOR) ? registry.current : data.startsWith(PREV_SELECTOR) ? registry.previous : null;
        if (!answer) throw new Error('execution reverted');
        return addressWord(answer);
      }
      if (to === PERMIT2 && data.startsWith(NONCE_BITMAP)) {
        const owner = '0x' + data.slice(10 + 24, 10 + 64), position = BigInt('0x' + data.slice(10 + 64, 10 + 128)), block = blockOf(params[1]);
        let bitmap = 0n;
        for (const [key, at] of usedNonces) {
          const [who, nonce] = key.split(':') as [string, string];
          if (who === owner && at <= block && BigInt(nonce) >> 8n === position) bitmap |= 1n << (BigInt(nonce) & 0xffn);
        }
        return word(bitmap);
      }
    }
    return chain.rpc(method, params, context);
  };
  const answer = (status: number, body: unknown): ZeroExAnswer => ({ status, body, rawHash: zeroExRawHash(body) });
  const error = (status: number, name: string, data: Record<string, unknown> = {}) => answer(status, { name, message: name, data: { zid: '0x111111111111111111111111', ...data } });
  const allowanceOf = (token: string, owner: string) => BigInt(chain.state.allowances.get(`${token.toLowerCase()}:${owner.toLowerCase()}:${PERMIT2}`) ?? 0n);
  function buildQuote(query: Readonly<Record<string, string>>) {
    const sellToken = query.sellToken!.toLowerCase(), buyToken = query.buyToken!.toLowerCase(), taker = query.taker!.toLowerCase();
    const sellAmount = BigInt(query.sellAmount!), slippageBps = BigInt(query.slippageBps ?? '50');
    const feeToken = script.feeToken === 'buy' ? buyToken : sellToken, zeroExFee = script.zeroExFee ?? 0n;
    const gasFee = script.gasFee === undefined ? 420_000n : script.gasFee;
    const price = options.price ?? { numerator: 2_600_000_000n, denominator: 1n };
    const netSell = feeToken === sellToken ? sellAmount - (gasFee ?? 0n) - zeroExFee : sellAmount;
    const gross = netSell * price.numerator / price.denominator, buyAmount = feeToken === buyToken ? gross - (gasFee ?? 0n) - zeroExFee : gross;
    const minBuyAmount = buyAmount * (10_000n - slippageBps) / 10_000n;
    const settler = script.settler ?? registry.current!, nonce = nextNonce++, deadline = Math.floor(options.now() / 1000) + (script.deadlineSeconds ?? 300);
    const action0 = METATXN_TRANSFER_FROM_SELECTOR + addressWord(settler).slice(2) + addressWord(sellToken).slice(2) + word(sellAmount).slice(2) + word(nonce).slice(2) + word(BigInt(deadline)).slice(2);
    const action1 = '0x38c9c147' + addressWord(sellToken).slice(2) + word(10_000n).slice(2);
    const zero = '0x' + '0'.repeat(40);
    const tradeTyped: eip712.TypedData = {
      types: { PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }, { name: 'slippageAndActions', type: 'SlippageAndActions' }],
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        SlippageAndActions: [{ name: 'recipient', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'actions', type: 'bytes[]' }] },
      domain: { name: 'Permit2', chainId: 4663, verifyingContract: PERMIT2 }, primaryType: 'PermitWitnessTransferFrom',
      message: { permitted: { token: sellToken, amount: sellAmount.toString() }, spender: settler, nonce: nonce.toString(), deadline: String(deadline),
        slippageAndActions: script.zeroSlippageStruct ? { recipient: zero, buyToken: zero, minAmountOut: '0', actions: [action0, action1] }
          : { recipient: taker, buyToken, minAmountOut: minBuyAmount.toString(), actions: [action0, action1] } } };
    const short = allowanceOf(sellToken, taker) < sellAmount;
    const approvalValue = script.approvalValue === 'unlimited' ? MAX : script.approvalValue ?? sellAmount;
    const approvalTyped: eip712.TypedData | null = short && (script.permitTokens?.has(sellToken) ?? false) ? {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      domain: { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: sellToken }, primaryType: 'Permit',
      message: { owner: taker, spender: PERMIT2, value: approvalValue.toString(), nonce: 0, deadline: String(deadline + 300) } } : null;
    const tradeHash = eip712.hashTypedData(tradeTyped);
    trades.set(tradeHash, { tradeHash, taker, sellToken, buyToken, sellAmount, buyAmount, minBuyAmount, gasFee: gasFee ?? 0n, feeToken, zeroExFee, nonce, deadline, settler,
      approval: approvalTyped ? { value: approvalValue } : null });
    const fee = (amount: bigint | null, type: 'gas' | 'volume') => amount === null ? null : { amount: amount.toString(), token: feeToken, type };
    return { allowanceTarget: PERMIT2, approval: approvalTyped ? { type: script.approvalType ?? 'permit', hash: eip712.hashTypedData(approvalTyped), eip712: approvalTyped } : null,
      blockNumber: String(chain.state.head), buyAmount: buyAmount.toString(), buyToken, fees: { integratorFee: null, integratorFees: null,
        zeroExFee: zeroExFee > 0n ? fee(zeroExFee, 'volume') : null, gasFee: fee(gasFee, 'gas') },
      issues: { allowance: short ? { actual: allowanceOf(sellToken, taker).toString(), spender: PERMIT2 } : null,
        balance: script.balanceIssue ? { token: sellToken, actual: '0', expected: sellAmount.toString() } : null,
        simulationIncomplete: script.simulationIncomplete ?? false, invalidSourcesPassed: [] },
      liquidityAvailable: true, minBuyAmount: minBuyAmount.toString(),
      route: { fills: [{ from: sellToken, to: buyToken, source: '0x_RFQ', proportionBps: '10000' }], tokens: [{ address: sellToken, symbol: 'SELL' }, { address: buyToken, symbol: 'BUY' }] },
      sellAmount: sellAmount.toString(), sellToken, target: settler,
      tokenMetadata: { buyToken: { buyTaxBps: '0', sellTaxBps: '0', transferTaxBps: null }, sellToken: { buyTaxBps: '0', sellTaxBps: '0', transferTaxBps: '0' } },
      trade: { type: 'settler_metatransaction', hash: tradeHash, eip712: tradeTyped }, zid: '0x111111111111111111111111' };
  }
  /** Plays 0x's relayer: one transaction to the Settler in a new block; the owner's sell amount moves, the buy amount arrives, the nonce is used. */
  function settle(tradeHash: string): string {
    const trade = trades.get(tradeHash) ?? (() => { throw new Error('MOCK_TRADE_UNKNOWN'); })();
    chain.mine(1);
    const head = chain.state.head, logs: Record<string, unknown>[] = [];
    const stock = (token: string) => chain.state.stocks.has(token);
    const transfer = (token: string, from: string, to: string, amount: bigint) => {
      chain.fund(token, from, chain.balance(token, from) - amount);
      chain.fund(token, to, chain.balance(token, to) + amount);
      logs.push({ address: token, topics: [TRANSFER_TOPIC, addressWord(from), addressWord(to)], data: word(amount) });
      if (stock(token)) logs.push({ address: token, topics: [SCALED_TRANSFER_TOPIC, addressWord(from), addressWord(to)], data: word(amount) + word(amount).slice(2) });
    };
    const hash = '0x' + createHash('sha256').update(`zeroex-settlement-${tradeHash}-${settlements.size}`).digest('hex');
    if (!script.revert) {
      if (trade.approval) {
        chain.state.allowances.set(`${trade.sellToken}:${trade.taker}:${PERMIT2}`, trade.approval.value);
        logs.push({ address: trade.sellToken, topics: [APPROVAL_TOPIC, addressWord(trade.taker), addressWord(PERMIT2)], data: word(trade.approval.value) });
      }
      const allowance = allowanceOf(trade.sellToken, trade.taker);
      if (allowance < trade.sellAmount || chain.balance(trade.sellToken, trade.taker) < trade.sellAmount) throw new Error('MOCK_SETTLEMENT_UNFUNDED');
      if (allowance !== MAX) chain.state.allowances.set(`${trade.sellToken}:${trade.taker}:${PERMIT2}`, allowance - trade.sellAmount);
      transfer(trade.sellToken, trade.taker, trade.settler, trade.sellAmount);
      const fees = trade.gasFee + trade.zeroExFee, received = script.received ?? trade.buyAmount, pool = '0x00000000000000000000000000000000000b0011';
      if (trade.feeToken === trade.sellToken) transfer(trade.sellToken, trade.settler, MOCK_FEE_RECIPIENT, fees);
      chain.fund(trade.buyToken, pool, chain.balance(trade.buyToken, pool) + received + (trade.feeToken === trade.buyToken ? fees : 0n));
      transfer(trade.sellToken, trade.settler, pool, chain.balance(trade.sellToken, trade.settler));
      transfer(trade.buyToken, pool, trade.settler, received + (trade.feeToken === trade.buyToken ? fees : 0n));
      if (trade.feeToken === trade.buyToken) transfer(trade.buyToken, trade.settler, MOCK_FEE_RECIPIENT, fees);
      transfer(trade.buyToken, trade.settler, trade.taker, received);
      usedNonces.set(nonceKey(trade.taker, trade.nonce), head);
    }
    const nonce = chain.state.nonces.get(MOCK_RELAYER) ?? 0;
    chain.state.nonces.set(MOCK_RELAYER, nonce + 1);
    return recordSettlement(hash, head, nonce, logs, trade);
  }
  function recordSettlement(hash: string, head: number, nonce: number, logs: Record<string, unknown>[], trade: MockTrade): string {
    const blockNumber = '0x' + head.toString(16);
    // The mock chain derives block hashes lazily (synchronously inside its read); ask once so the receipt carries the canonical one.
    if (!chain.state.hashes.has(head)) void chain.rpc('eth_getBlockByNumber', [blockNumber, false]);
    const blockHash = chain.state.hashes.get(head)!;
    chain.state.transactions.set(hash, { hash, from: MOCK_RELAYER, to: trade.settler, input: EXECUTE_METATXN_SELECTOR + '00'.repeat(32), value: '0x0', chainId: chain.state.chainHex,
      type: '0x2', nonce: '0x' + nonce.toString(16), blockHash, blockNumber, gas: '0x' + (400_000).toString(16), maxFeePerGas: '0x' + (chain.state.gasPrice * 3n).toString(16) });
    chain.state.receipts.set(hash, { transactionHash: hash, status: script.revert ? '0x0' : '0x1', blockNumber, blockHash, from: MOCK_RELAYER, to: trade.settler,
      gasUsed: '0x' + (250_000).toString(16), effectiveGasPrice: '0x' + chain.state.gasPrice.toString(16), gasUsedForL1: '0x0', logs: script.revert ? [] : logs });
    settlements.set(trade.tradeHash, hash);
    return hash;
  }
  const http: ZeroExHttp = {
    async get(path, query) {
      calls.push({ method: 'GET', path, query });
      if (path === '/gasless/chains') return answer(200, { chains: (script.chains ?? [1, 8453, 42161, 4663]).map(chainId => ({ chainId, chainName: `chain-${chainId}` })), zid: '0x1' });
      if (path === '/gasless/quote') {
        if (script.quoteError) return error(script.quoteError.status, script.quoteError.name);
        if (script.liquidity === false) return answer(200, { liquidityAvailable: false, zid: '0x2' });
        return answer(200, buildQuote(query));
      }
      const status = /^\/gasless\/status\/(0x[0-9a-f]{64})$/.exec(path);
      if (status) {
        const tradeHash = status[1]!;
        if (!submitted.includes(tradeHash)) return error(404, 'META_TRANSACTION_STATUS_NOT_FOUND');
        const settled = settlements.get(tradeHash);
        const scripted = script.status;
        const body = scripted ? { status: scripted.status, ...scripted.reason ? { reason: scripted.reason } : {},
          transactions: (scripted.transactions ?? (settled ? [settled] : [])).map(hash => ({ hash, timestamp: options.now() })), zid: '0x3' }
          : { status: settled ? 'confirmed' : 'submitted', transactions: settled ? [{ hash: settled, timestamp: options.now() }] : [], zid: '0x3' };
        return answer(200, body);
      }
      throw new Error('MOCK_ZEROX_UNKNOWN_PATH ' + path);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (path !== '/gasless/submit') throw new Error('MOCK_ZEROX_UNKNOWN_PATH ' + path);
      const request = body as { chainId: number; trade: { eip712: eip712.TypedData; signature: { v: number; r: string; s: string } };
        approval?: { eip712: eip712.TypedData; signature: { v: number; r: string; s: string } } };
      const tradeHash = eip712.hashTypedData(request.trade.eip712), trade = trades.get(tradeHash);
      const signer = (typed: eip712.TypedData, sig: { v: number; r: string; s: string }) =>
        eip712.recoverTypedDataSigner(eip712.hashTypedData(typed), sig.r + sig.s.slice(2) + sig.v.toString(16));
      if (script.submit === 'timeout') { submitted.push(tradeHash); if (script.settle !== false) settle(tradeHash); throw new Error('ZEROX_PROVIDER_UNAVAILABLE'); }
      if (script.submit === 'already') { submitted.push(tradeHash); return error(400, 'TRADE_ALREADY_SUBMITTED', { tradeHash }); }
      if (script.submit && typeof script.submit === 'object') return error(script.submit.status, script.submit.name);
      if (!trade || signer(request.trade.eip712, request.trade.signature) !== trade.taker ||
          (trade.approval ? !request.approval || signer(request.approval.eip712, request.approval.signature) !== trade.taker : request.approval !== undefined))
        return error(400, 'INVALID_SIGNATURE');
      submitted.push(tradeHash);
      if (script.settle !== false) settle(tradeHash);
      return answer(201, { tradeHash: script.submit === 'wrong-hash' ? '0x' + 'ab'.repeat(32) : tradeHash, type: 'settler_metatransaction', zid: '0x4' });
    },
  };
  return { http, rpc, script, registry, calls, trades, submitted, settle, settlements, usedNonces };
}
export type ZeroExDouble = ReturnType<typeof createZeroExDouble>;
