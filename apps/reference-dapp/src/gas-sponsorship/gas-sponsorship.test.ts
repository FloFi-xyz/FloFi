// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: network-fee sponsorship on deterministic fixtures — a loopback paymaster provider double, file storage under a
 * disposable directory, ed25519 keys generated in memory. No provider, RPC, wallet or fund is reached; nothing is signed for a real network.
 */
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { base58Encode, erc4337, parseTransaction, serializeSignedTransaction, setComputeUnitLimit, setComputeUnitPrice, type SolanaInstruction } from '@defi-workflow-engine/reference-compiler';
import { readGasSponsorshipConfig, paymasterProxyUrl, solanaSecretKey } from './config';
import { callsHash, createGrantStore, createSponsorLedger } from './ledger';
import { handlePaymasterRpc, reconcileSponsoredOperation, type PaymasterTransport } from './paymaster-service';
import { assertSponsorableMessage, cosignSponsoredTransaction, solanaSponsorSigner, sponsoredMessage, sponsoredTransactionId } from './solana-fee-payer';
import { gasSponsorshipRuntime, sponsorshipPort } from './runtime';
import { handlePaymasterHttp } from './http';

const OWNER = '0x4b212af0a923256961487ae72499ca79f920b3ce', PAYMASTER = '0x' + '7a'.repeat(20), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ENV = { FLOFI_GAS_SPONSORSHIP: 'enabled', FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN: 'https://flofi.example', FLOFI_PAYMASTER_RPC_8453: 'https://paymaster.provider.example/v2/8453?apikey=SERVER_ONLY',
  FLOFI_PAYMASTER_ADDRESS_8453: PAYMASTER, FLOFI_SPONSOR_MAX_WEI_PER_OP_8453: '50000000000000', FLOFI_SPONSOR_DAILY_BUDGET_WEI_8453: '120000000000000',
  FLOFI_PAYMASTER_CONTEXT_8453: '{"sponsorshipPolicyId":"sp_flofi"}' };
