// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): the server-side Pimlico Kora runtime the Solana flows share.
 *
 *   port        what the builders need: the PINNED signer and payment address (from configuration, never from Kora), the fee tokens both FloFi
 *               and Kora accept (Kora's `getPayerSigner` must equal the pins), and Kora's quote
 *   selection   native first: the Kora build is tried only after the native build failed for lack of SOL, and only `selectGasMechanism` decides
 *   relay       K1 then one Kora call: the exact owner-signed bytes are re-verified (pinned fee payer, Kora's slot empty, the reviewed payment),
 *               the S1 token-fee claim is asserted, `signAndSendTransaction` is called (one retry with the identical bytes when the answer is
 *               lost, unless the caller counts its calls itself), and Kora's answer must be those bytes completed by the pinned signer. REFUSED
 *               only when nothing was sent (a local check failed) or Kora's own pre-signing refusal answered the FIRST call for these bytes;
 *               any other failure is UNKNOWN (Kora may have signed: it also broadcasts in the background) and the caller observes the chain
 *   still due   before the wallet is asked: the policy would still pick Kora (no SOL arrived), the payment account exists, the fee token covers
 *
 * FloFi never pays: a Review without a positive token payment never reaches Kora, and Kora's own refusal of the first call is final for those bytes.
 */
import { isSolanaNativeFeeShortfall, readSolanaAccounts, verifyKoraAnswer, verifyKoraOwnerSigned, parseMessageV0, parseTransaction, fromBase64, decodeTokenAccount,
  KORA_MECHANISM, KORA_TOKEN_PROGRAM, type KoraFeeToken, type KoraGasTerms, type KoraPort, type LookupTables, type SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { assertReviewedMechanism, selectGasMechanism, SOLANA_MAINNET } from '../mechanism.ts';
import { readKoraGasConfig, type KoraGasConfig } from '../config.ts';
import { assertUserFundedSubmission } from '../../user-funded/gas-payer.ts';
import { createKoraClient, isKoraRefusalBeforeSigning, KORA_CODES, type KoraClient, type KoraTransport } from './client.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type KoraRelayOutcome = { readonly kind: 'SIGNED'; readonly signature: string; readonly transaction: string }
  | { readonly kind: 'REFUSED'; readonly code: string } | { readonly kind: 'UNKNOWN'; readonly code: string };
export type KoraRelayInput = { readonly review: { readonly message: string; readonly owner: string; readonly gas: KoraGasTerms; readonly lookupTables?: LookupTables };
  readonly ownerSigned: string; readonly prefix: string;
  /**
   * Kora calls already made for these exact bytes (a caller that counts its calls durably, e.g. a sign-all group); 0 (default): this relay's first
   * call is the first one. A refusal is definitive only for the first call.
   */
  readonly priorCalls?: number;
  /** Calls this relay may make (default 2: one retry with the identical bytes when the answer was lost; a caller that counts its calls passes 1). */
  readonly maxCalls?: 1 | 2 };
export type KoraGas = { readonly feePayer: string; readonly paymentAddress: string; readonly port: KoraPort; relay(input: KoraRelayInput): Promise<KoraRelayOutcome> };
type EnabledKora = Extract<KoraGasConfig, { enabled: true }>;
const codeOf = (cause: unknown) => cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : '';
/** Provider answers worth one retry with the identical bytes: Kora may have signed and the answer was lost. */
const RETRYABLE: ReadonlySet<string> = new Set([KORA_CODES.unreachable, KORA_CODES.invalid, KORA_CODES.unknown]);

/** The pins, the token list and Kora's quote, cached briefly per process (Kora's signer answer is re-checked against the pins on every refresh). */
export function createKoraGas(config: EnabledKora, client: KoraClient, options: { readonly now?: () => number; readonly cacheMs?: number } = {}): KoraGas {
  const now = options.now ?? Date.now, cacheMs = options.cacheMs ?? 300_000;
  let cached: { at: number; tokens: readonly KoraFeeToken[] } | null = null;
  const port: KoraPort = {
    feePayer: config.signer, paymentAddress: config.paymentAddress,
    async tokens() {
      if (cached && now() - cached.at < cacheMs) return cached.tokens;
      const [payer, supported] = await Promise.all([client.getPayerSigner(), client.getSupportedTokens()]);
      // A provider answer naming another signer or payment address is refused, never trusted (KORA_SIGNER_MISMATCH).
      if (payer.signerAddress !== config.signer || payer.paymentAddress !== config.paymentAddress) throw new Error('KORA_SIGNER_MISMATCH');
      const tokens = config.feeTokens.filter(t => supported.includes(t.mint)).map(t => ({ symbol: t.symbol, mint: t.mint, decimals: t.decimals }));
      if (!tokens.length) throw new Error('KORA_FEE_TOKEN_UNSUPPORTED');
      cached = { at: now(), tokens };
      return tokens;
    },
    estimate: (transaction, mint) => client.estimateTransactionFee(transaction, mint),
  };
  async function relay(input: KoraRelayInput): Promise<KoraRelayOutcome> {
    const { review, ownerSigned } = input, gas = review.gas;
    // A Review made under another configuration (other pins) is never relayed: it needs a new Review.
    if (gas.mechanism !== KORA_MECHANISM || gas.feePayer !== config.signer || gas.paymentAddress !== config.paymentAddress) return { kind: 'REFUSED', code: 'KORA_SIGNER_MISMATCH' };
    // K1 on the exact bytes about to leave: pinned fee payer, Kora's slot empty, the owner's valid signature, exactly the reviewed payment.
    verifyKoraOwnerSigned(review, ownerSigned, input.prefix);
    const feePayer = parseMessageV0(parseTransaction(fromBase64(ownerSigned, 2048)).message).staticKeys[0] ?? '';
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer, ownerWallet: review.owner,
      tokenFee: { mechanism: KORA_MECHANISM, relayer: gas.feePayer, pinnedRelayers: [config.signer], token: gas.token.mint, amount: gas.amount } });
    const prior = input.priorCalls ?? 0, calls = input.maxCalls ?? 2;
    if (!Number.isSafeInteger(prior) || prior < 0 || ![1, 2].includes(calls)) throw new Error('KORA_RELAY_INPUT_INVALID');
    for (let attempt = 0; attempt < calls; attempt++) {
      let answer: Awaited<ReturnType<KoraClient['signAndSendTransaction']>>;
      try { answer = await client.signAndSendTransaction(ownerSigned); }
      catch (cause) {
        const code = codeOf(cause) || KORA_CODES.unknown;
        // Kora's own pre-signing refusal of the FIRST call for these bytes: it never signed them, so they can never land. Any other answer —
        // an HTTP-level failure, -32603, a rate limit, or a refusal after an earlier call whose answer was lost (it may have been signed and
        // landed) — proves nothing: UNKNOWN, and the caller observes the chain until the blockhash provably expired.
        if (prior + attempt === 0 && isKoraRefusalBeforeSigning(cause)) return { kind: 'REFUSED', code };
        // A lost answer: retried once with the identical bytes (the same transaction at most once), then unknown.
        if (!RETRYABLE.has(code) || attempt === calls - 1) return { kind: 'UNKNOWN', code };
        continue;
      }
      try { return { kind: 'SIGNED', ...verifyKoraAnswer(ownerSigned, answer, config.signer) }; }
      catch (cause) { return { kind: 'UNKNOWN', code: codeOf(cause) || 'KORA_ANSWER_INVALID' }; }
    }
    return { kind: 'UNKNOWN', code: KORA_CODES.unknown };
  }
  return { feePayer: config.signer, paymentAddress: config.paymentAddress, port, relay };
}

/** The deployment's Kora runtime, or null when `FLOFI_KORA_TOKEN_GAS` is off or invalid (its operations keep native gas exactly as before). */
export function koraGasFromEnv(env: Env, options: { readonly transport?: KoraTransport } = {}): KoraGas | null {
  const config = readKoraGasConfig(env);
  if (!config.enabled) return null;
  return createKoraGas(config, createKoraClient(config.rpcUrl, options.transport ? { transport: options.transport } : {}));
}

/**
 * The Kora runtime of one Solana flow: a public flow uses only the pinned https endpoint, a loopback harness (`GRYLOO_*_HARNESS=MOCKED_LOOPBACK_ONLY`)
 * only the loopback double — an offline harness never reaches a public provider, and a public flow never a local one.
 */
export function koraGasForFlow(env: Env, harness: boolean, options: { readonly transport?: KoraTransport } = {}): KoraGas | null {
  const config = readKoraGasConfig(env);
  if (!config.enabled || config.loopback !== harness) return null;
  return createKoraGas(config, createKoraClient(config.rpcUrl, options.transport ? { transport: options.transport } : {}));
}

/**
 * ADR-0010 §2 for one Solana operation: the native build exactly as before; only when it failed for lack of SOL, the Kora build; the policy
 * (`selectGasMechanism`) decides. A Kora refusal surfaces its own closed `KORA_*` code (what is missing); `KORA_NATIVE_COVERS` or any other
 * failure of the Kora build keeps the native error.
 */
export async function withKoraFallback<T>(native: () => Promise<T>, kora: (() => Promise<T>) | null): Promise<T> {
  try { return await native(); }
  catch (cause) {
    if (!kora || !isSolanaNativeFeeShortfall(cause)) throw cause;
    let review: T;
    try { review = await kora(); }
    catch (koraCause) {
      const code = codeOf(koraCause);
      if (!code.startsWith('KORA_') || code === 'KORA_NATIVE_COVERS') throw cause;
      const selection = selectGasMechanism({ chain: SOLANA_MAINNET, nativeCovers: false, candidate: { mechanism: KORA_MECHANISM, eligible: false, code } });
      throw new Error(selection.unavailable[0]?.code ?? code, { cause: koraCause });
    }
    if (selectGasMechanism({ chain: SOLANA_MAINNET, nativeCovers: false, candidate: { mechanism: KORA_MECHANISM, eligible: true } }).mechanism !== KORA_MECHANISM) throw cause;
    return review;
  }
}

/**
 * Fresh chain facts right before the wallet is asked to sign a Kora Review: the owner's SOL still does not cover the native cost (otherwise the
 * policy now picks native: GAS_MECHANISM_CHANGED_REVIEW_REQUIRED, never a silent switch), Kora's payment account exists, and the owner's fee
 * account still covers the fee plus what the operation itself spends from that same account.
 */
export async function assertKoraStillSelected(rpc: SolanaRpc, owner: string, gas: KoraGasTerms, spend: { readonly account: string; readonly amount: bigint } | null): Promise<void> {
  const { accounts } = await readSolanaAccounts(rpc, [owner, gas.feeAccount, gas.paymentAccount]);
  const lamports = accounts[0]?.lamports ?? 0n;
  assertReviewedMechanism(KORA_MECHANISM, selectGasMechanism({ chain: SOLANA_MAINNET, nativeCovers: lamports >= BigInt(gas.nativeWorstCaseLamports),
    candidate: { mechanism: KORA_MECHANISM, eligible: true } }));
  const balance = (account: (typeof accounts)[number], wallet: string) => {
    if (!account || account.owner !== KORA_TOKEN_PROGRAM || account.data.length !== 165) return null;
    const decoded = decodeTokenAccount(account.data);
    return decoded.owner === wallet && decoded.mint === gas.token.mint ? decoded.amount : null;
  };
  if (balance(accounts[2]!, gas.paymentAddress) === null) throw new Error('KORA_PAYMENT_ACCOUNT_MISSING');
  const required = BigInt(gas.amount) + (spend && spend.account === gas.feeAccount ? spend.amount : 0n);
  if ((balance(accounts[1]!, owner) ?? 0n) < required) throw new Error('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT');
}
