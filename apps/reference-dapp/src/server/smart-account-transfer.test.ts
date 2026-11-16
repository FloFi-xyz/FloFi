// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-7702-TRANSFER-001: transfers from MetaMask Smart Accounts (EIP-7702 owners delegated to the reviewed DeleGator) on the shared
 * transfer coordinator, sent directly by the account or relayed by MetaMask through the Delegation Manager.
 *
 * MOCKED loopback only: no wallet key, public RPC or MAINNET_EXECUTED evidence. The relay is played by the in-memory chain in the shape of the
 * real MetaMask relay recorded in testdata/metamask-delegated-depth1-approval.base-sepolia.json; it is not evidence of a live mainnet relay.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, catalogAsset, parseArbitrumTokenList, UNISWAP_V3_ARBITRUM as UNI, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { createNativeTransferNode, createTokenTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { erc7710, VERIFIED_EIP7702_DELEGATES } from '@defi-workflow-engine/reference-compiler';
import { createRobinhoodTransferService, relayedTransferNonceRelease, type TransferRecord } from './robinhood-transfer-service';
import { createRobinhoodMockChain, MOCK_DELEGATOR_IMPL, MOCK_DELEGATION_MANAGER } from './robinhood-mainnet.test-harness';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const owner = '0x1111111111111111111111111111111111111111', recipient = '0x3333333333333333333333333333333333333333';
const relayer = '0xc066ac5d385419b1a8c43a0e146fa439837a8b8c';
const chainId = ARBITRUM_ONE.chain, DESIGNATOR = '0xef0100' + MOCK_DELEGATOR_IMPL.slice(2);
let now = Date.parse('2026-10-11T22:06:20Z'), catalog: AssetCatalog, chain: ReturnType<typeof createRobinhoodMockChain>;
const dirs: string[] = [], dir = () => { const d = mkdtempSync(join(tmpdir(), 'flofi-7702-transfer-')); dirs.push(d); return d; };
const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
const native = (amount = '10000000000000000', to = recipient) => flow(createNativeTransferNode('node-002', { chain: chainId, amount, recipient: to }));
const usdc = catalogAsset(parseArbitrumTokenList(bytes, new Date(now).toISOString()), { symbol: 'USDC' })!;
/** 1 USDC (the production case): `transfer(recipient, 1_000_000)` on Arbitrum One. */
const token = (amount = '1000000', to = recipient) => flow(createTokenTransferNode('node-002', { chain: chainId, amount, recipient: to,
  token: { address: usdc.address!, decimals: usdc.decimals, officialId: null } }));
function service(path = dir()) {
  return createRobinhoodTransferService({ rpcs: { [chainId]: chain.rpc }, idPrefix: 'art', journalDir: path, now: () => now,
    provenance: 'MOCKED', catalogFor: async () => catalog, executionEnabled: true });
}
type Service = ReturnType<typeof service>;
/** Simulate → Review → begin → handoff: the exact wallet request, nothing sent yet. */
async function prepared(s: Service, w: SemanticWorkflow) {
  const run = await s.simulate(w, owner);
  await s.review(run.id, run.review.commitment, w);
  const begun = await s.begin(run.id, owner, w);
  await s.handoff(run.id);
  return { id: run.id, run, transaction: begun.transaction };
}
const intents = (path: string, nonce = 0) => readFileSync(join(path, `eip155-42161-${owner}-${nonce}.intent`), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const limitations = (record: TransferRecord) => record.evidence!.bundle.reconciliation.limitations.join('\n');

beforeEach(() => {
  now = Date.parse('2026-10-11T22:06:20Z'); catalog = parseArbitrumTokenList(bytes, new Date(now).toISOString());
  chain = createRobinhoodMockChain(catalog, { now: () => now });
  chain.fundNative(owner, 10n ** 18n); chain.fund(UNI.usdc, owner, 1_000_000_000n); chain.fundNative(relayer, 10n ** 18n);
});
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('BUILD-FLOFI-7702-TRANSFER-001 owner account classification at Simulate and Review', () => {
  it('the harness plays the reviewed MetaMask Delegation Framework v1.3.0 contracts', () => {
    expect(VERIFIED_EIP7702_DELEGATES).toEqual([MOCK_DELEGATOR_IMPL]);
    expect(erc7710.DELEGATION_FRAMEWORK_V1_3.delegationManager).toBe(MOCK_DELEGATION_MANAGER);
  });
  it.each([['ERC-20', token], ['native', native]] as const)('a standard EOA keeps its exact %s Review (no owner delegation field)', async (_, make) => {
    const run = await service().simulate(make(), owner);
    expect(run.review.state).not.toHaveProperty('ownerDelegation');
  });
  it.each([['ERC-20', token], ['native', native]] as const)('a verified MetaMask Smart Account is simulated and reviewed for an %s transfer, the delegate bound into the commitment', async (_, make) => {
    const eoa = await service().simulate(make(), owner);
    chain.state.codeOverride.set(owner, DESIGNATOR);
    const run = await service().simulate(make(), owner);
    expect(run.review.state.ownerDelegation).toBe(MOCK_DELEGATOR_IMPL);
    // The delegate is part of the reviewed state, so of the commitment and the manifest (via the artifact set).
    expect(run.review.manifest.artifactSetHash).not.toBe(eoa.review.manifest.artifactSetHash);
    expect(run.review).toMatchObject({ account: owner, recipient, nonce: '0', transaction: { from: owner } });
  });
  it('the production case: 1 USDC on Arbitrum One from a MetaMask Smart Account is no longer refused as TRANSFER_OWNER_NOT_EOA', async () => {
    chain.state.codeOverride.set(owner, DESIGNATOR);
    const run = await service().simulate(token('1000000'), owner);
    expect(run.review.transaction).toEqual(expect.objectContaining({ to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + (1_000_000n).toString(16).padStart(64, '0') }));
    expect(run.review.asset).toMatchObject({ token: UNI.usdc, decimals: 6 });
  });
  it('refuses an EIP-7702 delegation to an unreviewed implementation (a sweeper could act on what the account receives)', async () => {
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    await expect(service().simulate(native('10000000000000000', 'CONNECTED_OWNER'), owner)).rejects.toThrow('TRANSFER_OWNER_DELEGATION_UNVERIFIED');
    await expect(service().simulate(token(), owner)).rejects.toThrow('TRANSFER_OWNER_DELEGATION_UNVERIFIED');
  });
  it('refuses a smart contract wallet, and a malformed or cleared (zero-address) designator, as accounts that cannot originate the transfer', async () => {
    for (const code of ['0x6080604052', '0xef0100' + '0'.repeat(40), DESIGNATOR + '00']) {
      chain.state.codeOverride.set(owner, code);
      await expect(service().simulate(token(), owner)).rejects.toThrow('TRANSFER_OWNER_NOT_EOA');
    }
  });
  it('never relaxes recipient verification: the recipient\'s code stays bound into the Review, and a change needs a new Review', async () => {
    chain.state.codeOverride.set(owner, DESIGNATOR); chain.state.codeOverride.set(recipient, DESIGNATOR);
    const s = service(), w = native(), run = await s.simulate(w, owner);
    expect(run.review.state.recipientCodeHash).toBeDefined();
    await s.review(run.id, run.review.commitment, w);
    chain.state.codeOverride.delete(recipient);
    await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_RECIPIENT_CODE_CHANGED_REVIEW_REQUIRED');
  });
  it('an upgrade, a removed delegation or another delegate after Review needs a new Review before any reservation or wallet request', async () => {
    const s = service(), w = token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w);
    chain.state.codeOverride.set(owner, DESIGNATOR);
    await expect(s.begin(run.id, owner, w)).rejects.toThrow('TRANSFER_OWNER_ACCOUNT_CHANGED_REVIEW_REQUIRED');
    expect((await s.load(run.id)).attempt).toBeNull();
    const delegated = await s.simulate(w, owner);
    await s.review(delegated.id, delegated.review.commitment, w);
    chain.state.codeOverride.delete(owner);
    await expect(s.begin(delegated.id, owner, w)).rejects.toThrow('TRANSFER_OWNER_ACCOUNT_CHANGED_REVIEW_REQUIRED');
  });
  it('the account changing between begin and the wallet handoff stops the handoff (no wallet request)', async () => {
    chain.state.codeOverride.set(owner, DESIGNATOR);
    const s = service(), w = token(), run = await s.simulate(w, owner);
    await s.review(run.id, run.review.commitment, w); await s.begin(run.id, owner, w);
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    await expect(s.handoff(run.id)).rejects.toThrow('TRANSFER_OWNER_DELEGATION_UNVERIFIED');
    chain.state.codeOverride.delete(owner);
    await expect(s.handoff(run.id)).rejects.toThrow('TRANSFER_OWNER_ACCOUNT_CHANGED_REVIEW_REQUIRED');
    expect((await s.load(run.id)).attempt?.state).toBe('PREPARED');
  });
});

describe('BUILD-FLOFI-7702-TRANSFER-001 direct submissions by a MetaMask Smart Account', () => {
  beforeEach(() => { chain.state.codeOverride.set(owner, DESIGNATOR); });
  it.each([
    ['ERC-20 to a third party', () => token(), 'TOKEN_TRANSFER_VERIFIED'],
    ['ERC-20 self-transfer', () => token('1000000', 'CONNECTED_OWNER'), 'TOKEN_TRANSFER_VERIFIED'],
    ['native to a third party', () => native(), 'NATIVE_TRANSFER_VERIFIED'],
    ['native self-transfer (the reviewed delegate\'s receive() runs and logs nothing)', () => native('10000000000000000', 'CONNECTED_OWNER'), 'NATIVE_TRANSFER_VERIFIED'],
  ] as const)('%s: the owner sends and pays; reconciled block-level from chain state', async (_, make, reason) => {
    const path = dir(), s = service(path), w = make(), nativeBefore = chain.state.native.get(owner)!, tokenBefore = chain.balance(UNI.usdc, owner);
    const { id, transaction } = await prepared(s, w);
    expect(transaction.from).toBe(owner);
    await s.report(id, { kind: 'HASH', hash: chain.apply(transaction) }); chain.mine(2);
    const done = await service(path).observe(id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', error: null });
    const facts = done.observations.at(-1)!.facts!;
    expect(done.observations.at(-1)!.reason).toBe(reason);
    expect(facts).toMatchObject({ ownerDelegation: MOCK_DELEGATOR_IMPL, nonceBefore: '0', nonceAfter: '1' });
    expect(facts).not.toHaveProperty('submission'); expect(facts).not.toHaveProperty('gasPayer'); expect(facts).not.toHaveProperty('reconciliationScope');
    // The owner paid the network fee (and, to a third party, the value) from its own balance.
    const fee = BigInt(facts.fee), self = done.review.recipient === owner;
    expect(fee).toBeGreaterThan(0n);
    expect(nativeBefore - chain.state.native.get(owner)!).toBe(fee + (done.review.asset || self ? 0n : 10_000_000_000_000_000n));
    expect(tokenBefore - chain.balance(UNI.usdc, owner)).toBe(done.review.asset && !self ? 1_000_000n : 0n);
    expect(done.evidence!.bundle.reconciliation.fees).toEqual([{ asset: { chainId, nativeId: 'ETH', decimals: 18 }, amount: facts.fee }]);
    expect(limitations(done)).toContain('MetaMask Smart Account: an EIP-7702 delegation to the reviewed DeleGator ' + MOCK_DELEGATOR_IMPL);
    expect(limitations(done)).toContain('Direct submission: the owner account sent the reviewed transaction');
    expect(done.evidence!.bundle.environment).toBe('MOCKED');
  });
  it('another relayed movement of the owner in the same block is not this transfer: proven from its own transaction and receipt instead', async () => {
    const path = dir(), s = service(path), { id, transaction } = await prepared(s, token());
    const hash = chain.apply(transaction);
    // A relay in the same inclusion block moves 7 more USDC units of the owner elsewhere without using its nonce.
    chain.relayInBlock({ from: owner, to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + relayer.slice(2).padStart(64, '0') + (7n).toString(16).padStart(64, '0') }, { relayer });
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    const done = await s.observe(id);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.observations.at(-1)!.facts).toMatchObject({ reconciliationScope: 'TRANSACTION', ownerDelegation: MOCK_DELEGATOR_IMPL });
    expect(limitations(done)).toContain('Another transaction or relayed redemption of this account was included in the same block');
  });
  it.each([['ERC-20', token, 'TRANSFER_TOKEN_BALANCE_MISMATCH'], ['native', native, 'TRANSFER_BALANCE_MISMATCH']] as const)(
    'an unexplained %s balance difference (no other transaction or relay of the owner in the block) is a mismatch, exactly as for a standard account', async (_, make, code) => {
      const s = service(), { id, transaction } = await prepared(s, make());
      const hash = chain.apply(transaction);
      if (make === token) chain.state.balances.set(`${UNI.usdc}:${owner}`, chain.balance(UNI.usdc, owner) - 7n);
      else chain.state.native.set(owner, chain.state.native.get(owner)! - 7n);
      await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
      expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: code, evidence: null });
    });
  it('an unrelated relay of the owner never makes its native transfer a duplicate (no empty-calldata match)', async () => {
    const path = dir(), s = service(path), { id, transaction } = await prepared(s, native());
    chain.relay({ from: owner, to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + relayer.slice(2).padStart(64, '0') + (7n).toString(16).padStart(64, '0') }, { relayer });
    await s.report(id, { kind: 'HASH', hash: chain.apply(transaction) }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'RECONCILED', error: null });
  });
  it('never reconciles a transfer whose owner code was not the reviewed delegation where it landed', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    const hash = chain.apply(transaction);
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_OWNER_ACCOUNT_CODE_MISMATCH', evidence: null });
    // A native self-transfer runs the owner's code as its recipient: the recipient-code binding already refuses it.
    chain.state.codeOverride.set(owner, DESIGNATOR);
    const self = await prepared(s, native('10000000000000000', 'CONNECTED_OWNER'));
    const selfHash = chain.apply(self.transaction);
    chain.state.codeOverride.set(owner, '0xef0100' + '9'.repeat(40));
    await s.report(self.id, { kind: 'HASH', hash: selfHash }); chain.mine(2);
    expect(await s.observe(self.id)).toMatchObject({ verdict: 'DIVERGENT', error: expect.stringMatching(/^TRANSFER_(?:RECIPIENT|OWNER_ACCOUNT)_CODE_MISMATCH$/), evidence: null });
  });
  it('an extra log in the receipt (another token moved) is never reconciled', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    const hash = chain.apply(transaction, { extraLogs: [{ address: UNI.weth, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + owner.slice(2).padStart(64, '0'), '0x' + relayer.slice(2).padStart(64, '0')], data: '0x' + (1n).toString(16).padStart(64, '0') }] });
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_LOGS_MISMATCH', evidence: null });
  });
});