const calls = [{ target: USDC, value: 0n, data: '0x095ea7b3' + '00'.repeat(64) }, { target: '0x' + '22'.repeat(20), value: 0n, data: '0x12345678' }];
const op = (callData = erc4337.batchCallData(calls), sender = OWNER) => ({ sender, nonce: '0x5', callData, callGasLimit: '0x30000', verificationGasLimit: '0x20000',
  preVerificationGas: '0xc350', maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x989680' });
async function setup(answer?: (body: { method: string; params: unknown[] }) => unknown, env: Record<string, string> = {}) {
  const config = readGasSponsorshipConfig({ ...ENV, ...env }), sponsor = config.evm['eip155:8453']!;
  const storage = createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-sponsor-')), 'GAS_SPONSOR_BUSY');
  let clock = Date.parse('2026-11-13T12:00:00Z');
  const now = () => new Date(clock), grants = createGrantStore(storage, now), ledger = createSponsorLedger(storage, now);
  const seen: { url: string; body: { method: string; params: unknown[] } }[] = [];
  const transport: PaymasterTransport = async (url, body) => { seen.push({ url, body: body as { method: string; params: unknown[] } });
    return answer ? answer(body as { method: string; params: unknown[] }) : { jsonrpc: '2.0', id: 1, result: { paymaster: PAYMASTER, paymasterData: '0xabcdef',
      paymasterVerificationGasLimit: '0x10000', paymasterPostOpGasLimit: '0x5000' } }; };
  const grant = await grants.create({ network: 'eip155:8453', owner: OWNER, callsHash: callsHash(calls), ttlSeconds: 600 });
  const rpc = (method: string, params: unknown[]) => handlePaymasterRpc({ sponsor, grants, ledger, transport, now }, { jsonrpc: '2.0', id: 7, method, params });
  return { config, sponsor, grants, ledger, grant, rpc, seen, tick: (ms: number) => { clock += ms; } };
}

describe('BUILD-FLOFI-MAINNET-EXEC-002 sponsorship configuration', () => {
  it('is off unless enabled and configured per network; a malformed network is refused on its own, never guessed', () => {
    expect(readGasSponsorshipConfig({})).toMatchObject({ enabled: false, code: 'GAS_SPONSORSHIP_DISABLED' });
    expect(readGasSponsorshipConfig({ FLOFI_GAS_SPONSORSHIP: 'enabled' })).toMatchObject({ enabled: false, code: 'GAS_SPONSORSHIP_NOT_CONFIGURED' });
    const config = readGasSponsorshipConfig({ ...ENV, FLOFI_PAYMASTER_RPC_42161: 'https://x.example', FLOFI_PAYMASTER_ADDRESS_42161: 'nope' });
    expect(Object.keys(config.evm)).toEqual(['eip155:8453']);
    expect(config.refusals).toEqual({ 'eip155:42161': 'GAS_SPONSOR_EVM_CONFIG_INVALID' });
    expect(config.evm['eip155:8453']).toMatchObject({ paymaster: PAYMASTER, entryPoint: erc4337.ENTRY_POINT_V0_7, maxWeiPerOp: 50_000_000_000_000n, context: { sponsorshipPolicyId: 'sp_flofi' } });
    // The browser-facing URL is FloFi's own proxy: the provider URL (and its key) never leaves the server.
    expect(paymasterProxyUrl(config, 'eip155:8453')).toBe('https://flofi.example/api/gas/paymaster/8453');
    expect(readGasSponsorshipConfig({ ...ENV, FLOFI_SPONSOR_DAILY_BUDGET_WEI_8453: '1' }).refusals['eip155:8453']).toBe('GAS_SPONSOR_EVM_CONFIG_INVALID');
    expect(readGasSponsorshipConfig({ ...ENV, FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN: 'http://flofi.example' }).refusals['eip155:8453']).toBe('GAS_SPONSOR_EVM_CONFIG_INVALID');
  });
  it('reads a Solana sponsor key only as a valid 64-byte keypair (base58 or the CLI JSON format)', () => {
    const key = solanaKeypair();
    expect(solanaSecretKey(JSON.stringify([...key.secret]))).toEqual(key.secret);
    expect(solanaSecretKey(base58Encode(key.secret))).toEqual(key.secret);
    expect(solanaSecretKey('[1,2,3]')).toBeNull();
    expect(readGasSponsorshipConfig({ FLOFI_GAS_SPONSORSHIP: 'enabled', FLOFI_SOLANA_SPONSOR_SECRET_KEY: 'x', FLOFI_SOLANA_SPONSOR_MAX_LAMPORTS_PER_TX: '20000',
      FLOFI_SOLANA_SPONSOR_DAILY_BUDGET_LAMPORTS: '1000000', FLOFI_SOLANA_SPONSOR_MIN_BALANCE_LAMPORTS: '0' })).toMatchObject({ enabled: false, solana: null });
  });
});

describe('BUILD-FLOFI-MAINNET-EXEC-002 ERC-7677 paymaster proxy (EVM)', () => {
  it('sponsors the owner\'s exact reviewed calls: forwards to the provider with its own context (never the grant), reserves the cost, records the operation', async () => {
    const s = await setup();
    const stub = await s.rpc('pm_getPaymasterStubData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: s.grant.id }]);
    expect(stub.result).toMatchObject({ paymaster: PAYMASTER, paymasterData: '0xabcdef', sponsor: { name: 'FloFi' } });
    expect(s.seen[0]!.url).toContain('apikey=SERVER_ONLY');
    expect(s.seen[0]!.body.params[3]).toEqual({ sponsorshipPolicyId: 'sp_flofi' });
    expect(JSON.stringify(s.seen[0]!.body)).not.toContain(s.grant.id);
    expect(await s.ledger.spentToday('eip155:8453')).toBe(0n); // a stub reserves nothing
    const final = await s.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: s.grant.id }]);
    expect(final.error).toBeUndefined();
    // Worst case: (0x20000 + 0x30000 + 0xc350 + 0x10000 + 0x5000) gas × 0.1 gwei = 0.0000463696 ETH, within the 0.00005 ETH cap.
    const expected = (0x20000n + 0x30000n + 0xc350n + 0x10000n + 0x5000n) * 100_000_000n;
    expect(await s.ledger.spentToday('eip155:8453')).toBe(expected);
    const used = (await s.grants.read(s.grant.id))!.uses;
    expect(used).toHaveLength(1);
    // Reconciliation: the EntryPoint's UserOperationEvent of that exact operation, from the owner, paid by the pinned paymaster.
    const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0'), word = (v: bigint) => v.toString(16).padStart(64, '0');
    const log = { address: erc4337.ENTRY_POINT_V0_7, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, used[0]!.userOpHash, topic(OWNER), topic(PAYMASTER)],
      data: '0x' + word(5n) + word(1n) + word(123_456_000_000_000n) + word(123_456n) };
    const paid = await reconcileSponsoredOperation(s, s.grant.id, OWNER, [log]);
    expect(paid).toMatchObject({ userOpHash: used[0]!.userOpHash, paidBy: PAYMASTER, actualGasCost: 123_456_000_000_000n, success: true });
    expect(await s.ledger.spentToday('eip155:8453')).toBe(123_456_000_000_000n); // the actual fee replaces the worst case
  });
  it('refuses anything it did not review: other calls, another sender, a deployment, another chain or EntryPoint, no or an expired grant', async () => {
    const s = await setup(), ctx = { flofiGrant: s.grant.id };
    const other = erc4337.batchCallData([{ ...calls[0]!, data: '0x095ea7b3' + 'ff'.repeat(64) }, calls[1]!]);
    expect((await s.rpc('pm_getPaymasterData', [op(other), erc4337.ENTRY_POINT_V0_7, '0x2105', ctx])).error?.message).toBe('GAS_SPONSOR_CALLS_NOT_REVIEWED');
    expect((await s.rpc('pm_getPaymasterData', [op(undefined, '0x' + '33'.repeat(20)), erc4337.ENTRY_POINT_V0_7, '0x2105', ctx])).error?.message).toBe('GAS_SPONSOR_SENDER_NOT_OWNER');
    expect((await s.rpc('pm_getPaymasterData', [{ ...op(), factory: '0x' + '44'.repeat(20), factoryData: '0x' }, erc4337.ENTRY_POINT_V0_7, '0x2105', ctx])).error?.message)
      .toBe('GAS_SPONSOR_DEPLOYMENT_REFUSED');
    expect((await s.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0xa4b1', ctx])).error?.message).toBe('GAS_SPONSOR_CHAIN_UNEXPECTED');
    expect((await s.rpc('pm_getPaymasterData', [op(), '0x' + '55'.repeat(20), '0x2105', ctx])).error?.message).toBe('GAS_SPONSOR_ENTRY_POINT_UNEXPECTED');
    expect((await s.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', {}])).error?.message).toBe('GAS_SPONSOR_GRANT_REQUIRED');
    expect((await s.rpc('pm_getPaymasterData', [op('0xdeadbeef'), erc4337.ENTRY_POINT_V0_7, '0x2105', ctx])).error?.message).toBe('GAS_SPONSOR_CALLS_UNREADABLE');
    expect((await s.rpc('eth_sendUserOperation', [op()])).error?.message).toBe('GAS_SPONSOR_METHOD_UNSUPPORTED');
    s.tick(601_000);
    expect((await s.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', ctx])).error?.message).toBe('GAS_SPONSOR_GRANT_EXPIRED');
    expect(s.seen).toHaveLength(0); // nothing unreviewed ever reached the provider
    expect(await s.ledger.spentToday('eip155:8453')).toBe(0n);
  });
  it('refuses a provider answer naming another paymaster, a cost above the cap, and spending beyond the daily budget', async () => {
    const wrong = await setup(() => ({ jsonrpc: '2.0', id: 1, result: { paymaster: '0x' + '66'.repeat(20), paymasterData: '0x', paymasterVerificationGasLimit: '0x1', paymasterPostOpGasLimit: '0x1' } }));
    expect((await wrong.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: wrong.grant.id }])).error?.message).toBe('GAS_SPONSOR_PAYMASTER_UNEXPECTED');
    const refused = await setup(() => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'policy rejected' } }));
    expect((await refused.rpc('pm_getPaymasterData', [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: refused.grant.id }])).error?.message).toBe('GAS_SPONSOR_PROVIDER_REFUSED');
    const s = await setup();
    const costly = { ...op(), maxFeePerGas: '0x3b9aca00' }; // 1 gwei: 0.00046 ETH worst case, above the 0.00005 ETH cap
    expect((await s.rpc('pm_getPaymasterData', [costly, erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: s.grant.id }])).error?.message).toBe('GAS_SPONSOR_COST_ABOVE_CAP');
    // Daily budget 0.00012 ETH; each operation reserves its 0.0000464 ETH worst case: two fit, the third is refused.
    const grants = await Promise.all([0, 1, 2].map(() => s.grants.create({ network: 'eip155:8453', owner: OWNER, callsHash: callsHash(calls), ttlSeconds: 600 })));
    const answers = [];
    for (const [i, g] of grants.entries()) answers.push(await s.rpc('pm_getPaymasterData', [{ ...op(), nonce: '0x' + (10 + i).toString(16) }, erc4337.ENTRY_POINT_V0_7, '0x2105', { flofiGrant: g.id }]));
    expect(answers.map(a => a.error?.message ?? 'OK')).toEqual(['OK', 'OK', 'GAS_SPONSOR_BUDGET_EXHAUSTED']);
  });
  it('a grant sponsors at most three final operations (one owner nonce lets only one land); the same operation asked again is not reserved twice', async () => {
    const s = await setup(undefined, { FLOFI_SPONSOR_DAILY_BUDGET_WEI_8453: '1000000000000000' }), ctx = { flofiGrant: s.grant.id };
    const results = [];
    for (const fee of ['0x5f5e100', '0x5f5e100', '0x5f5e101', '0x5f5e102', '0x5f5e103']) results.push(await s.rpc('pm_getPaymasterData', [{ ...op(), maxFeePerGas: fee }, erc4337.ENTRY_POINT_V0_7, '0x2105', ctx]));
    expect(results.map(r => r.error?.message ?? 'OK')).toEqual(['OK', 'OK', 'OK', 'OK', 'GAS_SPONSOR_GRANT_USED']);
    expect((await s.grants.read(s.grant.id))!.uses).toHaveLength(3);
    // Three distinct operations reserved (the repeat is not reserved twice, the refused fourth reserves nothing).
    const per = (fee: bigint) => (0x20000n + 0x30000n + 0xc350n + 0x10000n + 0x5000n) * fee;
    expect(await s.ledger.spentToday('eip155:8453')).toBe(per(0x5f5e100n) + per(0x5f5e101n) + per(0x5f5e102n));
  });
});

