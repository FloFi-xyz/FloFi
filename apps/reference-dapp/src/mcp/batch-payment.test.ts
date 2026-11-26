// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): Batch Payment over the real MCP gateway (ChatGPT / Claude), in the public mainnet scope. One
 * strategy step with its exact recipients and amounts; its legs and its batch are reported; discovery offers it on the four EVM mainnets only; a
 * preview needs the owner's wallet (the atomic batch is simulated at the signing surface); MCP has no signing authority.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { credential, gatewayEnv, session } from './gateway.test-harness.ts';

const alice = { principal: 'dev-alice', token: credential() };
const env = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' });
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment over MCP', () => {
  it('composes ONE Batch Payment: the canonical strategy keeps the exact recipients; its three legs and its batch are reported; one step was asked for', async () => {
    const client = session({ env, token: alice.token });
    const out = (await client.callTool('compose_strategy', { strategy: BATCH, expectedStepCount: 1 })).output as Record<string, unknown> & {
      workflowSteps: { action: string; strategy: { recipient: string; amount: string } }[]; batchPayments: unknown[] };
    expect(out).toMatchObject({ ok: true, strategy: { version: 2, steps: [{ action: 'batch_payment', network: 'base', asset: 'USDC', recipients: BATCH.recipients }] },
      stepCount: 3, authority: expect.stringMatching(/^NONE/), readiness: { execution: 'NOT_EVALUATED', ownerAuthorization: 'NONE', submission: 'NOT_SUBMITTED' } });
    expect(out.workflowSteps.map(s => [s.action, s.strategy.amount, s.strategy.recipient])).toEqual([['transfer', '25', A], ['transfer', '50', B], ['transfer', '75', C]]);
    expect(out.batchPayments).toEqual([{ step: 0, legs: [0, 2], network: 'base', asset: 'USDC', recipients: 3, total: '150', execution: 'ATOMIC_ONLY' }]);
    const engine = composeWorkflow(BATCH);
    expect(engine.ok && engine.workflowHash).toBe(out.workflowHash);
    expect((await client.callTool('validate_strategy', { strategy: out.strategy, workflowHash: out.workflowHash })).output).toMatchObject({ ok: true, valid: true, stepCount: 3 });
  });

  it('refuses a duplicate recipient and Solana explicitly; never merges, drops or reroutes a payment', async () => {
    const client = session({ env, token: alice.token });
    const dup = await client.callTool('compose_strategy', { strategy: { ...BATCH, recipients: [{ recipient: A, amount: '1' }, { recipient: A, amount: '2' }] } });
    expect(dup.output).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_DUPLICATE_RECIPIENT' });
    expect(dup.texts.join('\n')).toMatch(/more than once|mais de uma vez/);
    const solana = await client.callTool('compose_strategy', { strategy: { ...BATCH, network: 'solana' } });
    expect(solana.isError).toBe(true);
  });

  it('discovery: batch_payment on Base, Arbitrum One, Ethereum and Robinhood Chain, never Solana; the strategy cannot be previewed without the owner wallet', async () => {
    const client = session({ env, token: alice.token });
    const networks = (await client.callTool('get_supported_networks', {})).output.networks as { id: string; actions: string[] }[];
    expect(networks.filter(n => n.actions.includes('batch_payment')).map(n => n.id).sort()).toEqual(['arbitrum-one', 'base', 'ethereum', 'robinhood']);
    const assets = (await client.callTool('get_supported_assets', { network: 'base' })).output.assets as { symbol: string; actions: string[] }[];
    expect(assets.find(a => a.symbol === 'USDC')!.actions).toContain('batch_payment');
    const composed = (await client.callTool('compose_strategy', { strategy: BATCH })).output;
    const preview = (await client.callTool('simulate_strategy', { strategy: composed.strategy, workflowHash: composed.workflowHash, simulationSubject: A })).output;
    expect(preview).toMatchObject({ ok: true, kind: 'WORKFLOW_PREVIEW', authorizable: false, status: 'INCOMPLETE' });
  });
});
