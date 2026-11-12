// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): a certified Cross-chain Router bridge step inside a user-funded EVM wallet batch — so Swap (Arbitrum One) → Bridge (Arbitrum One
 * → Base) is ONE `wallet_sendCalls` from the owner's own account: [approve WETH] · swap · [approve USDC to the pinned SpokePool] · Across deposit.
 *
 * NARROW by construction (`bridgeStepRefusal`, a closed code for everything else; the universal bridge and every other provider stay owner-step
 * groups through their own flows):
 *   pair          a certified Router MAINNET pair (packages/workflow-contracts router-pairs, the action registry's router profile with its pins)
 *                 whose two sides carry the same asset (USDC → USDC); both chains opted in to user-funded execution with a read RPC, and the
 *                 deployment offers the route (`UserFundedFacts.bridgeRoutes`)
 *   provider      Across direct deposit (routing `auto` or `across`; the batch never routes through the LI.FI Diamond)
 *   recipient     the owner's own address (the run's wallet), never another account
 *   slippage      within ROUTER_MAXIMUM_SLIPPAGE_BPS (and the profile's own maximum)
 *
 * The deposit is built from a FRESH Across quote for the exact input the batch spends, normalized and decoded by the Router's own provider
 * adapter (`server/router-providers.ts`: calldata is authoritative) and accepted only under the Router's own checks (`server/across-route.ts`),
 * plus what the batch adds: the SpokePool and both tokens' runtime code match their pins on BOTH chains, deposits and fills are not paused, the
 * quote outlives the batch's on-chain deadline, the fill deadline leaves the relayers time after it, an exclusivity window ends before the fill
 * deadline, and the bridge fee stays within the owner's own slippage limit. Read-only: nothing here signs or sends.
 */
import { createHash } from 'node:crypto';
import { routerProfileFor, type RouterProfile } from '@defi-workflow-engine/action-registry';
import { decodeAcrossDeposit, ROUTER_SELECTORS as SEL } from '@defi-workflow-engine/reference-compiler';
import { ROUTER_MAXIMUM_SLIPPAGE_BPS, routerPair, type CanonicalRoute } from '@defi-workflow-engine/workflow-contracts';
import type { ChainTransport } from '../delegation/chains.ts';
import type { StepRequirement } from '../delegation/steps.ts';
import { routeMatchesIntent, routeMatchesPair } from '../server/across-route.ts';
import type { RouteRequest, TransferHint } from '../server/router-providers.ts';

/** The Across deposit of a bridge step inside a wallet batch (persisted with the prepared group; amounts as decimal strings). */
export type AcrossDepositUserCall = {
  readonly kind: 'ACROSS_DEPOSIT';
  /** The pinned origin SpokePool (the call's target) and the exact deposit calldata the Across quote carries. */
  readonly spokePool: string; readonly data: string;
  readonly inputToken: string; readonly outputToken: string; readonly inputAmount: string; readonly outputAmount: string;
  readonly destinationChain: string; readonly destinationChainId: number; readonly destinationSpokePool: string;
  readonly depositor: string; readonly recipient: string; readonly exclusiveRelayer: string; readonly quoteTimestamp: number; readonly fillDeadline: number;
  readonly exclusivityParameter: number;
  /** The route's fee (input − output, source token units), the quote's id and validity, Across's expected fill time (seconds). */
  readonly feeTotal: string; readonly quoteId: string; readonly quoteExpiresAt: string; readonly expectedFillSeconds: number;
  /** The router profile id (`arbitrum-usdc-to-base-usdc`) whose pins and finality rules the delivery is verified under. */
  readonly profile: string;
  /** The destination block when the deposit was prepared: its fill is searched from here (a fill can never precede its deposit). */
  readonly destinationFromBlock: string;
};
/** The deployment's Across route between two user-funded chains: the certified profile, the pins verified, the quote and status providers. */
export type AcrossRoute = {
  readonly profile: RouterProfile;
  /** The runtime code pins of both sides: the profile's own on a public deployment; a MOCKED harness injects its doubles' (never public). */
  readonly pins: RouterProfile['codeSha256'];
  readonly quote: (request: RouteRequest) => Promise<CanonicalRoute>;
  /** Across's deposit status (a hint only, e.g. a refund transaction to verify on chain); absent: no hint. */
  readonly status?: (sourceTxHash: string) => Promise<TransferHint>;
};
export type AcrossRoutes = (sourceChain: string, destinationChain: string) => AcrossRoute | null;

/** How a deployment names a batchable bridge route in `UserFundedFacts.bridgeRoutes`. */
export const bridgeRouteKey = (sourceChain: string, destinationChain: string) => `${sourceChain}>${destinationChain}`;
/** The certified Router MAINNET pair a wallet batch may carry between two chains: Across, same asset on both sides (USDC → USDC). */
export function batchBridgeProfile(sourceChain: string, destinationChain: string): RouterProfile | null {
  const p = routerProfileFor(sourceChain, destinationChain);
  return p && p.network === 'MAINNET' && p.environment === 'MAINNET' && p.underlyingProtocol === 'across' && p.source.symbol === p.destination.symbol
    && p.source.decimals === p.destination.decimals && routerPair(sourceChain, p.source.token, destinationChain, p.destination.token) ? p : null;
}
/** The ids of the router profiles a wallet batch may carry (for the deployment's facts). */
export function batchBridgeRoutes(chains: readonly string[], profiles: readonly RouterProfile[]): readonly string[] {
  return profiles.filter(p => chains.includes(p.source.chain) && chains.includes(p.destination.chain) && batchBridgeProfile(p.source.chain, p.destination.chain) === p)
    .map(p => bridgeRouteKey(p.source.chain, p.destination.chain));
}

/**
 * Whether a bridge step can join a wallet batch on this deployment, decided at planning (no quote): null, or the closed reason it runs through
 * its own flow instead. `owner`: the run's EVM wallet when known (an authored recipient must be exactly it); `routes`: the deployment's
 * batchable routes (absent: none).
 */
export function bridgeStepRefusal(step: StepRequirement, chains: readonly string[], owner?: string | null, routes?: readonly string[]): string | null {
  if (step.action !== 'bridge') return 'USER_FUNDED_ACTION_NOT_BUILDABLE';
  // The universal bridge (Relay, Mayan, LI.FI best route, Solana) and any other adapter keep their own reviewed flow.
  if (step.adapterId !== 'flofi.router') return 'USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED';
  const destination = step.destinationChain, input = step.inputs[0], output = step.outputs[0];
  if (!destination || destination === step.chain || step.inputs.length !== 1 || step.outputs.length !== 1 || !input || !output) return 'USER_FUNDED_STEP_SHAPE_UNSUPPORTED';
  const profile = batchBridgeProfile(step.chain, destination);
  if (!profile) return 'USER_FUNDED_BRIDGE_PAIR_UNSUPPORTED';
  if (input.chain !== step.chain || input.address.toLowerCase() !== profile.source.token || input.decimals !== profile.source.decimals
    || output.chain !== destination || output.address.toLowerCase() !== profile.destination.token || output.decimals !== profile.destination.decimals)
    return 'USER_FUNDED_BRIDGE_ASSET_UNSUPPORTED';
  // Reconciliation reads the delivery on the destination chain with the deployment's own read RPC: without one, the run could never complete.
  if (!chains.includes(destination)) return 'USER_FUNDED_BRIDGE_DESTINATION_UNREADABLE';
  if (!routes?.includes(bridgeRouteKey(step.chain, destination))) return 'USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE';
  const strategy = step.strategy as { readonly routing?: unknown; readonly recipient?: unknown };
  if (strategy.routing !== undefined && strategy.routing !== 'auto' && strategy.routing !== 'across') return 'USER_FUNDED_BRIDGE_PROVIDER_UNSUPPORTED';
  if (strategy.recipient !== undefined && (typeof strategy.recipient !== 'string' || !owner || strategy.recipient.toLowerCase() !== owner.toLowerCase()))
    return 'USER_FUNDED_BRIDGE_RECIPIENT_NOT_OWNER';
  if ((step.slippageBps ?? 0) > Math.min(ROUTER_MAXIMUM_SLIPPAGE_BPS, profile.maximumSlippageBps)) return 'WORKFLOW_SLIPPAGE_UNSUPPORTED';
  return null;
}

const word = (data: unknown): bigint => {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{64}/.test(data)) throw new Error('USER_FUNDED_RPC_UNAVAILABLE');
  return BigInt(data.slice(0, 66));
};
/** Provider failures that say nothing about the route (retry later) — the Router's own availability rule. */
const AVAILABILITY = /_(HTTP_\d+|RATE_LIMITED|UNAVAILABLE|RESPONSE_TOO_LARGE|RESPONSE_INVALID|URL_INVALID)$/;
/** Across's own bound between an exclusivity offset (seconds) and an absolute exclusivity deadline (`MAX_EXCLUSIVITY_PERIOD_SECONDS`). */
const MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000;
type Deployment = { readonly depositQuoteTimeBuffer: number; readonly destinationBlock: bigint };

