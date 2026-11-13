// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): a user-funded EVM group whose owner holds too little ETH for its network fee, paid in
 * the owner's USDC through Circle's paymaster — eligibility (every closed reason), the two owner signatures (permit, then operation), the
 * due-time checks before relay, the relay of exactly the signed bytes (also after a lost submission) and the reconciliation of the USDC fee
 * from the chain. Native gas stays untouched for an owner who holds ETH.
 *
 * MOCKED loopback doubles only (an EVM chain, Circle's paymaster MODEL, EntryPoints v0.7/v0.8 and a bundler behind FloFi's own bundler client):
 * this proves FloFi's logic, never Circle's live behaviour, a bundler's, or any public execution.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded, type ChainTransport } from '../delegation/chains.ts';
import { evmWallet } from '../delegation/delegation.test-harness.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { authorizeGroup, checkUserOperation, prepareGroup, reconcileEvmGroup, relayUserOperation, type NativeFeeShortfall, type Prepared, type UserFundedDeps } from './groups.ts';
import { circleDepsOf, circleFactsOf, circleOperationOf, circlePermitOf, finalizeCirclePermit, forgetCircleVerifications, tokenNeedOf, type CircleFacts } from './circle-gas.ts';
import type { PriceSource } from '../automations/price-source.ts';
import { reconcileUserOperation, TRANSFER_TOPIC } from './evm-reconcile.ts';
import type { EvmGroupCalls } from './evm-calls.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const PROFILES = { 1: { profile: ETHEREUM_MAINNET_SWAP, network: 'ethereum' }, 8453: { profile: BASE_MAINNET_SWAP, network: 'base' },
  42161: { profile: ARBITRUM_MAINNET_SWAP, network: 'arbitrum-one' } } as const;
type ChainId = keyof typeof PROFILES;
const R1 = '0x' + '2'.repeat(40), R2 = '0x' + '3'.repeat(40);
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topic = (a: string) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');

function compose(input: unknown) {
  const c = composeWorkflow(input);
  if (!c.ok) throw new Error(c.code);
  const r = requirementOf(c);
  if (!r.ok) throw new Error(r.code);
  return { composition: c, requirement: r.value };
}
const transfers = (network: string) => ({ version: 2, steps: [
  { action: 'transfer', network, asset: 'USDC', amount: '1', recipient: R1 }, { action: 'transfer', network, asset: 'USDC', amount: '2', recipient: R2 }] });

