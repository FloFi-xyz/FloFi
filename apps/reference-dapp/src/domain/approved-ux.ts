// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 approved UX (boards 05–08, handoff board 16 §3, §6): pure presentation decisions of the Editor footer, Review panel and blocker panel.
 * Every value is read from the existing projections (`projectSimulation`, the run review, the server's fee evidence); nothing here quotes,
 * computes a fee, decides an action or claims an outcome the records do not state.
 */
import { shortTokenDecimal } from './token-amount-display';
import type { NativeFeeShortfall } from '../user-funded/groups';
import { networkIdentity } from './network-registry';

/** A network answer as the registry knows it (`Base (8453)` and `Base` name the same network). */
export const networkOfOption = (option: string) => networkIdentity(option.replace(/ \(\d+\)$/, '').trim());
/**
 * P0 approved UX (board 05): FloFi's question is a network question when every suggested answer is a network the registry knows. Presentation
 * only: the answers, and what each one sends, are FloFi's own. The chat's network buttons and the footer's prompt share this one detector.
 */
export function networkChoiceOptions(options: readonly string[] | undefined): readonly string[] | null {
  return options && options.length >= 2 && options.every(option => networkOfOption(option)) ? options : null;
}
/** FloFi's latest message asks which network to use: its suggested answers are networks only (board 05). */
export function networkQuestionPending(messages: readonly { readonly role: string; readonly options?: readonly string[] | undefined }[]): boolean {
  const last = messages.at(-1);
  return Boolean(last && last.role !== 'you' && networkChoiceOptions(last.options));
}
/** "m:ss" for a positive remaining time; "0:00" once expired. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
/** Board 16 §6: the validity countdown turns to attention under 15 seconds. */
export const COUNTDOWN_ATTENTION_MS = 15_000;

export type FooterStatus = { readonly tone: 'ready' | 'attention' | 'blocked' | 'expired' | 'neutral'; readonly text: string; readonly parameters?: readonly string[];
  readonly detail?: string | null };
/**
 * The footer's left status on Simulate (board 06/07): a valid simulation counts down its own validity; a blocker names itself and, only when no
 * execution of this workflow has started, says nothing was sent; a running simulation says so. Null where the footer shows the Create notices.
 */
export function simulateFooterStatus(input: { readonly busy: boolean; readonly status: 'ready' | 'attention' | 'blocked'; readonly label: string;
  readonly expiresAt: number | null; readonly now: number; readonly executionStarted: boolean; readonly networkQuestion?: boolean;
  /** Board 06: the footer of the whole-workflow Review (Execute, before authorization) words its own Review, never a simulation. */
  readonly subject?: 'simulation' | 'review' | 'quote' }): FooterStatus | null {
  const review = input.subject === 'review';
  if (input.networkQuestion) return { tone: 'attention', text: 'Choose the network in the chat to simulate' };
  if (input.busy) return { tone: 'neutral', text: review ? 'Reviewing the whole workflow…' : 'Simulating workflow…' };
  if (input.status === 'blocked') return { tone: 'blocked', text: input.label, detail: input.executionStarted ? null : 'Nothing was sent' };
  if (input.expiresAt !== null) {
    const left = input.expiresAt - input.now;
    if (left > 0 && input.subject === 'quote') return { tone: 'attention', text: 'Pool quote' };
    return left > 0 ? { tone: left < COUNTDOWN_ATTENTION_MS ? 'attention' : 'ready', text: review ? 'Review valid for {0}' : 'Simulation valid for {0}', parameters: [countdown(left)] }
      // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (C2): an expired Review blocks authorization ("Review expired", its own red tone, as C2 shows); the
      // footer's one action refreshes it. An expired simulation keeps its amber line.
      : review ? { tone: 'expired', text: 'Review expired' } : { tone: 'attention', text: 'Expired, simulate again' };
  }
  return null;
}

/** A wei amount as a decimal native amount at six significant digits (the global rule), rounded up; a non-zero amount never reads 0. */
export function nativeAmount(wei: string, decimals = 18): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(wei)) return '—';
  // Six significant digits (the global rule), rounded UP, so a requirement or a shortfall is never understated.
  return shortTokenDecimal({ units: wei, decimals }, 'up')!;
}
/** The balance the owner HAS, rounded DOWN (never overstated). */
export function nativeBalance(wei: string, decimals = 18): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(wei)) return '—';
  return shortTokenDecimal({ units: wei, decimals }, 'down')!;
}
/** `fee`: the network fee ceiling alone; `sends`: native value the request itself sends (null when none); `required` = fee + sends. */
export type FeeShortfallView = { readonly network: string; readonly symbol: string; readonly owner: string; readonly balance: string; readonly fee: string;
  readonly sends: string | null; readonly required: string; readonly missing: string;
  /** ADR-0010: why paying the fee in USDC through Circle was not available for this request (closed codes; absent: not considered). */
  readonly alternatives?: readonly string[];
  /**
   * KAN-20 (a Solana Batch Payment, lamports): the token-account deposits `fee` includes at most, and the SOL the owner's wallet keeps as Solana's
   * minimum balance (part of `required`); each only when the evidence carries it and it is not zero. Absent on EVM.
   */
  readonly deposits?: string; readonly reserve?: string };
