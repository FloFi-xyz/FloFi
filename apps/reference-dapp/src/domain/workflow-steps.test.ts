// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { initialEditor } from './editor';
import { applyCommand, BASE_CONTEXT, buildWorkflow, contextFor, FIXTURE, TEST_WALLET } from './copilot-test-fixtures';
import { workflowSteps } from './workflow-steps';

const steps = (sentences: readonly string[]) => { const workflow = buildWorkflow(sentences); return workflowSteps(workflow, contextFor(workflow)); };

describe('workflow steps (read-only descriptors of the canonical IR)', () => {
  it('describes the untouched template as one protected template step', () => {
    const [only, ...rest] = workflowSteps(initialEditor().workflow, BASE_CONTEXT);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ index: 1, nodeId: 'node-001', kind: 'TEMPLATE', detail: { type: 'TEMPLATE', template: 'read' }, removable: false, testFunds: true });
  });
  it('reads Aave steps with their amount, beneficiary, failure policy and authorization class', () => {
    const [supply] = steps([FIXTURE.supply]);
    expect(supply).toMatchObject({ index: 1, nodeId: 'node-002', kind: 'SUPPLY', protocol: 'Aave V3', network: 'Base Sepolia', testFunds: true, removable: true,
      failurePolicy: 'ABORT', authorization: 'MODE_A', detail: { type: 'AAVE', operation: 'SUPPLY', input: { amount: '5', beneficiary: TEST_WALLET } } });
    expect(steps([FIXTURE.borrow])[0]).toMatchObject({ kind: 'BORROW', detail: { operation: 'BORROW', input: { amount: '2' } } });
    expect(steps([FIXTURE.repay])[0]).toMatchObject({ kind: 'REPAY', detail: { operation: 'REPAY', input: { amount: '1' } } });
    expect(steps([FIXTURE.withdraw])[0]).toMatchObject({ kind: 'WITHDRAW', detail: { type: 'AAVE_WITHDRAW', input: { amount: '3', recipient: 'CONNECTED_OWNER' } } });
  });
  it('numbers several swaps in canonical dependency order and marks Base as real funds', () => {
    const [first, second] = steps([FIXTURE.baseSwap, FIXTURE.baseSwap2]);
    expect(first).toMatchObject({ index: 1, kind: 'SWAP', protocol: 'Uniswap v3', network: 'Base', testFunds: false,
      detail: { type: 'EVM_SWAP', network: 'Base', from: 'USDC', to: 'WETH', amount: '2', slippage: '50' } });
    expect(second).toMatchObject({ index: 2, nodeId: 'node-003', detail: { amount: '3' } });
    expect(steps([FIXTURE.testnetSwap])[0]).toMatchObject({ network: 'Base Sepolia', testFunds: true, detail: { network: 'Base Sepolia', amount: '3' } });
  });
  it('reads the Router bridge, Solana swaps and both liquidity pools', () => {
    const [bridge, ...none] = steps([FIXTURE.bridge]);
    expect(none).toEqual([]);
    // BUILD-SOLANA-MAINNET-001 (intentional change, requirement D): the only action is removable; the Canvas is then empty.
    expect(bridge).toMatchObject({ kind: 'BRIDGE', network: 'Base Sepolia → Arbitrum Sepolia', testFunds: true, removable: true,
      detail: { type: 'ROUTER', network: 'testnet', input: { source: 'Base Sepolia', destination: 'Arbitrum Sepolia', amount: '1', recipient: '', routing: 'AUTO' } } });
    expect(steps([FIXTURE.mainnetBridge])[0]).toMatchObject({ network: 'Base → Arbitrum One', testFunds: false });
    expect(steps([FIXTURE.solanaSwap])[0]).toMatchObject({ kind: 'SWAP', protocol: 'Jupiter', testFunds: false, detail: { type: 'SOLANA_SWAP', input: { from: 'SOL', to: 'USDC' } } });
    expect(steps([FIXTURE.devnetSwap])[0]).toMatchObject({ kind: 'SWAP', network: 'Solana Devnet', testFunds: true });
    expect(steps([FIXTURE.uniswap])[0]).toMatchObject({ kind: 'LIQUIDITY', detail: { type: 'UNISWAP_LIQUIDITY', input: { maxUsdc: '100', maxWeth: '0.05', slippage: '100' } } });
    expect(steps([FIXTURE.orca])[0]).toMatchObject({ kind: 'LIQUIDITY', detail: { type: 'ORCA_LIQUIDITY', input: { maxSol: '1', lower: '-1024', upper: '1024' } } });
  });
  // BUILD-SOLANA-MAINNET-001 (intentional change, requirement D): composition steps are removable; what cannot run alone goes with them.
  it('presents the lending composition as three removable steps that share one input', () => {
    const composition = steps([FIXTURE.lending]);
    expect(composition.map(step => step.kind)).toEqual(['SUPPLY', 'BORROW', 'SWAP']);
    expect(composition.every(step => step.removable && step.detail.type === 'LENDING_COMPOSITION')).toBe(true);
    expect(composition[2]).toMatchObject({ protocol: 'Uniswap v3', detail: { role: 'SWAP', input: { supply: '10', borrow: '4', slippage: '50', owner: TEST_WALLET } } });
  });
  it('describes legacy actions without typing them as editable steps', () => {
    const workflow = applyCommand(initialEditor().workflow, { type: 'ADD_COW_SWAP', direction: 'USDC_TO_WETH', amount: '2', slippage: '50', source: 'CANVAS', baseRevision: 0 });
    expect(workflowSteps(workflow, BASE_CONTEXT)[0]).toMatchObject({ kind: 'OTHER', network: 'Base', testFunds: false });
  });
});
