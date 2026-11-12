// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 approved UX (boards 05–08, handoff board 16 §3, §6): pure presentation decisions of the Editor footer, Review panel and blocker panel.
 * Every value is read from the existing projections (`projectSimulation`, the run review, the server's fee evidence); nothing here quotes,
 * computes a fee, decides an action or claims an outcome the records do not state.
 */
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

export type FooterStatus = { readonly tone: 'ready' | 'attention' | 'blocked' | 'neutral'; readonly text: string; readonly parameters?: readonly string[];
  readonly detail?: string | null };
/**
 * The footer's left status on Simulate (board 06/07): a valid simulation counts down its own validity; a blocker names itself and, only when no
 * execution of this workflow has started, says nothing was sent; a running simulation says so. Null where the footer shows the Create notices.
 */
export function simulateFooterStatus(input: { readonly busy: boolean; readonly status: 'ready' | 'attention' | 'blocked'; readonly label: string;
  readonly expiresAt: number | null; readonly now: number; readonly executionStarted: boolean; readonly networkQuestion?: boolean }): FooterStatus | null {
  if (input.networkQuestion) return { tone: 'attention', text: 'Choose the network in the chat to simulate' };
  if (input.busy) return { tone: 'neutral', text: 'Simulating workflow…' };
  if (input.status === 'blocked') return { tone: 'blocked', text: input.label, detail: input.executionStarted ? null : 'Nothing was sent' };
  if (input.expiresAt !== null) {
    const left = input.expiresAt - input.now;
    return left > 0 ? { tone: left < COUNTDOWN_ATTENTION_MS ? 'attention' : 'ready', text: 'Simulation valid for {0}', parameters: [countdown(left)] }
      : { tone: 'attention', text: 'Expired, simulate again' };
  }
  return null;
}

/** A wei amount as a decimal native amount, never rounded to zero (at most 6 decimals; a non-zero value below that reads "< 0.000001"). */
export function nativeAmount(wei: string, decimals = 18): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(wei)) return '—';
  const value = BigInt(wei), scale = 10n ** BigInt(decimals), step = 10n ** BigInt(Math.max(0, decimals - 6));
  if (value > 0n && value < step) return '< 0.000001';
  // Rounded UP to the shown precision, so a requirement or a shortfall is never understated.
  const shown = (value + step - 1n) / step * step, whole = shown / scale;
  const fraction = (shown % scale).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
/** The balance the owner HAS, rounded DOWN (never overstated). */
export function nativeBalance(wei: string, decimals = 18): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(wei)) return '—';
  const value = BigInt(wei), scale = 10n ** BigInt(decimals), step = 10n ** BigInt(Math.max(0, decimals - 6));
  const shown = value / step * step, whole = shown / scale;
  const fraction = (shown % scale).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  return value > 0n && shown === 0n ? '< 0.000001' : `${whole}${fraction ? `.${fraction}` : ''}`;
}
/** `fee`: the network fee ceiling alone; `sends`: native value the request itself sends (null when none); `required` = fee + sends. */
export type FeeShortfallView = { readonly network: string; readonly symbol: string; readonly owner: string; readonly balance: string; readonly fee: string;
  readonly sends: string | null; readonly required: string; readonly missing: string };
const NATIVE: Readonly<Record<string, { readonly network: string; readonly symbol: string }>> = Object.freeze({
  'eip155:1': { network: 'Ethereum', symbol: 'ETH' }, 'eip155:8453': { network: 'Base', symbol: 'ETH' }, 'eip155:42161': { network: 'Arbitrum One', symbol: 'ETH' },
  'eip155:4663': { network: 'Robinhood Chain', symbol: 'ETH' } });
/** The blocker panel's three numbers from the server's own evidence; null when the evidence names a network FloFi does not label. */
export function feeShortfallView(evidence: NativeFeeShortfall | null | undefined): FeeShortfallView | null {
  const native = evidence ? NATIVE[evidence.chainId] : undefined;
  if (!evidence || !native || evidence.unit !== 'wei') return null;
  const sends = /^[1-9][0-9]{0,77}$/.test(evidence.nativeSpend) ? nativeAmount(evidence.nativeSpend) : null;
  return { ...native, owner: evidence.owner, balance: nativeBalance(evidence.balance), fee: nativeAmount(evidence.maxFee), sends, required: nativeAmount(evidence.required),
    missing: nativeAmount(evidence.shortfall) };
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
  /** Part of this workflow ran or may have run (a step, a run, a restore): an explanation then never says nothing was sent. */ readonly started?: boolean };
/** The blocker in plain words with the same facts the panel shows: the server's numbers when it has them, and the next action. EN source copy. */
export function blockerExplanation(blocker: ActiveBlocker): { readonly text: string; readonly parameters: readonly string[] } | null {
  const fee = feeShortfallView(blocker.feeShortfall);
  if (fee) {
    const short = `${fee.owner.slice(0, 6)}…${fee.owner.slice(-4)}`;
    // "Nothing was sent" holds here: this evidence comes only from the Review's preparation before any run of this workflow exists.
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
  ERC20_TRANSFER: 'Transfer (step {0})', NATIVE_TRANSFER: 'Transfer (step {0})' });
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
 * Board 08 (Confirm in wallet): which wallet request this is ("REQUEST n OF m") and what the wallet shows, in plain words. The group is the run's
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
