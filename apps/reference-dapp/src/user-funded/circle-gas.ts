// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): the network fee of a user-funded EVM group paid in the OWNER's USDC through Circle's
 * permissionless paymaster, on Ethereum, Base and Arbitrum One — offered only when the owner's native balance does NOT cover the group's
 * worst-case fee (native gas stays the default) and this module proves the alternative eligible for exactly this group:
 *
 *   (a) the operator enabled it for the chain (`FLOFI_CIRCLE_USDC_GAS`), and (b) the user-funded runtime has a bundler and a read RPC there
 *   (c) the owner's native balance is short (`selectGasMechanism`), yet covers any native value the group itself sends
 *   (d) the owner's account is a pinned EIP-7702 smart account whose EntryPoint has a Circle paymaster on this chain: MetaMask's
 *       EIP7702StatelessDeleGator (v0.7: Base, Arbitrum One) or eth-infinitism's Simple7702Account (v0.8: Ethereum, Base, Arbitrum One)
 *       (CIRCLE_SMART_ACCOUNT_REQUIRED, CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED, CIRCLE_ACCOUNT_UNSUPPORTED)
 *   (e) an injected wallet that signs typed data (FloFi Wallet has no EIP-7702 delegation and no typed data: CIRCLE_WALLET_UNSUPPORTED)
 *   (f) the paymaster and USDC are verified on chain — code present, `entryPoint()` = the pinned EntryPoint, USDC `name()`/`version()` = the pinned
 *       permit domain (CIRCLE_PAYMASTER_UNVERIFIED; a success is cached per process for an hour, a failure never)
 *   (g) a fresh ETH/USD price from the deployment's verified price source (CIRCLE_PRICE_UNAVAILABLE)
 *   (h) the owner's USDC covers the group's own USDC spend at its worst point PLUS the permit cap (CIRCLE_INSUFFICIENT_USDC): the fee reserve is
 *       never what the group's own steps (or a step bound to them) spend
 *
 * The group then runs as an ERC-4337 operation of the owner's own account (`EVM_USER_OPERATION`, relayed when due — never an operation signed
 * upfront), in two owner signatures, both typed data:
 *
 *   phase 1 (`circleAttempt`)          the exact calls of the wallet batch (deadline-bounded swaps or a deadline guard), simulated whole first;
 *                                      conservative gas limits, the USDC cap they price to, and the permit typed data (spender = the pinned
 *                                      paymaster, value = the cap, the owner's USDC permit nonce, the never-expiring deadline Circle requires)
 *   phase 2 (`finalizeCirclePermit`)   the owner's permit signature verified (signer = owner, the nonce unmoved), `paymasterAndData` built, the
 *                                      FINAL operation estimated by the bundler with it, and its new worst case required to stay within the
 *                                      signed cap (else CIRCLE_PERMIT_CAP_EXCEEDED: a new permit is asked, nothing is relayed beyond the cap);
 *                                      returns the operation's typed data
 *   authorization (`groups.ts`)        the owner's operation signature, recovered to the owner (the account's own scheme)
 *   submission                         S1 with the token-fee claim (relayer = the pinned paymaster, the owner pays a positive USDC amount),
 *                                      the operation check again, the permit nonce unmoved (CIRCLE_PERMIT_EXPIRED), the bundler's re-estimate
 *                                      within the signed limits — then recorded, then relayed once
 *
 * Nothing here holds a key, signs, or pays: Circle fronts the native fee from its own deposit and is paid back by the owner in USDC inside the
 * same operation. FloFi's only cost is the operator's bundler plan.
 */
import { circlePaymaster as C, erc4337, type erc7710 } from '@defi-workflow-engine/reference-compiler';
import { readCircleGasConfig } from '../gas-abstraction/config.ts';
import { type GasPayment, type MechanismCandidate } from '../gas-abstraction/mechanism.ts';
import { observationFresh, type PriceSource } from '../automations/price-source.ts';
import { parseScaled, PRICE_SCALE } from '../automations/decimal.ts';
import type { ChainTransport } from '../delegation/chains.ts';
import type { BatchSimulation } from './batch-simulation.ts';
import type { BundlerClient } from './bundler.ts';
import type { EvmGroupCalls, UserCall } from './evm-calls.ts';
import { assertUserFundedSubmission } from './gas-payer.ts';
import type { GroupStrategy } from '../workflow-runs/execution-groups.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Rpc = ChainTransport['rpc'];
/** ETH/USD (and, when the source has it, USDC/USD) in 8-decimal fixed point, with when the source observed it. */
export type CirclePrice = { readonly ethUsd: bigint; readonly usdcUsd: bigint | null; readonly observedAt: string };
/** What a runtime offers Circle with: the enabled chains that also have a bundler and a read RPC, and the verified price. */
export type CircleDeps = { readonly chains: readonly string[]; readonly price: (now: Date) => Promise<CirclePrice | null> };
const codeOf = (cause: unknown, fallback: string) => cause instanceof Error && /^[A-Z][A-Z0-9_:]{2,100}$/.test(cause.message) ? cause.message : fallback;
const big = (v: unknown) => BigInt(String(v));

