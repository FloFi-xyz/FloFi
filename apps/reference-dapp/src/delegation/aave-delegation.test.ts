// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: Swap 3 USDC → WETH, Supply the reconciled WETH and Borrow USDC on Arbitrum One under ONE delegated
 * authorization: capability (closed by default, opt-in per mainnet), grant scope and coverage, the manifest's health-factor floor, the drivers'
 * exact calls, the grant's own on-chain scope (v1.3.0 enforcer model), the fresh-simulation policy, the session signature and reconciliation.
 *
 * MOCKED evidence only. The Aave state readers (`readSupplyState`/`readBorrowState`/`estimateBorrow`/`assertSupplyCap`, already tested in
 * the reference compiler against their own fixtures) are stubbed at the module boundary; every other piece is the production code. Keys are
 * disposable in-memory test keys; nothing reaches a network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { memorySignerProvider } from '@defi-workflow-engine/reference-executor';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { evmTemplates, serializeDelegation } from './adapters.ts';
import { resolveAuthorityGraph, scopeHash, type GrantScope, type GrantView, type StepBinding } from './authority.ts';
import { stepCapability } from './capabilities.ts';
import { readDelegationConfig } from './config.ts';
import { driverFor, evmAaveDriver, evmSwapDriver, type StepContext } from './drivers.ts';
import { buildManifest, executionSpend } from './manifest.ts';
import type { GrantRecord } from './pg-store.ts';
import { stepPolicyViolation } from './policy.ts';
import { delegationAavePool, delegationAaveReserve } from './profiles.ts';
import { narrowedStep, workflowRequirement, type StepRequirement } from './steps.ts';

const reads = vi.hoisted(() => ({ supply: null as unknown, borrow: null as unknown, estimate: null as unknown, capFull: false }));
vi.mock('@defi-workflow-engine/reference-compiler', async importOriginal => {
  const actual = await importOriginal<typeof import('@defi-workflow-engine/reference-compiler')>();
  // `readBorrowState` returns the Supply state of the reserve plus its Borrow facts (as the real reader does); Supply of an owner-beneficiary
  // (mainnet) reserve reads through it too.
  return { ...actual, readSupplyState: vi.fn(async () => reads.supply),
    readBorrowState: vi.fn(async (_rpc: unknown, profile: { asset: string }) => profile.asset === '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'
      ? reads.supply : { ...reads.supply as object, ...reads.borrow as object }),
    estimateBorrow: vi.fn(() => { if (reads.estimate instanceof Error) throw reads.estimate; return reads.estimate; }),
    assertSupplyCap: vi.fn(() => { if (reads.capFull) throw new Error('SUPPLY_CAP_EXCEEDED'); }) };
});

const D = erc7710, CHAIN = 'eip155:42161', MAINNET = [CHAIN];
const USDC = ARBITRUM_MAINNET_SWAP.usdc, WETH = ARBITRUM_MAINNET_SWAP.weth, ROUTER = ARBITRUM_MAINNET_SWAP.router;
const POOL = delegationAavePool(CHAIN, MAINNET)!, A_WETH = delegationAaveReserve(CHAIN, POOL, WETH)!.aToken.toLowerCase(), A_USDC = delegationAaveReserve(CHAIN, POOL, USDC)!.aToken.toLowerCase();
const NOW = new Date('2026-11-05T12:00:00.000Z'), now = () => NOW;
const keys = memorySignerProvider();
const word = (v: bigint) => v.toString(16).padStart(64, '0'), pad = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const TRANSFER = D.keccakHex('Transfer(address,address,uint256)');
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => typeof x === 'bigint' ? x.toString() : x)) as Record<string, unknown>;

