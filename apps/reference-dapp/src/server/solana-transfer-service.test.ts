// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMockedSolanaTransferChain, createMockedSolanaWallet, MOCKED_RENT, type MockedTransferOptions } from '@defi-workflow-engine/reference-compiler';
import { SOLANA_MAINNET_TOKENS, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { createSolanaTransferNode, type SemanticWorkflow, type SolanaTransferToken } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaTransferService } from './solana-transfer-service';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';

/** MOCKED certification of the full owner lifecycle (deterministic in-memory cluster, disposable keys); nothing reaches a public network. */
const USDC = SOLANA_MAINNET_TOKENS.USDC, usdc: SolanaTransferToken = { mint: USDC.mint, decimals: 6, program: 'spl-token' };
const workflow = (recipient: string, amount: string, token: SolanaTransferToken | null = null): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-transfer',
  revision: 1, resourceEdges: [], nodes: [createSolanaTransferNode('node-002', { chain: SOLANA_MAINNET_TRANSFER.chain, amount, recipient, token })] });
async function setup(options: MockedTransferOptions = {}, service: { executionEnabled?: boolean; provenance?: 'MOCKED' | 'PUBLIC_MAINNET' } = {}) {
  const chain = createMockedSolanaTransferChain(options), wallet = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
  chain.fundWallet(wallet.owner, 2_000_000_000n); chain.fundWallet(recipient, 3_000_000n); chain.createMint(USDC.mint, { decimals: 6 });
  chain.fundToken(wallet.owner, USDC.mint, 40_000_000n);
  const dir = await mkdtemp(join(tmpdir(), 'flofi-solana-transfer-'));
  let clock = Date.parse('2026-10-17T12:00:00.000Z');
  const fault = { method: '', malformed: false };
  const make = () => createSolanaTransferService({ profile: SOLANA_MAINNET_TRANSFER, rpc: async (method, params) => {
    if (fault.method === method) { if (fault.malformed) return { value: [] }; throw new Error('SOLANA_RPC_UNAVAILABLE'); }
    return chain.rpc(method, params);
  }, journalDir: dir, provenance: service.provenance ?? 'MOCKED',
    executionEnabled: service.executionEnabled ?? true, now: () => clock });
  return { chain, wallet, recipient, service: make(), make, fault, dir, tick: (ms: number) => { clock += ms; } };
}
type Env = Awaited<ReturnType<typeof setup>>;
async function reviewed(s: Env, wf: SemanticWorkflow) {
  const simulated = await s.service.simulate(wf, s.wallet.owner);
  return s.service.review(simulated.id, simulated.review.commitment, wf);
}