/** The runtime's Circle facts from its configuration (off unless `FLOFI_CIRCLE_USDC_GAS=enabled`), or null. */
export function circleDepsOf(env: Env, bundlerChains: readonly string[], prices: () => PriceSource | null): CircleDeps | null {
  const config = readCircleGasConfig(env);
  if (!config.enabled) return null;
  const chains = config.chains.filter(c => bundlerChains.includes(c));
  if (!chains.length) return null;
  let source: PriceSource | null | undefined;
  return { chains, price: async now => {
    source ??= prices();
    if (!source) return null;
    const read = async (asset: 'ETH' | 'USDC'): Promise<{ value: bigint; at: string } | null> => {
      if (!source!.assets.includes(asset)) return null;
      const r = await source!.observe(asset, now).catch(() => null);
      if (!r?.ok || !observationFresh(r.observation, now, source!.maxAgeMs)) return null;
      const value = parseScaled(r.observation.priceUsd, PRICE_SCALE);
      return value !== null && value > 0n ? { value, at: r.observation.observedAt } : null;
    };
    const eth = await read('ETH');
    if (!eth) return null;
    const usdc = await read('USDC');
    return { ethUsd: eth.value, usdcUsd: usdc?.value ?? null, observedAt: eth.at };
  } };
}

// ── What a Circle-prepared group carries (`prepared.circle`) ─────────────────────────────────────────────────────────────────
export type CircleGas = { readonly verificationGasLimit: string; readonly callGasLimit: string; readonly preVerificationGas: string; readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string; readonly paymasterVerificationGasLimit: string; readonly paymasterPostOpGasLimit: string };
export type CircleFacts = {
  /** PERMIT: the owner signs the permit next; OPERATION: the permit is signed and verified, the owner signs the operation next. */
  readonly stage: 'PERMIT' | 'OPERATION';
  readonly accountKind: erc4337.OwnerAccountKind; readonly entryPoint: string; readonly paymaster: string; readonly usdc: string;
  /** The reviewed allowance cap (USDC base units): the most the owner can pay for this fee. */
  readonly permitCap: string; readonly permitNonce: string; readonly permitSignature?: string;
  readonly price: { readonly ethUsd: string; readonly usdcUsd: string | null; readonly observedAt: string };
  readonly surchargeBps: string; readonly marginBps: string;
  readonly nonce: string; readonly callData: string; readonly gas: CircleGas;
  /** What native gas would have needed (the batch's fee ceiling plus any native value): re-checked at authorization. */
  readonly nativeRequired: string;
  /** The group's own USDC need at its worst point (base units), reserved beside the cap. */
  readonly usdcSpend: string;
  /** The strategy the group was planned with (restored when this preparation expires). */
  readonly plannedStrategy: GroupStrategy;
};
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
/** The Circle facts of a prepared artifact (strictly read back), or null for any artifact that is not Circle-paid. */
export function circleFactsOf(prepared: Readonly<Record<string, unknown>> | null | undefined): CircleFacts | null {
  const c = prepared && typeof prepared === 'object' && prepared.circle && typeof prepared.circle === 'object' ? prepared.circle as Record<string, unknown> : null;
  if (!c || (c.stage !== 'PERMIT' && c.stage !== 'OPERATION') || typeof c.accountKind !== 'string' || !(c.accountKind in erc4337.OWNER_ACCOUNT_KINDS)) return null;
  const strings = ['entryPoint', 'paymaster', 'usdc', 'permitCap', 'permitNonce', 'surchargeBps', 'marginBps', 'nonce', 'callData', 'nativeRequired', 'usdcSpend', 'plannedStrategy'];
  if (strings.some(k => typeof c[k] !== 'string') || !c.gas || typeof c.gas !== 'object' || !c.price || typeof c.price !== 'object') return null;
  if (![c.permitCap, c.permitNonce, c.nonce, c.nativeRequired, c.usdcSpend].every(v => DECIMAL.test(String(v)))) return null;
  return c as unknown as CircleFacts;
}
/** The strategy a Circle preparation replaced (restored when it expires or must be prepared again), else null. */
export const plannedStrategyOf = (prepared: Readonly<Record<string, unknown>> | null | undefined): GroupStrategy | null => circleFactsOf(prepared)?.plannedStrategy ?? null;
const gasOf = (g: CircleGas): erc4337.UserOperationGas => ({ verificationGasLimit: BigInt(g.verificationGasLimit), callGasLimit: BigInt(g.callGasLimit),
  preVerificationGas: BigInt(g.preVerificationGas), maxFeePerGas: BigInt(g.maxFeePerGas), maxPriorityFeePerGas: BigInt(g.maxPriorityFeePerGas) });
