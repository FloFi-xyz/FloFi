// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: the system-wide settlement regression matrix, generated from the current capability registry.
 *
 * Every MAINNET row of `executionCapabilityRegistry` that declares RECONCILE must have a declared settlement proof, a finality rule and
 * at least one existing regression suite below; a new adapter, action or network without them fails this test. The generated table is
 * docs/engineering/SETTLEMENT-REGRESSION-MATRIX.md (regenerate with FLOFI_WRITE_SETTLEMENT_MATRIX=1). Offline: no network, no signing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executionCapabilityRegistry, RELAY_ROUTER_V3_2, UNIVERSAL_ROUTER_DEPLOYMENT } from '@defi-workflow-engine/action-registry';
import { MAINNET_SWAP_CONFIRMATIONS } from '../server/public-testnet-service.ts';
import { MAINNET_LIQUIDITY_CONFIRMATIONS } from '../server/uniswap-liquidity-service.ts';

const ROOT = new URL('../../../../', import.meta.url);
const S = 'apps/reference-dapp/src/server/';
type Settlement = { readonly proof: string; readonly finality: string; readonly suites: readonly string[] };
const SWAP_SUITES = [S + 'base-swap.test.ts', S + 'robinhood-swap.test.ts'];
const AAVE: Settlement = { proof: 'Aave receipt events of the reviewed call and the exact owner wallet balance change (a third-party transfer in the same block fails closed)',
  finality: 'Receipt two blocks deep, canonical hash re-checked', suites: [S + 'ethereum-lending.test.ts', S + 'base-lending.test.ts', S + 'arbitrum-lending.test.ts', S + 'supply-service.test.ts'] };
