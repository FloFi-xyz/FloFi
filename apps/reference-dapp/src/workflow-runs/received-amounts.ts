// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: canonical spent/received amounts from an owner-signed flow's durable record.
 *
 * Confirm-mode workflow bindings resolve min(cap, received) from these facts — the same rule delegated runs already apply.
 * Only amounts proven on the flow's own reconciled record are returned (never quotes or estimates). Native ETH uses its own
 * native asset key; native SOL follows the existing Jupiter/Orca wrapped-mint identity convention for amount bindings.
 */
import { assetKey } from '../delegation/steps.ts';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';

export type FlowAmount = { readonly asset: string; readonly amount: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const units = (v: unknown): string | null => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) ? v : null;
const tokenAddress = (token: Record<string, unknown>): string | null =>
  typeof token.address === 'string' && token.address.length > 0 ? token.address : token.kind === 'NATIVE' && typeof token.chainId === 'string'
    ? token.chainId.startsWith('eip155:') ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : token.chainId.startsWith('solana:') ? SOLANA_MAINNET_TOKENS.SOL.mint : null : null;

/**
 * Public spent/received facts of one owner-signed flow run, read from its durable `status` record.
 * Empty when the record has not reconciled a delivery the binding engine can identity-match.
 */
const listAmounts = (v: unknown): FlowAmount[] | null => Array.isArray(v) && v.every(x => isObject(x) && typeof x.asset === 'string' && units(x.amount))
  ? v.map(x => ({ asset: String((x as FlowAmount).asset), amount: String((x as FlowAmount).amount) })) : null;

