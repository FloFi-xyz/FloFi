// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-E2E-001: which owner-wallet runtime serves the current workflow. One pure decision shared by the Canvas and the
 * `/approve` signing surface (AppShell), so the simulation, Review, authorization, execution and recovery of a workflow always come from the
 * runtime of that workflow's own action and network.
 *
 * Each owner-wallet store restores the last run of this browser (a `localStorage` pointer) on every visit. Such a recovered run may claim the
 * routing only for the visit's untouched draft (where its run is shown again), or for exactly its own reviewed workflow. Before this rule, a
 * recovered Solana Mainnet Jupiter run claimed a Base Sepolia swap opened on `/approve`, and its Strategy Manifest was presented for the
 * Base Sepolia workflow; a recovered Aave run claimed every workflow below it in the order (Solana included).
 */
import { isBoundComposition, uniswapCatalogDeployment, uniswapLiquidityProfile } from '@defi-workflow-engine/action-registry';
import { isLendingComposition, isSolanaTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { isPristineDraft, type Workflow } from './initial-workflow';
import { ownerWalletSwapServes } from './public-testnet-swap';
import { routerDetails } from './router-authoring';
import { universalBridgeDetails } from './universal-bridge-authoring';

/** A run a store holds: `recovered` when it came from the browser's recovery pointer; `workflow` is the run's reviewed workflow (null: no run). */
export type HeldRun = { readonly recovered: boolean; readonly workflow: unknown };
export type OwnerRuntimeSignals = {
  /** False once the owner created a new workflow in this visit: a persisted run is recovered only into the visit's initial draft. */
  readonly recoveryShell: boolean;
  readonly solanaTransfer: HeldRun; readonly transfer: HeldRun; readonly lending: HeldRun; readonly uniswapLiquidity: HeldRun; readonly router: HeldRun;
  /** BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router run. */ readonly universal?: HeldRun;
  readonly solanaComposition: HeldRun; readonly solanaLiquidity: HeldRun; readonly jupiter: HeldRun;
  /** The Aave run, with the operation its Review is for. */
  readonly supply: HeldRun & { readonly operation: 'supply' | 'borrow' | 'repay' | 'withdraw' | null };
  /** The public owner-wallet swap: a run recovered for observation only, or a confirmed approval that continues into its swap. */
  readonly publicSwap: { readonly recoveryOnly: boolean; readonly workflow: unknown; readonly continuedApproval: boolean };
  /** Base USDC ⇄ WETH joins the owner-wallet swap only where Base mainnet swaps are served and no local fork runtime is available. */
  readonly baseReferenceServed: boolean;
};
export type OwnerRuntimeKind = 'universal' | 'router' | 'solana-transfer' | 'transfer' | 'lending' | 'supply' | 'uniswap-pool' | 'solana-composition' | 'solana-pool' | 'solana-swap' | 'public';
export type OwnerRuntime = {
  readonly kind: OwnerRuntimeKind | null;
  readonly universalPath: boolean; readonly routerPath: boolean; readonly solanaTransferPath: boolean; readonly transferPath: boolean; readonly lendingPath: boolean;
  readonly withdrawPath: boolean; readonly repayPath: boolean; readonly borrowPath: boolean; readonly supplyPath: boolean;
  readonly uniswapLiquidityPath: boolean; readonly solanaCompositionPath: boolean; readonly solanaLiquidityPath: boolean; readonly solanaPath: boolean;
  readonly publicPath: boolean;
};

/** The visit's initial draft before any edit: only mock template cards, revision 0. */
export const untouchedDraft = (workflow: Workflow) => isPristineDraft(workflow);
/** A recovered run attaches to the untouched draft, or to exactly its own reviewed workflow; never to another workflow. */
export function recoveredRunAttaches(workflow: Workflow, run: HeldRun): boolean {
  if (!run.recovered || run.workflow === null || run.workflow === undefined) return false;
  if (untouchedDraft(workflow)) return true;
  try { return JSON.stringify(run.workflow) === JSON.stringify(workflow); } catch { return false; }
}

/**
 * The owner-wallet Uniswap position networks, from the registries: the public testnet profiles (Base Sepolia, Ethereum Sepolia) and every
 * catalog deployment (Robinhood Chain, Base, Arbitrum One, Ethereum). A hand-kept list here once missed Arbitrum One and Ethereum, whose
 * position runs (`arlp-`, `etlp-`) exist, so their workflows fell through to the local fork liquidity runtime.
 */
export const ownerPositionNetwork = (chain: string) => uniswapLiquidityProfile(chain) !== null || uniswapCatalogDeployment(chain) !== null;
export function selectOwnerRuntime(workflow: Workflow, signals: OwnerRuntimeSignals): OwnerRuntime {
  const nodes = workflow.nodes, recovers = (run: HeldRun) => signals.recoveryShell && recoveredRunAttaches(workflow, run);
  // BUILD-SOLANA-TRANSFER-UX-001: a Solana transfer has its own runtime; the EVM transfer runtime never receives it.
  const solanaTransferPath = nodes.some(isSolanaTransferNode) || recovers(signals.solanaTransfer);
  const transferPath = !solanaTransferPath && (nodes.some(n => n.actionType === 'asset.transfer') || recovers(signals.transfer));
  const lendingPath = isLendingComposition(workflow) || recovers(signals.lending);
  const supplyRecovered = recovers(signals.supply), operation = supplyRecovered ? signals.supply.operation : null;
  const withdrawPath = nodes.some(n => n.actionType === 'withdraw') || operation === 'withdraw';
  const repayPath = nodes.some(n => n.actionType === 'repay') || operation === 'repay';
  const borrowPath = nodes.some(n => n.actionType === 'borrow') || operation === 'borrow';
  const supplyPath = nodes.some(n => n.actionType === 'supply') || supplyRecovered;
  const uniswapLiquidityPath = !supplyPath && (nodes.some(n => n.actionType === 'asset.liquidity.concentrated' && ownerPositionNetwork(n.chainId)) || recovers(signals.uniswapLiquidity));
  const universalPath = nodes.some(n => universalBridgeDetails(n as SemanticWorkflow['nodes'][number])) || (signals.universal ? recovers(signals.universal) : false);
  const routerPath = !universalPath && (nodes.some(n => routerDetails(n as SemanticWorkflow['nodes'][number])) || recovers(signals.router));
  // Solana Devnet Swap → Orca liquidity (a registered bound composition) is checked before the isolated Solana paths.
  const solanaCompositionPath = !supplyPath && (isBoundComposition(workflow) || recovers(signals.solanaComposition));
  const solanaLiquidityPath = !supplyPath && !solanaCompositionPath && !uniswapLiquidityPath &&
    (nodes.some(n => n.actionType === 'asset.liquidity.concentrated' && n.chainId.startsWith('solana:')) || recovers(signals.solanaLiquidity));
  const solanaPath = !supplyPath && !solanaCompositionPath && !solanaLiquidityPath &&
    (nodes.some(n => n.actionType === 'asset.swap.exact-input' && n.chainId.startsWith('solana:')) || recovers(signals.jupiter));
  // The engineering compositions own their full graph: their destination swap is never routed as an isolated owner-wallet run.
  const legacyComposition = nodes.some(n => n.nodeId === 'build009-bridge' || n.actionType === 'asset.liquidity.prepare');
  const testnetWorkflow = !legacyComposition && nodes.some(n => ownerWalletSwapServes(n, signals.baseReferenceServed));
  const publicRecovery = recovers({ recovered: signals.publicSwap.recoveryOnly, workflow: signals.publicSwap.workflow });
  const publicPath = testnetWorkflow || publicRecovery || signals.publicSwap.continuedApproval;
  const kind: OwnerRuntimeKind | null = universalPath ? 'universal' : routerPath ? 'router' : solanaTransferPath ? 'solana-transfer' : transferPath ? 'transfer' : lendingPath ? 'lending'
    : supplyPath || borrowPath || repayPath || withdrawPath ? 'supply' : uniswapLiquidityPath ? 'uniswap-pool' : solanaCompositionPath ? 'solana-composition'
    : solanaLiquidityPath ? 'solana-pool' : solanaPath ? 'solana-swap' : publicPath ? 'public' : null;
  return { kind, universalPath, routerPath, solanaTransferPath, transferPath, lendingPath, withdrawPath, repayPath, borrowPath, supplyPath, uniswapLiquidityPath,
    solanaCompositionPath, solanaLiquidityPath, solanaPath, publicPath };
}