const NATIVE: Readonly<Record<string, { readonly network: string; readonly symbol: string }>> = Object.freeze({
  'eip155:1': { network: 'Ethereum', symbol: 'ETH' }, 'eip155:8453': { network: 'Base', symbol: 'ETH' }, 'eip155:42161': { network: 'Arbitrum One', symbol: 'ETH' },
  'eip155:4663': { network: 'Robinhood Chain', symbol: 'ETH' } });
/** KAN-20: the one network whose fee evidence is in lamports (a Solana Batch Payment on Solana mainnet-beta: SOL, 9 decimals). */
const LAMPORTS: Readonly<Record<string, { readonly network: string; readonly symbol: string }>> = Object.freeze({
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { network: 'Solana', symbol: 'SOL' } });
/** The blocker panel's three numbers from the server's own evidence; null when the evidence names a network FloFi does not label. */
export function feeShortfallView(evidence: NativeFeeShortfall | null | undefined): FeeShortfallView | null {
  // EVM evidence is in wei on an EVM network FloFi labels; KAN-20 lamports only on Solana mainnet (9 decimals). Any other pairing is not shown.
  const native = !evidence ? undefined : evidence.unit === 'wei' ? NATIVE[evidence.chainId] : evidence.unit === 'lamports' ? LAMPORTS[evidence.chainId] : undefined;
  if (!evidence || !native) return null;
  const decimals = evidence.unit === 'lamports' ? 9 : 18;
  const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value);
  const sends = positive(evidence.nativeSpend) ? nativeAmount(evidence.nativeSpend, decimals) : null;
  const alternatives = Array.isArray(evidence.unavailable) ? evidence.unavailable.filter(u => u && u.mechanism === 'CIRCLE_USDC_PAYMASTER' && typeof u.code === 'string')
    .map(u => u.code) : [];
  const solana = evidence.unit === 'lamports' ? { ...positive(evidence.deposits) ? { deposits: nativeAmount(evidence.deposits, decimals) } : {},
    ...positive(evidence.reserve) ? { reserve: nativeAmount(evidence.reserve, decimals) } : {} } : {};
  return { ...native, owner: evidence.owner, balance: nativeBalance(evidence.balance, decimals), fee: nativeAmount(evidence.maxFee, decimals), sends,
    required: nativeAmount(evidence.required, decimals), missing: nativeAmount(evidence.shortfall, decimals), ...alternatives.length ? { alternatives } : {}, ...solana };
}

/**
 * Board 07 / handoff §3: a vague request for an explanation ("explain", "why?", "não entendi", "me explique melhor", "me explique melhor, nao
 * entendi") — while a blocker is active it is answered with THAT blocker, never routed to the model (which once answered "There is no pending proposal").
 */
