// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): FloFi's 0x Gasless API v2 client — four calls over the bounded transport, each
 * answer parsed strictly. FloFi never asks for an integrator fee, a surplus recipient or a different recipient: the owner is the taker and
 * receives the swap. `/gasless/chains` must list the chain (a positive answer is remembered for ten minutes per process; a negative one or a
 * failure is never remembered). `submit` returns what 0x definitively said; every failure to get a definitive answer throws, and the caller
 * treats that as "the result is unknown" — it observes by trade hash and never submits again.
 */
import { parseGaslessChains, parseGaslessQuote, parseGaslessStatus, zeroExErrorCode, type GaslessQuoteRequest, type GaslessStatus, type ParsedQuote,
  type TypedData } from './quote.ts';
import type { ZeroExHttp } from './transport.ts';

export type GaslessSignature = { readonly signatureType: 2; readonly v: 27 | 28; readonly r: string; readonly s: string };
export type GaslessSubmission = { readonly chainId: number;
  readonly trade: { readonly type: 'settler_metatransaction'; readonly eip712: TypedData; readonly signature: GaslessSignature };
  readonly approval?: { readonly type: 'permit' | 'erc7597Permit'; readonly eip712: TypedData; readonly signature: GaslessSignature } };
/** What 0x definitively answered to a submission. */
export type SubmitAnswer = { readonly kind: 'ACCEPTED'; readonly tradeHash: string } | { readonly kind: 'ALREADY_SUBMITTED'; readonly tradeHash: string | null }
  | { readonly kind: 'REFUSED'; readonly code: string };
export type ZeroExGaslessClient = {
  readonly supports: (chainId: number) => Promise<boolean>;
  readonly quote: (request: GaslessQuoteRequest) => Promise<{ readonly parsed: ParsedQuote; readonly rawHash: string }>;
  readonly submit: (submission: GaslessSubmission) => Promise<SubmitAnswer>;
  /** null: 0x does not know the trade (yet). */
  readonly status: (tradeHash: string, chainId: number) => Promise<GaslessStatus | null>;
};
const fail = (code: string): never => { throw new Error(code); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const CHAINS_TTL_MS = 600_000;

export function createZeroExGaslessClient(http: ZeroExHttp, now: () => number = Date.now): ZeroExGaslessClient {
  let supported: { readonly chains: readonly number[]; readonly at: number } | null = null;
  return {
    async supports(chainId) {
      if (supported && now() - supported.at < CHAINS_TTL_MS && now() >= supported.at) return supported.chains.includes(chainId);
      const answer = await http.get('/gasless/chains', {});
      if (answer.status !== 200) fail(zeroExErrorCode(answer.status, answer.body));
      const chains = parseGaslessChains(answer.body);
      if (chains.includes(chainId)) supported = { chains, at: now() };
      return chains.includes(chainId);
    },
    async quote(request) {
      if (!/^0x[0-9a-f]{40}$/.test(request.taker) || !/^0x[0-9a-f]{40}$/.test(request.sellToken) || !/^0x[0-9a-f]{40}$/.test(request.buyToken) ||
          !/^[1-9][0-9]{0,77}$/.test(request.sellAmount) || !Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > 300)
        fail('ZEROX_REQUEST_INVALID');
      // No swapFee*, tradeSurplus* or recipient parameter: FloFi takes nothing and the owner receives the swap.
      const answer = await http.get('/gasless/quote', { chainId: String(request.chainId), sellToken: request.sellToken, buyToken: request.buyToken,
        sellAmount: request.sellAmount, taker: request.taker, slippageBps: String(request.slippageBps) });
      if (answer.status !== 200) fail(zeroExErrorCode(answer.status, answer.body));
      return { parsed: parseGaslessQuote(answer.body), rawHash: answer.rawHash };
    },
    async submit(submission) {
      const answer = await http.post('/gasless/submit', submission);
      if (answer.status === 200 || answer.status === 201) {
        const body = isRecord(answer.body) ? answer.body : null;
        if (!body || typeof body.tradeHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.tradeHash) || body.type !== 'settler_metatransaction')
          return fail('ZEROX_PROVIDER_RESPONSE_INVALID');
        return { kind: 'ACCEPTED', tradeHash: (body.tradeHash as string).toLowerCase() };
      }
      const code = zeroExErrorCode(answer.status, answer.body);
      if (code === 'ZEROX_TRADE_ALREADY_SUBMITTED') {
        const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : {};
        return { kind: 'ALREADY_SUBMITTED', tradeHash: typeof data.tradeHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data.tradeHash) ? data.tradeHash.toLowerCase() : null };
      }
      // Only 0x's own closed 4xx refusals are definitive; anything else (an unknown envelope) is not proof that nothing was accepted.
      if (answer.status >= 400 && answer.status < 500 && !code.startsWith('ZEROX_PROVIDER_')) return { kind: 'REFUSED', code };
      return fail(code);
    },
    async status(tradeHash, chainId) {
      if (!/^0x[0-9a-f]{64}$/.test(tradeHash)) fail('ZEROX_REQUEST_INVALID');
      const answer = await http.get(`/gasless/status/${tradeHash}`, { chainId: String(chainId) });
      if (answer.status === 404 && zeroExErrorCode(404, answer.body) === 'ZEROX_STATUS_NOT_FOUND') return null;
      if (answer.status !== 200) fail(zeroExErrorCode(answer.status, answer.body));
      return parseGaslessStatus(answer.body);
    },
  };
}