async function setup(scopeOverride: Partial<Extract<GrantScope, { mechanism: 'EVM_ERC7710_METAMASK_V1_3' }>> = {}) {
  const owner = await keys.create('eip155'), session = await keys.create('eip155');
  const strategy = { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
    { action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.002', beneficiary: owner.address },
    { action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: owner.address }], bindings: [{ step: 1, amountFrom: 0 }] };
  const requirement = workflowRequirement(strategy);
  if (!requirement.ok) throw new Error(requirement.code);
  const scope: Extract<GrantScope, { mechanism: 'EVM_ERC7710_METAMASK_V1_3' }> = { mechanism: 'EVM_ERC7710_METAMASK_V1_3', chain: CHAIN, router: ROUTER,
    pairs: [{ tokenIn: USDC, tokenOut: WETH, perCallInputCap: '3000000' }], maxCalls: 5, validFrom: '2026-11-05T00:00:00.000Z', expiresAt: '2026-12-05T00:00:00.000Z',
    aave: { pool: POOL, supply: [{ asset: WETH, perCallCap: '2000000000000000' }], borrow: [{ asset: USDC, perCallCap: '1000000' }] }, ...scopeOverride };
  const unsigned = D.compileGrant({ chainId: 42161, owner: owner.address, session: session.address, validAfter: BigInt(Date.parse(scope.validFrom) / 1000) - 1n,
    validBefore: BigInt(Date.parse(scope.expiresAt) / 1000), maxCalls: BigInt(scope.maxCalls), templates: evmTemplates(scope), salt: 42n });
  const sig = await keys.signEvmDigest(owner.ref, D.bytesOf(D.delegationDigest(42161, unsigned)));
  const signed = { ...unsigned, signature: '0x' + word(sig.r) + word(sig.s) + (sig.yParity + 27).toString(16) };
  const commitment = D.delegationHash(unsigned);
  const view: GrantView = { grantId: 'grt_aaaaaaaaaaaaaaaaaaaaaaaaaa', credentialId: 'crd_aaaaaaaaaaaaaaaaaaaaaaaaaa', walletNamespace: 'eip155', walletAddress: owner.address,
    chain: CHAIN, mechanism: 'EVM_ERC7710_METAMASK_V1_3', state: 'ACTIVE', scope, scopeHash: scopeHash(scope), sessionAddress: session.address, commitment,
    passkeyId: 'psk_aaaaaaaaaaaaaaaaaaaaaaaaaa', verifiedAt: NOW.toISOString(), callsUsed: 0 };
  const grant = { ...view, owner: { namespace: 'eip155', address: owner.address }, sessionKeyRef: session.ref, enrollment: {}, grantPayload: { delegation: serializeDelegation(signed) },
    verification: null, expiresAt: new Date(scope.expiresAt), revocation: null, revocationRequestedAt: null, revokedAt: null, evmNextNonce: null, version: 1,
    createdAt: NOW, updatedAt: NOW } as unknown as GrantRecord;
  return { owner, session, requirement: requirement.value, scope, grant, view, delegation: signed };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A read-only Arbitrum transport double: the upgraded owner account, fees, the quoter, balances, receipts; broadcasts are recorded. */
function transport(s: Setup, receipts: Map<string, unknown> = new Map(), sent: string[] = []) {
  return { chain: CHAIN, provenance: 'MOCKED' as const, async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    if (method === 'eth_chainId') return '0xa4b1';
    if (method === 'eth_getCode') return (params[0] as string).toLowerCase() === s.owner.address ? D.DELEGATOR_DESIGNATOR : '0x';
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (method === 'eth_gasPrice') return '0x989680';
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0] as string) ?? null;
    if (method === 'eth_getTransactionByHash') return null;
    if (method === 'eth_sendRawTransaction') { sent.push(params[0] as string); return '0x'; }
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: string; data: string };
      if (to === ARBITRUM_MAINNET_SWAP.quoter) return '0x' + word(1_000_000_000_000_000n) + word(0n) + word(0n) + word(0n);
      if (data.startsWith(D.selectorOf('balanceOf(address)'))) return '0x' + word(to === USDC ? 10_000_000n : 3_000_000_000_000_000n);
      if (data.startsWith(D.selectorOf('getUserAccountData(address)'))) return '0x' + [1n, 2n, 3n, 4n, 5n, 2_400_000_000_000_000_000n].map(word).join('');
    }
    throw new Error('UNEXPECTED_RPC ' + method);
  } };
}
function context(s: Setup, k: number, extra: Partial<StepContext> = {}, used?: bigint): StepContext {
  const graph = resolveAuthorityGraph(s.requirement, [s.view], 'PRODUCTION', NOW.getTime(), undefined, MAINNET);
  if (!graph.ok) throw new Error(graph.failures[0]!.code);
  const pinned = graph.bindings.find(b => b.stepIndex === k)!;
  const step: StepRequirement = used === undefined ? s.requirement.steps[k]! : narrowedStep(s.requirement, k, used);
  const binding: StepBinding = used === undefined ? pinned : { ...pinned, need: { ...pinned.need, amount: used } as StepBinding['need'] };
  return { step, binding, grant: s.grant, transport: transport(s), now, mainnet: MAINNET, ...extra };
}
function manifest(s: Setup) {
  const graph = resolveAuthorityGraph(s.requirement, [s.view], 'PRODUCTION', NOW.getTime(), undefined, MAINNET);
  if (!graph.ok) throw new Error(graph.failures[0]!.code);
  const spend = executionSpend(s.requirement);
  return buildManifest({ owner: `eip155:${s.owner.address}`, authorizationId: 'dau_aaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 1, now: NOW, validFrom: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000), timezone: 'UTC', engineVersion: 'test', requirement: s.requirement, bindings: graph.bindings,
    limits: { assets: [...spend.entries()].map(([asset, amount]) => ({ asset, maxPerExecution: amount.toString(), budgets: [{ period: 'DAY' as const, amount: amount.toString() }] })),
      maxExecutionsPerPeriod: { count: 1, period: 'MONTH' }, cooldownSeconds: 0, maxSlippageBps: 50 } });
}
const redeemed = (s: Setup) => ({ address: D.DELEGATION_FRAMEWORK_V1_3.delegationManager, topics: [D.REDEEMED_DELEGATION_TOPIC, pad(s.owner.address), pad(s.session.address)], data: '0x' });
const transfer = (token: string, from: string, to: string, amount: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: '0x' + word(amount) });

