// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): a FloFi Wallet group (a Privy embedded EOA, planned as
 * owner steps) whose owner holds no ETH but USDC runs as ONE Circle-paid operation of the owner's own address: on first use the account is
 * upgraded to the pinned `Simple7702Account` v0.8 INSIDE that operation (the owner's explicit consent, then an EIP-7702 authorization of exactly
 * this chain, the pinned delegate and the account's nonce), then the USDC permit and the operation — three signatures; two once delegated. An
 * owner with ETH keeps the owner-step path untouched; an account delegated elsewhere is never replaced.
 *
 * MOCKED loopback doubles only (an EVM chain, Circle's paymaster MODEL, EntryPoint v0.8 and a bundler that applies `eip7702Auth` as its type-4
 * transaction would): FloFi's logic, never Circle's, a bundler's, Privy's or any public execution.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP, ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded, type ChainTransport } from '../delegation/chains.ts';
import { evmWallet } from '../delegation/delegation.test-harness.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { authorizeGroup, checkUserOperation, prepareGroup, reconcileEvmGroup, relayUserOperation, type Prepared, type UserFundedDeps } from './groups.ts';
import { circleFactsOf, circleOperationOf, circlePermitOf, circleUpgradeAuthorization, circleUserOpHash, consentCircleUpgrade, finalizeCircleAuthorization,
  finalizeCirclePermit, forgetCircleVerifications } from './circle-gas.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const PROFILES = { 1: { profile: ETHEREUM_MAINNET_SWAP, network: 'ethereum' }, 8453: { profile: BASE_MAINNET_SWAP, network: 'base' },
  42161: { profile: ARBITRUM_MAINNET_SWAP, network: 'arbitrum-one' } } as const;
type ChainId = keyof typeof PROFILES;
const R1 = '0x' + '2'.repeat(40);
const SIMPLE_CODE = '0xef0100' + erc4337.SIMPLE_7702_ACCOUNT_V0_8.slice(2);

async function setup(input: { chainId: ChainId; eth?: bigint; account?: 'PLAIN' | 'SIMPLE_7702' | 'DELEGATOR' | 'OTHER'; nonce?: bigint; wallet?: 'INJECTED' | 'FLOFI_WALLET' }) {
  const { profile, network } = PROFILES[input.chainId], chain = `eip155:${input.chainId}`;
  const evm = createEvmDouble(input.chainId, () => Math.floor(NOW.getTime() / 1000), { profile });
  const circle = createCircleDouble(evm, { chainId: input.chainId });
  const owner = await evmWallet(), stranger = await evmWallet(), address = owner.address.toLowerCase();
  evm.control.fundNative(address, input.eth ?? 0n);
  evm.control.fundToken(address, profile.usdc, 50_000_000n);
  evm.control.setNonce(address, input.nonce ?? 5n);
  if (input.account === 'SIMPLE_7702') evm.control.setCode(address, SIMPLE_CODE);
  if (input.account === 'DELEGATOR') evm.control.upgrade(address);
  if (input.account === 'OTHER') evm.control.setCode(address, '0xef0100' + '12'.repeat(20));
  const transport: ChainTransport = guarded(chain, 'read', 'MOCKED', circle.rpc);
  const deps: UserFundedDeps = { chains: [chain], evm: c => c === chain ? transport : null, bundler: c => c === chain ? circle.bundler : null, solana: null, jupiter: null,
    now: () => NOW, circle: { chains: [chain], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: NOW.toISOString() }) } };
  const c = composeWorkflow({ version: 2, steps: [{ action: 'transfer', network, asset: 'USDC', amount: '1', recipient: R1 }] });
  if (!c.ok) throw new Error(c.code);
  const req = requirementOf(c);
  if (!req.ok) throw new Error(req.code);
  // A FloFi Wallet group is planned as owner steps; it may be prepared only as a Circle-paid operation (tokenGas: due, never handed to a wallet).
  const group = { runId: 'wfr_' + 'f'.repeat(26), groupIndex: 0, strategy: 'EVM_OWNER_STEP' as const, chain, feePayer: address, stepFrom: 0, stepTo: 0, tokenGas: true,
    wallet: input.wallet ?? 'FLOFI_WALLET' as const };
  const prepare = () => prepareGroup(deps, c, req.value, group);
  return { evm, circle, owner, stranger, address, deps, chainId: input.chainId, usdc: profile.usdc, prepare };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const factsOf = (p: Readonly<Record<string, unknown>>) => circleFactsOf(p) ?? (() => { throw new Error('CIRCLE_EXPECTED'); })();