/** Keyed by `actionType|adapterId`. */
const SETTLEMENT: Readonly<Record<string, Settlement>> = {
  'asset.swap.exact-input|uniswap.v3': { proof: 'Reviewed calldata; owner Transfer of the exact input, pool and router WETH movements, WETH9 Withdrawal for native ETH out; balance lower bound when the window is the owner\'s alone; EIP-7702 shapes verified; 0x Gasless settlements from the trade\'s own logs and Permit2 nonce',
    finality: 'Transfer-profile confirmation depth (2 on L2, 3 on Ethereum), canonical block re-read until then', suites: SWAP_SUITES },
  'asset.swap.exact-input|weth9.wrap': { proof: 'Exactly one WETH9 Deposit or Withdrawal of the amount for the owner', finality: 'Transfer-profile confirmation depth', suites: [S + 'base-swap.test.ts'] },
  'asset.liquidity.concentrated|uniswap.v3': { proof: 'Mint: Approval and IncreaseLiquidity events, position NFT owner, token balance deltas. Position management (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): the reviewed request only; DecreaseLiquidity and the pool Burn of exactly the reviewed liquidity at or above the minimums, one Collect to the owner with pool → owner token transfers, nothing leaving the owner, the position read back at the receipt block (remaining liquidity, nothing owed) or burned (Transfer to zero, ownerOf reverts), and owner balance deltas',
    finality: 'Transfer-profile confirmation depth', suites: [S + 'robinhood-liquidity.test.ts', S + 'arbitrum-liquidity.test.ts', S + 'base-liquidity.test.ts', S + 'ethereum-liquidity.test.ts',
      S + 'uniswap-position-service.test.ts'] },
  'asset.transfer|evm.native-transfer': { proof: 'The owner\'s own transaction to/value and the exact owner balance change when it is the owner\'s only transaction in the block; relayed native transfers refused',
    finality: 'Profile minimumConfirmations, reorg re-check', suites: ['packages/reference-reconciler/test/native-transfer.test.ts', S + 'robinhood-transfer-mainnet.test.ts', S + 'smart-account-transfer.test.ts'] },
  'asset.transfer|evm.token-transfer': { proof: 'Exact ERC-20 Transfer logs and both balances', finality: 'Profile minimumConfirmations, reorg re-check',
    suites: [S + 'robinhood-transfer-mainnet.test.ts', S + 'robinhood-transfer-service.test.ts'] },
  'supply|aave-v3': AAVE, 'borrow|aave-v3': AAVE, 'repay|aave-v3': AAVE, 'withdraw|aave-v3': AAVE,
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: a Batch Payment settles only as its one atomic owner-wallet batch of transfer legs.
  'asset.transfer.batch|evm.batch-payment': { proof: 'One atomic owner-wallet batch (EIP-5792 atomicRequired, or the owner\'s own smart-account operation) carrying exactly the ' +
    'prepared transfer calls: every receipt from the owner, nothing mined before the prepared block, each ERC-20 leg attributed to its own recipient\'s Transfer log; ' +
    'native legs credited from the atomic success of the reviewed calls; a failed batch settles no leg',
    finality: 'Transfer-profile confirmation depth for the batch receipt, reorg re-check', suites: ['apps/reference-dapp/src/engine/batch-payment.test.ts',
      'apps/reference-dapp/src/user-funded/groups.test.ts', 'apps/reference-dapp/src/workflow-runs/batch-payment-run.pg.test.ts'] },
  // BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20): a Solana Batch Payment settles only as its one atomic owner-signed transaction.
  'asset.transfer.batch|solana.batch-payment': { proof: 'One owner-signed atomic v0 transaction carrying exactly the reviewed legs (or them plus only a verified ' +
    'Lighthouse wallet guard); finalized meta: each recipient\'s exact lamport or token-account delta, the owner\'s delta equal to the total plus the fee and ' +
    'the created token-account deposits, nothing else moving; a failed transaction settles no leg',
    finality: 'Finalized commitment', suites: ['packages/reference-compiler/test/solana-batch-payment.test.ts',
      'packages/reference-reconciler/test/solana-batch-payment.test.ts'] },
  'asset.bridge|flofi.router': { proof: 'Destination FilledRelay and the exact ERC-20 Transfer to the recipient (durable log scan fallback); ERC-20 profiles only',
    finality: 'Safe head on both chains, reorg re-check', suites: [S + 'router-service.test.ts', S + 'router-arbitrum-base.test.ts', S + 'router-robinhood.test.ts', S + 'router-ethereum.test.ts'] },
  'asset.bridge|flofi.router.universal': { proof: 'Source deposit logs bound to the order id; destination ERC-20 net Transfer, or native net credit from a validated trace (trace_transaction or callTracer) of an order-bound Relay solver fill; provider status is never proof',
    finality: 'Safe head, destination block hash re-checked on every observation', suites: [S + 'universal-router/service.test.ts', S + 'universal-router/incident-replay.test.ts'] },
  'asset.swap.exact-input|jupiter.swap-v2': { proof: 'Finalized transaction and its own pre/post token balances, fee accounted', finality: 'Finalized commitment', suites: [S + 'jupiter-service.test.ts'] },
  'asset.transfer|solana.system-transfer': { proof: 'Finalized transaction meta balances', finality: 'Finalized commitment', suites: [S + 'solana-transfer-service.test.ts'] },
  'asset.transfer|solana.spl-transfer': { proof: 'Finalized transaction token balances', finality: 'Finalized commitment', suites: [S + 'solana-transfer-service.test.ts'] },
  'asset.liquidity.concentrated|orca.whirlpools-mainnet-liquidity': { proof: 'Finalized transaction and the position account; COLLECT (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): the fee checkpoint and collect_fees_v2 vault outflows to the owner with liquidity and principal unchanged and the position authority re-verified',
    finality: 'Finalized commitment',
    suites: [S + 'orca-mainnet-liquidity-service.test.ts', 'packages/reference-reconciler/test/orca-mainnet-liquidity.test.ts', 'packages/reference-compiler/test/orca-mainnet-liquidity.test.ts'] },
};
/** How a step's settlement reaches every surface, for every row above. */
const PROPAGATION = [
  ['Workflow step', 'RECONCILED only on reconciled evidence of an error-free, fully observed run; a pending step is UNCERTAIN (ATTENTION) and never reopens signing',
    'apps/reference-dapp/src/workflow-runs/confirm-run.pg.test.ts', 'apps/reference-dapp/src/workflow-runs/user-funded-run.pg.test.ts'],
  ['Canvas and execution panels', 'Destination operation pending with "Provider reports delivery · awaiting independent verification" until verified', S + 'universal-router/service.test.ts'],
  ['History', 'In progress with the same message and "Awaiting an execution status check"', S + 'universal-router/service.test.ts', 'apps/reference-dapp/src/lib/dashboard/run-mapping.test.ts'],
  ['Historical executions', 'reconcile-history re-queues only the read-only reconcile task through the audited recovery', 'apps/reference-dapp/src/admin/support/historical-reconciliation.pg.test.ts'],
] as const;

