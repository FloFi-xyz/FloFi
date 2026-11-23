// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { createErc4626DepositNode, hashJournalBytes, hashSupplyValue, supplyAddress, type ExecutionJournal,
  type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { assertFreshErc4626Deposit, fromHex, rpcHash, rpcRecord, supplyArtifactHash, supplyCall, supplyWord, toHex, simulateErc4626Deposit,
  type Erc4626DepositProfile, type SupplyRpc } from '@defi-workflow-engine/reference-compiler';
import { createAttemptCoordinator, transitionAttemptState, type Attempt } from '../../reference-executor/src/attempts.js';
import { appendJournalState, createJournal } from '../../reference-executor/src/journal.js';
import { reconcileErc4626Deposit } from '../src/erc4626-deposit.js';

const chain = 'eip155:31337', amount = 1_000_000n, minShares = 1_950_000n;

async function withAnvil(test: (rpc: SupplyRpc) => Promise<void>): Promise<void> {
  const binary = process.env.GRYLOO_ANVIL_BIN;
  if (!binary || basename(binary) !== 'anvil' || basename(dirname(binary)) !== 'foundry-v1.8.3')
    throw new Error('GRYLOO_ANVIL_BIN must name the verified foundry-v1.8.3/anvil binary');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const bound = reservation.address();
  if (!bound || typeof bound === 'string') throw new Error('LOOPBACK_PORT_UNAVAILABLE');
  const port = bound.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '2', '--silent'], { stdio: 'ignore' });
  const ended = once(child, 'exit');
  void ended.catch(() => {});
  const rpc: SupplyRpc = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!response.ok) throw new Error('LOOPBACK_RPC_INVALID');
    const body = rpcRecord(await response.json());
    if (body.error) throw new Error(String(rpcRecord(body.error).message));
    return body.result;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('LOOPBACK_ANVIL_EXITED');
      if (await rpc('eth_chainId', []).catch(() => null) === '0x7a69') { ready = true; break; }
      await sleep(25);
    }
    if (!ready) throw new Error('LOOPBACK_ANVIL_UNAVAILABLE');
    await test(rpc);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  }
}

async function deployFixture(rpc: SupplyRpc) {
  // Reproduce the two deployment byte strings with official solc 0.8.30:
  // --evm-version cancun --optimize --metadata-hash none --combined-json bin
  const fixture = JSON.parse(await readFile(new URL('./testdata/erc4626-bounded-fixture.json', import.meta.url), 'utf8')) as { asset: string; vault: string };
  const accounts = await rpc('eth_accounts', []) as string[];
  const [owner, other] = accounts.map(supplyAddress);
  const localWallet = async (tx: Record<string, string>) => {
    const hash = rpcHash(await rpc('eth_sendTransaction', [tx]));
    for (let attempt = 0; attempt < 80; attempt++) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt !== null) return { hash, receipt: rpcRecord(receipt) };
      await sleep(25);
    }
    throw new Error('LOOPBACK_TRANSACTION_INCLUSION_TIMEOUT');
  };
  const deploy = async (data: string) => supplyAddress(String((await localWallet({ from: owner!, data })).receipt.contractAddress));
  const underlying = await deploy(fixture.asset), vault = await deploy(fixture.vault + supplyWord(underlying));
  const digest = async (address: string) => toHex(keccak_256(fromHex(String(await rpc('eth_getCode', [address, 'latest'])))));
  const profile: Erc4626DepositProfile = { chain, vault, underlying, assetDecimals: 6, shareDecimals: 6,
    certificationDigest: hashSupplyValue({ chain, vault, underlying, fixture: true }), vaultCodeHash: await digest(vault),
    underlyingCodeHash: await digest(underlying), genesisHash: rpcHash(rpcRecord(await rpc('eth_getBlockByNumber', ['0x0', false])).hash),
    maximumAssets: '1000000', maximumGasCost: '100000000000000000', maximumSlippageBps: 300,
    nativeSymbol: 'ETH', minimumConfirmations: 2, gasModel: 'EIP1559_EXECUTION_ONLY' };
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'test-vault', revision: 1, resourceEdges: [],
    nodes: [createErc4626DepositNode('test-deposit', { ...profile, amount: amount.toString(), minimumShares: minShares.toString() })] };
  const approve = (value: bigint) => localWallet({ from: owner!, to: underlying, data: supplyCall('approve(address,uint256)', vault, value) });
  const setOffer = (value: bigint) => localWallet({ from: other!, to: vault, data: supplyCall('setOffer(uint256)', value) });
  return { owner: owner!, other: other!, workflow, profile, approve, localWallet, setOffer };
}