const value = <T,>(r: { ok: true; value: T } | { ok: false; code: string }): T => { if (!r.ok) throw new Error(r.code); return r.value; };
/** What Privy's `useSign7702Authorization` signs: the EIP-7702 digest of exactly the tuple FloFi asked for. */
const signAuthorization = (ctx: Ctx, p: Prepared) => ctx.owner.signDigest(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(factsOf(p))));
const signPermit = (ctx: Ctx, p: Prepared) => ctx.owner.signDigest(C.permitDigest(circlePermitOf(factsOf(p), ctx.chainId, ctx.address)));
const signOperation = (ctx: Ctx, p: Prepared) => { const c = factsOf(p); return ctx.owner.signDigest(circleUserOpHash(c, ctx.chainId, circleOperationOf(c, ctx.address))); };

beforeEach(() => forgetCircleVerifications());

describe('FloFi Wallet + Circle: native first, the owner-step path untouched', () => {
  it('a FloFi Wallet that holds enough ETH is never prepared as anything: CIRCLE_NOT_NEEDED (its owner steps run exactly as before)', async () => {
    const ctx = await setup({ chainId: 8453, eth: 10n ** 17n });
    expect(await ctx.prepare()).toMatchObject({ ok: false, code: 'CIRCLE_NOT_NEEDED' });
    expect(ctx.circle.control.estimates()).toBe(0);
    expect(ctx.owner.signatures).toBe(0);
  });
  it('an owner-step group is prepared only for FloFi Wallet with token gas allowed (never another wallet, never a group already handed out)', async () => {
    const injected = await setup({ chainId: 8453, wallet: 'INJECTED' });
    expect(await injected.prepare()).toMatchObject({ ok: false, code: 'WORKFLOW_RUN_GROUP_OWNER_STEP' });
  });
});