type Account = 'DELEGATOR' | 'SIMPLE_7702' | 'EOA' | 'OTHER';
async function setup(input: { chainId: ChainId; account: Account; eth?: bigint; usdc?: bigint; circle?: boolean; price?: boolean; wallet?: 'INJECTED' | 'FLOFI_WALLET';
  strategy?: unknown; estimate?: Parameters<typeof createCircleDouble>[1]['estimate'] }) {
  const { profile, network } = PROFILES[input.chainId], chain = `eip155:${input.chainId}`;
  const evm = createEvmDouble(input.chainId, () => Math.floor(NOW.getTime() / 1000), { profile });
  const circle = createCircleDouble(evm, { chainId: input.chainId, ...input.estimate ? { estimate: input.estimate } : {} });
  const owner = await evmWallet(), stranger = await evmWallet(), address = owner.address.toLowerCase();
  evm.control.fundNative(address, input.eth ?? 0n);
  evm.control.fundToken(address, profile.usdc, input.usdc ?? 50_000_000n);
  if (input.account === 'DELEGATOR') evm.control.upgrade(address);
  if (input.account === 'SIMPLE_7702') evm.control.setCode(address, '0xef0100' + erc4337.SIMPLE_7702_ACCOUNT_V0_8.slice(2));
  if (input.account === 'OTHER') evm.control.setCode(address, '0xef0100' + '12'.repeat(20));
  const transport: ChainTransport = guarded(chain, 'read', 'MOCKED', circle.rpc);
  const deps: UserFundedDeps = { chains: [chain], evm: c => c === chain ? transport : null, bundler: c => c === chain ? circle.bundler : null, solana: null, jupiter: null,
    now: () => NOW, ...input.circle === false ? {} : { circle: { chains: [chain],
      price: async () => input.price === false ? null : { ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: NOW.toISOString() } } } };
  const { composition, requirement } = compose(input.strategy ?? transfers(network));
  const group = { runId: 'wfr_' + 'c'.repeat(26), groupIndex: 0, strategy: 'EVM_WALLET_BATCH' as const, chain, feePayer: address, stepFrom: 0,
    stepTo: requirement.steps.length - 1, ...input.wallet ? { wallet: input.wallet } : {} };
  const prepare = () => prepareGroup(deps, composition, requirement, group);
  return { evm, circle, owner, stranger, address, deps, chain, chainId: input.chainId, usdc: profile.usdc, prepare };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const factsOf = (p: Prepared) => circleFactsOf(p) ?? (() => { throw new Error('CIRCLE_EXPECTED'); })();
/** The owner's wallet signs the permit exactly as the page asks it (`eth_signTypedData_v4` of the artifact's typed data). */
async function signPermit(ctx: Ctx, p: Prepared, signer = ctx.owner) { return signer.signDigest(C.permitDigest(circlePermitOf(factsOf(p), ctx.chainId, ctx.address))); }
/** The owner's wallet signs the operation in its account's own scheme. */
async function signOperation(ctx: Ctx, p: Prepared, signer = ctx.owner) {
  const c = factsOf(p), op = circleOperationOf(c, ctx.address);
  return signer.signDigest(c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.userOpHashV08(op, ctx.chainId) : erc4337.delegatorUserOpDigest(ctx.chainId, op));
}
async function prepared(ctx: Ctx): Promise<Prepared> {
  const r = await ctx.prepare();
  if (!r.ok) throw new Error(r.code);
  return r.value.prepared;
}
async function finalized(ctx: Ctx, p: Prepared): Promise<Prepared> {
  const f = await finalizeCirclePermit(ctx.deps, p, await signPermit(ctx, p));
  if (!f.ok) throw new Error(f.code);
  return f.value as Prepared;
}
const shortfallOf = (r: Awaited<ReturnType<Ctx['prepare']>>): NativeFeeShortfall => {
  if (r.ok || !r.evidence) throw new Error('SHORTFALL_EXPECTED');
  expect(r.code).toBe('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
  return r.evidence;
};

beforeEach(() => forgetCircleVerifications());

describe('ADR-0010 Circle USDC paymaster: native gas first', () => {
  it('an owner with enough ETH on Base keeps the native wallet batch, exactly as before (Circle is never asked)', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR', eth: 10n ** 17n });
    const p = await prepared(ctx);
    expect(p.kind).toBe('EVM_WALLET_BATCH');
    expect(circleFactsOf(p)).toBeNull();
    expect(p).not.toHaveProperty('gasPayment');
    expect((p.fee as { unit: string }).unit).toBe('wei');
    expect(ctx.circle.control.estimates()).toBe(0);
  });
  it('without the operator switch (or without ETH and without Circle) the shortfall is unchanged: no alternative is claimed', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR', circle: false });
    const e = shortfallOf(await ctx.prepare());
    expect(e).not.toHaveProperty('unavailable');
  });
});

