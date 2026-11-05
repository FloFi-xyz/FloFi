// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: workflow-scoped ERC-7710 grants. One owner signature authorizes exactly the calls of one
 * workflow on one chain, each at most once. These tests replay a compromised executor (it holds the session key and ignores every
 * application check) against the enforcer model: MOCKED evidence of the v1.3.0 hooks, not of the deployed bytecode (the read-only mainnet
 * probe in apps/reference-dapp/scripts covers that). Arbitrum One identities are registry values used as data only; nothing is called.
 */
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import * as d from '../src/erc7710.js';

const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
function address() { return hex(keccak_256(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false).subarray(1)).subarray(12)); }
const CHAIN = 42161;
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const ROUTER = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const owner = address(), session = address(), attacker = address();
const T0 = 1_800_000_000n;

/** Swap 3 USDC → ≥ 0.000997 WETH, Supply exactly the guaranteed 0.000997 WETH, Borrow exactly 1 USDC (variable). */
const CALLS: readonly d.WorkflowCall[] = [
  { kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER, amount: 3_000_000n },
  { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: ROUTER, tokenIn: USDC, tokenOut: WETH, fee: 500, amountIn: 3_000_000n, amountOutMinimum: 997_000_000_000_000n },
  { kind: 'ERC20_APPROVE', token: WETH, spender: POOL, amount: 997_000_000_000_000n },
  { kind: 'AAVE_V3_SUPPLY', pool: POOL, asset: WETH, amount: 997_000_000_000_000n },
  { kind: 'AAVE_V3_BORROW', pool: POOL, asset: USDC, amount: 1_000_000n },
];
const scope: d.WorkflowGrantScope = { chainId: CHAIN, owner, session, validAfter: T0, validBefore: T0 + 3600n, calls: CALLS, salt: 0x5a17n };
const unsigned = d.compileWorkflowGrant(scope), signed: d.Delegation = { ...unsigned, signature: '0x' };
const hash = d.delegationHash(unsigned);

/**
 * A minimal chain double over the enforcer model: the DelegationManager's root-caveat hooks (Redeemer, Timestamp, LimitedCalls, ValueLte,
 * LogicalOrWrapper and the selected group's inner caveats), with LimitedCalls and IdEnforcer state committed only for a successful call,
 * exactly as a reverted transaction rolls back enforcer storage.
 */
function chain() {
  let callCount = 0n;
  const usedIds = new Set<string>();
  let disabled = false;
  return {
    redeem(group: number, call: d.Call, opts: { redeemer?: string; at?: bigint; delegation?: d.Delegation; reverts?: boolean } = {}) {
      if (disabled) return { ok: false as const, code: 'CannotUseADisabledDelegation' };
      const delegation = opts.delegation ?? signed;
      let verdict: d.ModelVerdict;
      try {
        verdict = d.modelBeforeHooks(d.withGroupArgs(delegation, group), { redeemer: opts.redeemer ?? session, call, blockTimestamp: opts.at ?? T0 + 60n,
          delegationHash: d.delegationHash(delegation), callCount, usedIds });
      } catch { return { ok: false as const, code: 'LogicalOrWrapperEnforcer:invalid-group-index' }; }
      if (!verdict.ok) return verdict;
      if (opts.reverts) return { ok: false as const, code: 'EXECUTION_REVERTED' };
      if (verdict.countsCall) callCount++;
      verdict.usedIds.forEach(id => usedIds.add(id));
      return { ok: true as const };
    },
    disable() { disabled = true; },
  };
}
const exact = (i: number) => d.workflowCallData(CALLS[i]!, owner);
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).padStart(64, '0');