const EXPLAIN = new Set(['explain', 'explain it', 'explain this', 'explain more', 'explain better', 'explain please', 'please explain', 'why', 'why not', 'what happened',
  'i dont understand', 'i do not understand', 'i didnt understand', 'what does that mean', 'what does this mean', 'help', 'explique', 'explique melhor', 'me explique',
  'me explique melhor', 'me explica', 'me explica melhor', 'explica', 'explica melhor', 'nao entendi', 'nao entendi nada', 'nao entendo', 'por que', 'porque', 'por que nao',
  'o que aconteceu', 'como assim', 'o que significa', 'o que isso significa', 'ajuda']);
export function isExplainRequest(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, '');
  const parts = normalized.split(/[,.!?;:]+|\s+e\s+|\s+and\s+/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return parts.length > 0 && parts.length <= 3 && parts.every(part => EXPLAIN.has(part));
}
export type ActiveBlocker = { readonly title: string; readonly message: string; readonly feeShortfall?: NativeFeeShortfall | null; readonly owner?: string | null;
  /** P0 hotfix (locale contract): the sentence rendered in a given language (values as explicit parameters), when the message carries values. */
  readonly messageIn?: ((language: 'EN' | 'PT') => string) | undefined;
  /** Part of this workflow ran or may have run (a step, a run, a restore): an explanation then never says nothing was sent. */ readonly started?: boolean };
/** The blocker in plain words with the same facts the panel shows: the server's numbers when it has them, and the next action. EN source copy. */
export function blockerExplanation(blocker: ActiveBlocker): { readonly text: string; readonly parameters: readonly string[] } | null {
  const fee = feeShortfallView(blocker.feeShortfall);
  if (fee) {
    const short = `${fee.owner.slice(0, 6)}…${fee.owner.slice(-4)}`;
    // "Nothing was sent" holds here: this evidence comes only from the Review's preparation before any run of this workflow exists.
    // KAN-20 (a Solana Batch Payment, lamports): the fee includes the token-account deposits, and Solana keeps the wallet's minimum balance (part
    // of `required`), so both are named and the sentence's numbers add up. EVM evidence keeps the sentences below.
    if (blocker.feeShortfall!.unit === 'lamports') return fee.sends === null
      ? { text: 'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this Batch Payment\'s fee can reach {4} {1}, including up to {6} {1} in deposits for recipients who need a token account, and Solana keeps {7} {1} in your wallet as its minimum balance, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.',
        parameters: [fee.network, fee.symbol, short, fee.balance, fee.fee, fee.missing, fee.deposits ?? '0', fee.reserve ?? '0'] }
      : { text: 'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this Batch Payment sends {6} {1}, its fee can reach {4} {1} and Solana keeps {7} {1} in your wallet as its minimum balance, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.',
        parameters: [fee.network, fee.symbol, short, fee.balance, fee.fee, fee.missing, fee.sends, fee.reserve ?? '0'] };
    return fee.sends === null ? { text: 'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}, and this fee can reach {4} {1}, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.',
      parameters: [fee.network, fee.symbol, short, fee.balance, fee.fee, fee.missing] }
      : { text: 'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this request sends {6} {1} and its fee can reach {4} {1}, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.',
        parameters: [fee.network, fee.symbol, short, fee.balance, fee.fee, fee.missing, fee.sends] };
  }
  return null; // the caller states the blocker's own title and sentence, each translated as it is
}

/** Board 08: one wallet call of the prepared request in plain words (EN source copy; the step number is 1-based). */
const CALL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ERC20_APPROVE: 'Token permission for step {0}', UNISWAP_V3_EXACT_INPUT_SINGLE: 'Swap on Uniswap (step {0})', AAVE_V3_SUPPLY: 'Supply on Aave (step {0})',
  AAVE_V3_BORROW: 'Borrow on Aave (step {0})', AAVE_V3_REPAY: 'Repay on Aave (step {0})', AAVE_V3_WITHDRAW: 'Withdraw from Aave (step {0})',
  ERC20_TRANSFER: 'Transfer (step {0})', NATIVE_TRANSFER: 'Transfer (step {0})',
  // P0 hotfix (E1): a batched bridge's deposit into the pinned Across SpokePool.
  ACROSS_DEPOSIT: 'Bridge deposit on Across (step {0})' });