/** Both sides of the certified deployment, read now: runtime code against the pins, chain ids, pause flags, the quote and fill buffers. */
async function verifyDeployment(t: ChainTransport, dt: ChainTransport, route: AcrossRoute): Promise<Deployment | string> {
  const p = route.profile, SRC = p.source, DST = p.destination;
  try {
    const codeHash = async (transport: ChainTransport, target: string) => {
      const code = await transport.rpc('eth_getCode', [target, 'latest']);
      if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new Error('USER_FUNDED_RPC_UNAVAILABLE');
      if (code.length <= 2) throw new Error('ROUTER_CONTRACT_CODE_MISSING');
      return createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
    };
    const call = (transport: ChainTransport, to: string, data: string) => transport.rpc('eth_call', [{ to, data }, 'latest']).then(word);
    const pins: readonly [ChainTransport, string, string][] = [[t, SRC.spokePool, route.pins.baseSpokePool], [t, SRC.token, route.pins.baseUsdc],
      [dt, DST.spokePool, route.pins.arbitrumSpokePool], [dt, DST.token, route.pins.arbitrumUsdc]];
    for (const [transport, target, pin] of pins) if (await codeHash(transport, target) !== pin) return 'ROUTER_UNEXPECTED_CONTRACT';
    if (await call(t, SRC.spokePool, SEL.chainId) !== BigInt(SRC.chainId) || await call(dt, DST.spokePool, SEL.chainId) !== BigInt(DST.chainId)) return 'ROUTER_DEPLOYMENT_MISMATCH';
    if (await call(t, SRC.spokePool, SEL.pausedDeposits) !== 0n) return 'ROUTER_DEPOSITS_PAUSED';
    if (await call(dt, DST.spokePool, SEL.pausedFills) !== 0n) return 'ROUTER_FILLS_PAUSED';
    if (await call(t, SRC.token, SEL.decimals) !== BigInt(SRC.decimals) || await call(dt, DST.token, SEL.decimals) !== BigInt(DST.decimals)) return 'ROUTER_TOKEN_MISMATCH';
    const buffer = Number(await call(t, SRC.spokePool, SEL.depositQuoteTimeBuffer)), fillBuffer = Number(await call(t, SRC.spokePool, SEL.fillDeadlineBuffer));
    if (!Number.isSafeInteger(buffer) || buffer < 600 || !Number.isSafeInteger(fillBuffer) || fillBuffer < 600) return 'ROUTER_DEPLOYMENT_MISMATCH';
    const head = await dt.rpc('eth_blockNumber', []);
    if (typeof head !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(head)) return 'USER_FUNDED_RPC_UNAVAILABLE';
    return { depositQuoteTimeBuffer: buffer, destinationBlock: BigInt(head) };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    return code === 'ROUTER_CONTRACT_CODE_MISSING' ? code : 'USER_FUNDED_RPC_UNAVAILABLE';
  }
}