function solanaKeypair() {
  const pair = generateKeyPairSync('ed25519');
  const seed = Uint8Array.from(pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16)), pub = Uint8Array.from(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  return { secret: Uint8Array.from([...seed, ...pub]), publicKey: base58Encode(pub), sign: (message: Uint8Array) => Uint8Array.from(signBytes(null, message, pair.privateKey)) };
}
describe('BUILD-FLOFI-MAINNET-EXEC-002 Solana sponsored fee payer', () => {
  const PROGRAM = 'depoUZ2vFRS2Xp1b9yX7Zkz8HU5FmRpk8d6ZyZBQeBY', BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));
  const fixture = () => {
    const sponsorKey = solanaKeypair(), owner = solanaKeypair(), signer = solanaSponsorSigner(sponsorKey.secret);
    const deposit: SolanaInstruction = { programId: PROGRAM, accounts: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Uint8Array.from([1, 2, 3]) };
    const built = sponsoredMessage(signer.publicKey, [setComputeUnitLimit(60_000), ...setComputeUnitPrice('100000'), deposit], BLOCKHASH);
    const policy = { sponsor: signer.publicKey, owner: owner.publicKey, blockhash: BLOCKHASH, allowedPrograms: [PROGRAM], maxLamportsPerTx: 20_000n };
    return { sponsorKey, owner, signer, built, policy, deposit };
  };
  it('the sponsor pays only the fee: the owner signs its own instruction, FloFi verifies it, then co-signs slot 0', () => {
    const f = fixture();
    expect(assertSponsorableMessage(f.built.message, f.policy)).toBe(2n * 5_000n + 6_000n); // 2 signatures + 60 000 CU × 0.1 lamport
    const ownerSigned = serializeSignedTransaction([null, f.owner.sign(f.built.message)], f.built.message);
    const done = cosignSponsoredTransaction(ownerSigned, { messageHash: f.built.messageHash, policy: f.policy, signer: f.signer });
    const parsed = parseTransaction(done.transaction);
    expect(parsed.signatures).toHaveLength(2);
    expect(sponsoredTransactionId(done.transaction)).toBe(done.signature);
    expect(done.maxFee).toBe(16_000n);
  });
  it('refuses a changed message, a missing or forged owner signature, a filled sponsor slot, and a sponsor any instruction could debit', () => {
    const f = fixture();
    const ownerSigned = serializeSignedTransaction([null, f.owner.sign(f.built.message)], f.built.message);
    expect(() => cosignSponsoredTransaction(ownerSigned, { messageHash: '0x' + '0'.repeat(64), policy: f.policy, signer: f.signer })).toThrow('GAS_SPONSOR_SOLANA_MESSAGE_CHANGED');
    expect(() => cosignSponsoredTransaction(serializeSignedTransaction([null, null], f.built.message), { messageHash: f.built.messageHash, policy: f.policy, signer: f.signer }))
      .toThrow('GAS_SPONSOR_SOLANA_OWNER_SIGNATURE_INVALID');
    expect(() => cosignSponsoredTransaction(serializeSignedTransaction([f.owner.sign(f.built.message), f.owner.sign(f.built.message)], f.built.message),
      { messageHash: f.built.messageHash, policy: f.policy, signer: f.signer })).toThrow('GAS_SPONSOR_SOLANA_SPONSOR_SLOT_FILLED');
    // An instruction that names the sponsor (e.g. a transfer FROM it) is never co-signed.
    const draining = sponsoredMessage(f.signer.publicKey, [setComputeUnitLimit(60_000), { ...f.deposit, accounts: [...f.deposit.accounts, { pubkey: f.signer.publicKey, isSigner: true, isWritable: true }] }], BLOCKHASH);
    expect(() => assertSponsorableMessage(draining.message, f.policy)).toThrow('GAS_SPONSOR_SOLANA_SPONSOR_REFERENCED');
    const expensive = sponsoredMessage(f.signer.publicKey, [setComputeUnitLimit(1_400_000), ...setComputeUnitPrice('1000000'), f.deposit], BLOCKHASH);
    expect(() => assertSponsorableMessage(expensive.message, f.policy)).toThrow('GAS_SPONSOR_SOLANA_FEE_ABOVE_CAP');
    const foreign = sponsoredMessage(f.signer.publicKey, [{ ...f.deposit, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }], BLOCKHASH);
    expect(() => assertSponsorableMessage(foreign.message, f.policy)).toThrow('GAS_SPONSOR_SOLANA_PROGRAM_NOT_ALLOWED');
    expect(() => assertSponsorableMessage(f.built.message, { ...f.policy, blockhash: base58Encode(new Uint8Array(32).fill(9)) })).toThrow('GAS_SPONSOR_SOLANA_BLOCKHASH_MISMATCH');
    expect(() => solanaSponsorSigner(Uint8Array.from([...f.sponsorKey.secret.slice(0, 32), ...new Uint8Array(32)]))).toThrow('GAS_SPONSOR_SOLANA_KEY_INVALID');
  });
});

