// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: Chat and Canvas hold ONE workflow. A multi-step strategy authored in Chat (or MCP / a channel) opens in
 * the Canvas as one workflow that reads back to exactly the same canonical strategy hash, and a Canvas workflow becomes exactly the strategy
 * Chat composes — across EVM networks, EVM → Solana, Solana → EVM and Solana-only sequences, with typed dependent amounts.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { canvasWorkflowOfStrategy, editorWorkflowStrategy } from './workflow-strategy';

const OWNER = '0x' + '1'.repeat(40);
const SWAP_BASE = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
const SUPPLY_BASE = { action: 'supply', network: 'base', asset: 'WETH', amount: '0.002', beneficiary: OWNER };
const BRIDGE_BASE_SOLANA = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '5' };
const SOL_SWAP = { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '5' };
const SOL_SEND = { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.01', recipient: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' };
const BRIDGE_SOLANA_BASE = { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
const CASES: Readonly<Record<string, unknown>> = {
  'EVM: swap then supply what the swap delivered': { version: 2, steps: [SWAP_BASE, SUPPLY_BASE], bindings: [{ step: 1, amountFrom: 0 }] },
  'EVM → Solana: bridge then swap the delivered USDC to SOL': { version: 2, steps: [BRIDGE_BASE_SOLANA, SOL_SWAP], bindings: [{ step: 1, amountFrom: 0 }] },
  'Solana → EVM: bridge then swap the delivered USDC on Base': { version: 2, steps: [BRIDGE_SOLANA_BASE, SWAP_BASE], bindings: [{ step: 1, amountFrom: 0 }] },
  'Solana only: swap then send the SOL it delivered': { version: 2, steps: [SOL_SWAP, SOL_SEND], bindings: [{ step: 1, amountFrom: 0 }] },
};

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 Chat ↔ Canvas parity', () => {
  for (const [name, strategy] of Object.entries(CASES)) it(`${name}: Chat → Canvas → Chat keeps the canonical hash`, () => {
    const chat = composeWorkflow(strategy);
    expect(chat.ok).toBe(true);
    if (!chat.ok) return;
    const canvas = canvasWorkflowOfStrategy(strategy);
    expect(canvas).toMatchObject({ ok: true, workflowHash: chat.workflowHash });
    if (!canvas.ok) return;
    // One Canvas workflow with every step, in order.
    expect(canvas.workflow.nodes.filter(n => !n.actionType.startsWith('mock-'))).toHaveLength(chat.steps.length);
    const back = editorWorkflowStrategy(canvas.workflow);
    expect(back).toMatchObject({ ok: true, workflowHash: chat.workflowHash, stepCount: chat.steps.length });
    if (!back.ok) return;
    // The Canvas spells assets by exact identity, Chat by symbol: both compose to the same IR, bindings and hash (one workflow).
    const again = composeWorkflow(back.strategy);
    expect(again.ok && again.workflowHash).toBe(chat.workflowHash);
    expect(back.composition.bindings).toEqual(chat.bindings);
  });

  it('refuses a strategy whose bindings differ from what the Canvas would fund (never two interpretations of one workflow)', () => {
    // Without the binding, the Canvas would still fund the supply from the swap's delivered WETH: not the same workflow.
    expect(canvasWorkflowOfStrategy({ version: 2, steps: [SWAP_BASE, SUPPLY_BASE] })).toMatchObject({ ok: false, code: 'CANVAS_PARITY_FAILED' });
    expect(canvasWorkflowOfStrategy({ version: 2, steps: [SOL_SWAP, SOL_SEND] })).toMatchObject({ ok: false, code: 'CANVAS_PARITY_FAILED' });
    expect(canvasWorkflowOfStrategy({ version: 2, steps: [SWAP_BASE] })).toMatchObject({ ok: false });
  });
});