describe('BUILD-FLOFI-7702-TRANSFER-001 MetaMask-relayed submissions (Delegation Manager redemptions)', () => {
  beforeEach(() => { chain.state.codeOverride.set(owner, DESIGNATOR); });
  it('a relayed 1 USDC transfer reconciles from its receipt: the relayer pays the fee, the owner pays none and keeps its nonce', async () => {
    const path = dir(), s = service(path), nativeBefore = chain.state.native.get(owner)!, tokenBefore = chain.balance(UNI.usdc, owner);
    const { id, transaction } = await prepared(s, token());
    const hash = chain.relay(transaction, { relayer });
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    const done = await service(path).observe(id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', error: null, attempt: { transactionHash: hash, reconciled: true } });
    const facts = done.observations.at(-1)!.facts!;
    expect(facts).toMatchObject({ submission: 'RELAYED', gasPayer: relayer, fee: '0', ownerDelegation: MOCK_DELEGATOR_IMPL, nonceBefore: '0', nonceAfter: '0' });
    expect(BigInt(facts.networkFee!)).toBeGreaterThan(0n);
    expect(chain.state.native.get(owner)).toBe(nativeBefore);
    expect(tokenBefore - chain.balance(UNI.usdc, owner)).toBe(1_000_000n);
    expect(chain.balance(UNI.usdc, recipient)).toBe(1_000_000n);
    expect(done.evidence!.bundle.reconciliation.fees).toEqual([{ asset: { chainId, nativeId: 'ETH', decimals: 18 }, amount: '0' }]);
    expect(limitations(done)).toContain(`Relayed submission: ${relayer} sent one single-use redemption of exactly the reviewed call`);
    expect(limitations(done)).toContain('the owner paid no network fee and its nonce was not used');
    // One relayed transaction, one run: its hash is claimed create-once.
    expect(readdirSync(path).filter(name => name.startsWith('claim-'))).toEqual([`claim-42161-${hash}.tx`]);
  });
  it('a completed relayed transfer does not block the next one: the next Review takes owner nonce 0 over with that evidence, then executes directly', async () => {
    const path = dir(), s = service(path), first = await prepared(s, token());
    const relayed = chain.relay(first.transaction, { relayer });
    await s.report(first.id, { kind: 'HASH', hash: relayed }); chain.mine(2);
    expect((await s.observe(first.id)).verdict).toBe('RECONCILED');
    const second = await prepared(s, token('2000000'));
    expect(second.run.review.nonce).toBe('0');
    expect(intents(path)).toEqual([{ id: first.id, transaction: first.transaction },
      { id: second.id, transaction: second.transaction, supersedes: first.id, release: { id: first.id, txHash: relayed } }]);
    await s.report(second.id, { kind: 'HASH', hash: chain.apply(second.transaction) }); chain.mine(2);
    const done = await s.observe(second.id);
    expect(done.verdict).toBe('RECONCILED');
    expect(BigInt(done.observations.at(-1)!.facts!.fee)).toBeGreaterThan(0n);
  });
  it('never hands a reservation over before the holder is reconciled, or after a direct, divergent or pending holder', async () => {
    const path = dir(), s = service(path), first = await prepared(s, token());
    const early = await s.simulate(token('2000000'), owner);
    await s.review(early.id, early.review.commitment, token('2000000'));
    await expect(s.begin(early.id, owner, token('2000000'))).rejects.toThrow('TRANSFER_NONCE_ALREADY_RESERVED'); // holder only handed off
    const hash = chain.relay(first.transaction, { relayer, singleUse: false });
    await s.report(first.id, { kind: 'HASH', hash }); chain.mine(2);
    expect(await s.observe(first.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_DELEGATION_NOT_SINGLE_USE', evidence: null });
    const later = await s.simulate(token('2000000'), owner);
    await s.review(later.id, later.review.commitment, token('2000000'));
    await expect(s.begin(later.id, owner, token('2000000'))).rejects.toThrow('TRANSFER_NONCE_ALREADY_RESERVED');
    expect(intents(path)).toHaveLength(1);
  });
  it('relayedTransferNonceRelease accepts only a reconciled, verified relayed holder at the same owner, chain and nonce', async () => {
    const path = dir(), s = service(path), first = await prepared(s, token());
    const hash = chain.relay(first.transaction, { relayer });
    await s.report(first.id, { kind: 'HASH', hash }); chain.mine(2);
    const holder = await s.observe(first.id), next = { account: owner, chain: chainId, nonce: '0' };
    expect(relayedTransferNonceRelease(holder, next)).toEqual({ id: first.id, txHash: hash });
    expect(relayedTransferNonceRelease(holder, { ...next, nonce: '1' })).toBeNull();
    expect(relayedTransferNonceRelease(holder, { ...next, account: recipient })).toBeNull();
    expect(relayedTransferNonceRelease(holder, { ...next, chain: 'eip155:8453' })).toBeNull();
    expect(relayedTransferNonceRelease({ ...holder, verdict: 'DIVERGENT' }, next)).toBeNull();
    expect(relayedTransferNonceRelease({ ...holder, evidence: null }, next)).toBeNull();
    const direct = { ...holder, observations: holder.observations.map(o => {
      const facts = { ...o.facts! };
      delete facts.submission; delete facts.gasPayer;
      return { ...o, facts };
    }) };
    expect(relayedTransferNonceRelease(direct, next)).toBeNull();
  });
  it('a relayed native ETH transfer is not a shape FloFi reconciles: recorded as divergent, never a result', async () => {
    const s = service(), { id, transaction } = await prepared(s, native());
    await s.report(id, { kind: 'HASH', hash: chain.relay(transaction, { relayer }) }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_NATIVE_UNSUPPORTED', evidence: null });
  });
  it('an owner reviewed as a standard account is never reconciled from a relayed redemption', async () => {
    chain.state.codeOverride.delete(owner);
    const s = service(), { id, transaction } = await prepared(s, token());
    chain.state.codeOverride.set(owner, DESIGNATOR);
    await s.report(id, { kind: 'HASH', hash: chain.relay(transaction, { relayer }) }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_TRANSACTION_MISMATCH', evidence: null });
  });
  it('a reverted relay is divergent (never a result) and keeps the nonce reservation', async () => {
    const path = dir(), s = service(path), { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'HASH', hash: chain.relay(transaction, { relayer, reverted: true }) }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_SUBMISSION_REVERTED', evidence: null });
    const next = await s.simulate(token('2000000'), owner);
    await s.review(next.id, next.review.commitment, token('2000000'));
    await expect(s.begin(next.id, owner, token('2000000'))).rejects.toThrow('TRANSFER_NONCE_ALREADY_RESERVED');
  });
  it('a relay that also moved another asset of the owner is never reconciled', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    const hash = chain.relay(transaction, { relayer, extraLogs: [{ address: UNI.weth, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + owner.slice(2).padStart(64, '0'), '0x' + relayer.slice(2).padStart(64, '0')], data: '0x' + (1n).toString(16).padStart(64, '0') }] });
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_LOGS_MISMATCH', evidence: null });
  });
  it('credits one relayed transaction to one run only: another run reporting the same hash is divergent', async () => {
    const path = dir(), s = service(path), first = await prepared(s, token());
    // A second run of the identical call (prepared at another owner nonce) whose wallet later reports the first run's relayed hash.
    chain.state.nonces.set(owner, 1);
    const second = await prepared(s, token());
    chain.state.nonces.set(owner, 0);
    const hash = chain.relay(first.transaction, { relayer });
    await s.report(first.id, { kind: 'HASH', hash }); chain.mine(2);
    expect((await s.observe(first.id)).verdict).toBe('RECONCILED');
    await s.report(second.id, { kind: 'HASH', hash });
    expect(await s.observe(second.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_TRANSACTION_ALREADY_CLAIMED', evidence: null });
  });
  it('a relayed and a direct execution of the same reviewed transfer are a duplicate (paid twice): divergent, never reconciled', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    const relayed = chain.relay(transaction, { relayer });
    chain.apply(transaction);
    await s.report(id, { kind: 'HASH', hash: relayed }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_DUPLICATE_EXECUTION', evidence: null });
  });
  it('a direct execution whose call was also relayed is a duplicate, found from the direct receipt too', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    const direct = chain.apply(transaction);
    chain.relay(transaction, { relayer });
    await s.report(id, { kind: 'HASH', hash: direct }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_DUPLICATE_EXECUTION', evidence: null });
  });
  it('discovers a relayed submission whose wallet result was lost, without another wallet request', async () => {
    const path = dir(), s = service(path), { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'UNKNOWN' });
    expect((await s.observe(id)).error).toBe('TRANSFER_TRANSACTION_NOT_OBSERVED');
    const hash = chain.relay(transaction, { relayer }); chain.mine(2);
    const done = await service(path).observe(id);
    expect(done).toMatchObject({ verdict: 'RECONCILED', attempt: { transactionHash: hash } });
    expect(done.observations.at(-1)!.facts).toMatchObject({ submission: 'RELAYED', gasPayer: relayer, fee: '0' });
  });
  it('a lost result relayed in a shape FloFi does not reconcile (batched) is recorded as divergent, never adopted or ignored', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'UNKNOWN' });
    chain.relay(transaction, { relayer, batch: true }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_EXECUTION_UNSUPPORTED_SHAPE', evidence: null });
  });
  it('a wallet refusal that was in fact relayed is found before any new Review (no second authorization of the same transfer)', async () => {
    const path = dir(), s = service(path), run = await s.simulate(token(), owner);
    await s.review(run.id, run.review.commitment, token());
    const begun = await s.begin(run.id, owner, token()); await s.handoff(run.id);
    const send = { method: 'eth_sendTransaction', submission: true, error: { code: 4001 } };
    await s.walletFailure(run.id, { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [send] });
    chain.relay(begun.transaction, { relayer }); chain.mine(2);
    await expect(s.recoverReview(run.id)).rejects.toThrow('TRANSFER_REJECTED_ATTEMPT_EXECUTED');
    expect(await s.load(run.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_REJECTED_ATTEMPT_EXECUTED' });
    expect(intents(path)).toHaveLength(1);
  });
  it('a genuine wallet refusal by a Smart Account can still be reviewed again at the same nonce', async () => {
    const s = service(), run = await s.simulate(token(), owner);
    await s.review(run.id, run.review.commitment, token());
    await s.begin(run.id, owner, token()); await s.handoff(run.id);
    const send = { method: 'eth_sendTransaction', submission: true, error: { code: 4001 } };
    await s.walletFailure(run.id, { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [send] });
    const fresh = await s.recoverReview(run.id);
    expect(fresh).toMatchObject({ recoveryOf: run.id, review: { nonce: '0', state: { ownerDelegation: MOCK_DELEGATOR_IMPL } } });
  });
  it('a refused native transfer is not "executed" because of an unrelated relay: it can be reviewed again', async () => {
    const s = service(), run = await s.simulate(native(), owner);
    await s.review(run.id, run.review.commitment, native());
    await s.begin(run.id, owner, native()); await s.handoff(run.id);
    await s.walletFailure(run.id, { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    chain.relay({ from: owner, to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + relayer.slice(2).padStart(64, '0') + (7n).toString(16).padStart(64, '0') }, { relayer }); chain.mine(2);
    expect(await s.recoverReview(run.id)).toMatchObject({ recoveryOf: run.id });
  });
  it('a refused transfer relayed only after its recovery Review is found again before the recovery run reserves or asks the wallet', async () => {
    const path = dir(), s = service(path), run = await s.simulate(token(), owner);
    await s.review(run.id, run.review.commitment, token());
    const begun = await s.begin(run.id, owner, token()); await s.handoff(run.id);
    await s.walletFailure(run.id, { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    const fresh = await s.recoverReview(run.id);
    chain.relay(begun.transaction, { relayer }); chain.mine(3);
    await s.review(fresh.id, fresh.review.commitment, token());
    await expect(s.begin(fresh.id, owner, token())).rejects.toThrow('TRANSFER_REJECTED_ATTEMPT_EXECUTED');
    // Recorded on the recovery Review: no longer authorized, so a repeated Execute never scans again or reaches the wallet.
    expect(await s.load(fresh.id)).toMatchObject({ attempt: null, authorization: null, error: 'TRANSFER_REJECTED_ATTEMPT_EXECUTED', relayedExecutions: [expect.any(String)] });
    await expect(s.begin(fresh.id, owner, token())).rejects.toThrow('TRANSFER_REVIEW_REQUIRED');
    expect(intents(path)).toHaveLength(1);
  });
  it('a refused transfer relayed after the recovery run began is a duplicate of the recovery run\'s own execution (scans start at the first attempt)', async () => {
    const s = service(), run = await s.simulate(token(), owner);
    await s.review(run.id, run.review.commitment, token());
    const begun = await s.begin(run.id, owner, token()); await s.handoff(run.id);
    await s.walletFailure(run.id, { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    const fresh = await s.recoverReview(run.id);
    await s.review(fresh.id, fresh.review.commitment, token());
    const next = await s.begin(fresh.id, owner, token()); await s.handoff(fresh.id);
    chain.relay(begun.transaction, { relayer });
    await s.report(fresh.id, { kind: 'HASH', hash: chain.apply(next.transaction) }); chain.mine(2);
    expect(await s.observe(fresh.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_DUPLICATE_EXECUTION', evidence: null });
  });
  it('a lost result whose nonce another transaction used is not called "can never execute" while a relay could still land', async () => {
    const s = service(), { id } = await prepared(s, token());
    await s.report(id, { kind: 'UNKNOWN' });
    // The owner's wallet uses nonce 0 for something else; no relay of the reviewed call exists.
    chain.apply({ from: owner, to: recipient, value: '0x1', data: '0x' }); chain.mine(2);
    // MetaMask may still relay shortly after: within the settle window the run stays observable.
    expect(await s.observe(id)).toMatchObject({ verdict: 'PENDING', error: 'TRANSFER_RELAYED_EXECUTION_PENDING' });
    now += 11 * 60_000;
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_NONCE_USED_RELAY_NOT_FOUND', evidence: null });
  });
  it('a reported relay hash mined before preparation is a mismatch, never a provider error that keeps the nonce forever', async () => {
    const s = service();
    const earlier = chain.relay({ from: owner, to: UNI.usdc, value: '0x0', data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + (1_000_000n).toString(16).padStart(64, '0') }, { relayer });
    chain.mine(1);
    const { id } = await prepared(s, token());
    await s.report(id, { kind: 'HASH', hash: earlier }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_BLOCK_MISMATCH', evidence: null });
  });
  it('a hash from another sender that is not a Delegation Manager redemption is a plain mismatch, not called a relay', async () => {
    const s = service(), { id } = await prepared(s, native());
    const other = chain.apply({ from: relayer, to: recipient, value: '0x2386f26fc10000', data: '0x' }); chain.mine(2);
    await s.report(id, { kind: 'HASH', hash: other });
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_TRANSACTION_MISMATCH', evidence: null });
  });
  it('the reconciler looks for other redemptions with the Delegation Manager\'s real RedeemedDelegation topic', () => {
    expect(erc7710.REDEEMED_DELEGATION_TOPIC).toBe('0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873');
  });
  // Second review round.
  const fail4001 = { invoked: true, rejectionCode: 4001, code: 'TRANSFER_REJECTED', calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] };
  const wethTransfer = (to: string, amount: bigint) => ({ from: owner, to: UNI.weth, value: '0x0', data: '0xa9059cbb' + to.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0') });
  it('a divergence found while the browser never reported (attempt still SUBMITTING) is recorded, never an invalid transition', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    expect((await s.load(id)).attempt?.state).toBe('SUBMITTING');
    chain.relay(transaction, { relayer, batch: true }); chain.mine(2);
    const done = await s.observe(id);
    expect(done).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_EXECUTION_UNSUPPORTED_SHAPE', attempt: { state: 'RECONCILIATION_REQUIRED' } });
    expect(done.relayedExecutions).toHaveLength(1);
  });
  it('another token or a WETH transfer to the same recipient and amount is never taken for the reviewed call (exact decoding)', async () => {
    chain.fund(UNI.weth, owner, 10n ** 18n);
    const s = service(), token1 = await prepared(s, token());
    chain.relay(wethTransfer(recipient, 1_000_000n), { relayer });
    await s.report(token1.id, { kind: 'HASH', hash: chain.apply(token1.transaction) }); chain.mine(2);
    expect(await s.observe(token1.id)).toMatchObject({ verdict: 'RECONCILED', error: null });
    const eth = await prepared(s, native());
    chain.relay(wethTransfer(recipient, 10_000_000_000_000_000n), { relayer });
    await s.report(eth.id, { kind: 'HASH', hash: chain.apply(eth.transaction) }); chain.mine(2);
    expect(await s.observe(eth.id)).toMatchObject({ verdict: 'RECONCILED', error: null });
  });
  it.each([[false], [true]] as const)('a lost native transfer that MetaMask relayed (batch mode: %s) is found by the scan and recorded, never ignored', async batch => {
    const s = service(), { id, transaction } = await prepared(s, native());
    await s.report(id, { kind: 'UNKNOWN' });
    chain.relay(transaction, { relayer, batch }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_RELAYED_EXECUTION_UNSUPPORTED_SHAPE', evidence: null });
  });
  it('a refusal that was relayed is found for a native transfer too, before any new Review', async () => {
    const s = service(), run = await s.simulate(native(), owner);
    await s.review(run.id, run.review.commitment, native());
    const begun = await s.begin(run.id, owner, native()); await s.handoff(run.id);
    await s.walletFailure(run.id, fail4001);
    chain.relay(begun.transaction, { relayer }); chain.mine(2);
    await expect(s.recoverReview(run.id)).rejects.toThrow('TRANSFER_REJECTED_ATTEMPT_EXECUTED');
    expect((await s.load(run.id)).relayedExecutions).toHaveLength(1);
  });
  it('a node that serves the receipt but not the transaction keeps the scan pending, never "complete and empty"', async () => {
    let hide: string | null = null;
    const rpc: typeof chain.rpc = async (method, params) => method === 'eth_getTransactionByHash' && params[0] === hide ? null : chain.rpc(method, params);
    const s = createRobinhoodTransferService({ rpcs: { [chainId]: rpc }, idPrefix: 'art', journalDir: dir(), now: () => now, provenance: 'MOCKED',
      catalogFor: async () => catalog, executionEnabled: true });
    const { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'UNKNOWN' });
    hide = chain.relay(transaction, { relayer }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'PENDING', error: 'TRANSFER_RELAYED_EXECUTION_PENDING' });
    hide = null;
    expect(await s.observe(id)).toMatchObject({ verdict: 'RECONCILED' });
  });
  it('a provider whose log index lags (no RedeemedDelegation for the relay itself) decides nothing about the balance proof', async () => {
    let lag = false;
    const rpc: typeof chain.rpc = async (method, params) => lag && method === 'eth_getLogs' && (params[0] as { fromBlock?: string; toBlock?: string }).fromBlock === (params[0] as { toBlock?: string }).toBlock ? [] : chain.rpc(method, params);
    const s = createRobinhoodTransferService({ rpcs: { [chainId]: rpc }, idPrefix: 'art', journalDir: dir(), now: () => now, provenance: 'MOCKED',
      catalogFor: async () => catalog, executionEnabled: true });
    const { id, transaction } = await prepared(s, token());
    const hash = chain.relay(transaction, { relayer });
    chain.state.balances.set(`${UNI.usdc}:${owner}`, chain.balance(UNI.usdc, owner) - 7n); // not exactly this transfer's balance change
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    lag = true;
    expect(await s.observe(id)).toMatchObject({ verdict: 'PENDING', error: 'TRANSFER_RPC_INVALID' });
  });
  it('an inconsistent owner nonce (moved without a transaction of the owner) is retried, then treated as another use after the settle window', async () => {
    const s = service(), { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'UNKNOWN' });
    chain.mine(1); chain.state.nonces.set(owner, 1); chain.mine(2); // e.g. an EIP-7702 authorization of the account
    expect(await s.observe(id)).toMatchObject({ verdict: 'PENDING', error: 'TRANSFER_RELAYED_EXECUTION_PENDING' });
    const hash = chain.relay(transaction, { relayer }); chain.mine(2);
    // The relay is found; its duplicate check waits out the settle window before trusting the inconsistent nonce read.
    expect(await s.observe(id)).toMatchObject({ verdict: 'PENDING', attempt: { transactionHash: hash }, error: 'TRANSFER_RELAYED_EXECUTION_PENDING' });
    now += 11 * 60_000;
    expect(await s.observe(id)).toMatchObject({ verdict: 'RECONCILED' });
  });
  it('a direct native transfer whose receipt carries a Delegation Manager redemption (a contract recipient redeeming the owner) is never reconciled', async () => {
    const s = service(), { id, transaction } = await prepared(s, native());
    const hash = chain.apply(transaction, { extraLogs: [{ address: MOCK_DELEGATION_MANAGER, topics: ['0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873',
      '0x' + owner.slice(2).padStart(64, '0'), '0x' + recipient.slice(2).padStart(64, '0')], data: '0x' }] });
    await s.report(id, { kind: 'HASH', hash }); chain.mine(2);
    expect(await s.observe(id)).toMatchObject({ verdict: 'DIVERGENT', error: 'TRANSFER_LOGS_MISMATCH', evidence: null });
  });
  it('no relay scan or claim for a standard account (EOA) transfer: its reconciliation is unchanged', async () => {
    chain.state.codeOverride.delete(owner);
    const path = dir(), s = service(path), { id, transaction } = await prepared(s, token());
    await s.report(id, { kind: 'HASH', hash: chain.apply(transaction) }); chain.mine(2);
    const done = await s.observe(id);
    expect(done.verdict).toBe('RECONCILED');
    expect(done.observations.at(-1)!.facts).not.toHaveProperty('ownerDelegation');
    expect(limitations(done)).not.toContain('MetaMask Smart Account');
    expect(readdirSync(path).some(name => name.startsWith('claim-'))).toBe(false);
    expect(existsSync(join(path, `eip155-42161-${owner}-0.intent`))).toBe(true);
  });
});
