// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the canonical identity and verified read of one concentrated-liquidity position, shared by discovery
 * (Dashboard, Chat), authoring (the management command) and the runtimes (Uniswap v3 position runs, Orca runs).
 *
 * A position is bound to its network (CAIP-2 chain), protocol, position manager (Uniswap NonfungiblePositionManager or the Whirlpools program),
 * verified pool and position id (Uniswap token id or Orca position mint), and to the owner verified on chain when it was read. The same token id
 * on two networks is two positions: the key always includes the chain and the manager.
 *
 * Amounts a source could not verify are null ("unavailable"), never zero. Owed tokens a Uniswap position carries may include principal withdrawn
 * earlier without collecting, so they are never labelled as yield.
 */
import { LIQUIDITY_MANAGEMENT_INPUT, readConcentratedLiquidityManagement, type ConcentratedLiquidityManagement } from '@defi-workflow-engine/workflow-contracts';
export type LiquidityPositionProtocol = 'UNISWAP_V3' | 'ORCA';
/** COLLECT: owed tokens and fees only (liquidity unchanged). DECREASE: a share of the position's liquidity. EXIT: all of it (Orca also closes the position). */
export type LiquidityPositionOperation = 'COLLECT' | 'DECREASE' | 'EXIT';
export const LIQUIDITY_POSITION_OPERATIONS: readonly LiquidityPositionOperation[] = Object.freeze(['COLLECT', 'DECREASE', 'EXIT']);
export type LiquidityPositionRef = {
  readonly protocol: LiquidityPositionProtocol;
  /** CAIP-2 chain id (eip155:8453, solana:5eykt4…). */ readonly chain: string;
  /** Display name of the network (Base, Arbitrum One, Ethereum, Robinhood Chain, Solana). */ readonly network: string;
  /** Uniswap NonfungiblePositionManager address, or the Whirlpools program id. */ readonly manager: string;
  readonly pool: string;
  /** Uniswap token id (decimal) or Orca position mint (base58). */ readonly positionId: string;
  /** The owner verified on chain at the observation (lowercase EVM address or base58). */ readonly owner: string;
};
export type LiquidityPositionToken = { readonly symbol: string; readonly address: string; readonly decimals: number };
export type LiquidityPositionManageability =
  | { readonly ok: true }
  /** POOL_NOT_VERIFIED: a Uniswap v3 pair or pool FloFi cannot verify (non-catalog token or pool). Orca discovery reads only the verified SOL/USDC
   * Whirlpool; positions on other Whirlpools are not listed (a documented follow-up). LEGACY_POSITION_TOKEN / DELEGATED_POSITION_TOKEN: an Orca
   * position token the verified engine does not manage. REWARDS_UNSUPPORTED: emitting reward state the engine refuses. */
  | { readonly ok: false; readonly reason: 'POOL_NOT_VERIFIED' | 'LEGACY_POSITION_TOKEN' | 'DELEGATED_POSITION_TOKEN' | 'REWARDS_UNSUPPORTED' };
export type LiquidityPositionView = {
  readonly ref: LiquidityPositionRef;
  readonly token0: LiquidityPositionToken; readonly token1: LiquidityPositionToken;
  /** Pool fee in hundredths of a basis point (500 = 0.05%). */ readonly feeTier: number;
  readonly tickLower: number; readonly tickUpper: number;
  /** Prices are `quote` units per one `base` unit (the orientation FloFi's Review uses for this pool): the range bounds and the current pool price
   * (null when the pool price could not be read). */
  readonly price: { readonly base: string; readonly quote: string };
  readonly lowerPrice: string; readonly upperPrice: string; readonly currentPrice: string | null;
  readonly rangeState: 'IN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' | null;
  readonly liquidity: string;
  /** Principal the liquidity represents at the current pool price (rounded down as a removal would be). */
  readonly principal: readonly [string | null, string | null];
  /** Tokens the manager has already checkpointed as owed (Uniswap tokensOwed, Orca fee owed). */
  readonly recordedOwed: readonly [string, string];
  /** Exactly what a collection would pay at the observation (a static call of the protocol's own collect), or null when unavailable. */
  readonly collectable: readonly [string, string] | null;
  /** OPEN: has liquidity. EMPTY: no liquidity left (owed tokens and/or the position NFT remain). */
  readonly status: 'OPEN' | 'EMPTY';
  readonly manageable: LiquidityPositionManageability;
  /** The operations FloFi can prepare for this position now (capability-driven; nothing executes without Review and the owner's signature). */
  readonly operations: readonly LiquidityPositionOperation[];
  readonly observedAt: string;
  /** EVM block or Solana slot of the read. */ readonly observedAtHeight: number | null;
};

