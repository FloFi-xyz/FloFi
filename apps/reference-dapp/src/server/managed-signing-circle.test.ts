// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): the server gate in front of every FloFi Wallet signature of
 * a Circle-paid workflow group — the EIP-7702 upgrade authorization (only after the owner's consent, only the recorded tuple: this chain, the pinned
 * Simple7702Account v0.8, the account's current nonce), the USDC permit and the v0.8 operation, each re-derived from the prepared group and never
 * from the page. MOCKED loopback doubles; nothing is signed by Privy here (the gate decides whether Privy may be asked).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded, type ChainTransport } from '../delegation/chains.ts';
import { evmWallet } from '../delegation/delegation.test-harness.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { prepareGroup, type Prepared, type UserFundedDeps } from '../user-funded/groups.ts';
import { circleFactsOf, circleOperationOf, circleOperationTypedData, circlePermitOf, circleUpgradeAuthorization, consentCircleUpgrade, finalizeCircleAuthorization,
  finalizeCirclePermit, forgetCircleVerifications } from '../user-funded/circle-gas.ts';
import { parseSigningRequest, resolveManagedSigning, type CircleSigningRun, type ManagedSigningDeps } from './managed-signing.ts';
import { circleSigningContext, parseSigningContext } from '../wallet/flofi-signing.ts';
import { parseWalletRequest } from '../wallet-app/protocol.ts';

const NOW = new Date('2026-11-13T12:00:00Z'), RUN = 'wfr_' + 'a'.repeat(26), CHAIN = 'eip155:8453';
const value = <T,>(r: { ok: true; value: T } | { ok: false; code: string }): T => { if (!r.ok) throw new Error(r.code); return r.value; };