export type WalletRequestView = { readonly request: number; readonly of: number | null;
  /** The wallet's own call count for this request (the prepared group's), or null when it is not prepared yet: then `items` are its steps. */
  readonly calls: number | null; readonly items: readonly { readonly text: string; readonly parameters: readonly string[] }[];
  /** True when `items` are the wallet's calls themselves; false when they are the request's steps. */ readonly itemized: boolean };
type ReviewShape = { readonly counts: { readonly walletPrompts: number; readonly atLeast: boolean };
  readonly groups: readonly { readonly index: number; readonly steps: readonly [number, number]; readonly calls: readonly { readonly kind: string; readonly step: number }[] | null;
    readonly approvals?: number | null }[];
  readonly steps: readonly { readonly index: number; readonly action: string }[] };
type RunShape = { readonly currentStep: number;
  readonly groups: readonly { readonly index: number; readonly steps: readonly [number, number]; readonly planned: { readonly calls: number; readonly approvals: number } | null }[] };
/**
 * Board 08 (Confirm in wallet): which wallet request this is ("REQUEST n OF m") and what the wallet shows, in plain words — for a wallet batch
 * (a Circle-paid request is described by `circleSignatureView` instead: its wallet shows a permit, then an operation, never batch calls). The group is the run's
 * own group holding its current step (none: no header — never a guessed group); before a run exists, the Review's first group. The call count is
 * the PREPARED group's own (`planned.calls`): the Review's itemized calls are shown only when they agree with it (a group prepared again after an
 * expiry or an allowance change may differ), else the request is described by its steps. `of` is null when the Review counts only a lower
 * bound (`atLeast`): the header then never claims a total. Nothing here asks, signs or sends.
 */
export function walletRequestView(review: ReviewShape, run: RunShape | null): WalletRequestView | null {
  const runGroup = run ? run.groups.find(g => g.steps[0] <= run.currentStep && run.currentStep <= g.steps[1]) ?? null : null;
  if (run && !runGroup) return null;
  const index = runGroup ? runGroup.index : review.groups[0]?.index;
  const reviewed = review.groups.find(g => g.index === index);
  const steps = runGroup?.steps ?? reviewed?.steps;
  if (index === undefined || !steps) return null;
  const request = (runGroup ? run!.groups.indexOf(runGroup) : review.groups.indexOf(reviewed!)) + 1;
  const prepared = runGroup ? runGroup.planned : null;
  const reviewedCalls = reviewed?.calls ?? null;
  const agrees = reviewedCalls !== null && (prepared === null ? !run : prepared.calls === reviewedCalls.length
    && prepared.approvals === reviewedCalls.filter(call => call.kind === 'ERC20_APPROVE').length);
  const items = agrees ? reviewedCalls.map(call => call.kind === 'DEADLINE_GUARD' ? { text: 'Expiry check: the request is refused after its deadline', parameters: [] }
      : { text: CALL_WORDS[call.kind] ?? 'Call for step {0}', parameters: [String(call.step + 1)] })
    : review.steps.filter(step => steps[0] <= step.index && step.index <= steps[1]).map(step => ({ text: 'Step {0}: {1}', parameters: [String(step.index + 1), step.action] }));
  return { request, of: review.counts.atLeast ? null : Math.max(review.counts.walletPrompts, request), calls: agrees ? reviewedCalls.length : prepared?.calls ?? null, items, itemized: agrees };
}

/**
 * Review UX4 (ADR-0010 §3): what the wallet shows while a Circle-paid request is signed — never the batch calls of `walletRequestView` (the wallet
 * shows no batch): first the USDC permit (spender Circle's paymaster, value the cap), then the operation as typed data. `stage` follows the
 * request itself: 1 while its permit is unsigned, 2 once FloFi's permit step answered with the OPERATION stage. Neither signature sends a
 * transaction from the wallet. `cap`: the permit's cap as the owner reads it (e.g. "0.21 USDC").
 */