/**
 * The Across deposit of a bridge step for exactly `amount` (what the batch spends: the authored amount, or a same-batch producer's signed minimum),
 * from a fresh quote, refused with a closed code unless every check holds. `deadline`: the batch's on-chain deadline (unix seconds). The owner's
 * allowance and the approval it needs are the batch builder's (`approvalsFor`), drawn down in call order.
 */
export async function buildAcrossDeposit(input: { readonly step: StepRequirement; readonly owner: string; readonly amount: bigint; readonly deadline: number;
  readonly nowMs: number; readonly route: AcrossRoute; readonly source: ChainTransport; readonly destination: ChainTransport }): Promise<{ readonly ok: true; readonly call: AcrossDepositUserCall }
  | { readonly ok: false; readonly code: string }> {
  const { step, owner, amount, deadline, route: across } = input, profile = across.profile, SRC = profile.source, DST = profile.destination;
  if (profile.source.chain !== step.chain || profile.destination.chain !== step.destinationChain) return { ok: false, code: 'USER_FUNDED_BRIDGE_PAIR_UNSUPPORTED' };
  if (amount <= 0n) return { ok: false, code: 'WORKFLOW_BINDING_NOTHING_GUARANTEED' };
  const slippageBps = step.slippageBps ?? 0;
  const deployment = await verifyDeployment(input.source, input.destination, across);
  if (typeof deployment === 'string') return { ok: false, code: deployment };
  let route: CanonicalRoute;
  try {
    route = await across.quote({ owner, recipient: owner, amount: amount.toString(), slippageBps, nowMs: input.nowMs, depositQuoteTimeBuffer: deployment.depositQuoteTimeBuffer });
  } catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'ROUTER_PROVIDER_FAILED';
    return { ok: false, code: AVAILABILITY.test(code) || code === 'ROUTER_PROVIDER_FAILED' ? 'BRIDGE_QUOTE_UNAVAILABLE' : code };
  }
  // The Router's own Review checks (the shared rule): this pair, from Across, paying the owner from the owner for exactly this input.
  if (!routeMatchesPair(route, profile, 'across') || !routeMatchesIntent(route, { owner, recipient: owner, amount: amount.toString() }))
    return { ok: false, code: 'ROUTER_ROUTE_INTENT_MISMATCH' };
  const b = route.bridge;
  if (route.approval.token !== SRC.token || route.approval.spender !== SRC.spokePool || BigInt(route.approval.amount) !== amount) return { ok: false, code: 'ACROSS_SPENDER_UNEXPECTED' };
  if (route.deposit.to !== SRC.spokePool || route.deposit.chainId !== SRC.chain || route.deposit.value !== '0x0' || b.originSpokePool !== SRC.spokePool
    || b.destinationSpokePool !== DST.spokePool) return { ok: false, code: 'ACROSS_TRANSACTION_UNSUPPORTED' };
  // The calldata is authoritative (the adapter decoded it already; decoded again here against the very fields the batch records).
  let decoded: ReturnType<typeof decodeAcrossDeposit>;
  try { decoded = decodeAcrossDeposit(route.deposit.data); } catch { return { ok: false, code: 'ACROSS_CALLDATA_MISMATCH' }; }
  if (decoded.depositor !== owner || decoded.recipient !== owner || decoded.inputToken !== SRC.token || decoded.outputToken !== DST.token || decoded.inputAmount !== amount
    || decoded.outputAmount !== BigInt(b.outputAmount) || decoded.destinationChainId !== BigInt(DST.chainId) || decoded.exclusiveRelayer !== b.exclusiveRelayer
    || decoded.quoteTimestamp !== b.quoteTimestamp || decoded.fillDeadline !== b.fillDeadline || decoded.exclusivityParameter !== b.exclusivityParameter || decoded.message !== '0x'
    || b.depositor !== owner || b.recipient !== owner || b.message !== '0x' || route.minimumOutput !== b.outputAmount)
    return { ok: false, code: 'ACROSS_CALLDATA_MISMATCH' };
  const output = BigInt(b.outputAmount), fee = BigInt(route.feeTotal);
  if (output <= 0n || fee < 0n || fee !== amount - output) return { ok: false, code: 'ACROSS_FEES_INCONSISTENT' };
  // The owner's own limit: the bridge fee never exceeds their slippage share of what they bridge (provider fee drift beyond it is refused).
  if (fee * 10_000n > amount * BigInt(slippageBps)) return { ok: false, code: 'BRIDGE_FEE_ABOVE_LIMIT' };
  // The batch may execute until its deadline: the quote (and the SpokePool's quote-time window) must still stand then, and the relayers must
  // still have the safety margin before the fill deadline.
  if (Date.parse(route.quote.expiresAt) < deadline * 1000) return { ok: false, code: 'BRIDGE_QUOTE_VALIDITY_SHORT' };
  if (b.fillDeadline < deadline + profile.depositSafetyMarginSeconds) return { ok: false, code: 'BRIDGE_FILL_DEADLINE_SHORT' };
  // An exclusivity window (an offset from the deposit's block, or an absolute time) must end before the fill deadline.
  const exclusivity = b.exclusivityParameter;
  if (!Number.isSafeInteger(exclusivity) || exclusivity < 0 || (exclusivity > 0 && (exclusivity <= MAX_EXCLUSIVITY_PERIOD_SECONDS ? deadline + exclusivity : exclusivity) >= b.fillDeadline))
    return { ok: false, code: 'BRIDGE_EXCLUSIVITY_INVALID' };
  return { ok: true, call: { kind: 'ACROSS_DEPOSIT', spokePool: SRC.spokePool, data: route.deposit.data, inputToken: SRC.token, outputToken: DST.token,
    inputAmount: amount.toString(), outputAmount: output.toString(), destinationChain: DST.chain, destinationChainId: DST.chainId, destinationSpokePool: DST.spokePool,
    depositor: owner, recipient: owner, exclusiveRelayer: b.exclusiveRelayer, quoteTimestamp: b.quoteTimestamp, fillDeadline: b.fillDeadline,
    exclusivityParameter: b.exclusivityParameter, feeTotal: fee.toString(), quoteId: route.quote.id, quoteExpiresAt: route.quote.expiresAt,
    expectedFillSeconds: route.quote.estimatedDurationSeconds, profile: profile.id, destinationFromBlock: deployment.destinationBlock.toString() } };
}
/** The call's own deposit calldata, decoded and re-checked against what the batch recorded (a stored artifact is never trusted blindly). */
export function acrossDepositCalldata(c: AcrossDepositUserCall, owner: string): string {
  const d = decodeAcrossDeposit(c.data);
  if (d.depositor !== owner || d.recipient !== owner || c.depositor !== owner || c.recipient !== owner || d.inputToken !== c.inputToken || d.outputToken !== c.outputToken
    || d.inputAmount !== BigInt(c.inputAmount) || d.outputAmount !== BigInt(c.outputAmount) || d.destinationChainId !== BigInt(c.destinationChainId)
    || d.fillDeadline !== c.fillDeadline || d.quoteTimestamp !== c.quoteTimestamp || d.message !== '0x') throw new Error('USER_FUNDED_CALL_INVALID');
  return c.data;
}
/** The pair the shared Across checks need, from a recorded deposit call (its own sides, never a label). */
export const acrossPairOf = (c: AcrossDepositUserCall, sourceChain: string, sourceChainId: number) => ({
  source: { chain: sourceChain, chainId: sourceChainId, token: c.inputToken, spokePool: c.spokePool },
  destination: { chain: c.destinationChain, chainId: c.destinationChainId, token: c.outputToken, spokePool: c.destinationSpokePool } });
/** What the deposit's FundsDeposited must carry (the shared `depositMatches` expectation). */
export const depositExpectationOf = (c: AcrossDepositUserCall) => ({ recipient: c.recipient, inputAmount: c.inputAmount,
  bridge: { depositor: c.depositor, inputAmount: c.inputAmount, outputAmount: c.outputAmount, quoteTimestamp: c.quoteTimestamp, fillDeadline: c.fillDeadline,
    exclusiveRelayer: c.exclusiveRelayer } });