/** Unique across networks and managers: the same Uniswap token id on Base and Arbitrum are different positions. */
export const liquidityPositionKey = (ref: Pick<LiquidityPositionRef, 'chain' | 'manager' | 'positionId'>) => `${ref.chain}:${ref.manager}:${ref.positionId}`;
export const sameLiquidityPosition = (a: LiquidityPositionRef, b: LiquidityPositionRef) =>
  liquidityPositionKey(a) === liquidityPositionKey(b) && a.protocol === b.protocol && a.owner === b.owner;

const EVM = /^0x[0-9a-f]{40}$/, BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, TOKEN_ID = /^[1-9][0-9]{0,77}$/;
/** Strict shape check (commands, persistence and transports carry a ref; nothing else is accepted). */
export function liquidityPositionRefValid(value: unknown): value is LiquidityPositionRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'chain,manager,network,owner,pool,positionId,protocol') return false;
  if (typeof v.network !== 'string' || !/^[A-Za-z][A-Za-z ]{1,40}$/.test(v.network) || typeof v.chain !== 'string') return false;
  if (v.protocol === 'UNISWAP_V3') return /^eip155:[1-9][0-9]{0,9}$/.test(v.chain) && [v.manager, v.pool, v.owner].every(x => typeof x === 'string' && EVM.test(x)) &&
    typeof v.positionId === 'string' && TOKEN_ID.test(v.positionId);
  if (v.protocol === 'ORCA') return /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(v.chain) && [v.manager, v.pool, v.owner, v.positionId].every(x => typeof x === 'string' && BASE58.test(x));
  return false;
}
/** The operations a verified position supports, from its state alone (the runtime verifies again at Review and before each wallet request). */
export function liquidityPositionOperations(view: Pick<LiquidityPositionView, 'manageable' | 'liquidity' | 'recordedOwed' | 'collectable'>): LiquidityPositionOperation[] {
  if (!view.manageable.ok) return [];
  const liquid = /^[1-9][0-9]*$/.test(view.liquidity);
  const owed = [...view.recordedOwed, ...view.collectable ?? []].some(amount => /^[1-9][0-9]*$/.test(amount));
  // A position with liquidity may accrue fees not yet checkpointed; collecting is offered and the simulation decides whether anything is due.
  return [...liquid || owed ? ['COLLECT' as const] : [], ...liquid ? ['DECREASE' as const] : [], 'EXIT' as const];
}

/** The owner's staged choice for one position, before any simulation. `close` burns an emptied Uniswap NFT; an Orca exit always closes the position. */
export type LiquidityPositionChoice = { readonly position: LiquidityPositionRef; readonly operation: LiquidityPositionOperation; readonly partBps: number | null;
  readonly close: boolean };