export type CircleSignatureView = { readonly eyebrow: { readonly text: string; readonly parameters: readonly string[] };
  readonly detail: { readonly text: string; readonly parameters: readonly string[] }; readonly status: string };
export function circleSignatureView(stage: 1 | 2, cap: string): CircleSignatureView {
  return { eyebrow: { text: 'EXECUTION · SIGNATURE {0} OF {1}', parameters: [String(stage), '2'] },
    detail: stage === 1 ? { text: 'Signature 1 of 2: USDC permit, at most {0}. It lets Circle\'s paymaster take the network fee from your USDC.', parameters: [cap] }
      : { text: 'Signature 2 of 2: the operation. Your wallet shows it as typed data; FloFi relays it, and Circle\'s paymaster takes the network fee from your USDC.', parameters: [] },
    status: stage === 1 ? 'Sign the USDC permit in your wallet. It sends no transaction.' : 'Sign the operation in your wallet. It sends no transaction: FloFi relays it.' };
}

/**
 * P0 Track A: the wallet the Flight preflight checks — the signer of the step being simulated, by its chain family (an EVM step of a mixed
 * EVM/Solana workflow is signed by the EVM wallet even when the whole workflow's wallet kind is Solana). No step: the review binding's wallet.
 */
export function flightSignerFor(stepChain: string | null, wallets: { readonly evm: string | null; readonly solana: string | null; readonly fallback: string | null }): string | null {
  return stepChain === null ? wallets.fallback : stepChain.startsWith('solana:') ? wallets.solana : wallets.evm;
}
/** A runtime record whose own words must stay visible (a result that cannot be used, or a run that needs attention). */
export function recordNeedsAttention(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const r = record as { readonly verdict?: unknown; readonly status?: unknown };
  return ['DIVERGENT', 'FAILED', 'INCONCLUSIVE', 'NOT_EXECUTED', 'REFUNDED'].includes(String(r.verdict ?? ''))
    || ['FAILED', 'RECOVERY_REQUIRED', 'PAUSED', 'PARTIALLY_COMPLETED'].includes(String(r.status ?? ''));
}
/**
 * Where a Flight refusal for the current signer and workflow is said: as the simulation's own blocker ('SOURCE') while nothing of this workflow
 * ran — a simulation-only record is replaced, never presented as this request's result — or as a notice ('NOTICE') beside a run, a recovery or
 * a record that keeps its own words. Never swallowed; nothing while the runtime is busy.
 */
export function flightRefusalPlacement(input: { readonly applies: boolean; readonly busy: boolean; readonly recoveryOnly: boolean; readonly recordAttention: boolean;
  readonly executionStarted: boolean }): 'SOURCE' | 'NOTICE' | null {
  if (!input.applies) return null;
  if (input.recoveryOnly || input.recordAttention || input.executionStarted) return 'NOTICE';
  return input.busy ? null : 'SOURCE';
}

/** Board 16: a network as people read it, without the chain id the technical label carries ("Base (8453)" → "Base"). */
export const withoutChainId = (label: string): string => label.replace(/ \((?:\d+|0x[0-9a-fA-F]+)\)$/, '');

/**
 * KAN-20: a Solana Batch Payment's refusals in plain words, shared by the Editor's run (`EXECUTION_REFUSAL`) and /approve (`CLAIM_TEXT`), so each
 * has one translation: the core's refusal families (one transaction too large to carry every payment, a recipient that is not an ordinary
 * wallet, the paying wallet as a recipient, too little SOL or token balance, a new account below Solana's minimum, a signed transaction that is
 * not the reviewed one), FloFi Wallet (which cannot sign it), and C.4's earlier request: still able to land for a short time (retryable: try again
 * in a minute), or landed outside FloFi (never asked again). Each says nothing was signed or sent, or what may have happened.
 */
