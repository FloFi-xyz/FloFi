// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (Editor integration, BUILD-FLOFI-UX-EDITOR-FINOPS-001 architecture): how a position-management workflow reads
 * on every Editor stage. The canonical node's management marker — never client state — names the operation and the position, so the Canvas card,
 * the Simulate panel's "operations as configured", the Review and the expired Review's summary all say "Collect fees · Uniswap v3 position #123 ·
 * Base", "Remove 50% of liquidity", "Remove all liquidity" or "Close position", and never present the pool node's descriptive maxima as amounts
 * (a management operation never deposits). Presentation only: nothing here simulates, authorizes, signs or sends.
 */
import type { ConcentratedLiquidityManagement } from '@defi-workflow-engine/workflow-contracts';
import { workflowPositionManagement, type LiquidityPositionChoice, type LiquidityPositionProtocol } from './liquidity-positions';
import { robinhoodLiquidityDetails } from './robinhood-liquidity-authoring';
import { solanaLiquidityDetails } from './solana-liquidity-authoring';
import { shellChainLabel } from './product-shell';

/** `50%`, `12.5%`, `0.01%` (basis points as a share; trailing zeros dropped). */
export const percentOfBps = (value: number) => `${(value / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * The position operation in plain words (Review, Canvas, chat and panels). Owed tokens are never called yield alone: a Uniswap position's owed
 * tokens can include principal withdrawn earlier and not collected.
 */
export function liquidityPositionOperationPhrase(protocol: LiquidityPositionProtocol, operation: string, close: boolean): string {
  if (operation === 'COLLECT') return protocol === 'ORCA' ? 'Collect fees (liquidity unchanged)' : 'Collect owed tokens and fees (liquidity unchanged)';
  if (operation === 'DECREASE' || operation === 'DECREASE_PARTIAL') return protocol === 'ORCA' ? 'Remove part of the position\'s liquidity and collect fees'
    : 'Remove part of the position\'s liquidity and collect';
  if (protocol === 'ORCA') return 'Remove all liquidity, collect fees and close the position; the position NFT is closed and its account rent is refunded';
  return close ? 'Remove all liquidity, collect and close the position (burns the NFT)' : 'Remove all liquidity and collect (the position NFT stays in your wallet)';
}
/** The short action name of a position operation (the Review's and the execution's step name). */
export function liquidityPositionActionLabel(operation: string, close: boolean): string {
  return operation === 'COLLECT' ? 'Collect fees' : operation === 'EXIT' && close ? 'Close position' : operation === 'EXIT' ? 'Remove all liquidity' : 'Remove liquidity';
}
/**
 * The Editor's title of a configured position operation (Canvas card, Simulate panel, expired Review summary): it states the share removed. An Orca
 * exit always closes its position, so it is "Close position"; a Uniswap exit closes (burns the NFT) only when the owner chose to.
 */
export function liquidityPositionTitle(protocol: LiquidityPositionProtocol, management: Pick<ConcentratedLiquidityManagement, 'operation' | 'partBps' | 'close'>): string {
  if (management.operation === 'COLLECT') return 'Collect fees';
  if (management.operation === 'DECREASE') return management.partBps === null ? 'Remove liquidity' : `Remove ${percentOfBps(management.partBps)} of liquidity`;
  return protocol === 'ORCA' || management.close ? 'Close position' : 'Remove all liquidity';
}
/** The position itself, as the owner recognises it: the Uniswap token id, or the Orca position mint (shortened; the Review shows it whole). */
export function liquidityPositionSubject(protocol: LiquidityPositionProtocol, positionId: string): string {
  return protocol === 'UNISWAP_V3' ? `Uniswap v3 position #${positionId}`
    : `Orca position ${positionId.length > 12 ? `${positionId.slice(0, 4)}…${positionId.slice(-4)}` : positionId}`;
}

export type LiquidityPositionSummary = {
  readonly protocol: LiquidityPositionProtocol; readonly chain: string; readonly management: ConcentratedLiquidityManagement;
  /** "Collect fees", "Remove 50% of liquidity", "Remove all liquidity", "Close position". */ readonly title: string;
  /** "Uniswap v3 position #123", "Orca position 6daH…dhiQ". */ readonly subject: string;
  readonly provider: 'Uniswap v3' | 'Orca Whirlpools';
  /** The network's display name, without its chain number ("Base", "Solana"). */ readonly network: string;
  /** The pool's pair ("USDC / cbBTC", "SOL / USDC"), or null when the catalog no longer resolves it. */ readonly pair: string | null;
  /** The operation in plain words (`liquidityPositionOperationPhrase`). */ readonly phrase: string;
  /** "Collect fees · Uniswap v3 position #123 · Base". */ readonly label: string;
};
/** The position operation a node names (its management marker), or null for any other node. A malformed marker reads as null (every runtime refuses it). */
export function liquidityPositionSummaryOf(node: { readonly actionType: string; readonly chainId: string }): LiquidityPositionSummary | null {
  const managed = workflowPositionManagement({ nodes: [node] });
  if (!managed) return null;
  const { protocol, chain, management } = managed;
  const uniswapPool = protocol === 'UNISWAP_V3' ? robinhoodLiquidityDetails(node as Parameters<typeof robinhoodLiquidityDetails>[0]) : null;
  const orcaPool = protocol === 'ORCA' ? solanaLiquidityDetails(node as Parameters<typeof solanaLiquidityDetails>[0]) : null;
  const pair = uniswapPool ? `${uniswapPool.tokenA} / ${uniswapPool.tokenB}` : orcaPool ? `SOL / ${orcaPool.tokenB}` : null;
  const title = liquidityPositionTitle(protocol, management), subject = liquidityPositionSubject(protocol, management.positionId);
  const network = shellChainLabel(chain).replace(/ \(\d+\)$/, '').trim();
  return { protocol, chain, management, title, subject, provider: protocol === 'UNISWAP_V3' ? 'Uniswap v3' : 'Orca Whirlpools', network, pair,
    phrase: liquidityPositionOperationPhrase(protocol, management.operation, management.close), label: `${title} · ${subject} · ${network}` };
}