describe('FloFi Wallet + Circle: first use upgrades the address inside its first operation (three signatures)', () => {
  for (const chainId of [8453, 1, 42161] as const) {
    it(`eip155:${chainId}: 0 ETH + USDC → consent, authorization, permit, operation; delegation and the USDC fee reconciled`, async () => {
      const ctx = await setup({ chainId, nonce: 5n });
      const p = value(await ctx.prepare()).prepared;
      expect(p.kind).toBe('EVM_USER_OPERATION');
      const c = factsOf(p);
      // The upgrade: this chain (never 0), the pinned Simple7702Account v0.8, the account's own nonce; EntryPoint v0.8 and Circle's v0.8 paymaster.
      expect(c).toMatchObject({ stage: 'AUTHORIZATION', accountKind: 'SIMPLE_7702_V0_8', entryPoint: erc4337.ENTRY_POINT_V0_8, paymaster: C.CIRCLE_PAYMASTER_V08,
        plannedStrategy: 'EVM_OWNER_STEP', upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId, nonce: '5' } });
      expect(c.upgrade).not.toHaveProperty('consentedAt');
      expect(p.gasPayment).toMatchObject({ mechanism: 'CIRCLE_USDC_PAYMASTER', signatures: 3, upgrade: { delegate: erc4337.SIMPLE_7702_ACCOUNT_V0_8, chainId } });
      // Nothing is accepted before the owner's consent: an authorization is refused without it, and no permit is taken before the authorization
      // (the signing gate refuses to ask the wallet for either: tested there).
      const early = await ctx.stranger.signDigest(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(c)));
      expect(await finalizeCircleAuthorization(ctx.deps, p, early)).toEqual({ ok: false, code: 'CIRCLE_UPGRADE_CONSENT_REQUIRED' });
      expect(await finalizeCirclePermit(ctx.deps, p, early)).toEqual({ ok: false, code: 'CIRCLE_PERMIT_STAGE_INVALID' });
      const consented = value(consentCircleUpgrade(p, NOW)) as Prepared;
      expect(factsOf(consented).upgrade?.consentedAt).toBe(NOW.toISOString());
      // 1. the authorization; 2. the permit; 3. the operation.
      const authorized = value(await finalizeCircleAuthorization(ctx.deps, consented, await signAuthorization(ctx, consented))) as Prepared;
      expect(factsOf(authorized).stage).toBe('PERMIT');
      const f = value(await finalizeCirclePermit(ctx.deps, authorized, await signPermit(ctx, authorized))) as Prepared;
      const fc = factsOf(f);
      expect(fc.stage).toBe('OPERATION');
      // The operation the owner signs is the v0.8 typed digest with the delegate in place of the EIP-7702 marker.
      expect((f.typedData as { message: { initCode: string } }).message.initCode).toBe(erc4337.SIMPLE_7702_ACCOUNT_V0_8);
      expect(f.userOpHash).toBe(circleUserOpHash(fc, chainId, circleOperationOf(fc, ctx.address)));
      const authorization = value(authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ctx, f) }, ctx.address, NOW));
      expect(ctx.owner.signatures).toBe(3);
      const submitted = value(await checkUserOperation(ctx.deps, f, authorization, ctx.address));
      expect(ctx.evm.control.codeOf(ctx.address)).toBe('0x');
      expect(await relayUserOperation(ctx.deps, f, authorization)).toEqual({ ok: true, value: f.userOpHash });
      // The bundler applied the owner's authorization in its own transaction: the address is now the pinned smart account, nothing else moved.
      expect(ctx.circle.control.authorizationsApplied()).toBe(1);
      expect(ctx.evm.control.codeOf(ctx.address)).toBe(SIMPLE_CODE);
      const r = await reconcileEvmGroup(ctx.deps, f, submitted, authorization);
      expect(r).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: C.CIRCLE_PAYMASTER_V08, paidInToken: { mechanism: 'CIRCLE_USDC_PAYMASTER', token: ctx.usdc } },
        steps: [{ stepIndex: 0, spent: [{ amount: '1000000' }] }] });
      expect(ctx.evm.control.tokenBalance(ctx.usdc, R1)).toBe(1_000_000n);
    });
  }
  it('once delegated to Simple7702Account v0.8, the next group needs two signatures (no authorization, no consent)', async () => {
    const ctx = await setup({ chainId: 8453, account: 'SIMPLE_7702' });
    const p = value(await ctx.prepare()).prepared, c = factsOf(p);
    expect(c.stage).toBe('PERMIT');
    expect(c).not.toHaveProperty('upgrade');
    expect(p.gasPayment).toMatchObject({ signatures: 2 });
    expect(p.gasPayment).not.toHaveProperty('upgrade');
    expect(consentCircleUpgrade(p, NOW)).toEqual({ ok: false, code: 'CIRCLE_UPGRADE_NOT_PREPARED' });
    const f = value(await finalizeCirclePermit(ctx.deps, p, await signPermit(ctx, p))) as Prepared;
    expect((f.typedData as { message: { initCode: string } }).message.initCode).toBe('0x');
    const authorization = value(authorizeGroup(f, { kind: 'EVM_USER_OPERATION', signature: await signOperation(ctx, f) }, ctx.address, NOW));
    expect(ctx.owner.signatures).toBe(2);
    const submitted = value(await checkUserOperation(ctx.deps, f, authorization, ctx.address));
    expect(await relayUserOperation(ctx.deps, f, authorization)).toMatchObject({ ok: true });
    expect(ctx.circle.control.authorizationsApplied()).toBe(0);
    expect(await reconcileEvmGroup(ctx.deps, f, submitted, authorization)).toMatchObject({ status: 'RECONCILED' });
  });
});