describe('ADR-0010 Circle USDC paymaster: two signatures, relayed when due, reconciled in USDC', () => {
  for (const [chainId, account, entryPoint, paymaster] of [[8453, 'DELEGATOR', erc4337.ENTRY_POINT_V0_7, C.CIRCLE_PAYMASTER_V07],
    [42161, 'DELEGATOR', erc4337.ENTRY_POINT_V0_7, C.CIRCLE_PAYMASTER_V07], [1, 'SIMPLE_7702', erc4337.ENTRY_POINT_V0_8, C.CIRCLE_PAYMASTER_V08],
    [8453, 'SIMPLE_7702', erc4337.ENTRY_POINT_V0_8, C.CIRCLE_PAYMASTER_V08]] as const) {
    it(`eip155:${chainId} without ETH, ${account} account → Circle (EntryPoint ${entryPoint === erc4337.ENTRY_POINT_V0_7 ? 'v0.7' : 'v0.8'})`, async () => {
      const ctx = await setup({ chainId, account });
      const p = await prepared(ctx);
      // Phase 1: a Circle-paid user operation of the owner's own account; the fee is the permit's USDC cap, two signatures, no native fee.
      expect(p.kind).toBe('EVM_USER_OPERATION');
      const c = factsOf(p);
      expect(c).toMatchObject({ stage: 'PERMIT', entryPoint, paymaster, usdc: ctx.usdc, plannedStrategy: 'EVM_WALLET_BATCH' });
      expect(p.gasPayment).toMatchObject({ mechanism: 'CIRCLE_USDC_PAYMASTER', signatures: 2, paymaster, entryPoint, permitCap: c.permitCap,
        maxFee: { token: ctx.usdc, symbol: 'USDC', decimals: 6, amount: c.permitCap } });
      expect(p.fee).toMatchObject({ payer: ctx.address, unit: 'token', symbol: 'USDC', decimals: 6, maxCost: c.permitCap, estimated: false });
      // The exact calls of the batch (two transfers behind the batch's on-chain deadline guard), simulated whole before anything is asked.
      expect((p.group as EvmGroupCalls).calls.map(x => x.kind)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER', 'ERC20_TRANSFER']);
      expect(p.simulation).toBeTruthy();
      // The permit the wallet shows: Circle's pinned paymaster as spender, exactly the cap (never unlimited), the never-expiring deadline.
      const permit = (p.permit as { typedData: ReturnType<typeof C.permitTypedData> }).typedData;
      expect(permit.domain).toEqual({ name: 'USD Coin', version: '2', chainId, verifyingContract: ctx.usdc });
      expect(permit.message).toMatchObject({ owner: ctx.address, spender: paymaster, value: c.permitCap, nonce: '0', deadline: ((1n << 256n) - 1n).toString() });
      expect(p).not.toHaveProperty('typedData');
      // Before the permit is signed nothing can be authorized.
      expect(authorizeGroup(p, { kind: 'EVM_USER_OPERATION', signature: '0x' + '11'.repeat(65) }, ctx.address, NOW)).toMatchObject({ ok: false, code: 'CIRCLE_PERMIT_REQUIRED' });
      // Phase 2: the permit verified, the final operation estimated by the bundler WITH it, within the signed cap; its typed data to sign.
      const f = await finalized(ctx, p), fc = factsOf(f);
      expect(fc.stage).toBe('OPERATION');
      expect(BigInt(fc.gas.paymasterVerificationGasLimit) >= C.CIRCLE_PAYMASTER_GAS.verification).toBe(true);
      const typed = f.typedData as { domain: { name: string; verifyingContract: string } };
      expect(typed.domain).toMatchObject(account === 'SIMPLE_7702' ? { name: 'ERC4337', verifyingContract: erc4337.ENTRY_POINT_V0_8 }
        : { name: 'EIP7702StatelessDeleGator', verifyingContract: ctx.address });
      const opSignature = await signOperation(ctx, f);
      expect(ctx.owner.signatures).toBe(2);
      // The owner's operation signature is the only one accepted.
      expect(authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ctx, f, ctx.stranger) }, ctx.address, NOW))
        .toMatchObject({ ok: false, code: 'USER_OPERATION_SIGNER_MISMATCH' });
      const authorization = authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: opSignature }, ctx.address, NOW);
      if (!authorization.ok) throw new Error(authorization.code);
      // Due time: S1 with the token-fee claim, the permit nonce unmoved, the bundler's simulation within every signed limit — nothing relayed yet.
      const submitted = await checkUserOperation(ctx.deps, f, authorization.value, ctx.address);
      if (!submitted.ok) throw new Error(submitted.code);
      expect(submitted.value).toMatchObject({ userOpHash: f.userOpHash, entryPoint });
      expect(ctx.circle.control.sends()).toBe(0);
      const usdcBefore = ctx.evm.control.tokenBalance(ctx.usdc, ctx.address);
      expect(await relayUserOperation(ctx.deps, f, authorization.value)).toEqual({ ok: true, value: f.userOpHash });
      // Reconciled from the chain: the paymaster fronted the native fee; the owner paid it back in USDC (prefund − refund), excluded from the legs.
      const r = await reconcileEvmGroup(ctx.deps, f, submitted.value, authorization.value);
      const charged = ctx.circle.control.prefundOf(180_000n * 1_000_000_000n);
      expect(r).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: paymaster, amount: (180_000n * 1_000_000_000n).toString(), unit: 'wei', source: 'USER_OPERATION_EVENT',
        paidInToken: { mechanism: 'CIRCLE_USDC_PAYMASTER', token: ctx.usdc, symbol: 'USDC', decimals: 6, amount: charged.toString(), payee: paymaster } },
        steps: [{ stepIndex: 0, spent: [{ amount: '1000000' }] }, { stepIndex: 1, spent: [{ amount: '2000000' }] }] });
      expect((r as { gasPaid: { sponsored?: true } }).gasPaid.sponsored).toBeUndefined();
      expect(ctx.evm.control.tokenBalance(ctx.usdc, ctx.address)).toBe(usdcBefore - 3_000_000n - charged);
      // What remains of the cap stays approved to Circle's paymaster until the owner's next permit overwrites it (disclosed in the Review).
      expect(ctx.evm.control.allowance(ctx.usdc, ctx.address, paymaster)).toBe(BigInt(fc.permitCap) - ctx.circle.control.prefundOf(
        C.circleMaxNativeCost(erc4337.userOperationGas(circleOperationOf(fc, ctx.address)), { verificationGasLimit: BigInt(fc.gas.paymasterVerificationGasLimit),
          postOpGasLimit: BigInt(fc.gas.paymasterPostOpGasLimit) })));
      expect(ctx.evm.control.tokenBalance(ctx.usdc, R1)).toBe(1_000_000n);
    });
  }

  it('a lost submission is observed and relayed again with the SAME signed bytes, never different ones', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const f = await finalized(ctx, await prepared(ctx));
    const authorization = authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ctx, f) }, ctx.address, NOW);
    if (!authorization.ok) throw new Error(authorization.code);
    const submitted = await checkUserOperation(ctx.deps, f, authorization.value, ctx.address);
    if (!submitted.ok) throw new Error(submitted.code);
    ctx.circle.control.dropNextSend();
    expect(await relayUserOperation(ctx.deps, f, authorization.value)).toEqual({ ok: true, value: f.userOpHash });
    // Unknown to the bundler, nonce unconsumed: the same operation is relayed again (its nonce admits it once), then reconciled.
    expect(await reconcileEvmGroup(ctx.deps, f, submitted.value, authorization.value)).toEqual({ status: 'PENDING' });
    expect(ctx.circle.control.sends()).toBe(2);
    expect(await reconcileEvmGroup(ctx.deps, f, submitted.value, authorization.value)).toMatchObject({ status: 'RECONCILED' });
    expect(ctx.circle.control.receiptOf(String(f.userOpHash))?.status).toBe(1);
  });
});

