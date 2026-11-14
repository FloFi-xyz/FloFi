// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): FloFi's own JSON-RPC client for Pimlico's hosted Kora endpoint — server-side only.
 * No `@solana/kora` dependency (its published peers do not match the pinned `@solana/kit`); the five methods Pimlico implements, nothing else:
 *
 *   getPayerSigner            → { signer_address, payment_address }
 *   getSupportedTokens        → { tokens }
 *   getBlockhash              → { blockhash }                       (unused by the builders: FloFi's own RPC gives the validity window)
 *   estimateTransactionFee    { transaction, fee_token } → { fee_in_lamports, fee_in_token, signer_pubkey, payment_address }
 *   signAndSendTransaction    { transaction, respond_after: 'signed' } → { signature, signed_transaction, signer_pubkey }
 *
 * HTTPS on the pinned host only (`config.ts`; plain http on 127.0.0.1 for the loopback double), no redirects, a timeout, a bounded body, strict
 * parsing. Every failure is a closed code; the endpoint URL (it carries the API key in its query) never appears in an error, a log or a cause.
 * `signAndSendTransaction` is a new execution: it passes the operator's execution pause at the network boundary, like `sendTransaction`.
 */
import { assertExecutionEnabled } from '../../server/execution-guard.ts';

export const KORA_CODES = Object.freeze({
  refused: 'KORA_TRANSACTION_REFUSED', paymentInsufficient: 'KORA_PAYMENT_INSUFFICIENT', unavailable: 'KORA_PROVIDER_UNAVAILABLE',
  feeAccountMissing: 'KORA_FEE_TOKEN_ACCOUNT_MISSING', rateLimited: 'KORA_RATE_LIMITED', unknown: 'KORA_ERROR_UNKNOWN', unreachable: 'KORA_UNREACHABLE',
  invalid: 'KORA_RESPONSE_INVALID',
});
/**
 * JSON-RPC error codes Kora answers from its validation BEFORE it signs (Pimlico error reference): -32000 the transaction was refused (invalid,
 * its simulation failed, the token payment is insufficient), -32602 invalid params, -32050 an account was not found. Never -32603 (internal: it
 * may have signed), never an HTTP-level failure (a gateway may answer after Kora signed), never a rate limit.
 */
const PRE_SIGNING_RPC_CODES: ReadonlySet<number> = new Set([-32000, -32602, -32050]);
/** Errors this client raised for exactly such an answer (only this module can mark one). */
const refusedBeforeSigning = new WeakSet<Error>();
/**
 * Kora's own answer proves it refused BEFORE signing: a 2xx response whose body is a well-formed JSON-RPC 2.0 error object (integer code, string
 * message) with a pre-signing validation code. It proves nothing about these bytes unless it answered the FIRST call for them (a later call may be
 * refused because an earlier one was signed and landed): the caller decides that (`runtime.ts`).
 */
export const isKoraRefusalBeforeSigning = (cause: unknown): boolean => cause instanceof Error && refusedBeforeSigning.has(cause);
export type KoraEstimate = { readonly feeInLamports: string; readonly feeInToken: string; readonly signerPubkey: string; readonly paymentAddress: string };
export type KoraSigned = { readonly signature: string; readonly signedTransaction: string; readonly signerPubkey: string };
export type KoraClient = {
  getPayerSigner(): Promise<{ readonly signerAddress: string; readonly paymentAddress: string }>;
  getSupportedTokens(): Promise<readonly string[]>;
  getBlockhash(): Promise<string>;
  estimateTransactionFee(transaction: string, feeToken: string): Promise<KoraEstimate>;
  signAndSendTransaction(transaction: string): Promise<KoraSigned>;
};
export type KoraTransport = (url: string, init: RequestInit) => Promise<Response>;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, BASE64 = /^[A-Za-z0-9+/]{4,1704}={0,2}$/;
const MAX_BODY = 262_144;
/** Never let the API key (or anything shaped like a key) leave this module: provider messages are scrubbed and bounded. */
export const redactKoraText = (text: string): string => text.replace(/https?:\/\/\S+/gi, '[url]').replace(/(api[-_]?key|token|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 200);
const failure = (code: string, detail?: Readonly<Record<string, unknown>>): Error => new Error(code, detail ? { cause: detail } : undefined);
const record = (v: unknown, method: string): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : (() => { throw failure(KORA_CODES.invalid, { method }); })();
const key = (v: unknown, method: string): string => typeof v === 'string' && BASE58.test(v) ? v : (() => { throw failure(KORA_CODES.invalid, { method }); })();
/** An unsigned 64-bit amount as Kora sends it (a JSON number, kept exact by the reviver below, or a decimal string). */
const units = (v: unknown, method: string): string => {
  const text = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) ? v : null;
  if (text === null || BigInt(text) > 0xffff_ffff_ffff_ffffn) throw failure(KORA_CODES.invalid, { method });
  return text;
};
/** A JSON-RPC error object → its closed code (Pimlico error reference): -32000 refused (insufficient payment named), -32603 unavailable, -32050 account. */
export function koraErrorCode(error: { code?: unknown; message?: unknown }): string {
  const code = typeof error.code === 'number' ? error.code : NaN, message = typeof error.message === 'string' ? error.message : '';
  if (code === -32000) return /insufficient token payment/i.test(message) ? KORA_CODES.paymentInsufficient : KORA_CODES.refused;
  if (code === -32603) return KORA_CODES.unavailable;
  if (code === -32050) return KORA_CODES.feeAccountMissing;
  if (code === -32005 && /rate/i.test(message) || code === 429) return KORA_CODES.rateLimited;
  if ([-32001, -32003, -32004, -32005, -32006].includes(code)) return KORA_CODES.refused;
  return KORA_CODES.unknown;
}

/**
 * `url`: the configured endpoint (`readKoraGasConfig`), already pinned to https://solana.pimlico.io/v1/mainnet/rpc or the loopback double.
 * `transport`: `fetch` in production; tests pass the same `fetch` against a loopback double.
 */
export function createKoraClient(url: string, options: { readonly transport?: KoraTransport; readonly timeoutMs?: number; readonly signTimeoutMs?: number } = {}): KoraClient {
  const parsed = new URL(url);
  if (!(parsed.protocol === 'https:' && parsed.hostname === 'solana.pimlico.io' && !parsed.port) && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))
    throw new Error('KORA_CONFIGURATION_INVALID');
  const transport = options.transport ?? ((input, init) => fetch(input, init));
  let id = 0;
  async function call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (method === 'signAndSendTransaction') assertExecutionEnabled();
    let response: Response;
    try {
      response = await transport(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    } catch {
      // Timeout, connection loss, a redirect: whether the request reached Kora is unknown (the URL is never part of the error).
      throw failure(KORA_CODES.unreachable, { method });
    }
    if (response.status === 429) throw failure(KORA_CODES.rateLimited, { method });
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY) throw failure(KORA_CODES.invalid, { method });
    let text: string;
    try { text = await boundedText(response); } catch { throw failure(KORA_CODES.unreachable, { method }); }
    if (text.length > MAX_BODY) throw failure(KORA_CODES.invalid, { method });
    let body: unknown;
    try {
      // Large integers keep their exact decimal lexeme (Node 24's reviver context), never a rounded Number.
      body = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
        typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^[0-9]+$/.test(context.source) ? context.source : value);
    } catch { throw failure(response.ok ? KORA_CODES.invalid : KORA_CODES.unavailable, { method, status: response.status }); }
    const envelope = record(body, method);
    if (envelope.error !== undefined && envelope.error !== null) {
      const error = record(envelope.error, method);
      const raised = failure(koraErrorCode(error), { method, rpcCode: typeof error.code === 'number' ? error.code : null, message: redactKoraText(String(error.message ?? '')) });
      if (response.ok && envelope.jsonrpc === '2.0' && Number.isSafeInteger(error.code) && typeof error.message === 'string' && PRE_SIGNING_RPC_CODES.has(error.code as number))
        refusedBeforeSigning.add(raised);
      throw raised;
    }
    if (!response.ok) throw failure(response.status >= 500 ? KORA_CODES.unavailable : KORA_CODES.invalid, { method, status: response.status });
    if (envelope.jsonrpc !== '2.0' || !('result' in envelope)) throw failure(KORA_CODES.invalid, { method });
    return envelope.result;
  }
  const timeout = options.timeoutMs ?? 10_000, signTimeout = options.signTimeoutMs ?? 20_000;
  return {
    async getPayerSigner() {
      const r = record(await call('getPayerSigner', {}, timeout), 'getPayerSigner');
      return { signerAddress: key(r.signer_address, 'getPayerSigner'), paymentAddress: key(r.payment_address, 'getPayerSigner') };
    },
    async getSupportedTokens() {
      const r = record(await call('getSupportedTokens', {}, timeout), 'getSupportedTokens');
      if (!Array.isArray(r.tokens) || r.tokens.length > 64) throw failure(KORA_CODES.invalid, { method: 'getSupportedTokens' });
      return r.tokens.map(t => key(t, 'getSupportedTokens'));
    },
    async getBlockhash() {
      return key(record(await call('getBlockhash', {}, timeout), 'getBlockhash').blockhash, 'getBlockhash');
    },
    async estimateTransactionFee(transaction, feeToken) {
      const r = record(await call('estimateTransactionFee', { transaction, fee_token: feeToken }, timeout), 'estimateTransactionFee');
      return { feeInLamports: units(r.fee_in_lamports, 'estimateTransactionFee'), feeInToken: units(r.fee_in_token, 'estimateTransactionFee'),
        signerPubkey: key(r.signer_pubkey, 'estimateTransactionFee'), paymentAddress: key(r.payment_address, 'estimateTransactionFee') };
    },
    async signAndSendTransaction(transaction) {
      // `signed`: Kora answers as soon as it signed (it also broadcasts in the background); FloFi then broadcasts the same bytes itself.
      const r = record(await call('signAndSendTransaction', { transaction, respond_after: 'signed' }, signTimeout), 'signAndSendTransaction');
      if (typeof r.signature !== 'string' || !SIGNATURE.test(r.signature) || typeof r.signed_transaction !== 'string' || !BASE64.test(r.signed_transaction))
        throw failure(KORA_CODES.invalid, { method: 'signAndSendTransaction' });
      return { signature: r.signature, signedTransaction: r.signed_transaction, signerPubkey: key(r.signer_pubkey, 'signAndSendTransaction') };
    },
  };
}
/** The response body, read incrementally and abandoned past the bound (a declared length can lie). */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel().catch(() => undefined); return 'x'.repeat(MAX_BODY + 1); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