const TOO_LARGE = 'This Batch Payment does not fit in one Solana transaction, so FloFi does not split it. Nothing was signed or sent. Pay fewer recipients.';
const NOT_A_WALLET = 'A recipient of this Batch Payment is not an ordinary Solana wallet (a program, a token account or a program address). Nothing was signed or sent. Use the recipient\'s wallet address.';
const NOT_REVIEWED = 'The transaction your wallet signed is not exactly the one FloFi reviewed, so nothing was sent. Review again.';
export const SOLANA_BATCH_REFUSAL: Readonly<Record<string, string>> = Object.freeze({
  SOLANA_BATCH_PAYMENT_TRANSACTION_TOO_LARGE: TOO_LARGE, SOLANA_BATCH_PAYMENT_TOO_MANY_ACCOUNTS: TOO_LARGE, SOLANA_BATCH_PAYMENT_INSTRUCTION_TRACE_TOO_LONG: TOO_LARGE,
  SOLANA_BATCH_PAYMENT_COMPUTE_LIMIT_EXCEEDED: TOO_LARGE,
  SOLANA_BATCH_PAYMENT_RECIPIENT_RESERVED: NOT_A_WALLET, SOLANA_BATCH_PAYMENT_RECIPIENT_OFF_CURVE: NOT_A_WALLET, SOLANA_BATCH_PAYMENT_RECIPIENT_NOT_WALLET: NOT_A_WALLET,
  SOLANA_BATCH_PAYMENT_RECIPIENT_IS_TOKEN_ACCOUNT: NOT_A_WALLET, SOLANA_BATCH_PAYMENT_DESTINATION_OWNER_MISMATCH: NOT_A_WALLET,
  SOLANA_BATCH_PAYMENT_RECIPIENT_IS_SENDER: 'A recipient of this Batch Payment is the wallet that pays it. Nothing was signed or sent.',
  SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL: 'Your wallet does not hold enough SOL for this Batch Payment: SOL pays the network fee and a deposit for each recipient who needs a token account (and the payments themselves when they are in SOL). Nothing was signed or sent. Add SOL and review again.',
  SOLANA_BATCH_PAYMENT_INSUFFICIENT_TOKEN_BALANCE: 'Your wallet does not hold the whole total of this Batch Payment in one token account. Nothing was signed or sent.',
  SOLANA_BATCH_PAYMENT_AMOUNT_BELOW_RENT_EXEMPT: 'A SOL payment to a wallet that does not exist on Solana yet must be at least the minimum balance Solana requires for a new account. Nothing was signed or sent.',
  SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED: NOT_REVIEWED, SOLANA_BATCH_PAYMENT_ANSWER_MISMATCH: NOT_REVIEWED, SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH: NOT_REVIEWED,
  FLOFI_WALLET_SOLANA_BATCH_PAYMENT_UNSUPPORTED: 'FloFi Wallet cannot sign a Solana Batch Payment yet. Connect Phantom or Solflare to sign it. Nothing was signed or sent.',
  // C.4 (H1): retryable — the Editor treats it as transient, never as a Review refusal: FloFi asks the wallet again only once it can no longer land.
  SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE: 'Nothing was sent. The request FloFi prepared earlier for this Batch Payment can still land on Solana for a short time; FloFi asks your wallet again only once it can no longer land. Try again in a minute.',
  // C.4 (H3): the run is halted for good; the existing UNPROVEN / UNPROVABLE words are unchanged (platform/conversation-state.ts).
  BATCH_PAYMENT_EARLIER_REQUEST_LANDED: 'A transaction you signed earlier for this Batch Payment landed on Solana outside FloFi, so FloFi will not ask your wallet again (that would pay every recipient twice). Check your wallet\'s activity, then end the run.',
});
/** KAN-20: any other refusal of a Solana Batch Payment's preparation (a `SOLANA_BATCH_PAYMENT_*` code), with its code. */
export const SOLANA_BATCH_FALLBACK = 'FloFi could not prepare this Solana Batch Payment ({0}). Nothing was signed or sent.';