describe('ADR-0010 Circle USDC paymaster: every reason it is not offered, attached to the native shortfall', () => {
  const unavailableOf = async (input: Parameters<typeof setup>[0], arrange?: (ctx: Ctx) => void) => {
    const ctx = await setup(input);
    arrange?.(ctx);
    return shortfallOf(await ctx.prepare()).unavailable;
  };
  it('Ethereum with MetaMask\'s DeleGator: Circle has no v0.7 paymaster there (the native shortfall is still reported)', async () => {
    const ctx = await setup({ chainId: 1, account: 'DELEGATOR' });
    const e = shortfallOf(await ctx.prepare());
    expect(e).toMatchObject({ chainId: 'eip155:1', unit: 'wei', unavailable: [{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED' }] });
    expect(BigInt(e.shortfall) > 0n).toBe(true);
  });
  it('a plain EOA, another delegation, FloFi Wallet', async () => {
    expect(await unavailableOf({ chainId: 8453, account: 'EOA' })).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_SMART_ACCOUNT_REQUIRED' }]);
    expect(await unavailableOf({ chainId: 8453, account: 'OTHER' })).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_ACCOUNT_UNSUPPORTED' }]);
    expect(await unavailableOf({ chainId: 8453, account: 'DELEGATOR', wallet: 'FLOFI_WALLET' })).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_WALLET_UNSUPPORTED' }]);
  });
  it('USDC that does not cover the group\'s own spend plus the cap; no verified price', async () => {
    // 3 USDC spent by the transfers + a cap of a few cents: 3.000001 USDC is not enough.
    expect(await unavailableOf({ chainId: 8453, account: 'DELEGATOR', usdc: 3_000_001n })).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_INSUFFICIENT_USDC' }]);
    expect(await unavailableOf({ chainId: 8453, account: 'DELEGATOR', price: false })).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_PRICE_UNAVAILABLE' }]);
  });
  it('a paymaster or USDC that contradicts the pins (no code, another EntryPoint, another permit domain) or an unbounded postOp charge', async () => {
    for (const mode of ['NO_CODE', 'WRONG_ENTRY_POINT', 'WRONG_DOMAIN'] as const)
      expect(await unavailableOf({ chainId: 8453, account: 'DELEGATOR' }, ctx => ctx.circle.control.setUnverified(mode)))
        .toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_PAYMASTER_UNVERIFIED' }]);
    expect(await unavailableOf({ chainId: 8453, account: 'DELEGATOR' }, ctx => ctx.circle.control.setAdditionalGasCharge(10n ** 9n)))
      .toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_PAYMASTER_UNVERIFIED' }]);
    // A paymaster without `additionalGasCharge()` uses Circle's documented 15,000 postOp limit.
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    ctx.circle.control.setAdditionalGasCharge(null);
    expect(factsOf(await prepared(ctx)).gas.paymasterPostOpGasLimit).toBe('15000');
  });
  it('a group whose earlier wallet batch may still be in the owner\'s wallet keeps its batch (tokenGas false): no alternative', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const { composition, requirement } = compose(transfers('base'));
    const r = await prepareGroup(ctx.deps, composition, requirement, { runId: 'wfr_' + 'c'.repeat(26), groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: ctx.chain,
      feePayer: ctx.address, stepFrom: 0, stepTo: 1, tokenGas: false });
    expect(shortfallOf(r)).not.toHaveProperty('unavailable');
  });
});

describe('ADR-0010 Circle USDC paymaster: the permit and the operation are refused before anything is relayed', () => {
  it('a permit signed by someone else, or for a nonce the owner has since used, is refused at phase 2', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const p = await prepared(ctx);
    expect(await finalizeCirclePermit(ctx.deps, p, await signPermit(ctx, p, ctx.stranger))).toEqual({ ok: false, code: 'CIRCLE_PERMIT_INVALID' });
    expect(await finalizeCirclePermit(ctx.deps, p, '0x1234')).toEqual({ ok: false, code: 'CIRCLE_PERMIT_INVALID' });
    const signed = await signPermit(ctx, p);
    ctx.circle.control.usePermitNonce(ctx.address);
    expect(await finalizeCirclePermit(ctx.deps, p, signed)).toEqual({ ok: false, code: 'CIRCLE_PERMIT_EXPIRED' });
    expect(ctx.circle.control.sends()).toBe(0);
  });
  it('a permit overtaken after authorization (the owner signed another permit) is refused at due time, before relay', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const f = await finalized(ctx, await prepared(ctx));
    const authorization = authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ctx, f) }, ctx.address, NOW);
    if (!authorization.ok) throw new Error(authorization.code);
    ctx.circle.control.usePermitNonce(ctx.address);
    expect(await checkUserOperation(ctx.deps, f, authorization.value, ctx.address)).toEqual({ ok: false, code: 'CIRCLE_PERMIT_EXPIRED', stepIndex: null });
    expect(ctx.circle.control.sends()).toBe(0);
  });
  it('an operation whose final estimate no longer fits the signed cap asks for a new permit (CIRCLE_PERMIT_CAP_EXCEEDED); a tampered artifact is never relayed', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR', estimate: { verificationGasLimit: 110_000n, callGasLimit: 30_000_000n, preVerificationGas: 60_000n,
      paymasterVerificationGasLimit: 120_000n, paymasterPostOpGasLimit: 30_000n } });
    const p = await prepared(ctx);
    expect(await finalizeCirclePermit(ctx.deps, p, await signPermit(ctx, p))).toEqual({ ok: false, code: 'CIRCLE_PERMIT_CAP_EXCEEDED' });
    const ok = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const f = await finalized(ok, await prepared(ok));
    const authorization = authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ok, f) }, ok.address, NOW);
    if (!authorization.ok) throw new Error(authorization.code);
    const tampered = { ...f, op: { ...(f.op as Record<string, unknown>), callData: '0x00' } } as Prepared;
    expect(await checkUserOperation(ok.deps, tampered, authorization.value, ok.address)).toMatchObject({ ok: false, code: 'CIRCLE_OPERATION_INVALID' });
    expect(await relayUserOperation(ok.deps, tampered, authorization.value)).toMatchObject({ ok: false, code: 'CIRCLE_OPERATION_INVALID' });
    // A cap the facts no longer match (a raised cap without a new permit) is refused by the operation check.
    const raised = { ...f, circle: { ...factsOf(f), permitCap: (BigInt(factsOf(f).permitCap) + 1n).toString() } } as Prepared;
    expect(authorizeGroup(raised, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ok, f) }, ok.address, NOW)).toMatchObject({ ok: false });
    expect(ok.circle.control.sends()).toBe(0);
  });
  it('the bundler double refuses an operation naming another paymaster before anything is asked (FloFi never relays a sponsorship)', async () => {
    const ctx = await setup({ chainId: 8453, account: 'DELEGATOR' });
    const f = await finalized(ctx, await prepared(ctx)), c = factsOf(f);
    const foreign = { ...circleOperationOf(c, ctx.address), paymasterAndData: '0x' + '9'.repeat(40) + factsOf(f).gas.paymasterVerificationGasLimit.padStart(32, '0')
      + '0'.repeat(32) };
    await expect(ctx.circle.bundler.estimateCircle!(foreign, c.entryPoint)).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
    await expect(ctx.circle.bundler.sendCircle!({ ...foreign, signature: '0x' + '11'.repeat(65) }, c.entryPoint)).rejects.toThrow('ERC4337_SPONSORED_REFUSED');
  });
});

