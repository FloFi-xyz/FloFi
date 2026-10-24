// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-E2E-001: the network × action × protocol × channel certification matrix, generated from code, never kept by hand.
 *
 * Rows: every canonical capability example (`codeCapabilities`, the registry resolved on the composed IR), plus the implemented operations
 * the strategy grammar does not express (Orca position management, the Solana Devnet bound composition, sequences, delegated runs). For
 * each row: the deployment flow that executes it, the web runtime that serves it in the Canvas and on `/approve` (`selectOwnerRuntime`, the
 * same decision AppShell makes), which channels may author and hand it off, and its certification status:
 *
 * - LIVE_CERTIFIED: an owner-signed public execution in the execution ledger whose receipts were re-verified read-only;
 * - IMPLEMENTED_UNCERTIFIED: an owner-wallet implementation exists and a web runtime serves it, but no verified public execution;
 * - BROKEN: an implemented path that fails (e.g. no web runtime serves an implemented, handed-off action);
 * - NOT_IMPLEMENTED: the repository has no implementation for it.
 *
 * Documentation, unit tests, mocked browser tests and deployments never raise a row above IMPLEMENTED_UNCERTIFIED.
 */
import type { StrategySpec } from './strategy-spec';
import { codeCapabilities } from './capability-catalog';
import { composeStrategy } from './strategy-engine';
import { STRATEGY_EXAMPLES } from './strategy-examples';
import { strategyFlow } from '../mcp/simulation';
import { selectOwnerRuntime, type HeldRun } from '../domain/runtime-selection';
import { agentRolloutAllows, pendingAgentCapability } from '../domain/agent-rollout';
import type { Workflow } from '../domain/initial-workflow';

export type CertificationStatus = 'LIVE_CERTIFIED' | 'IMPLEMENTED_UNCERTIFIED' | 'BROKEN' | 'NOT_IMPLEMENTED';
export type LedgerEntry = { readonly id: string; readonly action: string; readonly network: string; readonly adapter: string; readonly recordedClass: string;
  readonly codeRef: string; readonly alsoCovers?: readonly string[] };
export type Ledger = { readonly entries: readonly LedgerEntry[] };
export type LiveVerification = { readonly checkedAt: string; readonly results: readonly { readonly id: string; readonly status: string }[] };
export type CertificationRow = {
  readonly id: string; readonly action: string; readonly network: string; readonly destinationNetwork: string | null; readonly funds: 'REAL_FUNDS' | 'TEST_FUNDS';
  readonly protocols: readonly string[]; readonly flow: string | null;
  /** The owner-wallet runtime the Canvas and `/approve` use for it (null: none serves it). */
  readonly webRuntime: string | null;
  readonly ownerWalletExecutionImplemented: boolean;
  /** Who may author it and hand it to its owner. Execution is always the owner's own wallet in FloFi (Canvas or `/approve`). */
  readonly channels: { readonly canvas: boolean; readonly approve: boolean; readonly copilot: boolean; readonly mcp: boolean; readonly telegram: boolean;
    readonly whatsapp: 'POLICY_BLOCKED'; readonly developerApi: boolean };
  readonly agentRollout: string | null;
  readonly registryEvidence: string | null;
  readonly liveEvidence: readonly string[];
  readonly status: CertificationStatus;
  readonly reason: string;
};

const none: HeldRun = { recovered: false, workflow: null };
/** Production routing: no browser recovery, the Base catalog swap served (no local fork runtime on a deployment). */
const PRODUCTION_ROUTING = { recoveryShell: false, solanaTransfer: none, transfer: none, lending: none, uniswapLiquidity: none, router: none, solanaComposition: none,
  solanaLiquidity: none, jupiter: none, supply: { ...none, operation: null }, publicSwap: { recoveryOnly: false, workflow: null, continuedApproval: false },
  baseReferenceServed: true } as const;
const strategyNetwork = (spec: StrategySpec) => 'network' in spec ? spec.network : spec.sourceNetwork;

function verifiedEntries(ledger: Ledger, verification: LiveVerification, key: string, adapters: readonly string[]): string[] {
  const verified = new Set(verification.results.filter(result => result.status === 'VERIFIED').map(result => result.id));
  return ledger.entries.filter(entry => verified.has(entry.id) &&
    (`${entry.action}:${entry.network}` === key && adapters.includes(entry.adapter) || entry.alsoCovers?.includes(key))).map(entry => entry.id);
}