describe('ERC-4626 bounded deposit on disposable Anvil', () => {
  it('uses canonical Review, exact owner transaction, durable attempt and independent receipt reconciliation', async () => {
    await withAnvil(async rpc => {
      const { owner, other, workflow, profile, approve, localWallet, setOffer } = await deployFixture(rpc);
      const simulate = () => simulateErc4626Deposit(workflow, profile, owner, rpc);
      await expect(simulate()).rejects.toThrow('VAULT_EXACT_ALLOWANCE_REQUIRED');
      await approve(amount + 1n);
      await expect(simulate()).rejects.toThrow('VAULT_EXACT_ALLOWANCE_REQUIRED');
      await approve(amount);
      await expect(simulateErc4626Deposit(workflow, { ...profile, vaultCodeHash: '0x' + '0'.repeat(64) }, owner, rpc))
        .rejects.toThrow('VAULT_DEPLOYMENT_MISMATCH');
      await expect(simulateErc4626Deposit(workflow, profile, owner, (method, args) => method === 'eth_chainId' ? Promise.resolve('0x1') : rpc(method, args)))
        .rejects.toThrow('VAULT_WRONG_CHAIN');

      const beforeSlippage = await simulate();
      await expect(assertFreshErc4626Deposit(beforeSlippage, profile, beforeSlippage.commitment, other, rpc)).rejects.toThrow('VAULT_REVIEW_REQUIRED');
      await setOffer(1n);
      await expect(assertFreshErc4626Deposit(beforeSlippage, profile, beforeSlippage.commitment, owner, rpc))
        .rejects.toThrow('VAULT_MINIMUM_SHARES_UNAVAILABLE');
      // A stale call submitted on this closed chain still reverts on the vault itself.
      const reverted = await localWallet(beforeSlippage.transaction);
      expect(reverted.receipt.status).toBe('0x0');
      await setOffer(2n);
      await expect(reconcileErc4626Deposit(beforeSlippage, profile, reverted.hash, rpc))
        .resolves.toMatchObject({ verdict: 'DIVERGENT', reason: 'VAULT_TRANSACTION_REVERTED' });

      const review = await simulate();
      expect(review.simulation.outputs[0]).toMatchObject({ expected: { amount: '2000000' }, minimum: { amount: minShares.toString() } });
      expect(review.manifest).toMatchObject({ authorizationMode: 'MODE_A', executor: null, owner: { address: owner } });
      const step = review.plan.segments[0]!.steps[0]!;
      if (step.executionKind !== 'DIRECT_TRANSACTION') throw new Error('VAULT_PLAN_INVALID');
      expect(step.payloadHash).toBe(hashSupplyValue(review.transaction, 'payload'));
      await expect(assertFreshErc4626Deposit(review, profile, review.commitment, owner, rpc)).resolves.toBeUndefined();

      const directory = await mkdtemp(join(tmpdir(), 'flofi-vault-attempt-')), path = join(directory, 'attempts.json');
      try {
        const segmentId = review.plan.segments[0]!.segmentId, time = () => new Date().toISOString();
        let journal = createJournal({ journalId: 'vault-local', workflowId: workflow.workflowId,
          executionPlanHash: supplyArtifactHash('execution-plan', review.plan), manifestHash: review.plan.manifestHash });
        journal = appendJournalState(journal, { level: 'workflow', entityId: workflow.workflowId, segmentId: null,
          stepId: null, executionAttemptId: null, toState: 'DRAFT', recordedAt: time() }).journal;
        journal = appendJournalState(journal, { level: 'segment', entityId: segmentId, segmentId,
          stepId: null, executionAttemptId: null, toState: 'PLANNED', recordedAt: time() }).journal;
        journal = appendJournalState(journal, { level: 'step', entityId: step.stepId, segmentId,
          stepId: step.stepId, executionAttemptId: null, toState: 'PLANNED', recordedAt: time() }).journal;
        const read = async () => JSON.parse(await readFile(path, 'utf8')) as { attempts: Attempt[]; journal: ExecutionJournal };
        await writeFile(path, JSON.stringify({ attempts: [], journal }), { flush: true });
        const persist = async (attempts: readonly Attempt[]) => {
          const [current] = attempts, previous = await read();
          if (!current) throw new Error('ATTEMPT_MISSING');
          const { executionAttemptId, state } = current;
          const { journal: next } = appendJournalState(previous.journal, { level: 'attempt', entityId: executionAttemptId,
            segmentId, stepId: step.stepId, executionAttemptId, toState: state, recordedAt: time() });
          await writeFile(path + '.pending', JSON.stringify({ attempts, journal: next }), { flush: true });
          await rename(path + '.pending', path);
        };
        const coordinator = createAttemptCoordinator({ read: async () => (await read()).attempts, write: persist });
        const { attempt } = await coordinator.prepare({ executionId: 'vault-local', stepId: step.stepId, idempotencyKey: 'wallet-click',
          payloadHash: step.payloadHash, preparedAtBlock: review.block, priorStepConfirmed: true });
        const { transactionHash } = await coordinator.request(attempt.executionAttemptId, async () => {
          expect((await read()).journal.entries.at(-1)?.toState).toBe('SUBMITTING');
          return (await localWallet(review.transaction)).hash;
        });
        expect(transactionHash).toBeTruthy();
        await expect(coordinator.request(attempt.executionAttemptId, () => Promise.reject(new Error('DUPLICATE_SEND')))).rejects.toThrow('ATTEMPT_NOT_PREPARED');
        await expect(reconcileErc4626Deposit(review, profile, transactionHash!, rpc))
          .resolves.toMatchObject({ verdict: 'INCONCLUSIVE', reason: 'VAULT_CONFIRMATIONS_PENDING' });
        await rpc('anvil_mine', [1]);
        const evidence = await reconcileErc4626Deposit(review, profile, transactionHash!, rpc);
        expect(evidence).toMatchObject({ verdict: 'RECONCILED', reason: 'EXACT', transactionHash, assets: amount.toString(), shares: '2000000' });
        const [pending] = (await read()).attempts;
        const confirmed = transitionAttemptState(pending!, 'CONFIRMED');
        await persist([confirmed]);
        const finalJournal = (await read()).journal;
        expect(finalJournal.entries.filter(entry => entry.level === 'attempt').map(entry => entry.toState))
          .toEqual(['PREPARED', 'SUBMITTING', 'PENDING', 'CONFIRMED']);
        expect(hashJournalBytes(new TextEncoder().encode(JSON.stringify(finalJournal))).at(-1)).toMatch(/^0x[0-9a-f]{64}$/);
        expect(confirmed.transactionHash).toBe(transactionHash);

        await expect(reconcileErc4626Deposit(review, profile, transactionHash!, async (method, params) => method === 'eth_getTransactionReceipt'
          ? { ...rpcRecord(await rpc(method, params)), logs: [] } : rpc(method, params)))
          .resolves.toMatchObject({ verdict: 'DIVERGENT', reason: 'VAULT_DEPOSIT_LOG_MISMATCH' });
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }, 15_000);
});
