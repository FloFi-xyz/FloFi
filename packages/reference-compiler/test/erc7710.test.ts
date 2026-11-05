import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeApprove } from '../src/abi.js';
import * as d from '../src/erc7710.js';

const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
function key() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = hex(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12));
  const sign = (digest: string) => {
    const sig = secp256k1.sign(d.bytesOf(digest), secret, { prehash: false, format: 'recovered' });
    return hex(sig.subarray(1)) + (sig[0]! + 27).toString(16).padStart(2, '0');
  };
  const signRaw = (digest: string) => {
    const sig = secp256k1.sign(d.bytesOf(digest), secret, { prehash: false, format: 'recovered' });
    return { yParity: sig[0]! as 0 | 1, r: BigInt(hex(sig.subarray(1, 33))), s: BigInt(hex(sig.subarray(33, 65))) };
  };
  return { address, sign, signRaw };
}
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e', WETH = '0x4200000000000000000000000000000000000006', ROUTER = '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4';
const CHAIN = 84532;

function grant(owner: string, session: string, overrides: Partial<d.GrantScope> = {}) {
  return d.compileGrant({ chainId: CHAIN, owner, session, validAfter: 1_000n, validBefore: 2_000_000_000n, maxCalls: 8n, salt: 77n,
    templates: [{ kind: 'ERC20_APPROVE', token: USDC, spender: ROUTER },
      { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: ROUTER, tokenIn: USDC, tokenOut: WETH, perCallInputCap: 50_000_000n }], ...overrides });
}
/** SwapRouter02 `exactInputSingle` exactly as FloFi's public swap flow encodes it (seven static words). */
const swapCall = (owner: string, amountIn = 50_000_000n, recipient = owner, tokenOut = WETH): d.Call => ({ target: ROUTER, value: 0n,
  data: d.EXACT_INPUT_SINGLE_METHOD + hex(d.abiEncode(['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
    [USDC, tokenOut, 500n, recipient, amountIn, 1n, 0n])).slice(2) });

/** An independent EIP-712 implementation over the JSON typed data a wallet receives (`eth_signTypedData_v4`). */
type Field = { name: string; type: string };
function typedDataDigest(td: ReturnType<typeof d.delegationTypedData>): string {
  const types = td.types as unknown as Record<string, Field[]>;
  const deps = (name: string, found = new Set<string>()): Set<string> => {
    if (found.has(name) || !types[name]) return found;
    found.add(name);
    for (const f of types[name]!) deps(f.type.replace(/\[\]$/, ''), found);
    return found;
  };
  const encodeType = (name: string) => [name, ...[...deps(name)].filter(n => n !== name).sort()].map(n => `${n}(${types[n]!.map(f => `${f.type} ${f.name}`).join(',')})`).join('');
  const typeHash = (name: string) => keccak_256(new TextEncoder().encode(encodeType(name)));
  const enc = (type: string, value: unknown): Uint8Array => {
    if (type.endsWith('[]')) return keccak_256(Uint8Array.from((value as unknown[]).flatMap(v => [...enc(type.slice(0, -2), v)])));
    if (types[type]) return hashStruct(type, value as Record<string, unknown>);
    if (type === 'string') return keccak_256(new TextEncoder().encode(value as string));
    if (type === 'bytes') return keccak_256(d.bytesOf(value as string));
    if (type === 'address') return d.bytesOf('0x' + (value as string).slice(2).padStart(64, '0'));
    if (type === 'bytes32') return d.bytesOf(value as string);
    if (type === 'uint256') return d.word(BigInt(value as string | number));
    throw new Error(type);
  };
  const hashStruct = (name: string, value: Record<string, unknown>) => keccak_256(Uint8Array.from([...typeHash(name), ...types[name]!.flatMap(f => [...enc(f.type, value[f.name])])]));
  return hex(keccak_256(Uint8Array.from([0x19, 0x01, ...hashStruct('EIP712Domain', td.domain as never), ...hashStruct(td.primaryType, td.message as never)])));
}

describe('MetaMask Delegation Framework v1.3.0 constants', () => {
  it('derives the selectors and event topic FloFi already pins for real redemptions', () => {
    expect(d.REDEEM_DELEGATIONS_SELECTOR).toBe('0xcef6d209');
    expect(d.REDEEMED_DELEGATION_TOPIC).toBe('0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873');
    expect(d.DELEGATOR_DESIGNATOR).toBe('0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b');
    expect(d.APPROVE_METHOD).toBe(d.selectorOf('approve(address,uint256)'));
    expect(d.EXACT_INPUT_SINGLE_METHOD).toBe(d.selectorOf('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'));
    expect(d.DISABLED_DELEGATIONS_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
  });
  it('typehashes are the keccak of the framework type strings', () => {
    expect(d.CAVEAT_TYPEHASH).toBe(d.keccakHex('Caveat(address enforcer,bytes terms)'));
    expect(d.DELEGATION_TYPEHASH).toBe(d.keccakHex('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'));
  });
});

describe('ABI codec', () => {
  it('round trips nested dynamic tuples canonically and refuses non-canonical bytes', () => {
    const types: d.AbiType[] = [{ array: { tuple: ['address', 'bytes', { array: 'bytes' }] } }, 'uint256'];
    const value = [[[USDC, '0x01', ['0x', '0xabcdef']], [WETH, '0x', []]], 5n];
    const encoded = d.abiEncode(types, value as never);
    expect(d.abiDecode(types, encoded)).toEqual(value);
    const tampered = Uint8Array.from(encoded); tampered[31] = 0x60; // a different (still in-range) offset
    expect(() => d.abiDecode(types, tampered)).toThrow();
  });
});

describe('grant compilation, signature and redemption encoding', () => {
  it('a delegation signed as typed data recovers to the owner and survives the permission-context round trip', () => {
    const owner = key(), session = key();
    const unsigned = grant(owner.address, session.address);
    expect(unsigned.caveats.map(c => c.enforcer)).toEqual([d.DELEGATION_FRAMEWORK_V1_3.enforcers.redeemer, d.DELEGATION_FRAMEWORK_V1_3.enforcers.timestamp,
      d.DELEGATION_FRAMEWORK_V1_3.enforcers.limitedCalls, d.DELEGATION_FRAMEWORK_V1_3.enforcers.valueLte, d.DELEGATION_FRAMEWORK_V1_3.enforcers.logicalOrWrapper]);
    const digest = d.delegationDigest(CHAIN, unsigned);
    const signature = owner.sign(digest);
    expect(d.recoverDigestSigner(digest, signature)).toBe(owner.address);
    // The digest binds the chain, the salt and every caveat term (but not caveat args or the signature).
    expect(d.delegationDigest(8453, unsigned)).not.toBe(digest);
    expect(d.delegationDigest(CHAIN, { ...unsigned, salt: 78n })).not.toBe(digest);
    expect(d.delegationHash({ ...unsigned, caveats: unsigned.caveats.map(c => ({ ...c, args: '0x1234' })) })).toBe(d.delegationHash(unsigned));
    const signed = { ...unsigned, signature };
    const data = d.redeemCalldata(signed, 1, swapCall(owner.address));
    const decoded = d.decodeRedeemCalldata(data);
    expect(decoded.modes).toEqual([d.MODE_SINGLE_DEFAULT]);
    expect(d.decodeSingleExecution(decoded.executions[0]!)).toEqual(swapCall(owner.address));
    const [round] = d.decodePermissionContext(decoded.contexts[0]!);
    expect(d.delegationHash(round!)).toBe(d.delegationHash(unsigned));
    expect(round!.signature).toBe(signature);
    expect(d.decodeLogicalOrArgs(round!.caveats[4]!.args)).toEqual({ groupIndex: 1, caveatArgs: ['0x', '0x', '0x', '0x', '0x', '0x'] });
    expect(typedDataDigest(d.delegationTypedData(CHAIN, unsigned))).toBe(digest);
  });
  it('revocation calldata carries the exact delegation', () => {
    const owner = key(), session = key(), unsigned = grant(owner.address, session.address), signed = { ...unsigned, signature: owner.sign(d.delegationDigest(CHAIN, unsigned)) };
    expect(d.delegationHash(d.decodeDisableDelegationCalldata(d.disableDelegationCalldata(signed)))).toBe(d.delegationHash(unsigned));
    expect(d.disabledDelegationsCalldata(d.delegationHash(unsigned))).toBe(d.DISABLED_DELEGATIONS_SELECTOR + d.delegationHash(unsigned).slice(2));
  });
  it('refuses unsafe scopes', () => {
    const owner = key();
    expect(() => grant(owner.address, owner.address)).toThrow('ERC7710_SCOPE_INVALID');
    expect(() => grant(owner.address, key().address, { templates: [] })).toThrow('ERC7710_SCOPE_INVALID');
    expect(() => grant(owner.address, key().address, { validBefore: 999n })).toThrow('ERC7710_SCOPE_INVALID');
    expect(() => grant(owner.address, key().address, { templates: [{ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', router: ROUTER, tokenIn: USDC, tokenOut: USDC, perCallInputCap: 1n }] })).toThrow('ERC7710_TEMPLATE_INVALID');
  });
  it('EIP-1559 transactions of a session signer recover to it and are canonical', () => {
    const session = key();
    const tx: d.Eip1559 = { chainId: 84532n, nonce: 3n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 2_000_000n, gasLimit: 400_000n,
      to: d.DELEGATION_FRAMEWORK_V1_3.delegationManager, value: 0n, data: '0xcef6d209' };
    const sig = session.signRaw(d.eip1559SigningHash(tx)), signed = d.signedEip1559(tx, sig.yParity, sig.r, sig.s);
    const decoded = d.decodeSignedEip1559(signed.raw);
    expect(decoded).toEqual({ tx, from: session.address, hash: signed.hash });
  });
});

describe('enforcer model (MOCKED evidence of the v1.3.0 hooks FloFi compiles)', () => {
  const owner = key(), session = key();
  const unsigned = grant(owner.address, session.address), signed = { ...unsigned, signature: '0x' };
  const ctx = (call: d.Call, group: number, extra: Partial<d.ModelContext> = {}): d.ModelVerdict =>
    d.modelBeforeHooks(d.withGroupArgs(signed, group), { redeemer: session.address, call, blockTimestamp: 1_500n, delegationHash: d.delegationHash(unsigned), callCount: 0n, ...extra });
  it('accepts the exact approve and swap groups and reports the balance rule and the counted call', () => {
    expect(ctx({ target: USDC, value: 0n, data: hex(encodeApprove(ROUTER, 50_000_000n)) }, 0)).toEqual({ ok: true, groupIndex: 0, countsCall: true, balanceRules: [] });
    const swap = ctx(swapCall(owner.address), 1);
    expect(swap).toEqual({ ok: true, groupIndex: 1, countsCall: true, balanceRules: [{ decrease: true, token: USDC, recipient: owner.address, amount: 50_000_000n }] });
    expect(d.modelAfterHook({ decrease: true, token: USDC, recipient: owner.address, amount: 50_000_000n }, 100_000_000n, 50_000_000n)).toEqual({ ok: true });
    expect(d.modelAfterHook({ decrease: true, token: USDC, recipient: owner.address, amount: 50_000_000n }, 100_000_000n, 49_999_999n))
      .toEqual({ ok: false, code: 'ERC20BalanceChangeEnforcer:exceeded-balance-decrease' });
  });
  it.each([
    ['another redeemer', () => ctx(swapCall(owner.address), 1, { redeemer: key().address }), 'RedeemerEnforcer:unauthorized-redeemer'],
    ['before validity', () => ctx(swapCall(owner.address), 1, { blockTimestamp: 1_000n }), 'TimestampEnforcer:early-delegation'],
    ['after expiry', () => ctx(swapCall(owner.address), 1, { blockTimestamp: 2_000_000_000n }), 'TimestampEnforcer:expired-delegation'],
    ['call count exhausted', () => ctx(swapCall(owner.address), 1, { callCount: 8n }), 'LimitedCallsEnforcer:limit-exceeded'],
    ['native value', () => ctx({ ...swapCall(owner.address), value: 1n }, 1), 'ValueLteEnforcer:value-too-high'],
    ['another recipient', () => ctx(swapCall(owner.address, 50_000_000n, key().address), 1), 'AllowedCalldataEnforcer:invalid-calldata'],
    ['another output token', () => ctx(swapCall(owner.address, 50_000_000n, owner.address, '0x' + '11'.repeat(20)), 1), 'AllowedCalldataEnforcer:invalid-calldata'],
    ['approve to another spender', () => ctx({ target: USDC, value: 0n, data: hex(encodeApprove('0x' + '22'.repeat(20), 1n)) }, 0), 'AllowedCalldataEnforcer:invalid-calldata'],
    ['approve through the swap group', () => ctx({ target: USDC, value: 0n, data: hex(encodeApprove(ROUTER, 1n)) }, 1), 'AllowedTargetsEnforcer:target-address-not-allowed'],
    ['another target', () => ctx({ ...swapCall(owner.address), target: '0x' + '33'.repeat(20) }, 1), 'AllowedTargetsEnforcer:target-address-not-allowed'],
    ['a transfer from the token', () => ctx({ target: USDC, value: 0n, data: d.selectorOf('transfer(address,uint256)') + '00'.repeat(64) }, 0), 'AllowedMethodsEnforcer:method-not-allowed'],
    ['a group that does not exist', () => d.modelBeforeHooks({ ...signed, caveats: signed.caveats.map(c => c.enforcer === d.DELEGATION_FRAMEWORK_V1_3.enforcers.logicalOrWrapper
      ? { ...c, args: d.logicalOrArgs(7, 1) } : c) }, { redeemer: session.address, call: swapCall(owner.address), blockTimestamp: 1_500n, delegationHash: '0x', callCount: 0n }),
    'LogicalOrWrapperEnforcer:invalid-group-index'],
  ])('refuses %s', (_name, run, code) => { expect(run()).toEqual({ ok: false, code }); });
  it('refuses any enforcer it does not model', () => {
    const foreign = { ...signed, caveats: [...signed.caveats, { enforcer: '0x' + '44'.repeat(20), terms: '0x', args: '0x' }] };
    expect(d.modelBeforeHooks(d.withGroupArgs(foreign, 1), { redeemer: session.address, call: swapCall(owner.address), blockTimestamp: 1_500n, delegationHash: '0x', callCount: 0n }))
      .toEqual({ ok: false, code: 'ENFORCER_NOT_MODELED' });
  });
});

// BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: Aave V3 Supply and Borrow as scoped ERC-7710 call templates (Arbitrum One addresses from the
// registry; the model is MOCKED evidence of the v1.3.0 hooks, the addresses are identities only — nothing is called here).
describe('Aave V3 Supply and Borrow templates', () => {
  const POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad', A_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', A_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const owner = key(), session = key();
  const templates: d.CallTemplate[] = [{ kind: 'ERC20_APPROVE', token: A_WETH, spender: POOL },
    { kind: 'AAVE_V3_SUPPLY', pool: POOL, asset: A_WETH, perCallCap: 2_000_000_000_000_000n }, { kind: 'AAVE_V3_BORROW', pool: POOL, asset: A_USDC, perCallCap: 1_000_000n }];
  const unsigned = d.compileGrant({ chainId: 42161, owner: owner.address, session: session.address, validAfter: 1_000n, validBefore: 2_000_000_000n, maxCalls: 6n, salt: 9n, templates });
  const signed = { ...unsigned, signature: '0x' };
  const run = (call: d.Call, group: number, extra: Partial<d.ModelContext> = {}) => d.modelBeforeHooks(d.withGroupArgs(signed, group),
    { redeemer: session.address, call, blockTimestamp: 1_500n, delegationHash: d.delegationHash(unsigned), callCount: 0n, ...extra });
  const supply = (amount: bigint, onBehalfOf = owner.address, asset = A_WETH, referral = 0n): d.Call => ({ target: POOL, value: 0n,
    data: d.AAVE_V3_SUPPLY_METHOD + hex(d.abiEncode(['address', 'uint256', 'address', 'uint256'], [asset, amount, onBehalfOf, referral])).slice(2) });
  const borrow = (amount: bigint, mode = 2n, onBehalfOf = owner.address, asset = A_USDC, referral = 0n): d.Call => ({ target: POOL, value: 0n,
    data: d.AAVE_V3_BORROW_METHOD + hex(d.abiEncode(['address', 'uint256', 'uint256', 'uint256', 'address'], [asset, amount, mode, referral, onBehalfOf])).slice(2) });
  it('pins the Pool selectors and the byte-aligned Borrow ceiling', () => {
    expect(d.AAVE_V3_SUPPLY_METHOD).toBe('0x617ba037'); expect(d.AAVE_V3_BORROW_METHOD).toBe('0xa415bcad');
    expect(d.borrowCeiling(1_000_000n)).toBe(1n << 24n); expect(d.borrowCeiling(255n)).toBe(256n); expect(d.borrowCeiling(256n)).toBe(1n << 16n);
    expect(() => d.borrowCeiling(0n)).toThrow('ERC7710_TEMPLATE_INVALID');
  });
  it('accepts the exact approval, a Supply on the owner\'s own position and a variable-rate Borrow for the owner', () => {
    expect(run({ target: A_WETH, value: 0n, data: hex(encodeApprove(POOL, 1_000_000_000_000_000n)) }, 0)).toMatchObject({ ok: true, groupIndex: 0 });
    expect(run(supply(1_000_000_000_000_000n), 1)).toEqual({ ok: true, groupIndex: 1, countsCall: true,
      balanceRules: [{ decrease: true, token: A_WETH, recipient: owner.address, amount: 2_000_000_000_000_000n }] });
    expect(run(borrow(500_000n), 2)).toEqual({ ok: true, groupIndex: 2, countsCall: true, balanceRules: [{ decrease: false, token: A_USDC, recipient: owner.address, amount: 1n }] });
    // Up to just below the on-chain ceiling (2^24 - 1 raw USDC ≈ 16.77 USDC); the exact cap (1 USDC) is the executor's.
    expect(run(borrow((1n << 24n) - 1n), 2)).toMatchObject({ ok: true });
    // A Supply that takes more than its cap from the owner's account fails in the after-hook.
    expect(d.modelAfterHook({ decrease: true, token: A_WETH, recipient: owner.address, amount: 2_000_000_000_000_000n }, 5n * 10n ** 18n, 5n * 10n ** 18n - 2_000_000_000_000_001n))
      .toEqual({ ok: false, code: 'ERC20BalanceChangeEnforcer:exceeded-balance-decrease' });
    // A Borrow whose asset does not reach the owner fails in the after-hook.
    expect(d.modelAfterHook({ decrease: false, token: A_USDC, recipient: owner.address, amount: 1n }, 7n, 7n)).toEqual({ ok: false, code: 'ERC20BalanceChangeEnforcer:insufficient-balance-increase' });
  });
  it.each([
    ['a Supply for someone else', () => run(supply(1n, key().address), 1)],
    ['a Supply of another asset', () => run(supply(1n, owner.address, A_USDC), 1)],
    ['a Supply with a referral code', () => run(supply(1n, owner.address, A_WETH, 1n), 1)],
    ['a stable-rate Borrow', () => run(borrow(1n, 1n), 2)],
    ['a Borrow at or above the ceiling', () => run(borrow(1n << 24n), 2)],
    ['a Borrow whose debt is someone else\'s', () => run(borrow(1n, 2n, key().address), 2)],
    ['a Borrow of another asset', () => run(borrow(1n, 2n, owner.address, A_WETH), 2)],
    ['a Borrow with a referral code', () => run(borrow(1n, 2n, owner.address, A_USDC, 7n), 2)],
  ])('refuses %s (calldata)', (_name, call) => { expect(call()).toEqual({ ok: false, code: 'AllowedCalldataEnforcer:invalid-calldata' }); });
  it.each([
    ['a Borrow through the Supply group', () => run(borrow(1n), 1), 'AllowedMethodsEnforcer:method-not-allowed'],
    ['a withdraw from the Pool', () => run({ target: POOL, value: 0n, data: d.selectorOf('withdraw(address,uint256,address)') + '00'.repeat(96) }, 2), 'AllowedMethodsEnforcer:method-not-allowed'],
    ['another redeemer', () => run(borrow(1n), 2, { redeemer: key().address }), 'RedeemerEnforcer:unauthorized-redeemer'],
    ['after expiry', () => run(borrow(1n), 2, { blockTimestamp: 2_000_000_000n }), 'TimestampEnforcer:expired-delegation'],
    ['call count exhausted', () => run(supply(1n), 1, { callCount: 6n }), 'LimitedCallsEnforcer:limit-exceeded'],
    ['native value', () => run({ ...supply(1n), value: 1n }, 1), 'ValueLteEnforcer:value-too-high'],
  ])('refuses %s', (_name, call, code) => { expect(call()).toEqual({ ok: false, code }); });
  it('refuses unsafe Aave templates', () => {
    expect(() => d.templateGroup({ kind: 'AAVE_V3_SUPPLY', pool: POOL, asset: A_WETH, perCallCap: 0n }, owner.address)).toThrow('ERC7710_TEMPLATE_INVALID');
    expect(() => d.templateGroup({ kind: 'AAVE_V3_BORROW', pool: POOL, asset: A_USDC, perCallCap: 0n }, owner.address)).toThrow('ERC7710_TEMPLATE_INVALID');
  });
});