describe('FloFi Wallet + Circle: never replaces a delegation, never signs a stale or foreign tuple', () => {
  it('an account delegated elsewhere (MetaMask DeleGator, any other delegate) is CIRCLE_ACCOUNT_UNSUPPORTED: nothing prepared, nothing signed', async () => {
    for (const account of ['DELEGATOR', 'OTHER'] as const) {
      const ctx = await setup({ chainId: 8453, account });
      const r = await ctx.prepare();
      expect(r).toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', evidence: { unavailable: [{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_ACCOUNT_UNSUPPORTED' }] } });
      expect(ctx.owner.signatures).toBe(0);
    }
  });
  it('a pending transaction of the account: the upgrade nonce is not knowable, so no upgrade is offered (CIRCLE_ACCOUNT_NONCE_PENDING)', async () => {
    const ctx = await setup({ chainId: 8453, nonce: 5n });
    ctx.evm.control.setPendingNonce(ctx.address, 6n);
    expect(await ctx.prepare()).toMatchObject({ ok: false, evidence: { unavailable: [{ code: 'CIRCLE_ACCOUNT_NONCE_PENDING' }] } });
  });
  it('the account moved after the Review (a transaction, another delegation): the authorization is refused before and after signing', async () => {
    const ctx = await setup({ chainId: 8453, nonce: 5n });
    const p = value(consentCircleUpgrade(value(await ctx.prepare()).prepared, NOW)) as Prepared;
    const signature = await signAuthorization(ctx, p);
    ctx.evm.control.setNonce(ctx.address, 6n);
    expect(await finalizeCircleAuthorization(ctx.deps, p, signature)).toEqual({ ok: false, code: 'CIRCLE_AUTHORIZATION_STALE' });
    // Another delegation landed meanwhile (it moved the nonce, as every EIP-7702 authorization does): never replaced.
    ctx.evm.control.setCode(ctx.address, '0xef0100' + '12'.repeat(20));
    expect(await finalizeCircleAuthorization(ctx.deps, p, signature)).toEqual({ ok: false, code: 'CIRCLE_AUTHORIZATION_STALE' });
  });
  it('a tuple of another delegate, chain 0, another chain or another nonce, or another signer, is never accepted', async () => {
    const ctx = await setup({ chainId: 8453, nonce: 5n });
    const p = value(consentCircleUpgrade(value(await ctx.prepare()).prepared, NOW)) as Prepared;
    const tuple = circleUpgradeAuthorization(factsOf(p));
    for (const forged of [{ ...tuple, address: '0x' + '12'.repeat(20) }, { ...tuple, nonce: 6n }, { ...tuple, chainId: 1 }]) {
      const signature = await ctx.owner.signDigest(erc4337.eip7702AuthorizationHash(forged));
      expect(await finalizeCircleAuthorization(ctx.deps, p, signature)).toEqual({ ok: false, code: 'CIRCLE_AUTHORIZATION_INVALID' });
    }
    // chainId 0 cannot even be hashed by FloFi; signed elsewhere, it never recovers to the owner for this tuple.
    expect(() => erc4337.eip7702AuthorizationHash({ ...tuple, chainId: 0 })).toThrow('EIP7702_AUTHORIZATION_CHAIN_INVALID');
    const stranger = await evmWallet();
    expect(await finalizeCircleAuthorization(ctx.deps, p, await stranger.signDigest(erc4337.eip7702AuthorizationHash(tuple))))
      .toEqual({ ok: false, code: 'CIRCLE_AUTHORIZATION_INVALID' });
  });
  it('the bundler client sends eip7702Auth only with the upgrade operation, and never an operation of an upgrade without it', async () => {
    const ctx = await setup({ chainId: 8453, nonce: 5n });
    const p = value(consentCircleUpgrade(value(await ctx.prepare()).prepared, NOW)) as Prepared;
    const a = value(await finalizeCircleAuthorization(ctx.deps, p, await signAuthorization(ctx, p))) as Prepared;
    const f = value(await finalizeCirclePermit(ctx.deps, a, await signPermit(ctx, a))) as Prepared, fc = factsOf(f);
    const op = { ...circleOperationOf(fc, ctx.address), signature: await signOperation(ctx, f) };
    const auth = erc4337.signedEip7702Authorization(circleUpgradeAuthorization(fc), fc.upgrade!.signature!, ctx.address);
    await expect(ctx.circle.bundler.sendCircle!(op, erc4337.ENTRY_POINT_V0_8)).rejects.toThrow('ERC4337_INIT_CODE_REFUSED');
    await expect(ctx.circle.bundler.sendCircle!({ ...op, initCode: '0x' }, erc4337.ENTRY_POINT_V0_8, auth)).rejects.toThrow('ERC4337_EIP7702_AUTH_REFUSED');
    await expect(ctx.circle.bundler.sendCircle!(op, erc4337.ENTRY_POINT_V0_7, auth)).rejects.toThrow();
    expect(ctx.circle.control.sends()).toBe(0);
    expect(ctx.evm.control.codeOf(ctx.address)).toBe('0x');
  });
});
