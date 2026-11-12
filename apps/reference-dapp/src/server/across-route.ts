// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1, Swap → Bridge in one wallet batch): the PURE Across checks the certified Cross-chain Router applies to its own Review and
 * settlement (`router-service.ts`), shared with the user-funded wallet batch (`user-funded/bridge-calls.ts`, `bridge-delivery.ts`,
 * `batch-simulation.ts`) so both paths accept exactly the same quote, deposit and fill — one rule, never two copies that drift.
 *
 *   routeMatchesPair     a provider's normalized route is for this profile's pair (chains, tokens) and from that provider
 *   routeMatchesIntent   the route pays the expected recipient from the expected depositor for exactly the expected input
 *   acrossCallPlan       the source calls of a route: the exact approval (only when required) and the deposit, as the route carries them
 *   depositMatches       exactly one FundsDeposited of the origin SpokePool matching the route field by field, and exactly one owner debit of
 *                        the input token for the route's input amount (throws ROUTER_DEPOSIT_EVENT_MISMATCH / ROUTER_OWNER_DEBIT_MISMATCH)
 *   fillMatches          the destination FilledRelay of THIS deposit (origin chain + deposit id) agrees with the deposit and the route, and the
 *                        recipient received exactly the filled amount; a fill of our deposit that disagrees is divergent, never ours
 *   refundMatches        the source SpokePool returned exactly the input to the refund address
 *
 * Read-only and deterministic: nothing here reads a chain, calls a provider, signs or sends. Callers read logs from their own transports.
 */
import type { CanonicalRoute, RoutingProvider } from '@defi-workflow-engine/workflow-contracts';
import { decodeErc20Transfer, decodeFilledRelay, decodeFundsDeposited, encodeRouterApprove, ROUTER_TOPICS as TOPIC, type FilledRelay, type FundsDeposited,
  type RouterLog } from '@defi-workflow-engine/reference-compiler';

const fail = (code: string): never => { throw new Error(code); };
const addrWord = (a: string) => a.slice(2).padStart(64, '0');
/** The parts of a router profile these checks need (a `RouterProfile` is one). */
export type AcrossPair = {
  readonly source: { readonly chain: string; readonly chainId: number; readonly token: string; readonly spokePool: string };
  readonly destination: { readonly chain: string; readonly chainId: number; readonly token: string; readonly spokePool: string };
};
/** What a deposit must carry (a `CanonicalRoute` is one): `inputAmount` is what the owner is debited, `bridge` what the SpokePool records. */
export type DepositExpectation = { readonly recipient: string; readonly inputAmount: string;
  readonly bridge: { readonly depositor: string; readonly inputAmount: string; readonly outputAmount: string; readonly quoteTimestamp: number; readonly fillDeadline: number;
    readonly exclusiveRelayer: string } };
export type SourceDeposit = { readonly depositId: string; readonly inputAmount: string; readonly outputAmount: string; readonly depositor: string; readonly fillDeadline: number };
export type FillExpectation = { readonly recipient: string; readonly minimumOutput: string; readonly expectedOutput: string };
export type FillMatch = { readonly ok: true; readonly fill: FilledRelay; readonly transferAmount: bigint } | { readonly ok: false; readonly divergent: string | null };

