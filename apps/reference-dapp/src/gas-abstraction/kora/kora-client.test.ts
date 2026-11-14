// SPDX-License-Identifier: AGPL-3.0-only
/** ADR-0010 §4: FloFi's Kora JSON-RPC client and runtime against in-process fake transports (no network, no provider). */
import { afterEach, describe, expect, it } from 'vitest';
import { createKoraClient, isKoraRefusalBeforeSigning, koraErrorCode, redactKoraText, KORA_CODES, type KoraClient, type KoraTransport } from './client';
import { createKoraGas, withKoraFallback } from './runtime';
import { readKoraGasConfig } from '../config';

const URL_WITH_KEY = 'https://solana.pimlico.io/v1/mainnet/rpc?apikey=sk-secret-123456';
const SIGNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', PAYMENT = '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const reply = (body: unknown, status = 200): KoraTransport => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const requests: { url: string; init: RequestInit }[] = [];
const recording = (body: unknown): KoraTransport => async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(body)); };
afterEach(() => { requests.length = 0; delete process.env.FLOFI_EXECUTION_PAUSED; });
const message = async (promise: Promise<unknown>) => { try { await promise; return null; } catch (cause) { return cause as Error & { cause?: unknown }; } };

describe('Kora JSON-RPC client', () => {
  it('pins the host: only https on solana.pimlico.io (no port) or the loopback double', () => {
    expect(() => createKoraClient('https://solana.pimlico.io.evil.example/v1/mainnet/rpc')).toThrow('KORA_CONFIGURATION_INVALID');
    expect(() => createKoraClient('http://solana.pimlico.io/v1/mainnet/rpc')).toThrow('KORA_CONFIGURATION_INVALID');
    expect(() => createKoraClient('https://solana.pimlico.io:8443/v1/mainnet/rpc')).toThrow('KORA_CONFIGURATION_INVALID');
    expect(() => createKoraClient('http://127.0.0.1:9/v1/mainnet/rpc')).not.toThrow();
  });
  it('posts one JSON-RPC request with snake_case params, no redirects and a timeout', async () => {
    const client = createKoraClient(URL_WITH_KEY, { transport: recording({ jsonrpc: '2.0', id: 1, result: { fee_in_lamports: 2049280, fee_in_token: 241000, signer_pubkey: SIGNER, payment_address: PAYMENT } }) });
    await expect(client.estimateTransactionFee('AQ==', USDC)).resolves.toEqual({ feeInLamports: '2049280', feeInToken: '241000', signerPubkey: SIGNER, paymentAddress: PAYMENT });
    expect(requests[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({ jsonrpc: '2.0', method: 'estimateTransactionFee', params: { transaction: 'AQ==', fee_token: USDC } });
  });
  it('keeps a large integer exact and refuses malformed answers', async () => {
    const exact = createKoraClient(URL_WITH_KEY, { transport: reply('{"jsonrpc":"2.0","id":1,"result":{"fee_in_lamports":18446744073709551615,"fee_in_token":1,"signer_pubkey":"' + SIGNER + '","payment_address":"' + PAYMENT + '"}}') });
    await expect(exact.estimateTransactionFee('AQ==', USDC)).resolves.toMatchObject({ feeInLamports: '18446744073709551615' });
    for (const result of [{ fee_in_lamports: -1, fee_in_token: 1, signer_pubkey: SIGNER, payment_address: PAYMENT }, { fee_in_lamports: 1, fee_in_token: '1.5', signer_pubkey: SIGNER, payment_address: PAYMENT },
      { fee_in_lamports: 1, fee_in_token: 1, signer_pubkey: 'not-a-key', payment_address: PAYMENT }, null])
      expect((await message(createKoraClient(URL_WITH_KEY, { transport: reply({ jsonrpc: '2.0', id: 1, result }) }).estimateTransactionFee('AQ==', USDC)))?.message).toBe(KORA_CODES.invalid);
    const sign = createKoraClient(URL_WITH_KEY, { transport: reply({ jsonrpc: '2.0', id: 1, result: { signature: 'short', signed_transaction: 'AQ==', signer_pubkey: SIGNER } }) });
    expect((await message(sign.signAndSendTransaction('AQ==')))?.message).toBe(KORA_CODES.invalid);
    expect((await message(createKoraClient(URL_WITH_KEY, { transport: reply('x'.repeat(300_000)) }).getBlockhash()))?.message).toBe(KORA_CODES.invalid);
  });
  it('maps Pimlico\'s errors to closed codes and never echoes the endpoint or its key', async () => {
    expect(koraErrorCode({ code: -32000, message: 'Insufficient token payment. Required 2049280 lamports' })).toBe('KORA_PAYMENT_INSUFFICIENT');
    expect(koraErrorCode({ code: -32000, message: 'The fee payer is not the address from getPayerSigner' })).toBe('KORA_TRANSACTION_REFUSED');
    expect(koraErrorCode({ code: -32603, message: 'Solana paymaster unavailable' })).toBe('KORA_PROVIDER_UNAVAILABLE');
    expect(koraErrorCode({ code: -32050, message: 'Account not found' })).toBe('KORA_FEE_TOKEN_ACCOUNT_MISSING');
    expect(koraErrorCode({ code: -31999, message: '?' })).toBe('KORA_ERROR_UNKNOWN');
    const leak = createKoraClient(URL_WITH_KEY, { transport: reply({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `bad request to ${URL_WITH_KEY} apikey=sk-secret-123456` } }) });
    const error = await message(leak.getPayerSigner());
    expect(error?.message).toBe('KORA_TRANSACTION_REFUSED');
    expect(JSON.stringify({ message: error?.message, cause: error?.cause })).not.toContain('sk-secret');
    expect(redactKoraText(`see ${URL_WITH_KEY}`)).toBe('see [url]');
    const lost = createKoraClient(URL_WITH_KEY, { transport: async () => { throw new TypeError(`fetch failed ${URL_WITH_KEY}`); } });
    const unreachable = await message(lost.signAndSendTransaction('AQ=='));
    expect(unreachable?.message).toBe('KORA_UNREACHABLE');
    expect(JSON.stringify(unreachable?.cause)).not.toContain('sk-secret');
    expect((await message(createKoraClient(URL_WITH_KEY, { transport: reply('', 429) }).getSupportedTokens()))?.message).toBe('KORA_RATE_LIMITED');
    expect((await message(createKoraClient(URL_WITH_KEY, { transport: reply('<html>', 502) }).getSupportedTokens()))?.message).toBe('KORA_PROVIDER_UNAVAILABLE');
  });
  // K1: only Kora's own well-formed JSON-RPC answer with a pre-signing validation code proves it did not sign; nothing at the HTTP level does.
  it('marks as a refusal before signing only a 2xx JSON-RPC 2.0 error with a pre-signing code (-32000, -32602, -32050)', async () => {
    const refusal = async (body: unknown, status = 200) => {
      const error = await message(createKoraClient(URL_WITH_KEY, { transport: reply(body, status) }).signAndSendTransaction('AQ=='));
      return { code: error?.message, definitive: isKoraRefusalBeforeSigning(error) };
    };
    const rpc = (code: unknown, text: unknown = 'refused') => ({ jsonrpc: '2.0', id: 1, error: { code, message: text } });
    expect(await refusal(rpc(-32000, 'Insufficient token payment. Required 5000 lamports'))).toEqual({ code: 'KORA_PAYMENT_INSUFFICIENT', definitive: true });
    expect(await refusal(rpc(-32000, 'Transaction simulation failed'))).toEqual({ code: 'KORA_TRANSACTION_REFUSED', definitive: true });
    expect(await refusal(rpc(-32602, 'Invalid params'))).toMatchObject({ definitive: true });
    expect(await refusal(rpc(-32050, 'Account not found'))).toEqual({ code: 'KORA_FEE_TOKEN_ACCOUNT_MISSING', definitive: true });
    // Kora may have signed: internal errors, gateways, rate limits, malformed or non-2xx error envelopes and unknown codes prove nothing.
    expect(await refusal(rpc(-32603, 'Solana paymaster unavailable'))).toEqual({ code: 'KORA_PROVIDER_UNAVAILABLE', definitive: false });
    expect(await refusal('<html>504 Gateway Time-out</html>', 504)).toEqual({ code: 'KORA_PROVIDER_UNAVAILABLE', definitive: false });
    expect(await refusal('', 429)).toEqual({ code: 'KORA_RATE_LIMITED', definitive: false });
    expect(await refusal(rpc(-32005, 'rate limited'))).toEqual({ code: 'KORA_RATE_LIMITED', definitive: false });
    expect(await refusal(rpc(-32000), 500)).toMatchObject({ definitive: false });
    expect(await refusal(rpc(-32000), 400)).toMatchObject({ definitive: false });
    expect(await refusal(rpc('-32000'))).toMatchObject({ definitive: false });
    expect(await refusal(rpc(-32000, { text: 'x' }))).toMatchObject({ definitive: false });
    expect(await refusal({ jsonrpc: '1.0', id: 1, error: { code: -32000, message: 'refused' } })).toMatchObject({ definitive: false });
    expect(await refusal(rpc(-32001))).toEqual({ code: 'KORA_TRANSACTION_REFUSED', definitive: false });
    expect(isKoraRefusalBeforeSigning(new Error('KORA_TRANSACTION_REFUSED'))).toBe(false);
  });
  it('passes the operator\'s execution pause before signAndSendTransaction leaves the process', async () => {
    process.env.FLOFI_EXECUTION_PAUSED = 'true';
    const client = createKoraClient(URL_WITH_KEY, { transport: recording({ jsonrpc: '2.0', id: 1, result: {} }) });
    expect((await message(client.signAndSendTransaction('AQ==')))?.message).toBe('EXECUTION_PAUSED');
    expect(requests).toEqual([]);
  });
});

describe('Kora runtime (pins, tokens, policy)', () => {
  const config = readKoraGasConfig({ FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: URL_WITH_KEY, FLOFI_KORA_SIGNER: SIGNER, FLOFI_KORA_PAYMENT_ADDRESS: PAYMENT,
    FLOFI_KORA_FEE_TOKENS: 'USDC,USDT' });
  const fake = (payer: { signerAddress: string; paymentAddress: string }, tokens: string[]): KoraClient => ({ getPayerSigner: async () => payer, getSupportedTokens: async () => tokens,
    getBlockhash: async () => SIGNER, estimateTransactionFee: async () => { throw new Error('unused'); }, signAndSendTransaction: async () => { throw new Error('unused'); } });
  it('intersects FloFi\'s fee tokens with Kora\'s and refuses a provider naming another signer or payment address', async () => {
    if (!config.enabled) throw new Error('config');
    await expect(createKoraGas(config, fake({ signerAddress: SIGNER, paymentAddress: PAYMENT }, [USDT])).port.tokens()).resolves.toEqual([{ symbol: 'USDT', mint: USDT, decimals: 6 }]);
    await expect(createKoraGas(config, fake({ signerAddress: PAYMENT, paymentAddress: PAYMENT }, [USDC])).port.tokens()).rejects.toThrow('KORA_SIGNER_MISMATCH');
    await expect(createKoraGas(config, fake({ signerAddress: SIGNER, paymentAddress: SIGNER }, [USDC])).port.tokens()).rejects.toThrow('KORA_SIGNER_MISMATCH');
    await expect(createKoraGas(config, fake({ signerAddress: SIGNER, paymentAddress: PAYMENT }, [])).port.tokens()).rejects.toThrow('KORA_FEE_TOKEN_UNSUPPORTED');
  });
  it('builds native first; tries Kora only after a SOL shortfall; surfaces Kora\'s own reason or keeps the native error', async () => {
    const fail = (code: string) => async () => { throw new Error(code); };
    await expect(withKoraFallback(async () => 'native', fail('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT'))).resolves.toBe('native');
    await expect(withKoraFallback(fail('JUPITER_INSUFFICIENT_USDC'), async () => 'kora')).rejects.toThrow('JUPITER_INSUFFICIENT_USDC');
    await expect(withKoraFallback(fail('JUPITER_INSUFFICIENT_SOL'), async () => 'kora')).resolves.toBe('kora');
    await expect(withKoraFallback(fail('JUPITER_INSUFFICIENT_SOL'), null)).rejects.toThrow('JUPITER_INSUFFICIENT_SOL');
    await expect(withKoraFallback(fail('JUPITER_SIMULATION_FAILED'), fail('KORA_NATIVE_COVERS'))).rejects.toThrow('JUPITER_SIMULATION_FAILED');
    await expect(withKoraFallback(fail('SOLANA_TRANSFER_OWNER_NOT_WALLET'), fail('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT'))).rejects.toThrow('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
    await expect(withKoraFallback(fail('JUPITER_INSUFFICIENT_SOL'), fail('JUPITER_SIMULATION_FAILED'))).rejects.toThrow('JUPITER_INSUFFICIENT_SOL');
  });
});
