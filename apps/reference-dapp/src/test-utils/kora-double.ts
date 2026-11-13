// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MOCKED loopback double of Pimlico's hosted Kora JSON-RPC (ADR-0010 §4) for tests only — never a public provider, never product code.
 *
 * It speaks the five documented methods with their documented shapes and errors (Pimlico reference: snake_case params, raw base-unit numbers,
 * base64 transactions; -32000 "Insufficient token payment. Required N lamports", -32603 unavailable, -32050 account not found) over HTTP on
 * 127.0.0.1, backed by one of the compiler's MOCKED Solana clusters (`rpc`). Its fee payer key is an in-memory disposable key created per double.
 * Like Kora it signs only a transaction whose fee payer is its signer and that pays it enough in a supported token, signs slot 0 and broadcasts
 * the completed bytes in the background (`respond_after: 'signed'`). It records every call so tests can prove what FloFi sent it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { base58Encode, createMockedSolanaWallet, decodeLookupTable, decompileMessageV0, fromBase64, koraAta, parseMessageV0, parseTransaction, readU64, verifyEd25519,
  KORA_ASSOCIATED_TOKEN_PROGRAM, KORA_TOKEN_PROGRAM, type LookupTables, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';

export type KoraDoubleOptions = {
  /** The MOCKED cluster the double simulates and broadcasts on. */
  readonly rpc: SolanaRpc;
  readonly tokens: readonly { readonly mint: string; readonly decimals: number }[];
  /** micro-USD per whole SOL; tokens are 1 USD (USDC/USDT). Default 117.6 USD, the Jupiter mock's price. */
  readonly solPriceMicroUsd?: bigint;
  /** Rent Kora advances for each ATA it creates (165-byte account). */
  readonly rentLamports?: bigint;
};
export type KoraDoubleCall = { readonly method: string; readonly params: Record<string, unknown> };
type SignMode = 'OK' | 'UNAVAILABLE' | 'WRONG_SIGNER' | 'HANG_UNSIGNED';

export async function startKoraDouble(options: KoraDoubleOptions) {
  const signer = createMockedSolanaWallet(), payment = createMockedSolanaWallet().owner;
  const solPrice = options.solPriceMicroUsd ?? 117_600_000n, rent = options.rentLamports ?? 2_039_280n;
  const state = { calls: [] as KoraDoubleCall[], signed: [] as string[], unpaid: 0, signMode: 'OK' as SignMode, loseAnswers: 0, priceDriftBps: 0n, broadcast: true,
    estimateError: null as { code: number; message: string } | null, answerSigner: null as string | null };
  const rpcError = (code: number, message: string) => Object.assign(new Error(message), { rpcCode: code });
  /** Like Kora, v0 address lookup tables are resolved from the chain itself. */
  async function tablesOf(parsed: ReturnType<typeof parseMessageV0>): Promise<LookupTables> {
    if (!parsed.lookups.length) return {};
    const addresses = parsed.lookups.map(l => l.table);
    const read = await options.rpc('getMultipleAccounts', [addresses, { encoding: 'base64' }]) as { value: ({ data: [string, string] } | null)[] };
    return Object.fromEntries(addresses.map((address, i) => [address, decodeLookupTable(fromBase64(read.value[i]?.data[0] ?? '', 1_000_000)).addresses]));
  }
  /** Kora's lamport outflow for a message: 5,000 per signature, the priority fee, and the rent of each ATA it is asked to create. */
  async function requiredLamports(message: Uint8Array): Promise<bigint> {
    const parsed = parseMessageV0(message), instructions = decompileMessageV0(parsed, await tablesOf(parsed));
    let limit = 200_000n, price = 0n;
    for (const ix of instructions) if (ix.programId === 'ComputeBudget111111111111111111111111111111') {
      if (ix.data[0] === 2) limit = BigInt(new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true));
      if (ix.data[0] === 3) price = readU64(ix.data, 1);
    }
    const created = instructions.filter(ix => ix.programId === KORA_ASSOCIATED_TOKEN_PROGRAM && ix.accounts[0]?.pubkey === signer.owner).map(ix => ix.accounts[1]!.pubkey);
    const existing = created.length ? ((await options.rpc('getMultipleAccounts', [created, { encoding: 'base64' }])) as { value: unknown[] }).value : [];
    const newAccounts = BigInt(existing.filter(a => a === null).length);
    return 5_000n * BigInt(parsed.header[0]) + (limit * price + 999_999n) / 1_000_000n + rent * newAccounts;
  }
  const tokenAmount = (lamports: bigint, decimals: number) => {
    const scaled = lamports * solPrice * 10n ** BigInt(decimals) * (10_000n + state.priceDriftBps);
    const denominator = 1_000_000_000n * 1_000_000n * 10_000n;
    return (scaled + denominator - 1n) / denominator;
  };
  function decode(transaction: unknown) {
    let bytes: Uint8Array;
    try { bytes = fromBase64(transaction, 2048); } catch { throw rpcError(-32602, 'Invalid params: transaction'); }
    const { signatures, message } = parseTransaction(bytes), parsed = parseMessageV0(message);
    if (parsed.staticKeys[0] !== signer.owner) throw rpcError(-32000, 'The fee payer is not the address from getPayerSigner');
    return { bytes, signatures, message, parsed };
  }
  async function simulate(transaction: string) {
    const result = await options.rpc('simulateTransaction', [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }]) as
      { value: { err: unknown } };
    if (result.value.err !== null) throw rpcError(-32000, 'Transaction simulation failed');
  }
  /** Payment in this transaction: TransferChecked/Transfer of a supported mint into the payment address's ATA. */
  async function paid(message: Uint8Array): Promise<{ mint: string; amount: bigint } | null> {
    const parsed = parseMessageV0(message), instructions = decompileMessageV0(parsed, await tablesOf(parsed));
    for (const ix of instructions) {
      if (ix.programId !== KORA_TOKEN_PROGRAM || ix.data[0] !== 12) continue;
      const token = options.tokens.find(t => ix.accounts[1]?.pubkey === t.mint && ix.accounts[2]?.pubkey === koraAta(payment, t.mint));
      if (token) return { mint: token.mint, amount: readU64(ix.data, 1) };
    }
    return null;
  }
  async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getPayerSigner': return { signer_address: signer.owner, payment_address: payment };
      case 'getSupportedTokens': return { tokens: options.tokens.map(t => t.mint) };
      case 'getBlockhash': { const latest = await options.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]) as { value: { blockhash: string } }; return { blockhash: latest.value.blockhash }; }
      case 'estimateTransactionFee': {
        if (state.estimateError) throw rpcError(state.estimateError.code, state.estimateError.message);
        const token = options.tokens.find(t => t.mint === params.fee_token);
        if (!token) throw rpcError(-32004, `Token ${String(params.fee_token)} is not supported`);
        const tx = decode(params.transaction);
        await simulate(params.transaction as string);
        const lamports = await requiredLamports(tx.message);
        return { fee_in_lamports: Number(lamports), fee_in_token: Number(tokenAmount(lamports, token.decimals)), signer_pubkey: signer.owner, payment_address: payment };
      }
      case 'signAndSendTransaction': {
        const tx = decode(params.transaction);
        state.signed.push(params.transaction as string);
        if (!await paid(tx.message)) state.unpaid++;
        if (state.signMode === 'UNAVAILABLE') throw rpcError(-32603, 'Solana paymaster unavailable');
        if (state.signMode === 'HANG_UNSIGNED') { await new Promise(resolve => setTimeout(resolve, 2_000)); throw rpcError(-32603, 'Solana paymaster unavailable'); }
        // Every other signer must already have signed; Kora fills only its own (empty) slot.
        if (tx.signatures.length !== tx.parsed.header[0] || tx.signatures.slice(1).some((s, i) => !verifyEd25519(s, tx.message, tx.parsed.staticKeys[i + 1]!)))
          throw rpcError(-32000, 'Transaction is missing required signatures');
        const required = await requiredLamports(tx.message), payment = await paid(tx.message);
        const token = payment ? options.tokens.find(t => t.mint === payment.mint)! : null;
        if (!payment || !token || payment.amount < tokenAmount(required, token.decimals)) throw rpcError(-32000, `Insufficient token payment. Required ${required} lamports`);
        await simulate(params.transaction as string);
        const signed = signer.sign(params.transaction as string), signature = base58Encode(parseTransaction(fromBase64(signed, 2048)).signatures[0]!);
        if (state.broadcast) await options.rpc('sendTransaction', [signed, { encoding: 'base64' }]).catch(() => undefined);
        return { signature, signed_transaction: state.signMode === 'WRONG_SIGNER' ? createMockedSolanaWallet().sign(params.transaction as string) : signed,
          signer_pubkey: state.answerSigner ?? signer.owner };
      }
      default: throw rpcError(-32601, 'Method not found');
    }
  }
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      void (async () => {
        let id: unknown = null;
        try {
          const envelope = JSON.parse(body) as { id?: unknown; method?: unknown; params?: unknown };
          id = envelope.id ?? null;
          const params = envelope.params && typeof envelope.params === 'object' ? envelope.params as Record<string, unknown> : {};
          const method = String(envelope.method);
          state.calls.push({ method, params });
          const result = await handle(method, params);
          if (method === 'signAndSendTransaction' && state.loseAnswers > 0) { state.loseAnswers--; request.socket.destroy(); return; }
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (cause) {
          const error = cause as { rpcCode?: number; message?: string };
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: error.rpcCode ?? -32603, message: error.message ?? 'error' } }));
        }
      })();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mainnet/rpc?apikey=test-loopback-key`;
  return { url, signer: signer.owner, payment, state, paymentAccount: (mint: string) => koraAta(payment, mint),
    /** Completes owner-signed bytes exactly as Kora would (tests that need the fully signed transaction without the HTTP round trip). */
    complete: (ownerSigned: string) => signer.sign(ownerSigned),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
export type KoraDouble = Awaited<ReturnType<typeof startKoraDouble>>;