/** The provider's route is for this pair, from this provider (`ROUTER_ROUTE_INTENT_MISMATCH` otherwise, as the Router's Review refuses it). */
export function routeMatchesPair(route: CanonicalRoute, pair: AcrossPair, provider: RoutingProvider): boolean {
  return route.routingProvider === provider && route.sourceChain === pair.source.chain && route.destinationChain === pair.destination.chain
    && route.inputToken.address === pair.source.token && route.outputToken.address === pair.destination.token;
}
/** The selected route pays exactly what was asked: this recipient, from this depositor, for this input amount. */
export function routeMatchesIntent(route: CanonicalRoute, intent: { readonly owner: string; readonly recipient: string; readonly amount: string }): boolean {
  return route.recipient === intent.recipient && route.depositor === intent.owner && route.inputAmount === intent.amount;
}
/** The route's source calls in order: its exact approval only when `approvalRequired`, then its deposit (the bytes the route carries). */
export function acrossCallPlan(route: CanonicalRoute, approvalRequired: boolean): readonly { readonly purpose: 'APPROVAL' | 'BRIDGE_DEPOSIT'; readonly to: string; readonly data: string }[] {
  return [...approvalRequired ? [{ purpose: 'APPROVAL' as const, to: route.approval.token, data: encodeRouterApprove(route.approval.spender, BigInt(route.approval.amount)) }] : [],
    { purpose: 'BRIDGE_DEPOSIT' as const, to: route.deposit.to, data: route.deposit.data }];
}
/** Exactly one Across deposit from the origin SpokePool, matching the expectation field by field, and exactly one owner debit of the input. */
export function depositMatches(pair: AcrossPair, expected: DepositExpectation, logs: readonly RouterLog[], owner: string): { readonly deposit: FundsDeposited; readonly ownerDebit: bigint } {
  const SRC = pair.source, DST = pair.destination;
  const deposits = logs.filter(l => typeof l.address === 'string' && l.address.toLowerCase() === SRC.spokePool && String(l.topics?.[0]).toLowerCase() === TOPIC.fundsDeposited);
  if (deposits.length !== 1) fail('ROUTER_DEPOSIT_EVENT_MISMATCH');
  const d = decodeFundsDeposited(deposits[0]!), b = expected.bridge;
  if (d.destinationChainId !== BigInt(DST.chainId) || d.depositor !== b.depositor || d.recipient !== expected.recipient || d.inputToken !== SRC.token ||
      d.outputToken !== DST.token || d.inputAmount !== BigInt(b.inputAmount) || d.outputAmount !== BigInt(b.outputAmount) || d.quoteTimestamp !== b.quoteTimestamp ||
      d.fillDeadline !== b.fillDeadline || d.message !== '0x' || d.exclusiveRelayer !== '0x' + addrWord(b.exclusiveRelayer)) fail('ROUTER_DEPOSIT_EVENT_MISMATCH');
  const debits = logs.filter(l => typeof l.address === 'string' && l.address.toLowerCase() === SRC.token && String(l.topics?.[0]).toLowerCase() === TOPIC.transfer)
    .map(decodeErc20Transfer).filter(t => t.from === owner);
  if (debits.length !== 1 || debits[0]!.amount !== BigInt(expected.inputAmount)) fail('ROUTER_OWNER_DEBIT_MISMATCH');
  return { deposit: d, ownerDebit: debits[0]!.amount };
}
/**
 * Independent destination proof for one candidate transaction's logs. A transaction without our fill is not ours (`divergent: null`); a fill of our
 * deposit that disagrees with it, or with the route, is divergent (a closed code). Canonical inclusion and status are the caller's reads.
 */
export function fillMatches(pair: AcrossPair, source: SourceDeposit, route: FillExpectation, logs: readonly RouterLog[]): FillMatch {
  const SRC = pair.source, DST = pair.destination;
  const fills = logs.filter(l => String(l.address).toLowerCase() === DST.spokePool && String(l.topics?.[0]).toLowerCase() === TOPIC.filledRelay).map(decodeFilledRelay)
    .filter(f => f.originChainId === BigInt(SRC.chainId) && f.depositId === BigInt(source.depositId));
  if (fills.length === 0) return { ok: false, divergent: null };
  if (fills.length !== 1) return { ok: false, divergent: 'ROUTER_FILL_DUPLICATED' };
  const f = fills[0]!;
  if (f.inputToken !== SRC.token || f.outputToken !== DST.token || f.inputAmount !== BigInt(source.inputAmount) || f.outputAmount !== BigInt(source.outputAmount) ||
      f.depositor !== source.depositor || f.recipient !== route.recipient || f.fillDeadline !== source.fillDeadline || !/^0x0{64}$/.test(f.messageHash))
    return { ok: false, divergent: 'ROUTER_FILL_MISMATCH' };
  if (f.updatedRecipient !== route.recipient) return { ok: false, divergent: 'ROUTER_FILL_RECIPIENT_MISMATCH' };
  if (f.updatedOutputAmount < BigInt(route.minimumOutput)) return { ok: false, divergent: 'ROUTER_FILL_BELOW_MINIMUM' };
  if (f.updatedOutputAmount > BigInt(route.expectedOutput)) return { ok: false, divergent: 'ROUTER_FILL_ABOVE_MAXIMUM' };
  const transfers = logs.filter(l => String(l.address).toLowerCase() === DST.token && String(l.topics?.[0]).toLowerCase() === TOPIC.transfer).map(decodeErc20Transfer)
    .filter(t => t.to === route.recipient);
  if (transfers.length !== 1 || transfers[0]!.amount !== f.updatedOutputAmount) return { ok: false, divergent: 'ROUTER_FILL_TRANSFER_MISMATCH' };
  return { ok: true, fill: f, transferAmount: transfers[0]!.amount };
}
/** A refund of exactly the deposit's input from the origin SpokePool to the refund address, in one transaction's logs (null: none). */
export function refundMatches(pair: AcrossPair, refundAddress: string, inputAmount: string, logs: readonly RouterLog[]): bigint | null {
  const refunds = logs.filter(l => String(l.address).toLowerCase() === pair.source.token && String(l.topics?.[0]).toLowerCase() === TOPIC.transfer).map(decodeErc20Transfer)
    .filter(t => t.from === pair.source.spokePool && t.to === refundAddress && t.amount === BigInt(inputAmount));
  return refunds.length === 1 ? refunds[0]!.amount : null;
}