async function setup() {
  const evm = createEvmDouble(8453, () => Math.floor(NOW.getTime() / 1000), { profile: BASE_MAINNET_SWAP });
  const circle = createCircleDouble(evm, { chainId: 8453 });
  const owner = await evmWallet(), address = owner.address.toLowerCase();
  evm.control.fundToken(address, BASE_MAINNET_SWAP.usdc, 50_000_000n);
  evm.control.setNonce(address, 9n);
  const transport: ChainTransport = guarded(CHAIN, 'read', 'MOCKED', circle.rpc);
  const deps: UserFundedDeps = { chains: [CHAIN], evm: c => c === CHAIN ? transport : null, bundler: c => c === CHAIN ? circle.bundler : null, solana: null, jupiter: null,
    now: () => NOW, circle: { chains: [CHAIN], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: NOW.toISOString() }) } };
  const c = composeWorkflow({ version: 2, steps: [{ action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) }] });
  if (!c.ok) throw new Error(c.code);
  const req = requirementOf(c);
  if (!req.ok) throw new Error(req.code);
  const prepared = value(await prepareGroup(deps, c, req.value, { runId: RUN, groupIndex: 0, strategy: 'EVM_OWNER_STEP', chain: CHAIN, feePayer: address, stepFrom: 0, stepTo: 0,
    tokenGas: true, wallet: 'FLOFI_WALLET' })).prepared;
  let stored: Prepared = prepared;
  const loaded = (): CircleSigningRun => ({ run: { runId: RUN, mode: 'USER_FUNDED', state: 'RUNNING', currentStep: 0 },
    groups: [{ groupIndex: 0, chain: CHAIN, feePayer: address, strategy: 'EVM_USER_OPERATION', state: 'PREPARED', stepFrom: 0, stepTo: 0,
      validUntil: new Date(NOW.getTime() + 300_000), prepared: stored }] });
  const gateDeps: ManagedSigningDeps = { load: async () => loaded(), managed: (_e, a) => a.toLowerCase() === address,
    pendingNonce: async (_chain, a) => BigInt(String(await circle.rpc('eth_getTransactionCount', [a, 'pending']))), now: () => NOW.getTime() };
  const context = circleSigningContext(RUN, 8453)!;
  const set = (p: Prepared) => { stored = p; };
  return { evm, circle, owner, address, deps, gateDeps, context, set, get stored() { return stored; } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const facts = (p: Prepared) => circleFactsOf(p)!;
/** The request exactly as the product page builds it (`flofi_signAuthorization` → protocol → gate body). */
const authorizationRequest = (ctx: Ctx, authorization: { chainId: number; contractAddress: string; nonce: string }) =>
  ({ op: 'evm_sign_authorization', address: ctx.address, authorization, signing: ctx.context });
const resolve = async (ctx: Ctx, body: unknown) => {
  const parsed = parseSigningRequest(body);
  if (!parsed) return { ok: false, code: 'PARSE_REFUSED' } as const;
  return resolveManagedSigning(parsed.context, parsed.request, ctx.gateDeps);
};
const tuple = (ctx: Ctx) => { const t = circleUpgradeAuthorization(facts(ctx.stored)); return { chainId: t.chainId, contractAddress: t.address, nonce: t.nonce.toString() }; };

beforeEach(() => forgetCircleVerifications());

describe('FloFi Wallet + Circle: the signing contract', () => {
  it('names the run\'s network flow, parses the workflow run id, and the wallet protocol carries only a strictly shaped tuple', () => {
    expect(circleSigningContext(RUN, 8453)).toEqual({ flow: 'base-circle-gas', runId: RUN });
    expect(circleSigningContext(RUN, 1)).toEqual({ flow: 'ethereum-circle-gas', runId: RUN });
    expect(circleSigningContext(RUN, 4663)).toBeNull();
    expect(parseSigningContext({ flow: 'base-circle-gas', runId: RUN })).toEqual({ flow: 'base-circle-gas', runId: RUN });
    const request = { protocol: 'flofi-wallet/1', type: 'request', id: 'abcdefgh12', request: { op: 'evm_sign_authorization', address: '0x' + '1'.repeat(40),
      authorization: { chainId: 8453, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '9' }, signing: { flow: 'base-circle-gas', runId: RUN } } };
    expect(parseWalletRequest(request)?.request).toMatchObject({ op: 'evm_sign_authorization', authorization: { chainId: 8453, nonce: '9' } });
    // Chain 0 (valid on every chain), a chain FloFi Wallet does not sign on, a nonce beyond uint64, extra keys: not a request at all.
    for (const authorization of [{ chainId: 0, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '9' }, { chainId: 10, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '9' },
      { chainId: 8453, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: (1n << 64n).toString() }, { chainId: 8453, contractAddress: erc4337.SIMPLE_7702_ACCOUNT_V0_8, nonce: '9', executor: 'self' }])
      expect(parseWalletRequest({ ...request, request: { ...request.request, authorization } })).toBeNull();
  });
});

describe('FloFi Wallet + Circle: the gate re-derives every signature from the prepared group', () => {
  it('the upgrade authorization: refused before consent; after it, only the recorded tuple at the account\'s current nonce', async () => {
    const ctx = await setup();
    expect(facts(ctx.stored)).toMatchObject({ stage: 'AUTHORIZATION', upgrade: { nonce: '9', chainId: 8453 } });
    expect(await resolve(ctx, authorizationRequest(ctx, tuple(ctx)))).toEqual({ ok: false, code: 'FLOFI_WALLET_UPGRADE_CONSENT_REQUIRED' });
    ctx.set(value(consentCircleUpgrade(ctx.stored, NOW)) as Prepared);
    const ok = value(await resolve(ctx, authorizationRequest(ctx, tuple(ctx))));
    expect(ok.attempt).toBe(`base-circle-gas:${RUN}:g0:authorization:9`);
    expect(ok.authorization?.digest).toBe(erc4337.eip7702AuthorizationHash(circleUpgradeAuthorization(facts(ctx.stored))));
    expect(ok.summary.lines.map(l => l.label)).toEqual(['Upgrade', 'Why', 'What stays the same', 'Smart account', 'Network fee']);
    expect(ok.summary.lines[0]!.value).toBe('This FloFi Wallet address on Base to a smart account (EIP-7702)');
    // Tampered tuples: another delegate, chain 0, another chain, another nonce.
    const t = tuple(ctx);
    expect(await resolve(ctx, authorizationRequest(ctx, { ...t, contractAddress: '0x' + '12'.repeat(20) }))).toEqual({ ok: false, code: 'FLOFI_WALLET_AUTHORIZATION_UNSUPPORTED' });
    expect(await resolve(ctx, authorizationRequest(ctx, { ...t, chainId: 0 }))).toEqual({ ok: false, code: 'PARSE_REFUSED' });
    expect(await resolve(ctx, authorizationRequest(ctx, { ...t, chainId: 1 }))).toEqual({ ok: false, code: 'FLOFI_WALLET_AUTHORIZATION_UNSUPPORTED' });
    expect(await resolve(ctx, authorizationRequest(ctx, { ...t, nonce: '10' }))).toEqual({ ok: false, code: 'FLOFI_WALLET_AUTHORIZATION_UNSUPPORTED' });
    // The account moved since the Review (a pending transaction): the recorded nonce is no longer its next one.
    ctx.evm.control.setPendingNonce(ctx.address, 10n);
    expect(await resolve(ctx, authorizationRequest(ctx, t))).toEqual({ ok: false, code: 'FLOFI_WALLET_NONCE_MISMATCH' });
    ctx.evm.control.setPendingNonce(ctx.address, null);
    // Another network's flow, another run, a foreign or unmanaged address: no match.
    expect(await resolve(ctx, { ...authorizationRequest(ctx, t), signing: { flow: 'ethereum-circle-gas', runId: RUN } })).toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    expect(await resolve(ctx, { ...authorizationRequest(ctx, t), signing: { flow: 'base-circle-gas', runId: 'wfr_' + 'b'.repeat(26) } }))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    expect(await resolve(ctx, { ...authorizationRequest(ctx, t), address: '0x' + '3'.repeat(40) })).toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
  });
  it('the USDC permit and the operation: exactly the facts\' typed data, each at its own stage; tampered typed data is refused', async () => {
    const ctx = await setup();
    ctx.set(value(consentCircleUpgrade(ctx.stored, NOW)) as Prepared);
    // No permit before the authorization.
    const permitTyped = (p: Prepared) => C.permitTypedData(circlePermitOf(facts(p), 8453, ctx.address));
    expect(await resolve(ctx, { op: 'evm_sign_typed_data', address: ctx.address, typedData: permitTyped(ctx.stored), signing: ctx.context }))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    const t = circleUpgradeAuthorization(facts(ctx.stored));
    ctx.set(value(await finalizeCircleAuthorization(ctx.deps, ctx.stored, await ctx.owner.signDigest(erc4337.eip7702AuthorizationHash(t)))) as Prepared);
    const permit = value(await resolve(ctx, { op: 'evm_sign_typed_data', address: ctx.address, typedData: permitTyped(ctx.stored), signing: ctx.context }));
    expect(permit).toMatchObject({ attempt: `base-circle-gas:${RUN}:g0:permit:0`, typedData: { kind: 'permit' } });
    // A permit with a larger value or another spender is never what the group's facts say.
    const forged = permitTyped(ctx.stored);
    for (const message of [{ ...forged.message, value: (BigInt(forged.message.value) + 1n).toString() }, { ...forged.message, spender: '0x' + '9'.repeat(40) }])
      expect(await resolve(ctx, { op: 'evm_sign_typed_data', address: ctx.address, typedData: { ...forged, message }, signing: ctx.context }))
        .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    // The authorization is no longer signable once it was taken.
    expect(await resolve(ctx, authorizationRequest(ctx, tuple(ctx)))).toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    ctx.set(value(await finalizeCirclePermit(ctx.deps, ctx.stored, await ctx.owner.signDigest(C.permitDigest(circlePermitOf(facts(ctx.stored), 8453, ctx.address))))) as Prepared);
    const c = facts(ctx.stored), typed = circleOperationTypedData(c, 8453, circleOperationOf(c, ctx.address));
    const operation = value(await resolve(ctx, { op: 'evm_sign_typed_data', address: ctx.address, typedData: typed, signing: ctx.context }));
    expect(operation).toMatchObject({ typedData: { kind: 'operation' } });
    expect(operation.attempt).toBe(`base-circle-gas:${RUN}:g0:operation:${String(ctx.stored.userOpHash)}`);
    // The operation typed WITHOUT the upgrade's delegate (the bare marker, or no initCode) is another operation.
    expect(await resolve(ctx, { op: 'evm_sign_typed_data', address: ctx.address, typedData: { ...typed, message: { ...typed.message, initCode: '0x' } }, signing: ctx.context }))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
  });
  it('an expired preparation, a run that is not running, or a group not due is never signed', async () => {
    const ctx = await setup();
    ctx.set(value(consentCircleUpgrade(ctx.stored, NOW)) as Prepared);
    const base = ctx.gateDeps.load;
    const with_ = (patch: (r: CircleSigningRun) => CircleSigningRun) => ({ ...ctx.gateDeps, load: async (f: Parameters<typeof base>[0], id: string) => patch(await base(f, id) as CircleSigningRun) });
    const req = parseSigningRequest(authorizationRequest(ctx, tuple(ctx)))!;
    expect(await resolveManagedSigning(req.context, req.request, with_(r => ({ ...r, groups: r.groups.map(g => ({ ...g, validUntil: new Date(NOW.getTime() - 1) })) }))))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_REVIEW_EXPIRED' });
    expect(await resolveManagedSigning(req.context, req.request, with_(r => ({ ...r, run: { ...r.run, state: 'HALTED' } }))))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    expect(await resolveManagedSigning(req.context, req.request, with_(r => ({ ...r, run: { ...r.run, currentStep: 1 } }))))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
  });
});