describe('BUILD-FLOFI-MAINNET-EXEC-002 sponsorship runtime and the paymaster HTTP proxy', () => {
  const storages = new WeakMap<object, ReturnType<typeof createFileExecutionStorage>>();
  const storageOf = (rt: object | null) => storages.get(rt!)!;
  const runtimeFor = async (env: Record<string, string> = ENV, answer?: () => unknown) => {
    const storage = createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-sponsor-rt-')), 'GAS_SPONSOR_BUSY');
    const transport: PaymasterTransport = async () => answer ? answer() : { jsonrpc: '2.0', id: 1, result: { paymaster: PAYMASTER, paymasterData: '0x01',
      paymasterVerificationGasLimit: '0x10000', paymasterPostOpGasLimit: '0x5000' } };
    const rt = gasSponsorshipRuntime(env, () => storage, { transport, now: () => new Date('2026-11-13T12:00:00Z') });
    if (rt) storages.set(rt, storage);
    return rt;
  };
  it('is absent without configuration (every batch stays owner-paid) and never opens storage then', async () => {
    let opened = false;
    expect(gasSponsorshipRuntime({}, () => { opened = true; throw new Error('never'); })).toBeNull();
    expect(gasSponsorshipRuntime({ ...ENV, FLOFI_GAS_SPONSORSHIP: 'off' }, () => { opened = true; throw new Error('never'); })).toBeNull();
    expect(opened).toBe(false);
  });
  it('offers per configured chain only; a preview creates no grant; a spent daily budget makes no offer; settles what a grant sponsored', async () => {
    const rt = (await runtimeFor())!;
    expect(await rt.offer({ chain: 'eip155:42161', owner: OWNER, calls, ttlSeconds: 600, preview: false })).toBeNull();
    expect(await rt.offer({ chain: 'eip155:8453', owner: OWNER, calls, ttlSeconds: 600, preview: true }))
      .toEqual({ grantId: null, chain: 'eip155:8453', paymaster: PAYMASTER, url: 'https://flofi.example/api/gas/paymaster/8453', context: null });
    const offer = (await rt.offer({ chain: 'eip155:8453', owner: OWNER, calls, ttlSeconds: 600, preview: false }))!;
    expect(offer.context).toEqual({ flofiGrant: offer.grantId });
    const final = await rt.paymaster(8453, { jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterData', params: [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', offer.context] });
    expect(final.error).toBeUndefined();
    const ops = (await rt.operations(offer.grantId!))!;
    expect(ops).toHaveLength(1);
    await rt.settle(offer.grantId!, ops[0]!, 1_000n);
    // A process without the sponsorship configuration (a worker) reads and settles the same grant from the shared state.
    const reader = sponsorshipPort({}, () => storageOf(rt))!;
    expect(await reader.offer({ chain: 'eip155:8453', owner: OWNER, calls, ttlSeconds: 600, preview: false })).toBeNull();
    expect(await reader.operations(offer.grantId!)).toEqual(ops);
    await expect(rt.settle(offer.grantId!, '0x' + '0'.repeat(64), 1n)).rejects.toThrow('GAS_SPONSOR_OPERATION_UNKNOWN');
    // Budget 0.00012 ETH, cap 0.00005 ETH: once more than 0.00007 ETH is spent today, no further offer is made.
    const tight = (await runtimeFor({ ...ENV, FLOFI_SPONSOR_DAILY_BUDGET_WEI_8453: '50000000000000' }))!;
    const one = (await tight.offer({ chain: 'eip155:8453', owner: OWNER, calls, ttlSeconds: 600, preview: false }))!;
    await tight.paymaster(8453, { jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterData', params: [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', one.context] });
    expect(await tight.offer({ chain: 'eip155:8453', owner: OWNER, calls, ttlSeconds: 600, preview: false })).toBeNull();
  });
  it('the HTTP proxy answers CORS preflight, refuses other methods, unknown chains, oversized or batch bodies, and is 404 when disabled', async () => {
    const rt = await runtimeFor(), url = 'https://flofi.example/api/gas/paymaster/8453';
    const call = (init: RequestInit, at = url, runtime: typeof rt = rt) => handlePaymasterHttp(new Request(at, init), {}, async () => runtime);
    const preflight = await call({ method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ method: 'POST', body: '{}' }, 'https://flofi.example/api/gas/paymaster/abc')).status).toBe(404);
    expect(await (await call({ method: 'POST', body: '{}' }, url, null)).json()).toMatchObject({ error: { message: 'GAS_SPONSORSHIP_DISABLED' } });
    expect((await call({ method: 'POST', body: 'x'.repeat(70_000) })).status).toBe(413);
    expect((await call({ method: 'POST', body: '[{"jsonrpc":"2.0"}]' })).status).toBe(400);
    expect((await call({ method: 'POST', body: 'not json' })).status).toBe(400);
    const refused = await call({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'pm_getPaymasterData', params: [op(), erc4337.ENTRY_POINT_V0_7, '0x2105', {}] }) });
    expect(refused.status).toBe(200);
    const body = await refused.json() as { id: number; error: { message: string } };
    expect(body).toMatchObject({ id: 3, error: { message: 'GAS_SPONSOR_GRANT_REQUIRED' } });
    // The provider's URL (and key) never appears in an answer.
    expect(JSON.stringify(body)).not.toContain('SERVER_ONLY');
  });
});