export function liquidityPositionChoiceValid(choice: unknown): choice is LiquidityPositionChoice {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return false;
  const c = choice as Record<string, unknown>;
  if (Object.keys(c).sort().join() !== 'close,operation,partBps,position' || !liquidityPositionRefValid(c.position) ||
      !LIQUIDITY_POSITION_OPERATIONS.includes(c.operation as LiquidityPositionOperation) || typeof c.close !== 'boolean') return false;
  if (c.operation === 'DECREASE' ? !Number.isSafeInteger(c.partBps) || (c.partBps as number) < 1 || (c.partBps as number) > 9_999 : c.partBps !== null) return false;
  const orca = (c.position as LiquidityPositionRef).protocol === 'ORCA';
  // Orca: EXIT is the verified remove-all + collect + close; there is no separate close. Uniswap: closing (burn) only with a full exit, never implied.
  return orca ? c.close === (c.operation === 'EXIT') : !c.close || c.operation === 'EXIT';
}
/** The Uniswap position runtime's request for a staged choice. */
export function uniswapPositionRequestOf(choice: LiquidityPositionChoice): { operation: 'COLLECT' | 'DECREASE' | 'EXIT'; tokenId: string; partBps: number | null; close: boolean } {
  if (choice.position.protocol !== 'UNISWAP_V3' || !liquidityPositionChoiceValid(choice)) throw new Error('LIQUIDITY_POSITION_CHOICE_INVALID');
  return { operation: choice.operation, tokenId: choice.position.positionId, partBps: choice.partBps, close: choice.close };
}
/** The Orca runtime's request for a staged choice (the engine's own operation names). */
export function orcaPositionRequestOf(choice: LiquidityPositionChoice): { operation: 'COLLECT' | 'DECREASE_PARTIAL' | 'EXIT'; positionMint: string; partBps?: number } {
  if (choice.position.protocol !== 'ORCA' || !liquidityPositionChoiceValid(choice)) throw new Error('LIQUIDITY_POSITION_CHOICE_INVALID');
  return choice.operation === 'DECREASE' ? { operation: 'DECREASE_PARTIAL', positionMint: choice.position.positionId, partBps: choice.partBps! }
    : { operation: choice.operation, positionMint: choice.position.positionId };
}

/**
 * The position operation a workflow's canonical node names (its management marker), or null for any other workflow. This — not client state —
 * decides that a workflow takes the position path: a reloaded, restored or chat-authored position workflow is never simulated as a deposit.
 * A malformed marker reads as null here (display); every runtime refuses it.
 */
export type WorkflowPositionManagement = { readonly protocol: LiquidityPositionProtocol; readonly chain: string; readonly management: ConcentratedLiquidityManagement };
export function workflowPositionManagement(workflow: { readonly nodes: readonly unknown[] } | null | undefined): WorkflowPositionManagement | null {
  const nodes = (workflow?.nodes ?? []).filter(node => (node as { actionType?: unknown })?.actionType === 'asset.liquidity.concentrated');
  if (nodes.length !== 1) return null;
  const node = nodes[0] as Parameters<typeof readConcentratedLiquidityManagement>[0];
  try {
    const { management } = readConcentratedLiquidityManagement(node);
    const protocol = node.adapterConstraints.protocols.join();
    return management && (protocol === 'uniswap-v3' || protocol === 'orca-whirlpools')
      ? { protocol: protocol === 'uniswap-v3' ? 'UNISWAP_V3' : 'ORCA', chain: node.chainId, management } : null;
  } catch { return null; }
}
/**
 * A workflow that holds a position-management node (well-formed or not) beside any other financial step. A position operation runs as its
 * workflow's ONLY financial step (one runtime, one wallet request): the Editor never produces such a mix — adding, duplicating or chatting
 * another step onto a position workflow is refused. A mix restored from elsewhere (saved or handed-off bytes) is not produced here and fails
 * closed at the runtimes, which accept only an isolated position node (`*_ISOLATED_ONLY`).
 */
export function workflowMixesPositionManagement(workflow: { readonly nodes: readonly { readonly actionType: string; readonly inputs?: readonly { readonly name: string }[] }[] }): boolean {
  const financial = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  return financial.length > 1 && financial.some(node => node.actionType === 'asset.liquidity.concentrated' && (node.inputs ?? []).some(input => input.name === LIQUIDITY_MANAGEMENT_INPUT));
}
/** The Uniswap position runtime's request a marked workflow names. */
export const uniswapPositionRequestOfMarker = (m: ConcentratedLiquidityManagement) => ({ operation: m.operation, tokenId: m.positionId, partBps: m.partBps, close: m.close });
/** The Orca runtime's request a marked workflow names (EXIT always closes; an EXIT that keeps the position is not an Orca operation). */
export function orcaPositionRequestOfMarker(m: ConcentratedLiquidityManagement): { operation: 'COLLECT' | 'DECREASE_PARTIAL' | 'EXIT'; positionMint: string; partBps: number | null } | null {
  return m.operation === 'COLLECT' ? { operation: 'COLLECT', positionMint: m.positionId, partBps: null }
    : m.operation === 'DECREASE' ? { operation: 'DECREASE_PARTIAL', positionMint: m.positionId, partBps: m.partBps }
      : m.close ? { operation: 'EXIT', positionMint: m.positionId, partBps: null } : null;
}