beforeEach(() => {
  reads.supply = { reserveConfiguration: String(1n << 56n), balance: '3000000000000000', position: '0', block: 100 };
  reads.borrow = { borrow: { debt: '0', healthFactor: (2n ** 256n - 1n).toString() }, balance: '10000000', block: 101 };
  reads.estimate = { borrowValueBase: '100000000', debtAfterBase: '100000000', healthFactorAfter: '2400000000000000000' };
  reads.capFull = false;
});

describe('capability and deployment opt-in (closed by default)', () => {
  it('refuses every Arbitrum One step without the opt-in, and resolves all three with it', async () => {
    const s = await setup();
    expect(s.requirement.steps.map(step => stepCapability(step, 'PRODUCTION'))).toEqual(s.requirement.steps.map(() => expect.objectContaining({ ok: false, code: 'MAINNET_DELEGATION_DISABLED' })));
    expect(s.requirement.steps.map(step => stepCapability(step, 'PRODUCTION', MAINNET)).map(c => c.ok && c.need.kind))
      .toEqual(['EVM_UNISWAP_V3_EXACT_INPUT_SINGLE', 'EVM_AAVE_V3_SUPPLY', 'EVM_AAVE_V3_BORROW']);
    // Only Arbitrum One is implemented; Base and Ethereum stay disabled even when listed by mistake (the config refuses them, see below).
    expect(stepCapability({ ...s.requirement.steps[2]!, chain: 'eip155:8453' }, 'PRODUCTION', ['eip155:8453'])).toMatchObject({ ok: false });
  });
  it('reads FLOFI_DELEGATION_MAINNET_CHAINS fail-closed and never enables a harness in the public product', () => {
    const base = { FLOFI_DELEGATION: 'enabled', FLOFI_PUBLIC_ORIGIN: 'https://flofi.example', FLOFI_NETWORK_SCOPE: 'PUBLIC_MAINNET' };
    expect(readDelegationConfig(base)).toMatchObject({ enabled: false, reason: 'MAINNET_ONLY_PRODUCT' });
    expect(readDelegationConfig({ ...base, FLOFI_DELEGATION_MAINNET_CHAINS: 'eip155:42161' })).toMatchObject({ enabled: true, mode: 'PRODUCTION', mainnetChains: [CHAIN], signer: { kind: 'none' } });
    for (const value of ['eip155:8453', 'eip155:42161,eip155:42161', 'arbitrum']) expect(readDelegationConfig({ ...base, FLOFI_DELEGATION_MAINNET_CHAINS: value }))
      .toMatchObject({ enabled: false, code: 'DELEGATION_CONFIGURATION_INVALID', reason: 'FLOFI_DELEGATION_MAINNET_CHAINS' });
    expect(readDelegationConfig({ ...base, FLOFI_DELEGATION_MAINNET_CHAINS: CHAIN, FLOFI_DELEGATION_HARNESS: 'MOCKED_LOOPBACK_ONLY', FLOFI_DELEGATION_HARNESS_URL: 'http://127.0.0.1:8560' }))
      .toMatchObject({ enabled: false, code: 'DELEGATION_CONFIGURATION_INVALID' });
  });
});

