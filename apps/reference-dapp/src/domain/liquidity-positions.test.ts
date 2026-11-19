// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { readConcentratedLiquidity, readConcentratedLiquidityManagement } from '@defi-workflow-engine/workflow-contracts';
import { editorReducer, initialEditor } from './editor';
import { liquidityPositionChoiceValid, liquidityPositionOperations, orcaPositionRequestOf, uniswapPositionRequestOf, type LiquidityPositionChoice,
  type LiquidityPositionRef } from './liquidity-positions';

const context = createBaseSepoliaReviewContext();
const OWNER = 'C'.repeat(32), MINT = 'D'.repeat(32);
const orca: LiquidityPositionRef = { protocol: 'ORCA', chain: ORCA.chain, network: 'Solana', manager: ORCA.programs.whirlpool, pool: ORCA.pool.address, positionId: MINT, owner: OWNER };
const uni: LiquidityPositionRef = { protocol: 'UNISWAP_V3', chain: 'eip155:8453', network: 'Base', manager: '0x' + '1'.repeat(40), pool: '0x' + '2'.repeat(40), positionId: '42',
  owner: '0x' + '3'.repeat(40) };
const choice = (position: LiquidityPositionRef, operation: LiquidityPositionChoice['operation'], partBps: number | null, close: boolean): LiquidityPositionChoice =>
  ({ position, operation, partBps, close });

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 liquidity position choices', () => {
  it('keeps the operations apart: a percentage only for a withdrawal, closing never implied for Uniswap, an Orca exit always closes', () => {
    expect(liquidityPositionChoiceValid(choice(uni, 'DECREASE', 5_000, false))).toBe(true);
    expect(liquidityPositionChoiceValid(choice(uni, 'EXIT', null, false))).toBe(true);
    expect(liquidityPositionChoiceValid(choice(uni, 'EXIT', null, true))).toBe(true);
    expect(liquidityPositionChoiceValid(choice(uni, 'COLLECT', null, true))).toBe(false);
    expect(liquidityPositionChoiceValid(choice(uni, 'DECREASE', 10_000, false))).toBe(false);
    expect(liquidityPositionChoiceValid(choice(uni, 'COLLECT', 100, false))).toBe(false);
    expect(liquidityPositionChoiceValid(choice(orca, 'EXIT', null, true))).toBe(true);
    expect(liquidityPositionChoiceValid(choice(orca, 'EXIT', null, false))).toBe(false);
    expect(liquidityPositionChoiceValid(choice(orca, 'COLLECT', null, false))).toBe(true);
    expect(liquidityPositionChoiceValid({ ...choice(uni, 'EXIT', null, false), extra: 1 })).toBe(false);
  });
  it('maps a choice to each runtime\'s own request, and never a withdrawal to an open or a collect to a withdrawal', () => {
    expect(uniswapPositionRequestOf(choice(uni, 'DECREASE', 2_500, false))).toEqual({ operation: 'DECREASE', tokenId: '42', partBps: 2_500, close: false });
    expect(orcaPositionRequestOf(choice(orca, 'DECREASE', 2_500, false))).toEqual({ operation: 'DECREASE_PARTIAL', positionMint: MINT, partBps: 2_500 });
    expect(orcaPositionRequestOf(choice(orca, 'COLLECT', null, false))).toEqual({ operation: 'COLLECT', positionMint: MINT });
    expect(orcaPositionRequestOf(choice(orca, 'EXIT', null, true))).toEqual({ operation: 'EXIT', positionMint: MINT });
    expect(() => orcaPositionRequestOf(choice(uni, 'EXIT', null, false))).toThrow('LIQUIDITY_POSITION_CHOICE_INVALID');
    expect(() => uniswapPositionRequestOf(choice(orca, 'EXIT', null, true))).toThrow('LIQUIDITY_POSITION_CHOICE_INVALID');
  });
  it('offers operations from the verified state only', () => {
    const base = { manageable: { ok: true } as const, recordedOwed: ['0', '0'] as const, collectable: null };
    expect(liquidityPositionOperations({ ...base, liquidity: '10' })).toEqual(['COLLECT', 'DECREASE', 'EXIT']);
    expect(liquidityPositionOperations({ ...base, liquidity: '0', recordedOwed: ['5', '0'] })).toEqual(['COLLECT', 'EXIT']);
    expect(liquidityPositionOperations({ ...base, liquidity: '0' })).toEqual(['EXIT']);
    expect(liquidityPositionOperations({ ...base, liquidity: '10', manageable: { ok: false, reason: 'POOL_NOT_VERIFIED' } })).toEqual([]);
  });
  it('authors the Orca position\'s exact pool node from a choice, and refuses to drop other financial steps', () => {
    const pool = { token0: { symbol: 'SOL', address: ORCA.token0.mint, decimals: 9 }, token1: { symbol: 'USDC', address: ORCA.token1.mint, decimals: 6 }, feeTier: ORCA.feeTier,
      tickLower: -39_104, tickUpper: -36_992, amount0: '123000000', amount1: '4500000', slippageBps: 100 };
    const next = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice: choice(orca, 'DECREASE', 5_000, false), pool, source: 'CHAT', baseRevision: 0 }, context);
    expect(next.error).toBeNull();
    const node = next.workflow.nodes.find(n => n.actionType === 'asset.liquidity.concentrated')!;
    expect(node.chainId).toBe(ORCA.chain);
    // The operation is in the canonical node (so a new choice is a new workflow), and the strict deposit reader refuses the marked node.
    const { node: unmarked, management } = readConcentratedLiquidityManagement(node as never);
    expect(management).toEqual({ positionId: MINT, operation: 'DECREASE', partBps: 5_000, close: false });
    expect(() => readConcentratedLiquidity(node as never)).toThrow('LIQUIDITY_PORTS_INVALID');
    expect(readConcentratedLiquidity(unmarked)).toMatchObject({ tickLower: -39_104, tickUpper: -36_992, feeTier: ORCA.feeTier, slippageBps: 100 });
    const quarter = editorReducer(next, { type: 'MANAGE_LIQUIDITY_POSITION', choice: choice(orca, 'DECREASE', 2_500, false), pool, source: 'CHAT', baseRevision: next.workflow.revision }, context);
    expect(quarter.error).toBeNull();
    expect(quarter.workflow.revision).toBe(next.workflow.revision + 1);
    const wrongPool = editorReducer(initialEditor(), { type: 'MANAGE_LIQUIDITY_POSITION', choice: choice({ ...orca, pool: 'E'.repeat(32) }, 'EXIT', null, true), pool,
      source: 'CHAT', baseRevision: 0 }, context);
    expect(wrongPool.error).toBe('ORCA_POSITION_POOL_MISMATCH');
    const withSwap = editorReducer(initialEditor(), { type: 'ADD_SOLANA_SWAP', input: { network: 'Solana', from: 'SOL', to: 'USDC', amount: '0.1', slippage: '50' },
      source: 'CANVAS', baseRevision: 0 }, context);
    expect(withSwap.error).toBeNull();
    const blocked = editorReducer(withSwap, { type: 'MANAGE_LIQUIDITY_POSITION', choice: choice(orca, 'EXIT', null, true), pool, source: 'CHAT',
      baseRevision: withSwap.workflow.revision }, context);
    expect(blocked.error).toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
  });
});