/**
 * Whether preparing `choice` from the Dashboard would replace steps the owner authored: any financial step other than this very position's own
 * node (another position, a deposit, a swap…). The Editor then asks before replacing (the owner starts a new workflow for the position); a workflow
 * that already manages this same position simply takes the new choice (a new revision, so no earlier Review can be authorized for it).
 */
export function positionPreparationConflict(workflow: { readonly nodes: readonly { readonly actionType: string; readonly chainId: string }[] }, choice: LiquidityPositionChoice): boolean {
  const financial = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  if (!financial.length) return false;
  const managed = financial.length === 1 ? workflowPositionManagement({ nodes: financial }) : null;
  return !(managed && managed.protocol === choice.position.protocol && managed.chain === choice.position.chain && managed.management.positionId === choice.position.positionId);
}
/**
 * Why the Dashboard may not prepare `choice` on the open workflow now (null: it may). While that workflow is being executed or checked nothing is
 * changed (its request stays followed in Operate); a workflow with other steps is replaced only after the owner explicitly starts a new one.
 */
export function positionPreparationRefusal(workflow: Parameters<typeof positionPreparationConflict>[0], choice: LiquidityPositionChoice, executing: boolean):
  'POSITION_WORKFLOW_EXECUTING' | 'POSITION_WORKFLOW_HAS_OTHER_STEPS' | null {
  if (executing) return 'POSITION_WORKFLOW_EXECUTING';
  return positionPreparationConflict(workflow, choice) ? 'POSITION_WORKFLOW_HAS_OTHER_STEPS' : null;
}

type PositionStep = { readonly action: string; readonly input: string; readonly result: string | null; readonly resultLabel: string; readonly minimum: string | null;
  readonly networks: readonly string[]; readonly details: readonly { readonly label: string; readonly value: string }[] };
/**
 * The rows a position operation's simulated step states (its own projection's values, never recomputed). `simulate` (B2 "Simulation result"): the
 * operation, liquidity removed and remaining, the principal expected and its enforced minimum, the owed tokens and fees and the collected amount
 * as LOWER bounds, what happens to the position NFT and any rent refunded — no permission row. `execute` (C1 "You are authorizing") adds what the
 * owner authorizes it against: protocol, network, position, pool, range, prices, recipient, deadline, the contract and the one wallet request.
 */
export function liquidityPositionResultRows(step: PositionStep, stage: 'simulate' | 'execute'): { readonly label: string; readonly value: string }[] {
  const detail = (label: string) => step.details.find(line => line.label === label)?.value ?? null;
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null | undefined) => { if (value && !rows.some(row => row.label === label)) rows.push({ label, value }); };
  if (stage === 'simulate') push(step.action, step.input);
  else for (const label of ['Operation', 'Protocol']) push(label, detail(label));
  if (stage === 'execute') {
    push('Network', detail('Network') ?? step.networks[0] ?? null);
    for (const label of ['Position', 'Pool', 'Price range', 'Range state', 'Current price']) push(label, detail(label));
  }
  for (const label of ['Liquidity removed', 'Liquidity remaining', 'Liquidity']) push(label, detail(label));
  // The step's own result: the principal expected back (an Orca withdrawal names it "Expected withdrawal"), or a collection's lower bound.
  if (step.result) push(step.resultLabel === 'Expected withdrawal' ? 'Expected principal returned' : step.resultLabel, step.result);
  push('Minimum principal (enforced)', detail('Minimum principal (enforced)') ?? step.minimum);
  for (const label of ['Owed tokens and fees', 'Collected, at least', 'Fees collected, at least']) push(label, detail(label));
  if (stage === 'execute') push('Tokens returned', detail('Tokens returned'));
  for (const label of ['Position NFT', 'Account rent refunded']) push(label, detail(label));
  if (stage === 'execute') for (const label of ['Deadline', 'Position Manager', 'Wallet requests']) push(label, detail(label));
  return rows;
}