describe('ADR-0010 Circle USDC paymaster: the USDC reserve and reconciliation', () => {
  it('reserves the group\'s worst-point USDC need beside the cap: a swap→bridge group needs only what leaves before the swap\'s minimum arrives', () => {
    const owner = '0x' + '1'.repeat(40), usdc = BASE_MAINNET_SWAP.usdc, weth = BASE_MAINNET_SWAP.weth;
    const group = { chain: 'eip155:8453', chainId: 8453, owner, steps: [], calls: [
      { kind: 'ERC20_APPROVE', token: weth, spender: BASE_MAINNET_SWAP.router, amount: '1' },
      { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: BASE_MAINNET_SWAP.router, tokenIn: weth, tokenOut: usdc, fee: 500, amountIn: '1000', amountOutMinimum: '2000000',
        quotedAmountOut: '2100000' },
      { kind: 'ACROSS_DEPOSIT', inputToken: usdc, inputAmount: '2000000' } as unknown as EvmGroupCalls['calls'][number],
    ] } as unknown as EvmGroupCalls;
    // The bridge spends exactly the swap's guaranteed USDC: nothing of the owner's own USDC, so the whole balance is the fee reserve.
    expect(tokenNeedOf(group, usdc)).toBe(0n);
    // A bridge of more than the swap guarantees draws on the owner's own USDC, which is then reserved beside the cap.
    const more = { ...group, calls: [...group.calls.slice(0, 2), { ...group.calls[2], inputAmount: '2500000' }] } as unknown as EvmGroupCalls;
    expect(tokenNeedOf(more, usdc)).toBe(500_000n);
    // Spending first and receiving later counts the spend in full.
    const swapIn = { ...group, calls: [{ kind: 'ERC20_TRANSFER', token: usdc, to: '0x' + '4'.repeat(40), amount: '700000' }, ...group.calls.slice(0, 2)] } as unknown as EvmGroupCalls;
    expect(tokenNeedOf(swapIn, usdc)).toBe(700_000n);
  });

  it('a swap and a transfer of USDC: eligible only when the owner holds the spend plus the cap', async () => {
    const strategy = { version: 2, steps: [{ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
      { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: R1 }] };
    const probe = await setup({ chainId: 8453, account: 'DELEGATOR', strategy });
    const c = factsOf(await prepared(probe));
    expect(c.usdcSpend).toBe('4000000');
    const exact = 4_000_000n + BigInt(c.permitCap);
    expect((await (await setup({ chainId: 8453, account: 'DELEGATOR', strategy, usdc: exact })).prepare()).ok).toBe(true);
    const short = await setup({ chainId: 8453, account: 'DELEGATOR', strategy, usdc: exact - 1n });
    expect(shortfallOf(await short.prepare()).unavailable).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_INSUFFICIENT_USDC' }]);
  });

  it('accepts only the pinned paymaster for a Circle group; any other owner outflow is still unexpected; the fee is bounded by the cap', async () => {
    const owner = '0x' + '1'.repeat(40), usdc = BASE_MAINNET_SWAP.usdc, pm = C.CIRCLE_PAYMASTER_V07, ep = erc4337.ENTRY_POINT_V0_7, hash = '0x' + 'ab'.repeat(32);
    const group = { chain: 'eip155:8453', chainId: 8453, owner, calls: [{ kind: 'ERC20_TRANSFER', token: usdc, to: R1, amount: '1000000' }],
      steps: [{ stepIndex: 0, calls: [0], spend: { asset: 'x', amount: '1000000' }, guaranteed: null, quoted: null, recipient: R1 }] } as unknown as EvmGroupCalls;
    const transfer = (from: string, to: string, amount: bigint) => ({ address: usdc, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: word(amount) });
    const event = (paymaster: string) => ({ address: ep, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, hash, topic(owner), topic(paymaster)],
      data: '0x' + [0n, 1n, 5_000n, 5n].map(v => v.toString(16).padStart(64, '0')).join('') });
    const before = { address: ep, topics: [erc4337.BEFORE_EXECUTION_TOPIC], data: '0x' };
    const receipt = (logs: unknown[]) => ({ chain: 'eip155:8453', provenance: 'MOCKED' as const, rpc: async () => ({ transactionHash: '0x' + 'cd'.repeat(32), status: '0x1',
      blockNumber: '0x10', logs }) });
    const circle = { entryPoint: ep, paymaster: pm, usdc, cap: 100_000n };
    const fine = [transfer(owner, pm, 90_000n), before, transfer(owner, R1, 1_000_000n), transfer(pm, owner, 60_000n), event(pm)];
    expect(await reconcileUserOperation(receipt(fine), group, hash, '0x' + 'cd'.repeat(32), circle)).toMatchObject({ status: 'RECONCILED',
      gasPaid: { payer: pm, paidInToken: { amount: '30000' } }, steps: [{ stepIndex: 0, spent: [{ amount: '1000000' }] }] });
    // The same receipt reconciled as an owner-paid operation is a sponsorship FloFi never accepts.
    expect(await reconcileUserOperation(receipt(fine), group, hash, '0x' + 'cd'.repeat(32))).toMatchObject({ status: 'MISMATCH', code: 'GAS_SPONSORSHIP_REFUSED' });
    expect(await reconcileUserOperation(receipt([...fine.slice(0, 4), event('0x' + '9'.repeat(40))]), group, hash, '0x' + 'cd'.repeat(32), circle))
      .toMatchObject({ status: 'MISMATCH', code: 'GAS_SPONSORSHIP_REFUSED' });
    expect(await reconcileUserOperation(receipt([fine[0], before, fine[2], transfer(owner, R2, 1n), fine[3], fine[4]]), group, hash, '0x' + 'cd'.repeat(32), circle))
      .toMatchObject({ status: 'MISMATCH', code: 'RECONCILIATION_UNEXPECTED_OWNER_OUTFLOW' });
    expect(await reconcileUserOperation(receipt([transfer(owner, pm, 200_000n), before, fine[2], fine[4]]), group, hash, '0x' + 'cd'.repeat(32), circle))
      .toMatchObject({ status: 'MISMATCH', code: 'CIRCLE_FEE_ABOVE_CAP' });
    expect(await reconcileUserOperation(receipt([before, fine[2], transfer(pm, owner, 1n), fine[4]]), group, hash, '0x' + 'cd'.repeat(32), circle))
      .toMatchObject({ status: 'MISMATCH', code: 'CIRCLE_FEE_UNRECONCILED' });
  });
});