describe('grant coverage of the whole workflow', () => {
  it('one grant covers Swap, Supply and Borrow: 2 + 2 + 1 on-chain calls, bound to its pool, assets and caps', async () => {
    const s = await setup(), graph = resolveAuthorityGraph(s.requirement, [s.view], 'PRODUCTION', NOW.getTime(), undefined, MAINNET);
    expect(graph.ok).toBe(true);
    expect(graph.bindings.map(b => b.grantId)).toEqual(Array(3).fill(s.view.grantId));
  });
  it.each([
    ['too few calls', { maxCalls: 4 }, 'CREDENTIAL_CALLS_EXHAUSTED'],
    ['no Aave scope', { aave: undefined }, 'CREDENTIAL_SCOPE_TARGET'],
    ['a smaller Borrow cap', { aave: { pool: POOL, supply: [{ asset: WETH, perCallCap: '2000000000000000' }], borrow: [{ asset: USDC, perCallCap: '999999' }] } }, 'CREDENTIAL_SCOPE_AMOUNT'],
    ['another Borrow asset', { aave: { pool: POOL, supply: [{ asset: WETH, perCallCap: '2000000000000000' }], borrow: [{ asset: WETH, perCallCap: '1' }] } }, 'CREDENTIAL_SCOPE_ASSET'],
  ] as const)('refuses %s', async (_name, override, code) => {
    const s = await setup(override as never), graph = resolveAuthorityGraph(s.requirement, [s.view], 'PRODUCTION', NOW.getTime(), undefined, MAINNET);
    expect(graph.ok).toBe(false);
    if (!graph.ok) expect(graph.failures.map(f => f.code)).toContain(code);
  });
  it('the one-shot manifest carries FloFi\'s Borrow health-factor floor and the Aave targets', async () => {
    const m = manifest(await setup());
    expect(m.limits.minHealthFactor).toBe('2');
    expect(m.protocols).toEqual(expect.arrayContaining([{ chain: CHAIN, adapterId: 'aave-v3', targets: [POOL, WETH].sort() }]));
    expect(m.recipients).toHaveLength(1);
  });
});