describe('Solana transfer service lifecycle', () => {
  it('never hands the same reviewed message to the wallet for two runs, even while the first is between its claim and PREPARED', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000');
    // Same workflow, same blockhash: byte-identical messages, i.e. one Solana transaction that could land only once.
    const a = await reviewed(s, wf), b = await reviewed(s, wf);
    expect(b.review.messageHash).toBe(a.review.messageHash);
    const storage = createFileExecutionStorage(s.dir, 'SOLANA_TRANSFER_BUSY');
    let pause!: () => void, resume!: () => void;
    const paused = new Promise<void>(resolve => { pause = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    const slow = createSolanaTransferService({ profile: SOLANA_MAINNET_TRANSFER, rpc: s.chain.rpc, provenance: 'MOCKED', executionEnabled: true,
      now: () => Date.parse('2026-10-17T12:00:00.000Z'), storage: { ...storage, log: { ...storage.log, extend: async (name, bytes, validate) => {
        if (name === `${a.id}.jsonl` && JSON.parse(new TextDecoder().decode(bytes).trimEnd().split('\n').at(-1)!).attempt?.state === 'PREPARED') {
          pause(); await resumed;
        }
        return storage.log.extend(name, bytes, validate);
      } } } });
    const first = slow.begin(a.id, s.wallet.owner, wf);
    await paused;
    let second: unknown;
    try { second = await s.make().begin(b.id, s.wallet.owner, wf).catch(error => error); }
    finally { resume(); }
    await first;
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toMatch(/SOLANA_TRANSFER_(BUSY|DUPLICATE_TRANSACTION_SIMULATE_AGAIN)/);
    expect((await s.service.load(a.id)).attempt?.state).toBe('PREPARED');
    expect((await s.service.load(b.id)).attempt).toBeNull();
    await expect(s.service.begin(b.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_DUPLICATE_TRANSACTION_SIMULATE_AGAIN');
    // The intentional identical transfer: a fresh Simulate on a new blockhash is a separate transaction, prepared while the first is pending.
    s.chain.advance(1);
    const c = await reviewed(s, wf);
    expect(c.review.messageHash).not.toBe(a.review.messageHash);
    expect((await s.service.begin(c.id, s.wallet.owner, wf)).record.attempt?.state).toBe('PREPARED');
    expect(s.chain.state.sent).toHaveLength(0);
  });
  it('re-verifies the RPC cluster before the wallet request and before broadcasting reviewed bytes', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    s.fault.method = 'getGenesisHash'; s.fault.malformed = true;
    await expect(s.service.begin(record.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_WRONG_CLUSTER');
    expect((await s.service.load(record.id)).attempt).toBeNull();
    s.fault.method = '';
    const begun = await s.service.begin(record.id, s.wallet.owner, wf);
    s.fault.method = 'getGenesisHash';
    expect(await s.service.submit(record.id, s.wallet.sign(begun.unsignedTransaction))).toMatchObject({ notSubmitted: true, error: 'SOLANA_TRANSFER_WRONG_CLUSTER' });
    expect(s.chain.state.sent).toHaveLength(0);
  });
  it('SOL to another wallet: Review, durable PREPARED before signing, one broadcast, finality and independent reconciliation with evidence', async () => {
    const s = await setup(), wf = workflow(s.recipient, '250000000');
    const simulated = await s.service.simulate(wf, s.wallet.owner);
    expect(simulated).toMatchObject({ format: 'gryloo.solana-transfer-run.v1', authorization: null, attempt: null, evidenceClass: 'MOCKED' });
    expect(simulated.id).toMatch(/^soltx-[a-f0-9]{32}$/);
    await expect(s.service.begin(simulated.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_REVIEW_REQUIRED');
    const record = await s.service.review(simulated.id, simulated.review.commitment, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    expect(begin.walletChain).toBe('solana:mainnet');
    expect((await s.service.load(record.id)).attempt?.state).toBe('PREPARED');
    expect(s.chain.state.sent).toEqual([]);
    const submitted = await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(submitted.attempt).toMatchObject({ state: 'PENDING' });
    expect(s.chain.state.sent).toHaveLength(1);
    const observed = await s.service.observe(record.id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED', reconciled: true } });
    expect(observed.observations.at(-1)).toMatchObject({ verdict: 'RECONCILED', amountSent: '250000000', amountReceived: '250000000', accountCreationLamports: '0' });
    expect(observed.observations.at(-1)!.explorer).toBe(`https://solscan.io/tx/${observed.attempt!.signature}`);
    expect(observed.evidence).toMatchObject({ bundle: { environment: 'MOCKED', outcome: 'RECONCILED' }, evidenceClass: 'MOCKED' });
    expect(s.chain.lamports(s.recipient)).toBe(3_000_000n + 250_000_000n);
    // A later observation never resends.
    await s.service.observe(record.id); expect(s.chain.state.sent).toHaveLength(1);
  });
  it('USDC to a new recipient account: the reviewed deposit is bounded and the actual token movement reconciled', async () => {
    const s = await setup(), wf = workflow(s.recipient, '12000000', usdc);
    const record = await reviewed(s, wf);
    expect(record.review.token).toMatchObject({ createDestination: true });
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    const observed = await s.service.observe(record.id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED' });
    expect(observed.observations.at(-1)).toMatchObject({ amountSent: '12000000', amountReceived: '12000000', accountCreationLamports: String(MOCKED_RENT.token),
      token: { sourceBefore: '40000000', sourceAfter: '28000000', destinationBefore: '0', destinationAfter: '12000000' } });
    expect(s.chain.tokenAccount(s.chain.ata(s.recipient, USDC.mint))).toMatchObject({ owner: s.recipient, amount: 12_000_000n });
  });
  it('USDC to an existing recipient account created after Review still reconciles, without charging a deposit', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000', usdc);
    const record = await reviewed(s, wf);
    s.chain.fundToken(s.recipient, USDC.mint, 5n);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect((await s.service.observe(record.id)).observations.at(-1)).toMatchObject({ verdict: 'RECONCILED', accountCreationLamports: '0',
      token: { destinationBefore: '5', destinationAfter: '1000005' } });
    expect((await s.service.load(record.id)).evidence?.publicExecution).toMatchObject({ destinationCreated: false });
  });
  it('refuses an ATA reassigned while the wallet prompt was open, without transferring tokens to the new owner', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000', usdc);
    const destination = s.chain.fundToken(s.recipient, USDC.mint, 0n), record = await reviewed(s, wf);
    const begun = await s.service.begin(record.id, s.wallet.owner, wf);
    s.chain.fundToken(s.recipient, USDC.mint, 0n, { tokenOwner: createMockedSolanaWallet().owner });
    await s.service.submit(record.id, s.wallet.sign(begun.unsignedTransaction));
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'SOLANA_TRANSFER_TRANSFER_FAILED', evidence: null });
    expect(s.chain.tokenAccount(destination)?.amount).toBe(0n);
  });
  it('bounds and reconciles the rent if an existing ATA closes while the wallet prompt is open', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000', usdc);
    const destination = s.chain.fundToken(s.recipient, USDC.mint, 0n), record = await reviewed(s, wf);
    expect(record.review.accountCreationLamports).toBe('0');
    const begun = await s.service.begin(record.id, s.wallet.owner, wf);
    s.chain.state.current.tokens.delete(destination); s.chain.state.current.lamports.delete(destination);
    await s.service.submit(record.id, s.wallet.sign(begun.unsignedTransaction));
    const final = await s.service.observe(record.id);
    expect(final).toMatchObject({ verdict: 'RECONCILED' });
    expect(final.observations.at(-1)).toMatchObject({ accountCreationLamports: String(MOCKED_RENT.token), amountReceived: '1000000' });
    expect(final.evidence?.publicExecution).toMatchObject({ destinationCreated: true });
  });
  it('a wallet rejection records that nothing was sent; a fresh simulation is required', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    await s.service.begin(record.id, s.wallet.owner, wf);
    const failed = await s.service.walletFailure(record.id, { stage: 'SIGN', code: 'SOLANA_TRANSFER_WALLET_REJECTED', error: { code: 4001 } });
    expect(failed).toMatchObject({ notSubmitted: true, authorization: null, attempt: { state: 'CANCELLED' }, error: 'SOLANA_TRANSFER_WALLET_REJECTED' });
    expect(s.chain.state.sent).toEqual([]);
    await expect(s.service.begin(record.id, s.wallet.owner, wf)).rejects.toThrow(/SOLANA_TRANSFER_(REVIEW_REQUIRED|EXISTING_ATTEMPT_OBSERVE_ONLY)/);
    // The owner lease is released by the resolved attempt: a fresh run can proceed.
    const again = await reviewed(s, wf);
    await expect(s.service.begin(again.id, s.wallet.owner, wf)).resolves.toBeTruthy();
  });
  it('refuses changed bytes and another signer before any broadcast', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    await s.service.begin(record.id, s.wallet.owner, wf);
    const refused = await s.service.submit(record.id, createMockedSolanaWallet().sign(record.review.unsignedTransaction));
    expect(refused).toMatchObject({ notSubmitted: true, error: 'SOLANA_TRANSFER_SIGNATURE_INVALID', attempt: { state: 'CANCELLED' } });
    expect(s.chain.state.sent).toEqual([]);
  });
  it('an expired blockhash is refused before broadcast; Review expiry blocks begin', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    s.chain.advance(200);
    expect(await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction))).toMatchObject({ notSubmitted: true, error: 'SOLANA_TRANSFER_REVIEW_EXPIRED' });
    const late = await reviewed(s, wf);
    s.tick(61_000);
    await expect(s.service.begin(late.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_REVIEW_EXPIRED');
  });
  it('an uncertain submission that landed is resolved by its signature, never resent', async () => {
    const s = await setup({ send: 'RPC_ERROR_AFTER_LANDING' }), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    const submitted = await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(submitted).toMatchObject({ attempt: { state: 'SUBMISSION_RESULT_UNKNOWN' }, error: 'SOLANA_TRANSFER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING' });
    expect((await s.service.observe(record.id))).toMatchObject({ verdict: 'RECONCILED' });
    expect(s.chain.state.sent).toHaveLength(1);
  });
  it('an uncertain submission that never landed becomes NOT_EXECUTED only after the blockhash can no longer land', async () => {
    const s = await setup({ send: 'RPC_ERROR_DROPPED' }), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'PENDING', error: 'SOLANA_TRANSFER_TRANSACTION_NOT_OBSERVED' });
    s.chain.advance(160);
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'NOT_EXECUTED', error: 'SOLANA_TRANSFER_TRANSACTION_EXPIRED_NOT_EXECUTED', attempt: { state: 'NOT_FOUND' } });
    expect(s.chain.lamports(s.recipient)).toBe(3_000_000n);
  });
  it('waits for finality before reconciling', async () => {
    const s = await setup({ confirmationDelay: 32 }), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'PENDING', error: 'AWAITING_FINALITY' });
    s.chain.advance(32);
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'RECONCILED' });
  });
  it.each([false, true])('never treats an unavailable/malformed history lookup as absence after expiry (malformed=%s)', async malformed => {
    const s = await setup({ send: 'RPC_ERROR_AFTER_LANDING' }), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf), begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    s.chain.advance(200); s.fault.method = 'getSignatureStatuses'; s.fault.malformed = malformed;
    expect(await s.make().observe(record.id)).toMatchObject({ verdict: 'PENDING', attempt: { state: 'SUBMISSION_RESULT_UNKNOWN' } });
    // The uncertain transfer keeps being observed by its own signature; an independent transfer is not blocked by it.
    const other = await reviewed(s, wf);
    expect((await s.service.begin(other.id, s.wallet.owner, wf)).record.attempt?.state).toBe('PREPARED');
    s.fault.method = '';
    expect(await s.make().observe(record.id)).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    expect((await s.service.load(other.id)).attempt).toMatchObject({ state: 'PREPARED', signature: null });
    await expect(s.make().submit(record.id, s.wallet.sign(begin.unsignedTransaction))).rejects.toThrow('SOLANA_TRANSFER_WALLET_HANDOFF_NOT_AUTHORIZED');
    expect(s.chain.state.sent).toHaveLength(1);
  });
  it('requires a successful cluster identity check before deciding an expired signature is absent', async () => {
    const options: MockedTransferOptions = { send: 'RPC_ERROR_DROPPED' }, s = await setup(options), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf), begin = await s.service.begin(record.id, s.wallet.owner, wf);
    await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    s.chain.advance(200); options.genesisHash = 'another-cluster';
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'PENDING', error: 'SOLANA_WRONG_CLUSTER' });
    delete options.genesisHash;
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'NOT_EXECUTED' });
  });
  it('keeps a divergent transfer for human reconciliation while an independent transfer proceeds', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000'), record = await reviewed(s, wf);
    const begin = await s.service.begin(record.id, s.wallet.owner, wf);
    const sent = await s.service.submit(record.id, s.wallet.sign(begin.unsignedTransaction));
    const landed = s.chain.state.transactions.get(sent.attempt!.signature!)!;
    landed.post[landed.keys.indexOf(s.recipient)]! += 1n;
    expect(await s.service.observe(record.id)).toMatchObject({ verdict: 'DIVERGENT', attempt: { state: 'RECONCILIATION_REQUIRED' } });
    // The same message can never be taken over: it was signed and landed, and stays bound to the divergent run.
    const same = await reviewed(s, wf);
    await expect(s.service.begin(same.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_DUPLICATE_TRANSACTION_SIMULATE_AGAIN');
    s.chain.advance(1);
    const other = await reviewed(s, wf), next = await s.service.begin(other.id, s.wallet.owner, wf);
    expect((await s.service.submit(other.id, s.wallet.sign(next.unsignedTransaction))).attempt?.state).toBe('PENDING');
    expect(await s.service.observe(other.id)).toMatchObject({ verdict: 'RECONCILED' });
    expect(await s.service.load(record.id)).toMatchObject({ verdict: 'DIVERGENT', attempt: { state: 'RECONCILIATION_REQUIRED' } });
    expect(s.chain.state.sent).toHaveLength(2);
  });
  it('recovers a message claim persisted before PREPARED without producing a duplicate attempt', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000'), record = await reviewed(s, wf);
    // A crash between the durable claim and PREPARED; a pre-hotfix owner lease file is simply ignored.
    await writeFile(join(s.dir, `${record.review.messageHash.slice(2)}.soltx-message`), record.id + '\n');
    await writeFile(join(s.dir, `${s.wallet.owner}.soltx-lease`), createMockedSolanaWallet().owner + '\n');
    expect((await s.make().begin(record.id, s.wallet.owner, wf)).record.attempt?.state).toBe('PREPARED');
    await expect(s.make().begin(record.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY');
    expect(s.chain.state.sent).toHaveLength(0);
  });
  it('re-checks balances before the wallet is asked; independent transfers of the same owner are prepared side by side', async () => {
    const s = await setup(), wf = workflow(s.recipient, '1000000', usdc);
    const record = await reviewed(s, wf);
    // The tokens moved elsewhere after Review: nothing is prepared or signed.
    s.chain.tokenAccount(s.chain.ata(s.wallet.owner, USDC.mint))!.amount = 10n;
    await expect(s.service.begin(record.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_INSUFFICIENT_TOKEN_BALANCE');
    s.chain.tokenAccount(s.chain.ata(s.wallet.owner, USDC.mint))!.amount = 40_000_000n;
    const first = await reviewed(s, workflow(s.recipient, '1000')), second = await reviewed(s, workflow(s.recipient, '2000'));
    const one = await s.service.begin(first.id, s.wallet.owner, workflow(s.recipient, '1000'));
    const two = await s.service.begin(second.id, s.wallet.owner, workflow(s.recipient, '2000'));
    // Both signed and broadcast while neither is final: two distinct signatures, each reconciled by its own run.
    const a = await s.service.submit(first.id, s.wallet.sign(one.unsignedTransaction)), b = await s.service.submit(second.id, s.wallet.sign(two.unsignedTransaction));
    expect([a.attempt?.state, b.attempt?.state]).toEqual(['PENDING', 'PENDING']);
    expect(a.attempt?.signature).not.toBe(b.attempt?.signature);
    expect((await s.service.observe(second.id)).observations.at(-1)).toMatchObject({ verdict: 'RECONCILED', signature: b.attempt?.signature, amountSent: '2000', amountReceived: '2000' });
    expect((await s.service.observe(first.id)).observations.at(-1)).toMatchObject({ verdict: 'RECONCILED', signature: a.attempt?.signature, amountSent: '1000', amountReceived: '1000' });
  });
  it('refuses the wrong wallet and keeps real-funds execution behind the deployment opt-in', async () => {
    const s = await setup({}, { executionEnabled: false }), wf = workflow(s.recipient, '1000000');
    const record = await reviewed(s, wf);
    await expect(s.service.begin(record.id, s.wallet.owner, wf)).rejects.toThrow('SOLANA_TRANSFER_MAINNET_EXECUTION_NOT_ENABLED');
    const enabled = s.make();
    void enabled;
    const t = await setup(), other = createMockedSolanaWallet().owner;
    const reviewedRun = await reviewed(t, wf);
    await expect(t.service.begin(reviewedRun.id, other, wf)).rejects.toThrow(/SOLANA_TRANSFER_(WRONG_OWNER|SEMANTIC_REVISION_CHANGED|RECIPIENT_IS_SENDER)/);
  });
  it('rejects a store with another provenance and only simulates its own cluster', async () => {
    const s = await setup();
    await expect(s.service.simulate({ ...workflow(s.recipient, '1'), nodes: [createSolanaTransferNode('node-002', { chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', amount: '1000000', recipient: s.recipient, token: null })] },
      s.wallet.owner)).rejects.toThrow('SOLANA_TRANSFER_NETWORK_UNSUPPORTED');
    expect(() => createSolanaTransferService({ profile: SOLANA_MAINNET_TRANSFER, rpc: s.chain.rpc, journalDir: '/tmp/x', provenance: 'PUBLIC_DEVNET', executionEnabled: true }))
      .toThrow('SOLANA_TRANSFER_PROVENANCE_INVALID');
  });
});