describe('ADR-0010 Circle runtime facts from the configuration and the verified price source', () => {
  const source = (prices: Partial<Record<'ETH' | 'USDC', string>>, observedAt = NOW.toISOString()): PriceSource => ({ id: 'fixture', maxAgeMs: 3_600_000,
    assets: Object.keys(prices) as PriceSource['assets'], observe: async asset => prices[asset as 'ETH' | 'USDC'] ? { ok: true, observation: { asset, priceUsd: prices[asset as 'ETH' | 'USDC']!,
      observedAt, receivedAt: observedAt, source: 'FIXTURE', evidence: 'MOCKED', provenance: {} } } : { ok: false, code: 'PRICE_UNAVAILABLE' } });
  it('is off unless enabled, and only on enabled chains that have a bundler', async () => {
    expect(circleDepsOf({}, ['eip155:8453'], () => source({ ETH: '3000' }))).toBeNull();
    expect(circleDepsOf({ FLOFI_CIRCLE_USDC_GAS: 'enabled', FLOFI_CIRCLE_USDC_GAS_CHAINS: 'eip155:1' }, ['eip155:8453'], () => source({ ETH: '3000' }))).toBeNull();
    const deps = circleDepsOf({ FLOFI_CIRCLE_USDC_GAS: 'enabled' }, ['eip155:8453', 'eip155:4663'], () => source({ ETH: '3012.5', USDC: '0.9998' }))!;
    expect(deps.chains).toEqual(['eip155:8453']);
    expect(await deps.price(NOW)).toEqual({ ethUsd: 301_250_000_000n, usdcUsd: 99_980_000n, observedAt: NOW.toISOString() });
  });
  it('fails closed without a fresh ETH price (no source, no feed, a stale observation)', async () => {
    const enabled = { FLOFI_CIRCLE_USDC_GAS: 'enabled' };
    expect(await circleDepsOf(enabled, ['eip155:8453'], () => null)!.price(NOW)).toBeNull();
    expect(await circleDepsOf(enabled, ['eip155:8453'], () => source({ USDC: '1' }))!.price(NOW)).toBeNull();
    expect(await circleDepsOf(enabled, ['eip155:8453'], () => source({ ETH: '3000' }, '2026-11-13T09:00:00.000Z'))!.price(NOW)).toBeNull();
    expect(await circleDepsOf(enabled, ['eip155:8453'], () => source({ ETH: '3000' }))!.price(NOW)).toMatchObject({ ethUsd: 300_000_000_000n, usdcUsd: null });
  });
});