describe('workflow grant compilation', () => {
  it('pins redeemer, window, call count and zero native value at the root, and one exact once-only call per group', () => {
    const [redeemer, timestamp, limited, value, or] = unsigned.caveats;
    const E = d.DELEGATION_FRAMEWORK_V1_3.enforcers;
    expect([redeemer!.enforcer, timestamp!.enforcer, limited!.enforcer, value!.enforcer, or!.enforcer]).toEqual([E.redeemer, E.timestamp, E.limitedCalls, E.valueLte, E.logicalOrWrapper]);
    expect(BigInt(limited!.terms)).toBe(5n);
    expect(BigInt(value!.terms)).toBe(0n);
    const calls = d.workflowGrantCalls(unsigned)!;
    expect(calls.map(c => ({ target: c.target, value: c.value, data: c.data }))).toEqual(CALLS.map(c => d.workflowCallData(c, owner)));
    expect(new Set(calls.map(c => c.id)).size).toBe(5);
    expect(calls.map(c => c.id)).toEqual(CALLS.map((_, i) => d.workflowCallId(CHAIN, owner, scope.salt, i)));
  });
  it('encodes the exact Aave and Uniswap calldata the executor sends', () => {
    expect(exact(4).data).toBe(d.AAVE_V3_BORROW_METHOD + addr(USDC) + word(1_000_000n) + word(2n) + word(0n) + addr(owner));
    expect(exact(3).data).toBe(d.AAVE_V3_SUPPLY_METHOD + addr(WETH) + word(997_000_000_000_000n) + addr(owner) + word(0n));
    expect(exact(1).data).toBe(d.EXACT_INPUT_SINGLE_METHOD + addr(USDC) + addr(WETH) + word(500n) + addr(owner) + word(3_000_000n) + word(997_000_000_000_000n) + word(0n));
    expect(d.workflowCallData({ kind: 'AAVE_V3_REPAY', pool: POOL, asset: USDC, amount: 5n }, owner).data).toBe(d.AAVE_V3_REPAY_METHOD + addr(USDC) + word(5n) + word(2n) + addr(owner));
    expect(d.workflowCallData({ kind: 'AAVE_V3_WITHDRAW', pool: POOL, asset: WETH, amount: 7n }, owner).data).toBe(d.AAVE_V3_WITHDRAW_METHOD + addr(WETH) + word(7n) + addr(owner));
    expect(d.workflowCallData({ kind: 'NATIVE_TRANSFER', to: attacker, amount: 9n }, owner)).toEqual({ target: attacker, value: 9n, data: '0x' });
  });
  it('is unique per grant: a new salt, chain or owner gives new ids, so authority never carries over between workflows', () => {
    const other = d.compileWorkflowGrant({ ...scope, salt: scope.salt + 1n });
    const ids = (g: Omit<d.Delegation, 'signature'>) => d.workflowGrantCalls(g)!.map(c => c.id);
    expect(ids(other).some(id => ids(unsigned).includes(id))).toBe(false);
    expect(d.workflowCallId(1, owner, 1n, 0)).not.toBe(d.workflowCallId(8453, owner, 1n, 0));
    expect(d.delegationHash(other)).not.toBe(hash);
  });
  it.each([
    ['no calls', { calls: [] }],
    ['more than 16 calls', { calls: Array.from({ length: 17 }, () => CALLS[0]!) }],
    ['an empty window', { validBefore: T0 }],
    ['a window over seven days', { validBefore: T0 + d.WORKFLOW_GRANT_MAX_WINDOW_SECONDS + 1n }],
    ['the owner as its own session', { session: owner }],
  ] as const)('refuses %s', (_name, override) => {
    expect(() => d.compileWorkflowGrant({ ...scope, ...override } as d.WorkflowGrantScope)).toThrow('ERC7710_SCOPE_INVALID');
  });
  it.each([
    ['a zero amount', { ...CALLS[4]!, amount: 0n }],
    ['an unbounded amount (uint256 max)', { ...CALLS[4]!, amount: (1n << 256n) - 1n }],
    ['a swap without a minimum output', { ...CALLS[1]!, amountOutMinimum: 0n }],
    ['an unregistered fee tier', { ...CALLS[1]!, fee: 2500 }],
    ['a swap of a token into itself', { ...CALLS[1]!, tokenOut: USDC }],
  ] as const)('refuses a call with %s', (_name, call) => {
    expect(() => d.compileWorkflowGrant({ ...scope, calls: [call as d.WorkflowCall] })).toThrow('ERC7710_WORKFLOW_CALL_INVALID');
  });
  it('reads back null for a delegation that does not have the workflow shape (a Credential grant)', () => {
    const credential = d.compileGrant({ chainId: CHAIN, owner, session, validAfter: T0, validBefore: T0 + 60n, maxCalls: 2n, salt: 1n,
      templates: [{ kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER }] });
    expect(d.workflowGrantCalls(credential)).toBeNull();
  });
});