describe('drivers: fresh simulation → grant scope → policy → session signature → reconciliation', () => {
  it('Swap: the exact approval and exactInputSingle, admitted by the grant and the policy', async () => {
    const s = await setup(), ctx = context(s, 0);
    expect(driverFor(ctx, 'PRODUCTION')).toBe(evmSwapDriver);
    expect(driverFor({ ...ctx, mainnet: [] }, 'PRODUCTION')).toBeNull();
    const { plan, prepared } = await evmSwapDriver.simulate(ctx);
    expect(plan.minimumReceive[0]).toMatchObject({ amount: 995_000_000_000_000n });
    expect(await evmSwapDriver.authorize(ctx, prepared)).toBeNull();
    expect(stepPolicyViolation(manifest(s), ctx.step, ctx.binding, plan, NOW.getTime())).toBeNull();
  });

  it('Supply spends exactly the WETH the Swap delivered (narrowed below its cap), into the owner\'s own position', async () => {
    const s = await setup(), used = 1_200_000_000_000_000n, ctx = context(s, 1, {}, used);
    expect(driverFor(ctx, 'PRODUCTION')).toBe(evmAaveDriver);
    const { plan, prepared } = await evmAaveDriver.simulate(ctx);
    expect(plan).toMatchObject({ actionType: 'supply', adapterId: 'aave-v3', targets: [WETH, POOL], spend: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: used }],
      healthFactorAfter: null, recipient: `${CHAIN}:${s.owner.address}` });
    const calls = prepared.calls as { target: string; data: string; method: string }[];
    expect(calls.map(c => [c.target, c.method])).toEqual([[WETH, 'approve'], [POOL, 'supply']]);
    expect(calls[1]!.data).toBe(D.AAVE_V3_SUPPLY_METHOD + pad(WETH).slice(2) + word(used) + pad(s.owner.address).slice(2) + word(0n));
    expect(await evmAaveDriver.authorize(ctx, prepared)).toBeNull();
    expect(stepPolicyViolation(manifest(s), ctx.step, ctx.binding, plan, NOW.getTime())).toBeNull();
    // Signed by the grant's own session key as canonical redemptions; nothing was broadcast by signing.
    const signed = await evmAaveDriver.sign(ctx, json(prepared), keys);
    const txs = signed.submission.txs as { raw: string; hash: string }[];
    expect(txs.map(tx => D.decodeSignedEip1559(tx.raw).from)).toEqual([s.session.address, s.session.address]);
    expect(txs.map(tx => D.decodeSignedEip1559(tx.raw).tx.to)).toEqual([D.DELEGATION_FRAMEWORK_V1_3.delegationManager, D.DELEGATION_FRAMEWORK_V1_3.delegationManager]);
    expect(txs.map(tx => D.decodeSignedEip1559(tx.raw).tx.nonce)).toEqual([7n, 8n]);
    // Reconciliation: pending until both receipts exist; then exactly `used` WETH moved from the owner into aWETH.
    const receipts = new Map<string, unknown>(), t = transport(s, receipts);
    expect((await evmAaveDriver.reconcile({ ...ctx, transport: t }, signed.submission, json(prepared))).status).toBe('PENDING');
    receipts.set(txs[0]!.hash, { status: '0x1', logs: [] });
    receipts.set(txs[1]!.hash, { status: '0x1', logs: [redeemed(s), transfer(WETH, s.owner.address, A_WETH, used)] });
    expect(await evmAaveDriver.reconcile({ ...ctx, transport: t }, signed.submission, json(prepared)))
      .toMatchObject({ status: 'CONFIRMED', spent: [{ asset: `${CHAIN}/erc20:${WETH}`, amount: used }], received: [] });
    receipts.set(txs[1]!.hash, { status: '0x1', logs: [redeemed(s), transfer(WETH, s.owner.address, A_WETH, used + 1n)] });
    await expect(evmAaveDriver.reconcile({ ...ctx, transport: t }, signed.submission, json(prepared))).rejects.toThrow('RECONCILIATION_MISMATCH');
  });

  it('Borrow is variable rate, for the owner, admitted only above the health-factor floor, and reconciled from the reserve to the owner', async () => {
    const s = await setup(), ctx = context(s, 2);
    const { plan, prepared } = await evmAaveDriver.simulate(ctx);
    expect(plan).toMatchObject({ actionType: 'borrow', targets: [POOL], spend: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: 1_000_000n }], healthFactorAfter: '2.400000000000000000' });
    expect((prepared.calls as { data: string }[])[0]!.data).toBe(D.AAVE_V3_BORROW_METHOD + pad(USDC).slice(2) + word(1_000_000n) + word(2n) + word(0n) + pad(s.owner.address).slice(2));
    expect(await evmAaveDriver.authorize(ctx, prepared)).toBeNull();
    expect(stepPolicyViolation(manifest(s), ctx.step, ctx.binding, plan, NOW.getTime())).toBeNull();
    // Defense in depth: even if a fresh read passed Aave's own rules, a plan below FloFi's floor is refused before signing.
    expect(stepPolicyViolation(manifest(s), ctx.step, ctx.binding, { ...plan, healthFactorAfter: '1.900000000000000000' }, NOW.getTime())).toBe('HEALTH_FACTOR_BELOW_FLOOR');
    expect(stepPolicyViolation(manifest(s), ctx.step, ctx.binding, { ...plan, healthFactorAfter: null }, NOW.getTime())).toBe('HEALTH_FACTOR_BELOW_FLOOR');
    const signed = await evmAaveDriver.sign(ctx, json(prepared), keys), txs = signed.submission.txs as { hash: string }[];
    const receipts = new Map<string, unknown>([[txs[0]!.hash, { status: '0x1', logs: [redeemed(s), transfer(USDC, A_USDC, s.owner.address, 1_000_000n)] }]]);
    expect(await evmAaveDriver.reconcile({ ...ctx, transport: transport(s, receipts) }, signed.submission, json(prepared))).toMatchObject({ status: 'CONFIRMED', spent: [],
      received: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: 1_000_000n }], evidence: { interestRateMode: 'VARIABLE', healthFactorAfter: '2.400000000000000000' } });
    receipts.set(txs[0]!.hash, { status: '0x0', logs: [] });
    expect(await evmAaveDriver.reconcile({ ...ctx, transport: transport(s, receipts) }, signed.submission, json(prepared))).toMatchObject({ status: 'REVERTED', spent: [] });
  });

  it.each([
    ['an unsafe health factor', () => { reads.estimate = new Error('BORROW_UNSAFE_HEALTH_FACTOR'); }, 2, 'BORROW_UNSAFE_HEALTH_FACTOR'],
    ['insufficient borrowing capacity', () => { reads.estimate = new Error('BORROW_ABOVE_CAPACITY'); }, 2, 'BORROW_ABOVE_CAPACITY'],
    ['insufficient Aave liquidity', () => { reads.estimate = new Error('BORROW_INSUFFICIENT_LIQUIDITY'); }, 2, 'BORROW_INSUFFICIENT_LIQUIDITY'],
    ['a full supply cap', () => { reads.capFull = true; }, 1, 'SUPPLY_CAP_EXCEEDED'],
    ['a frozen reserve', () => { reads.supply = { ...reads.supply as object, reserveConfiguration: String((1n << 56n) | (1n << 57n)) }; }, 1, 'SUPPLY_RESERVE_UNAVAILABLE'],
    ['too little WETH in the wallet', () => { reads.supply = { ...reads.supply as object, balance: '1' }; }, 1, 'SUPPLY_INSUFFICIENT_ASSET'],
  ] as const)('halts on %s before anything is signed', async (_name, arrange, k, code) => {
    const s = await setup(), ctx = context(s, k, {}, k === 1 ? 1_200_000_000_000_000n : undefined);
    arrange();
    await expect(evmAaveDriver.simulate(ctx)).rejects.toThrow(code);
  });

  it('refuses an owner account that is not the MetaMask smart account, and a call outside the grant', async () => {
    const s = await setup(), ctx = context(s, 2);
    const plain = { ...ctx.transport, rpc: async (method: string, params: readonly unknown[]) => method === 'eth_getCode' ? '0x' : ctx.transport.rpc(method, params) };
    await expect(evmAaveDriver.simulate({ ...ctx, transport: plain })).rejects.toThrow('EVM_ACCOUNT_NOT_UPGRADED');
    const { prepared } = await evmAaveDriver.simulate(ctx);
    const calls = prepared.calls as { target: string; data: string; group: number; method: string }[];
    // A Borrow above the on-chain ceiling, or for someone else, is outside the signed grant: refused before signing.
    const above = [{ ...calls[0]!, data: D.AAVE_V3_BORROW_METHOD + pad(USDC).slice(2) + word(1n << 24n) + word(2n) + word(0n) + pad(s.owner.address).slice(2) }];
    const other = [{ ...calls[0]!, data: D.AAVE_V3_BORROW_METHOD + pad(USDC).slice(2) + word(1n) + word(2n) + word(0n) + pad('0x' + '22'.repeat(20)).slice(2) }];
    expect(await evmAaveDriver.authorize(ctx, { ...prepared, calls: above })).toBe('GRANT_SCOPE_EXCEEDED');
    expect(await evmAaveDriver.authorize(ctx, { ...prepared, calls: other })).toBe('GRANT_SCOPE_EXCEEDED');
    // Without the deployment's opt-in no driver serves the step.
    expect(driverFor({ ...ctx, mainnet: [] }, 'PRODUCTION')).toBeNull();
  });
});