describe('ADR-0010 Circle facts are read back strictly', () => {
  it('ignores any artifact that is not Circle-paid or is malformed', () => {
    expect(circleFactsOf(null)).toBeNull();
    expect(circleFactsOf({ kind: 'EVM_USER_OPERATION' })).toBeNull();
    expect(circleFactsOf({ circle: { stage: 'OTHER' } })).toBeNull();
    const facts = { stage: 'PERMIT', accountKind: 'METAMASK_DELEGATOR_V1_3', entryPoint: erc4337.ENTRY_POINT_V0_7, paymaster: C.CIRCLE_PAYMASTER_V07, usdc: BASE_MAINNET_SWAP.usdc,
      permitCap: '1', permitNonce: '0', surchargeBps: '1000', marginBps: '2000', nonce: '0', callData: '0x', nativeRequired: '1', usdcSpend: '0',
      plannedStrategy: 'EVM_WALLET_BATCH', gas: {}, price: {} } satisfies Record<keyof Omit<CircleFacts, 'permitSignature'>, unknown>;
    expect(circleFactsOf({ circle: facts })?.stage).toBe('PERMIT');
    expect(circleFactsOf({ circle: { ...facts, permitCap: '-1' } })).toBeNull();
    expect(circleFactsOf({ circle: { ...facts, accountKind: 'COINBASE' } })).toBeNull();
    expect(erc7710.evmAddress(C.CIRCLE_PAYMASTER_V08)).toBe(C.CIRCLE_PAYMASTER_V08);
  });
});