describe('a compromised executor against a workflow grant (MOCKED enforcer model)', () => {
  it('runs the authorized workflow once, in order, and nothing more', () => {
    const c = chain();
    for (let i = 0; i < CALLS.length; i++) expect(c.redeem(i, exact(i))).toEqual({ ok: true });
    // Every call is spent: a sixth redemption fails on the call count, and any repeat on its id first.
    expect(c.redeem(4, exact(4))).toMatchObject({ ok: false, code: 'LimitedCallsEnforcer:limit-exceeded' });
  });
  it('cannot borrow more than the exact authorized amount — not 1 raw unit more, and not the old 16.77 USDC ceiling', () => {
    const c = chain(), borrow = (amount: bigint) => ({ target: POOL, value: 0n, data: d.AAVE_V3_BORROW_METHOD + addr(USDC) + word(amount) + word(2n) + word(0n) + addr(owner) });
    expect(c.redeem(4, borrow(1_000_001n))).toEqual({ ok: false, code: 'ExactCalldataEnforcer:invalid-calldata' });
    expect(c.redeem(4, borrow((1n << 24n) - 1n))).toEqual({ ok: false, code: 'ExactCalldataEnforcer:invalid-calldata' });
    expect(c.redeem(4, borrow(999_999n))).toEqual({ ok: false, code: 'ExactCalldataEnforcer:invalid-calldata' });
    expect(c.redeem(4, borrow(1_000_000n))).toEqual({ ok: true });
  });
  it('cannot borrow twice, even when it interrupts the run and replays the step later (IdEnforcer survives the interruption)', () => {
    const c = chain();
    expect(c.redeem(4, exact(4))).toEqual({ ok: true });
    expect(c.redeem(4, exact(4))).toEqual({ ok: false, code: 'IdEnforcer:id-already-used' });
    // Not through a group that is still unused either: every other group pins its own exact call.
    for (const g of [0, 1, 2, 3]) expect(c.redeem(g, exact(4))).toMatchObject({ ok: false });
  });
  it('a call that reverts on-chain spends nothing, so the legitimate retry still works exactly once', () => {
    const c = chain();
    expect(c.redeem(1, exact(1), { reverts: true })).toEqual({ ok: false, code: 'EXECUTION_REVERTED' });
    expect(c.redeem(1, exact(1))).toEqual({ ok: true });
    expect(c.redeem(1, exact(1))).toEqual({ ok: false, code: 'IdEnforcer:id-already-used' });
  });
  it.each([
    ['borrow at the stable rate', 4, () => ({ ...exact(4), data: d.AAVE_V3_BORROW_METHOD + addr(USDC) + word(1_000_000n) + word(1n) + word(0n) + addr(owner) })],
    ['borrow on behalf of another account', 4, () => ({ ...exact(4), data: d.AAVE_V3_BORROW_METHOD + addr(USDC) + word(1_000_000n) + word(2n) + word(0n) + addr(attacker) })],
    ['borrow another asset', 4, () => ({ ...exact(4), data: d.AAVE_V3_BORROW_METHOD + addr(WETH) + word(1_000_000n) + word(2n) + word(0n) + addr(owner) })],
    ['swap with no minimum output', 1, () => ({ ...exact(1), data: exact(1).data.slice(0, -128) + word(0n) + word(0n) })],
    ['swap more input', 1, () => ({ ...exact(1), data: d.EXACT_INPUT_SINGLE_METHOD + addr(USDC) + addr(WETH) + word(500n) + addr(owner) + word(3_000_001n) + word(997_000_000_000_000n) + word(0n) })],
    ['swap to another recipient', 1, () => ({ ...exact(1), data: d.EXACT_INPUT_SINGLE_METHOD + addr(USDC) + addr(WETH) + word(500n) + addr(attacker) + word(3_000_000n) + word(997_000_000_000_000n) + word(0n) })],
    ['approve another spender', 0, () => ({ ...exact(0), data: d.APPROVE_METHOD + addr(attacker) + word(3_000_000n) })],
    ['approve an unlimited allowance', 0, () => ({ ...exact(0), data: d.APPROVE_METHOD + addr(ROUTER) + word((1n << 256n) - 1n) })],
    ['supply for another account', 3, () => ({ ...exact(3), data: d.AAVE_V3_SUPPLY_METHOD + addr(WETH) + word(997_000_000_000_000n) + addr(attacker) + word(0n) })],
    ['transfer the owner\'s USDC away', 0, () => ({ target: USDC, value: 0n, data: d.ERC20_TRANSFER_METHOD + addr(attacker) + word(3_000_000n) })],
    ['send the owner\'s ETH', 0, () => ({ target: attacker, value: 1n, data: '0x' })],
    ['call the right calldata on another contract', 4, () => ({ ...exact(4), target: attacker })],
    ['append bytes to the exact calldata', 4, () => ({ ...exact(4), data: exact(4).data + '00' })],
  ] as const)('cannot %s', (_name, group, call) => {
    const r = chain().redeem(group, call());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toMatch(/^(ExactCalldataEnforcer:invalid-calldata|AllowedTargetsEnforcer:target-address-not-allowed|ValueLteEnforcer:value-too-high)$/);
  });
  it('cannot redeem from another key, before the window, after expiry, or after the owner disables the delegation', () => {
    expect(chain().redeem(4, exact(4), { redeemer: attacker })).toEqual({ ok: false, code: 'RedeemerEnforcer:unauthorized-redeemer' });
    expect(chain().redeem(4, exact(4), { at: T0 })).toEqual({ ok: false, code: 'TimestampEnforcer:early-delegation' });
    expect(chain().redeem(4, exact(4), { at: T0 + 3600n })).toEqual({ ok: false, code: 'TimestampEnforcer:expired-delegation' });
    const c = chain(); c.disable();
    expect(c.redeem(4, exact(4))).toEqual({ ok: false, code: 'CannotUseADisabledDelegation' });
  });
  it('cannot widen the grant: any changed caveat changes the delegation hash the owner signed', () => {
    const widened = d.compileWorkflowGrant({ ...scope, calls: CALLS.map((c, i) => i === 4 ? { ...c, amount: 16_000_000n } as d.WorkflowCall : c) });
    expect(d.delegationHash(widened)).not.toBe(hash);
    expect(d.delegationDigest(CHAIN, widened)).not.toBe(d.delegationDigest(CHAIN, unsigned));
  });
  it('a native transfer group allows exactly its value to exactly its recipient', () => {
    const g = d.compileWorkflowGrant({ ...scope, calls: [{ kind: 'NATIVE_TRANSFER', to: attacker, amount: 5n }] });
    const s: d.Delegation = { ...g, signature: '0x' };
    const run = (call: d.Call) => d.modelBeforeHooks(d.withGroupArgs(s, 0), { redeemer: session, call, blockTimestamp: T0 + 1n, delegationHash: '0x', callCount: 0n });
    expect(run({ target: attacker, value: 5n, data: '0x' })).toMatchObject({ ok: true });
    expect(run({ target: attacker, value: 6n, data: '0x' })).toEqual({ ok: false, code: 'ValueLteEnforcer:value-too-high' });
    expect(run({ target: owner, value: 5n, data: '0x' })).toEqual({ ok: false, code: 'AllowedTargetsEnforcer:target-address-not-allowed' });
    expect(run({ target: attacker, value: 5n, data: '0x00' })).toEqual({ ok: false, code: 'ExactCalldataEnforcer:invalid-calldata' });
  });
});

describe('ERC20BalanceChangeEnforcer decrease rules (model fidelity)', () => {
  it('reverts with Panic(0x11) when the cap exceeds the balance cached before the call, as Solidity 0.8 checked arithmetic does', () => {
    const rule = { decrease: true, token: WETH, recipient: owner, amount: 2n * 10n ** 18n };
    expect(d.modelAfterHook(rule, 10n ** 18n, 10n ** 18n)).toEqual({ ok: false, code: 'Panic(0x11)' });
    expect(d.modelAfterHook(rule, 2n * 10n ** 18n, 10n ** 18n)).toEqual({ ok: true });
  });
});