export function amountsFromOwnerRecord(record: unknown): { readonly spent: readonly FlowAmount[]; readonly received: readonly FlowAmount[] } {
  if (!isObject(record)) return { spent: [], received: [] };
  // Explicit binding facts (flow projectors / test harness): preferred when present.
  const explicitReceived = listAmounts(record.receivedAmounts), explicitSpent = listAmounts(record.spentAmounts);
  if (explicitReceived || explicitSpent) return { spent: explicitSpent ?? [], received: explicitReceived ?? [] };
  // These are the actual owner-wallet service contracts, rather than provider quote estimates.
  if (record.verdict === 'RECONCILED' && isObject(record.review) && Array.isArray(record.observations)) {
    const review = record.review, observed = record.observations.at(-1);
    if (isObject(observed) && observed.verdict === 'RECONCILED') {
      if (typeof review.chain === 'string' && isObject(review.output) && typeof review.output.mint === 'string' && units(observed.outputReceived)) {
        const received = [{ asset: assetKey({ chain: review.chain, address: review.output.mint }), amount: units(observed.outputReceived)! }];
        const spent = isObject(review.input) && typeof review.input.mint === 'string' && units(observed.inputSpent)
          ? [{ asset: assetKey({ chain: review.chain, address: review.input.mint }), amount: units(observed.inputSpent)! }] : [];
        return { spent, received };
      }
      if ((review.borrow || review.withdraw) && typeof review.chain === 'string' && typeof review.asset === 'string' && units(observed.walletDelta))
        return { spent: [], received: [{ asset: assetKey({ chain: review.chain, address: review.asset }), amount: units(observed.walletDelta)! }] };
    }
  }
  if (isObject(record.quote) && isObject(record.outcome)) {
    const quote = record.quote, outcome = record.outcome;
    const chain = typeof quote.chainId === 'number' && Number.isSafeInteger(quote.chainId) ? `eip155:${quote.chainId}`
      : typeof quote.chainId === 'string' ? quote.chainId.startsWith('eip155:') ? quote.chainId : /^[0-9]+$/.test(quote.chainId) ? `eip155:${quote.chainId}` : null : null;
    const token = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
    const output = token(quote.outputToken), input = token(quote.inputToken), received = units(outcome.outputReceived), spent = units(outcome.inputSpent);
    if (chain && output && received) return {
      received: [{ asset: assetKey({ chain, address: output }), amount: received }],
      spent: input && spent ? [{ asset: assetKey({ chain, address: input }), amount: spent }] : [] };
  }
  // Universal bridge: destination delivery amount + route token identities.
  if (typeof record.received === 'string' && units(record.received) && isObject(record.review) && isObject(record.review.route)) {
    const route = record.review.route, out = isObject(route.outputToken) ? route.outputToken : null, inn = isObject(route.inputToken) ? route.inputToken : null;
    const received: FlowAmount[] = [];
    const spent: FlowAmount[] = [];
    if (out && typeof route.destinationChain === 'string') {
      const address = tokenAddress(out);
      if (address && units(record.received)) received.push({ asset: assetKey({ chain: route.destinationChain, address }), amount: record.received });
    }
    if (inn && typeof route.sourceChain === 'string' && typeof route.inputAmount === 'string' && units(route.inputAmount)) {
      const address = tokenAddress(inn);
      if (address) spent.push({ asset: assetKey({ chain: route.sourceChain, address }), amount: route.inputAmount });
    }
    return { spent, received };
  }
  // Jupiter / Solana swap: evidence carries the reconciled output.
  if (isObject(record.evidence)) {
    const ev = record.evidence, outAmt = units(ev.received) ?? units(ev.outputReceived);
    if (outAmt && isObject(record.review) && isObject(record.review.output) && typeof record.review.chain === 'string') {
      const address = tokenAddress(record.review.output);
      if (address) {
        const received = [{ asset: assetKey({ chain: record.review.chain, address }), amount: outAmt }];
        const spent: FlowAmount[] = [];
        const inAmt = units(ev.spent) ?? units(ev.inputSpent) ?? (isObject(record.review.input) ? units(record.review.input.amount) : null);
        if (inAmt && isObject(record.review.input)) {
          const inAddr = tokenAddress(record.review.input);
          if (inAddr) spent.push({ asset: assetKey({ chain: record.review.chain, address: inAddr }), amount: inAmt });
        }
        return { spent, received };
      }
    }
  }
  // Public EVM swap (Base Sepolia / catalog): quote + reconciled observation on the run.
  if (isObject(record.quote) && isObject(record.observation)) {
    const q = record.quote, o = record.observation, outAmt = units(o.outputReceived) ?? units(o.output);
    const chain = typeof q.chainId === 'string' ? q.chainId : typeof q.chain === 'string' ? q.chain : null;
    const outAddr = typeof q.outputToken === 'string' ? q.outputToken : isObject(q.output) ? tokenAddress(q.output) : null;
    if (chain && outAddr && outAmt) {
      const received = [{ asset: assetKey({ chain, address: outAddr }), amount: outAmt }];
      const spent: FlowAmount[] = [];
      const inAmt = units(o.inputSpent) ?? units(q.amountIn);
      const inAddr = typeof q.inputToken === 'string' ? q.inputToken : isObject(q.input) ? tokenAddress(q.input) : null;
      if (inAmt && inAddr) spent.push({ asset: assetKey({ chain, address: inAddr }), amount: inAmt });
      return { spent, received };
    }
  }
  // Cross-chain Router (certified pairs): destination transfer amount.
  if (isObject(record.destination) && units(record.destination.transferAmount ?? record.destination.amount) && isObject(record.review)) {
    const dest = record.destination, route = isObject(record.review.route) ? record.review.route : isObject(record.review.quote) ? record.review.quote : null;
    const amount = units(dest.transferAmount ?? dest.amount)!;
    const intent = isObject(record.review.intent) ? record.review.intent : null;
    const chain = intent && typeof intent.destinationChain === 'string' ? intent.destinationChain : typeof dest.chainId === 'string' ? dest.chainId : typeof dest.chain === 'string' ? dest.chain : null;
    const token = typeof dest.outputToken === 'string' ? dest.outputToken : typeof dest.token === 'string' ? dest.token
      : route && isObject(route.outputToken) ? tokenAddress(route.outputToken) : null;
    if (chain && token) return { spent: [], received: [{ asset: assetKey({ chain, address: token }), amount }] };
  }
  return { spent: [], received: [] };
}
