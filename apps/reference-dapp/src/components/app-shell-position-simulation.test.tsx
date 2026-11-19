// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (audit defects 1 and 2): what the shell's Simulate (and the chat bridge's `simulate`, which is the same
 * `simulateAgain`) asks the Orca runtime for when a position operation is staged, and the Solana mainnet scoping of that runtime. A staged
 * withdrawal, exit or collection reaches the runtime as exactly that operation on exactly that position — never as an OPEN deposit — with no
 * Canvas interaction. The Uniswap side (the staged request reaching the real service) is proven in `state/uniswap-position-store.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { HookHarness } from '../test-utils/hook-harness';
import { editorReducer, initialEditor } from '../domain/editor';
import type { LiquidityPositionChoice } from '../domain/liquidity-positions';
import type { LiquidityPositionPoolInput } from '../domain/commands';
import { stagedPositionOf, type StagedPosition } from '../state/workflow-store';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ workflow: null as unknown, staged: null as unknown, mainnet: [] as unknown[], devnet: [] as unknown[] }));
const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
vi.mock('../state/workflow-store', async original => ({ ...await original<typeof import('../state/workflow-store')>(),
  useWorkflow: () => ({ state: { workflow: f.workflow }, stagedPosition: f.staged }) }));
vi.mock('../state/jupiter-store', () => ({ useJupiter: () => ({ session: { chain: 'solana:mainnet', account: { address: OWNER } } }) }));
vi.mock('../wallet/position-mint-signer', () => ({ createPositionMintSigner: async () => ({ address: '9'.repeat(43), sign: async () => new Uint8Array() }),
  signOrcaLiquidityTransaction: async () => { throw new Error('NEVER_SIGNED_HERE'); } }));
const refused = async () => ({ ok: false as const, code: 'UNUSED' });
vi.mock('../app/solana-liquidity-action', () => ({ solanaLiquidityInfo: refused, solanaLiquidityPrice: refused, solanaLiquidityPositions: refused,
  solanaLiquiditySimulate: async (...args: unknown[]) => { f.devnet.push(args); return { ok: false, code: 'DEVNET_MUST_NOT_BE_USED' }; },
  solanaLiquidityReview: refused, solanaLiquidityInvalidate: refused, solanaLiquidityBegin: refused, solanaLiquidityWalletFailure: refused, solanaLiquiditySubmit: refused,
  solanaLiquidityObserve: refused, solanaLiquidityStatus: refused }));
vi.mock('../app/solana-mainnet-liquidity-action', () => ({ solanaMainnetLiquidityInfo: refused, solanaMainnetLiquidityPrice: refused,
  solanaMainnetLiquidityPositions: async () => ({ ok: true, value: [] }),
  solanaMainnetLiquiditySimulate: async (...args: unknown[]) => { f.mainnet.push(args); return { ok: false, code: 'ORCA_SIMULATION_RECORDED_BY_TEST' }; },
  solanaMainnetLiquidityReview: refused, solanaMainnetLiquidityInvalidate: refused, solanaMainnetLiquidityBegin: refused, solanaMainnetLiquidityWalletFailure: refused,
  solanaMainnetLiquiditySubmit: refused, solanaMainnetLiquidityObserve: refused, solanaMainnetLiquidityStatus: refused }));
const { solanaPoolPrevious, solanaPoolSimulation } = await import('./app-shell');
const { SolanaLiquidityProvider, useSolanaLiquidity, solanaLiquidityNetworkOf } = await import('../state/solana-liquidity-store');

const MINT = 'Fm7mfcbKeHsUo2u8nDWjpcAfNudKk7XqzGu1QW8k6PJx';
const orcaChoice = (operation: LiquidityPositionChoice['operation'], partBps: number | null = null): LiquidityPositionChoice => ({
  position: { protocol: 'ORCA', chain: ORCA.chain, network: 'Solana', manager: ORCA.programs.whirlpool, pool: ORCA.pool.address, positionId: MINT, owner: OWNER },
  operation, partBps, close: operation === 'EXIT' });
const POOL: LiquidityPositionPoolInput = { token0: { symbol: 'SOL', address: ORCA.token0.mint, decimals: 9 }, token1: { symbol: 'USDC', address: ORCA.token1.mint, decimals: 6 },
  feeTier: 3000, tickLower: -19_200, tickUpper: -18_560, amount0: '1000000', amount1: '150000', slippageBps: 100 };
/** The workflow and staged position the workflow store holds after committing MANAGE_LIQUIDITY_POSITION (the real reducer). */
function stage(choice: LiquidityPositionChoice): StagedPosition {
  const command = { type: 'MANAGE_LIQUIDITY_POSITION' as const, choice, pool: POOL, source: 'CHAT' as const, baseRevision: 0 };
  const result = editorReducer(initialEditor(), command, createBaseSepoliaReviewContext());
  if (result.error) throw new Error(result.error);
  f.workflow = result.workflow as unknown as SemanticWorkflow;
  return stagedPositionOf(command, result.workflow, 1)!;
}
let host: HookHarness, store: ReturnType<typeof useSolanaLiquidity>;
function Probe() { store = useSolanaLiquidity(); return null; }
const read = () => host.render(() => renderToStaticMarkup(<SolanaLiquidityProvider><Probe/></SolanaLiquidityProvider>));
async function settle() { for (let i = 0; i < 10; i++) { await new Promise(resolve => setTimeout(resolve, 0)); read(); } }
beforeEach(() => {
  host = new HookHarness(); f.mainnet = []; f.devnet = []; f.staged = null; f.workflow = initialEditor().workflow;
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('Simulate of a staged position operation (Orca)', () => {
  it('an Orca mainnet choice is simulated as exactly its operation — DECREASE, EXIT and COLLECT never become OPEN', () => {
    for (const [choice, expected] of [[orcaChoice('DECREASE', 2_500), { operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 2_500 }],
      [orcaChoice('EXIT'), { operation: 'EXIT', positionMint: MINT, partBps: undefined }], [orcaChoice('COLLECT'), { operation: 'COLLECT', positionMint: MINT, partBps: undefined }]] as const) {
      const staged = stage(choice);
      // Even when the previous Review was an OPEN deposit, the staged operation wins.
      expect(solanaPoolSimulation(staged, { operation: 'OPEN', positionMint: '9'.repeat(43), partBps: null })).toEqual(expected);
    }
  });
  it('the Devnet engineering command keeps simulating its staged operation; without a staged operation the previous Review is simulated again', () => {
    const devnet: StagedPosition = { positionId: MINT, operation: 'EXIT', partBps: null, choice: null, serial: 1, workflowId: 'w', revision: 1, node: '[]' };
    expect(solanaPoolSimulation(devnet, null)).toEqual({ operation: 'EXIT', positionMint: MINT, partBps: undefined });
    expect(solanaPoolSimulation(null, null)).toEqual({ operation: 'OPEN', positionMint: undefined, partBps: undefined });
    expect(solanaPoolSimulation(null, { operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 5_000 })).toEqual({ operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 5_000 });
    // A Uniswap choice is never an Orca operation.
    const uniswap = { ...devnet, choice: { ...orcaChoice('COLLECT'), position: { ...orcaChoice('COLLECT').position, protocol: 'UNISWAP_V3' as const } } } as StagedPosition;
    expect(solanaPoolSimulation(uniswap, null)).toEqual({ operation: 'OPEN', positionMint: undefined, partBps: undefined });
  });
  it('the Orca store sends the staged operation to the Solana mainnet runtime (no Canvas interaction) and refuses an OPEN for it', async () => {
    f.staged = stage(orcaChoice('DECREASE', 5_000)); read(); await settle();
    expect(store.network).toBe('Solana');
    expect(store.owner).toBe(OWNER);
    const next = solanaPoolSimulation(f.staged as StagedPosition, null);
    await store.simulate(next.operation, next.positionMint, next.partBps); await settle();
    expect(f.mainnet).toHaveLength(1);
    expect(f.mainnet[0]).toEqual([f.workflow, OWNER, { operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 5_000 }]);
    expect(f.devnet).toHaveLength(0);
    // A deposit, another position or another share is refused before any server call.
    for (const [op, mint, part] of [['OPEN', undefined, undefined], ['EXIT', MINT, undefined], ['DECREASE_PARTIAL', MINT, 2_500], ['DECREASE_PARTIAL', '9'.repeat(43), 5_000]] as const) {
      await store.simulate(op, mint, part); await settle();
      expect(store.error, `${op}`).toBe('ORCA_POSITION_CHOICE_CHANGED');
    }
    expect(f.mainnet).toHaveLength(1);
  });
  it('a COLLECT choice reaches the runtime as COLLECT', async () => {
    f.staged = stage(orcaChoice('COLLECT')); read(); await settle();
    const next = solanaPoolSimulation(f.staged as StagedPosition, null);
    await store.simulate(next.operation, next.positionMint, next.partBps); await settle();
    expect(f.mainnet[0]).toEqual([f.workflow, OWNER, { operation: 'COLLECT', positionMint: MINT }]);
  });
  it('after a reload (no staged choice) the canonical node alone decides: a marked workflow is simulated as its operation and never as OPEN (F1)', async () => {
    stage(orcaChoice('DECREASE', 2_500)); f.staged = null; read(); await settle();
    const workflow = f.workflow as SemanticWorkflow;
    expect(solanaPoolSimulation(null, { operation: 'OPEN', positionMint: '9'.repeat(43), partBps: null }, workflow))
      .toEqual({ operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 2_500 });
    expect(store.network).toBe('Solana');
    const next = solanaPoolSimulation(null, null, workflow);
    await store.simulate(next.operation, next.positionMint, next.partBps); await settle();
    expect(f.mainnet).toEqual([[workflow, OWNER, { operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 2_500 }]]);
    for (const [op, mint, part] of [['OPEN', undefined, undefined], ['EXIT', MINT, undefined], ['DECREASE_PARTIAL', MINT, 5_000]] as const) {
      await store.simulate(op, mint, part); await settle();
      expect(store.error, `${op}`).toBe('ORCA_POSITION_CHOICE_CHANGED');
    }
    expect(f.mainnet).toHaveLength(1);
    // An unmarked workflow keeps the deposit default.
    expect(solanaPoolSimulation(null, null, initialEditor().workflow as unknown as SemanticWorkflow)).toEqual({ operation: 'OPEN', positionMint: undefined, partBps: undefined });
  });
  it('a retired run (another workflow, e.g. a new deposit at the same range) never lends its withdrawal to a deposit: it simulates an OPEN (flofi-workflow P2)', () => {
    const review = { operation: 'DECREASE_PARTIAL', accounts: { positionMint: MINT }, partBps: 5_000 };
    const deposit = initialEditor().workflow as unknown as SemanticWorkflow;
    expect(solanaPoolSimulation(null, solanaPoolPrevious(review, true), deposit)).toEqual({ operation: 'OPEN', positionMint: undefined, partBps: undefined });
    // The same run of exactly this workflow is simulated again as itself.
    expect(solanaPoolSimulation(null, solanaPoolPrevious(review, false), deposit)).toEqual({ operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 5_000 });
    expect(solanaPoolPrevious(null, false)).toBeNull();
  });
  it('Solana mainnet scoping: with no authored position the product and a mainnet session use Solana mainnet; only the engineering scope defaults to Devnet', () => {
    expect(solanaLiquidityNetworkOf({ authored: null, stagedMainnet: false, record: null, sessionChain: 'solana:mainnet', publicMainnet: false })).toBe('Solana');
    expect(solanaLiquidityNetworkOf({ authored: null, stagedMainnet: false, record: null, sessionChain: null, publicMainnet: true })).toBe('Solana');
    expect(solanaLiquidityNetworkOf({ authored: null, stagedMainnet: true, record: 'Solana Devnet', sessionChain: 'solana:devnet', publicMainnet: false })).toBe('Solana');
    expect(solanaLiquidityNetworkOf({ authored: 'Solana Devnet', stagedMainnet: false, record: null, sessionChain: 'solana:mainnet', publicMainnet: true })).toBe('Solana Devnet');
    expect(solanaLiquidityNetworkOf({ authored: null, stagedMainnet: false, record: null, sessionChain: null, publicMainnet: false })).toBe('Solana Devnet');
  });
});
