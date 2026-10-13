// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64 } from '@defi-workflow-engine/reference-compiler';
import { createPositionMintSigner } from '../src/wallet/position-mint-signer';
import { createOrcaLiquidityService } from '../src/server/orca-liquidity-service';
import { createSolanaRpc } from '../src/server/solana-rpc';
import { createSolanaLiquidityNode } from '../src/domain/solana-liquidity-authoring';
/** Seed reconciled MOCKED positions outside the UI using disposable fixture wallets. Production Review still rejects MOCKED authority.
 * Independent fixture journals let selection regressions cover a wallet with more than one registered position; no production limit changes.
 */
export async function seedCopilotPosition(wallet: ReturnType<typeof createMockedSolanaWallet>) {
  const journal = process.env.GRYLOO_SOLANA_DEVNET_JOURNAL;
  if (process.env.GRYLOO_SOLANA_DEVNET_E2E !== 'MOCKED_LOOPBACK_ONLY' || !journal?.startsWith(join(tmpdir(), 'gryloo-demo001-'))) throw new Error('MOCK_SEED_DENIED');
  await mkdir(journal, { recursive: true });
  const dir = await mkdtemp(join(journal + '-position-fixture-'));
  const service = createOrcaLiquidityService({ journalDir: dir, rpc: createSolanaRpc('http://127.0.0.1:8552/rpc', true), provenance: 'MOCKED', executionEnabled: true });
  const key = await createPositionMintSigner();
  const workflow = { schemaVersion: '1.0.0' as const, workflowId: 'copilot-position-fixture', revision: 1, resourceEdges: [], nodes: [createSolanaLiquidityNode('node-002', {
    network: 'Solana Devnet', maxSol: '0.01', maxDevUsdc: '0.3', rangeUnit: 'TICK', lower: '-39104', upper: '-36992', slippage: '100'
  })] };
  const simulated = await service.simulate(workflow, wallet.owner, { operation: 'OPEN', positionMint: key.address });
  await service.review(simulated.id, simulated.review.commitment, workflow);
  const begin = await service.begin(simulated.id, wallet.owner, workflow);
  const parsed = parseTransaction(fromBase64(wallet.sign(begin.unsignedTransaction), 2048));
  await service.submit(simulated.id, toBase64(serializeSignedTransaction([parsed.signatures[0]!, await key.sign(parsed.message)], parsed.message)));
  const observed = await service.observe(simulated.id);
  if (observed.verdict !== 'RECONCILED') throw new Error('MOCK_POSITION_NOT_RECONCILED');
  for (const name of await readdir(dir)) {
    const bytes = await readFile(join(dir, name));
    if (name.endsWith('.orcalp-positions')) await appendFile(join(journal, name), bytes);
    else if (name.endsWith('.jsonl')) await writeFile(join(journal, name), bytes);
  }
  return key.address;
}