function matrix() {
  // Every executable mainnet row is in scope; one that executes without reconciling fails the first assertion below.
  const rows = executionCapabilityRegistry.filter(row => row.environment === 'MAINNET' && (row.capabilities.RECONCILE || row.capabilities.EXECUTE));
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.actionType + '|' + row.adapterId, [...grouped.get(row.actionType + '|' + row.adapterId) ?? [], row.chainId]);
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, chains]) => ({ key, chains: [...new Set(chains)].sort(), settlement: SETTLEMENT[key] }));
}
function markdown() {
  const cell = (text: string) => text.replaceAll('|', '\\|');
  return ['# Settlement regression matrix', '',
    'Generated by `apps/reference-dapp/src/platform/settlement-regression-matrix.test.ts` from `executionCapabilityRegistry` (MAINNET rows that execute or reconcile).',
    'Regenerate with `FLOFI_WRITE_SETTLEMENT_MATRIX=1 pnpm exec vitest run apps/reference-dapp/src/platform/settlement-regression-matrix.test.ts`.',
    'Offline evidence only (MOCKED chains and closed replays); it is not proof of public execution.', '',
    '| Action / adapter | Networks | Settlement proof | Finality | Regression suites |', '| --- | --- | --- | --- | --- |',
    ...matrix().map(({ key, chains, settlement }) => `| \`${key.replace('|', '` / `')}\` | ${chains.join(', ')} | ${cell(settlement!.proof)} | ${cell(settlement!.finality)} | ${settlement!.suites.map(s => '`' + s + '`').join('<br>')} |`),
    '', '## Propagation', '', '| Surface | Rule | Suites |', '| --- | --- | --- |',
    ...PROPAGATION.map(([surface, rule, ...suites]) => `| ${surface} | ${cell(rule)} | ${suites.map(s => '`' + s + '`').join('<br>')} |`), ''].join('\n');
}

describe('settlement regression matrix (generated from the capability registry)', () => {
  it('declares a settlement proof, finality rule and existing suites for every mainnet reconcile capability', () => {
    const rows = matrix();
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.filter(row => !row.settlement).map(row => row.key)).toEqual([]);
    expect(executionCapabilityRegistry.filter(row => row.environment === 'MAINNET' && row.capabilities.EXECUTE && !row.capabilities.RECONCILE)
      .map(row => `${row.actionType}|${row.adapterId}|${row.chainId}`)).toEqual([]);
    const suites = [...rows.flatMap(row => row.settlement!.suites), ...PROPAGATION.flatMap(([, , ...files]) => files)];
    expect(suites.filter(path => !existsSync(new URL(path, ROOT)))).toEqual([]);
    expect(Object.keys(SETTLEMENT).filter(key => !rows.some(row => row.key === key))).toEqual([]);
  });

  it('every EVM universal-router destination binds Relay native fills to RelayRouter v3.2 and a published solver set', () => {
    const chains = matrix().find(row => row.key === 'asset.bridge|flofi.router.universal')!.chains.filter(chain => chain.startsWith('eip155:'));
    expect(chains.length).toBe(4);
    for (const chain of chains) {
      const settlement = UNIVERSAL_ROUTER_DEPLOYMENT.evm[chain]?.relaySettlement;
      expect(settlement?.router, chain).toBe(RELAY_ROUTER_V3_2);
      expect(settlement!.executors.length, chain).toBeGreaterThan(0);
      expect(settlement!.executors.every(address => /^0x[0-9a-f]{40}$/.test(address))).toBe(true);
    }
  });

  it('every mainnet Uniswap swap and liquidity network has a confirmation depth of at least two blocks', () => {
    for (const [key, depths] of [['asset.swap.exact-input|uniswap.v3', MAINNET_SWAP_CONFIRMATIONS], ['asset.liquidity.concentrated|uniswap.v3', MAINNET_LIQUIDITY_CONFIRMATIONS]] as const) {
      for (const chain of matrix().find(row => row.key === key)!.chains) expect(depths[Number(chain.split(':')[1])], `${key} ${chain}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('the published matrix matches the registry', () => {
    const path = new URL('docs/engineering/SETTLEMENT-REGRESSION-MATRIX.md', ROOT), generated = markdown();
    if (process.env.FLOFI_WRITE_SETTLEMENT_MATRIX === '1') writeFileSync(path, generated);
    expect(readFileSync(path, 'utf8')).toBe(generated);
  });
});