/** Operations the repository implements outside the strategy grammar, and capabilities it does not implement, with their code facts. */
const OTHER_ROWS: readonly (Omit<CertificationRow, 'liveEvidence' | 'status' | 'reason'> & { readonly implemented: boolean; readonly why: string })[] = [
  { id: 'remove-liquidity-solana-devnet', action: 'remove_liquidity', network: 'solana-devnet', destinationNetwork: null, funds: 'TEST_FUNDS',
    protocols: ['orca.whirlpools-devnet-liquidity'], flow: 'orca-liquidity', webRuntime: 'solana-pool', ownerWalletExecutionImplemented: true,
    channels: { canvas: true, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: null,
    registryEvidence: null, implemented: true, why: 'Orca decrease/exit (MANAGE_SOLANA_POSITION) in the Canvas only; the strategy grammar has no remove action.' },
  { id: 'remove-liquidity-solana', action: 'remove_liquidity', network: 'solana', destinationNetwork: null, funds: 'REAL_FUNDS',
    protocols: ['orca.whirlpools-mainnet-liquidity'], flow: 'orca-liquidity-mainnet', webRuntime: 'solana-pool', ownerWalletExecutionImplemented: true,
    channels: { canvas: true, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: 'orca-liquidity-mainnet',
    registryEvidence: null, implemented: true, why: 'Same Orca engine on mainnet-beta, Canvas only, behind GRYLOO_ORCA_MAINNET and the owner-execution gate.' },
  ...(['base-sepolia', 'ethereum-sepolia', 'base', 'arbitrum-one', 'ethereum', 'robinhood'] as const).map(network => ({
    id: `remove-liquidity-${network}`, action: 'remove_liquidity', network, destinationNetwork: null, funds: network.endsWith('sepolia') ? 'TEST_FUNDS' as const : 'REAL_FUNDS' as const,
    protocols: ['uniswap.v3'], flow: null, webRuntime: null, ownerWalletExecutionImplemented: false,
    channels: { canvas: false, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED' as const, developerApi: false }, agentRollout: null,
    registryEvidence: null, implemented: false, why: 'The public Uniswap v3 engine mints initialized-pool positions only; decrease/collect exist only in the BUILD-006 local-fork engine, which accepts no public route.' })),
  { id: 'swap-then-add-liquidity-solana-devnet', action: 'swap_then_add_liquidity', network: 'solana-devnet', destinationNetwork: null, funds: 'TEST_FUNDS',
    protocols: ['orca.whirlpools-devnet', 'orca.whirlpools-devnet-liquidity'], flow: 'solana-composition', webRuntime: 'solana-composition', ownerWalletExecutionImplemented: true,
    channels: { canvas: true, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: null,
    registryEvidence: null, implemented: true, why: 'The registered bound composition (swap output bound into the position), Canvas only.' },
  { id: 'sequence-confirm-each-step', action: 'sequence', network: 'any (per step)', destinationNetwork: null, funds: 'TEST_FUNDS',
    protocols: ['per step'], flow: 'workflow-run', webRuntime: 'per step', ownerWalletExecutionImplemented: true,
    channels: { canvas: false, approve: true, copilot: false, mcp: true, telegram: true, whatsapp: 'POLICY_BLOCKED', developerApi: true }, agentRollout: null,
    registryEvidence: null, implemented: true, why: 'Durable workflow runs (migration 0015), one approval, one wallet confirmation per step; off unless FLOFI_WORKFLOW_RUNS=enabled.' },
  { id: 'sequence-bound-amounts-confirm-mode', action: 'sequence_bound_amounts', network: 'any (per step)', destinationNetwork: null, funds: 'TEST_FUNDS',
    protocols: ['per step'], flow: null, webRuntime: null, ownerWalletExecutionImplemented: false,
    channels: { canvas: false, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: null,
    registryEvidence: null, implemented: false, why: 'DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED: owner-signed flows expose no canonical received amount.' },
  { id: 'sequence-delegated-single-authorization', action: 'sequence_delegated', network: 'base-sepolia, ethereum-sepolia (Uniswap swaps only)', destinationNetwork: null, funds: 'TEST_FUNDS',
    protocols: ['uniswap.v3'], flow: null, webRuntime: null, ownerWalletExecutionImplemented: false,
    channels: { canvas: false, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: null,
    registryEvidence: 'MOCKED', implemented: false, why: 'Production has no delegated signer provider (KMS/HSM): DELEGATED_SIGNER_UNAVAILABLE on every hosted deployment.' },
  { id: 'bridge-evm-solana', action: 'bridge', network: 'any EVM network', destinationNetwork: 'solana', funds: 'REAL_FUNDS',
    protocols: [], flow: null, webRuntime: null, ownerWalletExecutionImplemented: false,
    channels: { canvas: false, approve: false, copilot: false, mcp: false, telegram: false, whatsapp: 'POLICY_BLOCKED', developerApi: false }, agentRollout: null,
    registryEvidence: null, implemented: false, why: 'BRIDGE_ROUTE_UNAVAILABLE: no EVM ↔ Solana route exists.' },
];

export function certificationMatrix(ledger: Ledger, verification: LiveVerification): readonly CertificationRow[] {
  const capabilities = codeCapabilities('ENGINEERING');
  const rows = STRATEGY_EXAMPLES.map(({ id, strategy }, index): CertificationRow => {
    const capability = capabilities[index]!, composed = composeStrategy(strategy);
    if (!composed.ok) throw new Error(`CERTIFICATION_EXAMPLE_INVALID ${id}`);
    const network = strategyNetwork(strategy), destination = strategy.action === 'bridge' ? strategy.destinationNetwork : null;
    const webRuntime = selectOwnerRuntime(composed.workflow as Workflow, PRODUCTION_ROUTING).kind;
    const agents = agentRolloutAllows(strategy.action, network), real = capability.funds === 'REAL_FUNDS';
    const key = destination ? `${strategy.action}:${network}→${destination}` : `${strategy.action}:${network}`;
    const liveEvidence = verifiedEntries(ledger, verification, key, capability.adapters);
    const implemented = capability.ownerWalletExecutionImplemented;
    const status: CertificationStatus = !implemented ? 'NOT_IMPLEMENTED' : webRuntime === null ? 'BROKEN' : liveEvidence.length ? 'LIVE_CERTIFIED' : 'IMPLEMENTED_UNCERTIFIED';
    const reason = status === 'NOT_IMPLEMENTED' ? 'No owner-wallet execution in code for this environment.'
      : status === 'BROKEN' ? 'Implemented and handed off, but no web runtime serves it.'
      : status === 'LIVE_CERTIFIED' ? `Owner-signed public execution re-verified read-only at ${verification.checkedAt.slice(0, 10)} (historical; not re-run on this release).`
      : real ? 'Implemented; no owner-signed mainnet execution has ever been recorded.' : 'Implemented; no owner-signed public execution recorded for this exact path.';
    return { id, action: strategy.action, network, destinationNetwork: destination, funds: capability.funds, protocols: capability.adapters, flow: strategyFlow(strategy),
      webRuntime, ownerWalletExecutionImplemented: implemented,
      channels: { canvas: webRuntime !== null, approve: webRuntime !== null, copilot: agents, mcp: agents, telegram: agents, whatsapp: 'POLICY_BLOCKED', developerApi: !real && agents },
      agentRollout: pendingAgentCapability(strategy.action, network), registryEvidence: capability.demonstratedEvidence, liveEvidence, status, reason };
  });
  const others = OTHER_ROWS.map(({ implemented, why, ...row }): CertificationRow => {
    const liveEvidence = verifiedEntries(ledger, verification, `${row.action}:${row.network}`, row.protocols.length ? [row.protocols.join(' + ')] : []);
    const status: CertificationStatus = !implemented ? 'NOT_IMPLEMENTED' : liveEvidence.length ? 'LIVE_CERTIFIED' : 'IMPLEMENTED_UNCERTIFIED';
    return { ...row, liveEvidence, status, reason: status === 'LIVE_CERTIFIED' ? `${why} Owner-signed public execution re-verified read-only (historical).` : why };
  });
  return [...rows, ...others];
}