const paymasterGasOf = (g: CircleGas) => ({ verificationGasLimit: BigInt(g.paymasterVerificationGasLimit), postOpGasLimit: BigInt(g.paymasterPostOpGasLimit) });
/** The token-paid fee the owner reviews and signs (`GasPayment`), from the facts. */
export function circleGasPayment(c: CircleFacts): Extract<GasPayment, { mechanism: 'CIRCLE_USDC_PAYMASTER' }> {
  return { mechanism: 'CIRCLE_USDC_PAYMASTER', maxFee: { token: c.usdc, symbol: 'USDC', decimals: C.CIRCLE_USDC_DECIMALS, amount: c.permitCap }, signatures: 2,
    paymaster: c.paymaster, entryPoint: c.entryPoint, permitCap: c.permitCap };
}
/** The permit the owner signs for these facts (pure: rebuilt identically by the server and by the owner's browser). */
export const circlePermitOf = (c: CircleFacts, chainId: number, owner: string) =>
  C.circlePermit({ chainId, entryPoint: c.entryPoint, owner, cap: BigInt(c.permitCap), nonce: BigInt(c.permitNonce) });

// ── The USDC reserve ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The most of `token` the group's calls need from the owner's balance at any point of the batch, in order: every exact spend counted when it
 * leaves, every guaranteed receipt (a swap's signed minimum, a borrow's or withdrawal's exact amount) only after it arrived. The paymaster's
 * prefund (at most the cap) leaves BEFORE the calls run, so the owner must hold this plus the cap.
 */
export function tokenNeedOf(group: EvmGroupCalls, token: string): bigint {
  const t = token.toLowerCase(), owner = group.owner.toLowerCase();
  let net = 0n, worst = 0n;
  const flows = (c: UserCall): readonly [bigint, bigint] => {
    const of = (address: string, amount: string) => address.toLowerCase() === t ? BigInt(amount) : 0n;
    switch (c.kind) {
      case 'UNISWAP_V3_EXACT_INPUT_SINGLE': return [of(c.tokenIn, c.amountIn), of(c.tokenOut, c.amountOutMinimum)];
      case 'AAVE_V3_SUPPLY': case 'AAVE_V3_REPAY': return [of(c.asset, c.amount), 0n];
      case 'AAVE_V3_BORROW': case 'AAVE_V3_WITHDRAW': return [0n, of(c.asset, c.amount)];
      case 'ERC20_TRANSFER': return [of(c.token, c.amount), c.to.toLowerCase() === owner ? of(c.token, c.amount) : 0n];
      case 'ACROSS_DEPOSIT': return [of(c.inputToken, c.inputAmount), 0n];
      default: return [0n, 0n];
    }
  };
  for (const c of group.calls) {
    const [out, into] = flows(c);
    net -= out;
    if (-net > worst) worst = -net;
    net += into;
  }
  return worst;
}

// ── On-chain verification of the pinned contracts (cached per process on success, for public transports only) ────────────────
const VERIFIED_MS = 3_600_000;
const verifiedUntil = new Map<string, number>();
type Verification = 'OK' | 'UNVERIFIED' | 'UNAVAILABLE';
async function verifyCircleContracts(t: ChainTransport, chainId: number, entryPoint: string, paymaster: string, usdc: string, now: Date): Promise<Verification> {
  const key = `${chainId}:${entryPoint}:${paymaster}:${usdc}`;
  if (t.provenance === 'PUBLIC' && (verifiedUntil.get(key) ?? 0) > now.getTime()) return 'OK';
  try {
    const [pmCode, usdcCode] = await Promise.all([t.rpc('eth_getCode', [paymaster, 'latest']), t.rpc('eth_getCode', [usdc, 'latest'])]);
    if (typeof pmCode !== 'string' || pmCode.length <= 2 || typeof usdcCode !== 'string' || usdcCode.length <= 2) return 'UNVERIFIED';
    const [ep, name, version] = await Promise.all([t.rpc('eth_call', [{ to: paymaster, data: C.CIRCLE_SELECTORS.entryPoint }, 'latest']),
      t.rpc('eth_call', [{ to: usdc, data: C.CIRCLE_SELECTORS.name }, 'latest']), t.rpc('eth_call', [{ to: usdc, data: C.CIRCLE_SELECTORS.version }, 'latest'])]);
    if (C.decodeAddressAnswer(ep) !== entryPoint || C.decodeStringAnswer(name) !== C.CIRCLE_USDC_PERMIT_DOMAIN.name || C.decodeStringAnswer(version) !== C.CIRCLE_USDC_PERMIT_DOMAIN.version)
      return 'UNVERIFIED';
  } catch (cause) { return codeOf(cause, '') === 'DELEGATION_RPC_UNAVAILABLE' ? 'UNAVAILABLE' : 'UNVERIFIED'; }
  if (t.provenance === 'PUBLIC') verifiedUntil.set(key, now.getTime() + VERIFIED_MS);
  return 'OK';
}
/** The paymaster's `additionalGasCharge()` (its postOp overhead), or null when it does not answer one. */
async function additionalGasCharge(rpc: Rpc, paymaster: string): Promise<bigint | null> {
  try { return C.decodeUintAnswer(await rpc('eth_call', [{ to: paymaster, data: C.CIRCLE_SELECTORS.additionalGasCharge }, 'latest'])); } catch { return null; }
}
async function readUint(rpc: Rpc, to: string, data: string): Promise<bigint> { return C.decodeUintAnswer(await rpc('eth_call', [{ to, data }, 'latest'])); }
/** The sequence of nonce `key` from `EntryPoint.getNonce` (`key << 64 | sequence`), or null when the answer is about another key. */
async function entryPointSequence(rpc: Rpc, entryPoint: string, owner: string, key: bigint): Promise<bigint | null> {
  const n = erc4337.decodeGetNonce(await rpc('eth_call', [{ to: entryPoint, data: erc4337.getNonceCall(owner, key) }, 'latest']));
  return n >> 64n === key ? n & ((1n << 64n) - 1n) : n >> 64n === 0n ? n : null;
}

// ── Phase 1: eligibility, the operation's conservative limits, the cap and the permit ────────────────────────────────────────
/** Conservative phase-1 limits (the final ones come from the bundler's estimate of the operation WITH the signed permit, phase 2). */
export const CIRCLE_PHASE1 = Object.freeze({ accountVerificationGas: 250_000n, preVerificationGas: 150_000n, callGasPaddingPercent: 130n, callGasExtra: 50_000n });
/** A well-formed 65-byte ECDSA signature that recovers to nobody: the bundler estimates the final operation before the owner signs it. */
const ESTIMATION_SIGNATURE = '0x' + 'ff'.repeat(32) + '7f' + 'ff'.repeat(31) + '1c';
export type CircleAttemptInput = {
  readonly runId: string; readonly groupIndex: number; readonly chain: string; readonly strategy: GroupStrategy; readonly wallet?: 'INJECTED' | 'FLOFI_WALLET';
  /** The wallet batch's exact calls (deadline-bounded), its whole-batch simulation and simulated gas. */
  readonly group: EvmGroupCalls; readonly calls: readonly erc7710.Call[]; readonly simulation: BatchSimulation | null; readonly simulatedGas: bigint;
  readonly fees: { readonly priority: bigint; readonly gasPrice: bigint; readonly balance: bigint }; readonly l1FeeUpperBound: bigint;
  /** The native path's fee ceiling + native value: what the owner's balance did not cover. */ readonly nativeRequired: bigint;
  readonly nativeSpend: bigint; readonly now: Date };
export type CircleAttempt = { readonly considered: false } | { readonly considered: true; readonly candidate: MechanismCandidate; readonly prepared: Readonly<Record<string, unknown>> | null };
type CircleRuntimeDeps = { readonly evm: (chain: string) => ChainTransport | null; readonly bundler: (chain: string) => BundlerClient | null;
  readonly circle?: CircleDeps | null };
const unavailable = (code: string): CircleAttempt => ({ considered: true, candidate: { mechanism: 'CIRCLE_USDC_PAYMASTER', eligible: false, code }, prepared: null });

/**
 * Phase 1 for a group whose owner cannot pay the native fee. Not considered (`considered: false`) where the operator did not enable Circle on the
 * chain; otherwise the candidate the policy decides with and, when eligible, the Circle-prepared artifact (an `EVM_USER_OPERATION` at stage PERMIT).
 */
export async function circleAttempt(deps: CircleRuntimeDeps, input: CircleAttemptInput): Promise<CircleAttempt> {
  if (!deps.circle?.chains.includes(input.chain)) return { considered: false };
  const t = deps.evm(input.chain), bundler = deps.bundler(input.chain), group = input.group, owner = group.owner.toLowerCase(), chainId = group.chainId;
  if (!t || !bundler?.estimateCircle || !bundler.sendCircle) return unavailable('USER_OPERATION_BUNDLER_UNAVAILABLE');
  if (input.wallet === 'FLOFI_WALLET') return unavailable('CIRCLE_WALLET_UNSUPPORTED');
  // The fee only: any native value the group sends is still the owner's own ETH.
  if (input.fees.balance < input.nativeSpend) return unavailable('CIRCLE_NATIVE_VALUE_UNCOVERED');
  if (!input.simulation) return unavailable('USER_FUNDED_SIMULATION_UNAVAILABLE');
  const pins = C.circlePinsOf(chainId);
  if (!pins) return unavailable('TOKEN_GAS_CHAIN_UNSUPPORTED');
  let code: string;
  try { code = String(await t.rpc('eth_getCode', [owner, 'latest'])).toLowerCase(); } catch { return unavailable('USER_FUNDED_RPC_UNAVAILABLE'); }
  if (code === '0x' || code === '') return unavailable('CIRCLE_SMART_ACCOUNT_REQUIRED');
  const accountKind = erc4337.ownerAccountKindOfCode(code);
  if (!accountKind) return unavailable('CIRCLE_ACCOUNT_UNSUPPORTED');
  const entryPoint = erc4337.OWNER_ACCOUNT_KINDS[accountKind].entryPoint, paymaster = C.circlePaymasterOf(chainId, entryPoint);
  if (!paymaster) return unavailable('CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED');
  const verified = await verifyCircleContracts(t, chainId, entryPoint, paymaster, pins.usdc, input.now);
  if (verified !== 'OK') return unavailable(verified === 'UNAVAILABLE' ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'CIRCLE_PAYMASTER_UNVERIFIED');
  let postOpGasLimit: bigint;
  try { postOpGasLimit = C.circlePostOpGasLimit(await additionalGasCharge(t.rpc, paymaster)); } catch { return unavailable('CIRCLE_PAYMASTER_UNVERIFIED'); }
  const price = await deps.circle.price(input.now).catch(() => null);
  if (!price) return unavailable('CIRCLE_PRICE_UNAVAILABLE');
  const key = erc4337.nonceKeyOf(`${input.runId}:g${input.groupIndex}`);
  let sequence: bigint | null, usdcBalance: bigint, permitNonce: bigint;
  try {
    [sequence, usdcBalance, permitNonce] = await Promise.all([entryPointSequence(t.rpc, entryPoint, owner, key), readUint(t.rpc, pins.usdc, C.balanceOfCall(owner)),
      readUint(t.rpc, pins.usdc, C.permitNoncesCall(owner))]);
  } catch { return unavailable('USER_FUNDED_RPC_UNAVAILABLE'); }
  if (sequence === null) return unavailable('USER_FUNDED_RPC_UNAVAILABLE');
  // Conservative phase-1 limits: the simulated calls with headroom, a verification allowance for either pinned account, a pre-verification
  // allowance that covers an OP Stack chain's L1 data fee twice over at today's base price, and Circle's own paymaster limits.
  const maxFeePerGas = input.fees.gasPrice * 2n + input.fees.priority;
  if (maxFeePerGas <= 0n) return unavailable('USER_FUNDED_RPC_UNAVAILABLE');
  const l1Allowance = input.l1FeeUpperBound > 0n && input.fees.gasPrice > 0n ? (input.l1FeeUpperBound * 2n + input.fees.gasPrice - 1n) / input.fees.gasPrice : 0n;
  const gas: erc4337.UserOperationGas = { verificationGasLimit: CIRCLE_PHASE1.accountVerificationGas,
    callGasLimit: input.simulatedGas * CIRCLE_PHASE1.callGasPaddingPercent / 100n + CIRCLE_PHASE1.callGasExtra,
    preVerificationGas: CIRCLE_PHASE1.preVerificationGas + input.simulatedGas / 2n + l1Allowance, maxFeePerGas, maxPriorityFeePerGas: input.fees.priority };
  const pmGas = { verificationGasLimit: C.CIRCLE_PAYMASTER_GAS.verification, postOpGasLimit };
  const nativeWorst = C.circleMaxNativeCost(gas, pmGas);
  const permitCap = C.circleUsdcWorstCase({ nativeWei: nativeWorst, ethUsd: price.ethUsd, usdcUsd: price.usdcUsd });
  if (permitCap <= 0n) return unavailable('CIRCLE_PRICE_UNAVAILABLE');
  // (h) The fee reserve sits beside the group's own USDC need, never inside it.
  const usdcSpend = tokenNeedOf(group, pins.usdc);
  if (usdcBalance < usdcSpend + permitCap) return unavailable('CIRCLE_INSUFFICIENT_USDC');
  let callData: string;
  try { callData = erc4337.ownerAccountCallData(accountKind, input.calls); } catch (cause) { return unavailable(codeOf(cause, 'USER_FUNDED_GROUP_NOT_PREPARABLE')); }
  const nonce = erc4337.userOpNonce(key, sequence);
  const facts: CircleFacts = { stage: 'PERMIT', accountKind, entryPoint, paymaster, usdc: pins.usdc, permitCap: permitCap.toString(), permitNonce: permitNonce.toString(),
    price: { ethUsd: price.ethUsd.toString(), usdcUsd: price.usdcUsd?.toString() ?? null, observedAt: price.observedAt },
    surchargeBps: C.CIRCLE_SURCHARGE_BPS.toString(), marginBps: C.CIRCLE_PRICE_MARGIN_BPS.toString(), nonce: nonce.toString(), callData,
    gas: { verificationGasLimit: gas.verificationGasLimit.toString(), callGasLimit: gas.callGasLimit.toString(), preVerificationGas: gas.preVerificationGas.toString(),
      maxFeePerGas: gas.maxFeePerGas.toString(), maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString(), paymasterVerificationGasLimit: pmGas.verificationGasLimit.toString(),
      paymasterPostOpGasLimit: pmGas.postOpGasLimit.toString() },
    nativeRequired: input.nativeRequired.toString(), usdcSpend: usdcSpend.toString(), plannedStrategy: input.strategy };
  const permit = circlePermitOf(facts, chainId, owner);
  return { considered: true, candidate: { mechanism: 'CIRCLE_USDC_PAYMASTER', eligible: true }, prepared: {
    kind: 'EVM_USER_OPERATION', chainId, owner, group, upgraded: true, simulation: input.simulation, circle: facts, gasPayment: circleGasPayment(facts),
    permit: { typedData: C.permitTypedData(permit) },
    fee: { payer: owner, unit: 'token', token: pins.usdc, symbol: 'USDC', decimals: C.CIRCLE_USDC_DECIMALS, maxCost: permitCap.toString(), nativeMaxCost: nativeWorst.toString(),
      maxFeePerGas: maxFeePerGas.toString(), estimated: false } } };
}

// ── Phase 2: the owner's permit, the final operation ────────────────────────────────────────────────────────────────────────
export type CircleResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
const no = (code: string): CircleResult<never> => ({ ok: false, code });
/** The final operation of a Circle group from its facts (the signed permit inside its paymasterAndData). */
export function circleOperationOf(c: CircleFacts, sender: string, signature = '0x'): erc4337.PackedUserOperation {
  if (!c.permitSignature) throw new Error('CIRCLE_PERMIT_REQUIRED');
  const pm = paymasterGasOf(c.gas);
  return erc4337.packedUserOperationWithPaymaster({ sender, nonce: BigInt(c.nonce), callData: c.callData, gas: gasOf(c.gas), signature,
    paymasterAndData: C.circlePaymasterAndData({ paymaster: c.paymaster, verificationGasLimit: pm.verificationGasLimit, postOpGasLimit: pm.postOpGasLimit, token: c.usdc,
      permitAmount: BigInt(c.permitCap), permitSignature: c.permitSignature }) });
}
const expectationOf = (c: CircleFacts, chainId: number, owner: string): C.CircleOperationExpectation => ({ chainId, entryPoint: c.entryPoint, owner, accountKind: c.accountKind,
  permitCap: BigInt(c.permitCap), permitNonce: BigInt(c.permitNonce) });
/** The typed data the owner's wallet signs for the final operation (the account's own scheme) and the operation's EntryPoint hash. */
export function circleOperationTypedData(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation) {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.entryPointV08TypedData(chainId, op, c.entryPoint) : erc4337.delegatorUserOpTypedData(chainId, op, c.entryPoint);
}
/** Whether `signature` is the owner's signature of the final operation, as the owner's account validates it. */
export function verifyCircleOperationSignature(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation, signature: string): boolean {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.verifyOwnerUserOpSignatureV08(chainId, op, signature, c.entryPoint)
    : erc4337.verifyOwnerUserOpSignature(chainId, op, signature, c.entryPoint);
}
/** The owner's current USDC permit nonce: the signed permit is usable only while it is unmoved (it is consumed by the paymaster's validation). */
async function permitNonceUnmoved(rpc: Rpc, c: CircleFacts, owner: string): Promise<'OK' | 'MOVED' | 'UNAVAILABLE'> {
  try { return await readUint(rpc, c.usdc, C.permitNoncesCall(owner)) === BigInt(c.permitNonce) ? 'OK' : 'MOVED'; } catch { return 'UNAVAILABLE'; }
}
/**
 * Phase 2: the owner signed the permit. It is verified (signer = the owner over the pinned domain, spender = the paymaster, value = the cap,
 * the recorded nonce — still the owner's current one), the final operation is estimated by the bundler WITH it, padded, and its new worst case
 * must still price within the signed cap. Returns the prepared artifact at stage OPERATION with the operation's typed data.
 */
export async function finalizeCirclePermit(deps: CircleRuntimeDeps, prepared: Readonly<Record<string, unknown>>, permitSignature: string): Promise<CircleResult<Readonly<Record<string, unknown>>>> {
  const c = circleFactsOf(prepared);
  if (!c || c.stage !== 'PERMIT') return no('CIRCLE_PERMIT_STAGE_INVALID');
  const chainId = Number(prepared.chainId), owner = String(prepared.owner).toLowerCase(), chain = `eip155:${chainId}`;
  if (typeof permitSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(permitSignature)) return no('CIRCLE_PERMIT_INVALID');
  const signature = permitSignature.toLowerCase();
  try { if (C.recoverPermitSigner(circlePermitOf(c, chainId, owner), signature) !== owner) return no('CIRCLE_PERMIT_INVALID'); } catch { return no('CIRCLE_PERMIT_INVALID'); }
  const t = deps.evm(chain), bundler = deps.bundler(chain);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  if (!bundler?.estimateCircle) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  const nonce = await permitNonceUnmoved(t.rpc, c, owner);
  if (nonce !== 'OK') return no(nonce === 'MOVED' ? 'CIRCLE_PERMIT_EXPIRED' : 'USER_FUNDED_RPC_UNAVAILABLE');
  const signed: CircleFacts = { ...c, permitSignature: signature };
  let estimate: Awaited<ReturnType<NonNullable<typeof bundler.estimateCircle>>>;
  try { estimate = await bundler.estimateCircle({ ...circleOperationOf(signed, owner), signature: ESTIMATION_SIGNATURE }, c.entryPoint); }
  catch (cause) { return no(codeOf(cause, 'CIRCLE_PAYMASTER_REFUSED')); }
  const before = gasOf(c.gas), pmBefore = paymasterGasOf(c.gas);
  const atLeast = (estimated: bigint, floor: bigint) => estimated > floor ? estimated : floor;
  // The bundler's need with headroom (as an owner-paid operation's), never below Circle's own documented paymaster limits; bounded.
  const gas: erc4337.UserOperationGas = { ...before, verificationGasLimit: estimate.verificationGasLimit * 12n / 10n, callGasLimit: estimate.callGasLimit * 12n / 10n,
    preVerificationGas: estimate.preVerificationGas * 11n / 10n };
  const pmGas = { verificationGasLimit: atLeast(estimate.paymasterVerificationGasLimit * 12n / 10n, pmBefore.verificationGasLimit),
    postOpGasLimit: atLeast(estimate.paymasterPostOpGasLimit * 12n / 10n, pmBefore.postOpGasLimit) };
  if (pmGas.verificationGasLimit > C.CIRCLE_PAYMASTER_GAS.verificationMax || pmGas.postOpGasLimit > C.CIRCLE_PAYMASTER_GAS.postOpMax) return no('CIRCLE_PAYMASTER_GAS_INVALID');
  const nativeWorst = C.circleMaxNativeCost(gas, pmGas);
  const needed = C.circleUsdcWorstCase({ nativeWei: nativeWorst, ethUsd: BigInt(c.price.ethUsd), usdcUsd: c.price.usdcUsd === null ? null : BigInt(c.price.usdcUsd),
    surchargeBps: BigInt(c.surchargeBps), marginBps: BigInt(c.marginBps) });
  // Never beyond what the owner signed: the paymaster could take at most the cap, and the owner reviewed exactly it.
  if (needed > BigInt(c.permitCap)) return no('CIRCLE_PERMIT_CAP_EXCEEDED');
  const final: CircleFacts = { ...signed, stage: 'OPERATION', gas: { ...c.gas, verificationGasLimit: gas.verificationGasLimit.toString(), callGasLimit: gas.callGasLimit.toString(),
    preVerificationGas: gas.preVerificationGas.toString(), paymasterVerificationGasLimit: pmGas.verificationGasLimit.toString(), paymasterPostOpGasLimit: pmGas.postOpGasLimit.toString() } };
  let op: erc4337.PackedUserOperation;
  try { op = circleOperationOf(final, owner); C.assertCirclePaymasterOperation(op, expectationOf(final, chainId, owner)); }
  catch (cause) { return no(codeOf(cause, 'CIRCLE_OPERATION_INVALID')); }
  const fee = prepared.fee && typeof prepared.fee === 'object' ? prepared.fee as Record<string, unknown> : {};
  return { ok: true, value: { ...prepared, circle: final, gasPayment: circleGasPayment(final),
    op: { sender: op.sender, nonce: op.nonce.toString(), callData: op.callData, accountGasLimits: op.accountGasLimits, preVerificationGas: op.preVerificationGas.toString(),
      gasFees: op.gasFees, paymasterAndData: op.paymasterAndData },
    userOpHash: erc4337.userOpHashFor(op, chainId, final.entryPoint), typedData: circleOperationTypedData(final, chainId, op),
    fee: { ...fee, nativeMaxCost: nativeWorst.toString() } } };
}

// ── Authorization and submission checks ────────────────────────────────────────────────────────────────────────────────────
/** The owner's operation signature for a Circle group at stage OPERATION (pure; `groups.ts` `authorizeGroup`). */
export function authorizeCircleOperation(prepared: Readonly<Record<string, unknown>>, signature: string, owner: string): CircleResult<null> {
  const c = circleFactsOf(prepared), chainId = Number(prepared.chainId);
  if (!c || c.stage !== 'OPERATION') return no('CIRCLE_PERMIT_REQUIRED');
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return no('USER_OPERATION_SIGNATURE_INVALID');
  let op: erc4337.PackedUserOperation;
  try { op = circleOperationOf(c, owner.toLowerCase()); C.assertCirclePaymasterOperation(op, expectationOf(c, chainId, owner)); }
  catch (cause) { return no(codeOf(cause, 'CIRCLE_OPERATION_INVALID')); }
  if (op.sender !== owner.toLowerCase() || !verifyCircleOperationSignature(c, chainId, op, signature)) return no('USER_OPERATION_SIGNER_MISMATCH');
  return { ok: true, value: null };
}
/**
 * Before anything is relayed: S1 with the token-fee claim (Circle's pinned paymaster fronts the fee; the owner pays a positive USDC amount, at most
 * the cap), the operation check again (the permit recovers to the owner over its recorded nonce), and that nonce still the owner's current one —
 * a permit overtaken by another of the owner's permits can never execute (CIRCLE_PERMIT_EXPIRED, refused before relay).
 */
export async function checkCircleSubmission(deps: CircleRuntimeDeps, prepared: Readonly<Record<string, unknown>>, op: erc4337.PackedUserOperation, owner: string): Promise<CircleResult<CircleFacts>> {
  const c = circleFactsOf(prepared), chainId = Number(prepared.chainId);
  if (!c || c.stage !== 'OPERATION') return no('CIRCLE_PERMIT_REQUIRED');
  try {
    assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: op.sender, ownerWallet: owner, sponsorship: op.paymasterAndData,
      tokenFee: { mechanism: 'CIRCLE_USDC_PAYMASTER', relayer: c.paymaster, pinnedRelayers: C.circlePaymastersOf(chainId), token: c.usdc, amount: c.permitCap } });
    C.assertCirclePaymasterOperation(op, expectationOf(c, chainId, owner));
  } catch (cause) { return no(codeOf(cause, 'CIRCLE_OPERATION_INVALID')); }
  const t = deps.evm(`eip155:${chainId}`);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  const nonce = await permitNonceUnmoved(t.rpc, c, owner.toLowerCase());
  if (nonce !== 'OK') return no(nonce === 'MOVED' ? 'CIRCLE_PERMIT_EXPIRED' : 'USER_FUNDED_RPC_UNAVAILABLE');
  return { ok: true, value: c };
}
/** Whether the owner's native balance now covers what native gas needed when the group was prepared (ADR-0010 §2: never switched silently). */
export async function nativeNowCovers(deps: CircleRuntimeDeps, prepared: Readonly<Record<string, unknown>>): Promise<boolean | null> {
  const c = circleFactsOf(prepared), t = deps.evm(`eip155:${String(prepared.chainId)}`);
  if (!c || !t) return null;
  try { return big(await t.rpc('eth_getBalance', [String(prepared.owner), 'latest'])) >= BigInt(c.nativeRequired); } catch { return null; }
}
/** Test seam: forgets every cached contract verification (a process restart does the same). */
export function forgetCircleVerifications(): void { verifiedUntil.clear(); }
