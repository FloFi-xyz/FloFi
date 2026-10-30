// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { canonicalStrategy } from '../channels/core/strategy';
import { composeStrategy } from '../engine/strategy-engine';
import { executionPlan } from '../mcp/execution';
import { solanaTransferDetails } from './solana-transfer-authoring';
import { copilotSupportsSection } from '../server/copilot-capabilities';
import { PENDING_AGENT_CAPABILITIES } from './agent-rollout';

const recipient = 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH';
describe('Solana transfers across Copilot, channels and MCP', () => {
  it.each([
    ['SOLANA', 'Solana', 'SOL', '0.01', 'solana-transfer'],
    ['SOLANA', 'Solana', 'USDC', '1.5', 'solana-transfer'],
    ['SOLANA', 'Solana', 'USDT', '2', 'solana-transfer'],
    ['SOLANA_DEVNET', 'Solana Devnet', 'SOL', '0.01', 'solana-devnet-transfer'],
    ['SOLANA_DEVNET', 'Solana Devnet', 'devUSDC', '1.5', 'solana-devnet-transfer'],
  ])('grounds %s %s %s in the user request and uses the executable transfer flow', (network, label, asset, amount, flow) => {
    const session = new CopilotSession();
    const reply = session.say(`Please send ${amount} ${asset} on ${label} to the wallet ${recipient}`, intent.action(act.transfer({ network, asset, amount, recipient })));
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_RH_TRANSFER', input: { network: label, asset, amount, recipient } } });
    const command = session.pending!.command;
    const canonical = canonicalStrategy(command);
    expect(canonical.ok).toBe(true); if (!canonical.ok) return;
    const composition = composeStrategy(canonical.spec);
    expect(composition.ok).toBe(true); if (!composition.ok) return;
    expect(executionPlan(composition)).toMatchObject({ kind: 'SINGLE_FLOW', flow });
    session.apply();
    expect(session.workflow.nodes.map(solanaTransferDetails).find(Boolean)).toMatchObject({ network: label, symbol: asset, amount, recipient });
  });
  it('requires the exact case-sensitive destination, refuses an invented address and asks when it is missing', () => {
    const session = new CopilotSession();
    const fabricated = session.say('Please send 1 USDC on Solana to my friend', intent.action(act.transfer({ network: 'SOLANA', asset: 'USDC', amount: '1', recipient })));
    expect(fabricated?.kind).toBe('CLARIFICATION'); expect(session.pending).toBeNull();
    const fresh = new CopilotSession();
    expect(fresh.say('Please send 1 USDC to me on Solana', intent.action(act.transfer({ network: 'SOLANA', asset: 'USDC', amount: '1' })))?.kind).toBe('CLARIFICATION');
  });
  it('advertises Solana assets and an explicit base58 destination in the interpreter capability instructions', () => {
    const section = copilotSupportsSection();
    expect(section).toContain('Solana: SOL, USDC or USDT'); expect(section).toContain('case-sensitive');
  });
  it.each([['ETHEREUM_SEPOLIA', 'Ethereum Sepolia'], ['ROBINHOOD_TESTNET', 'Robinhood Chain Testnet']])('keeps the existing %s native self-transfer available through chat and handoff', (network, label) => {
    const request = `Please send 0.000001 ETH to my own wallet on ${label}`, action = act.transfer({ network, asset: 'ETH', amount: '0.000001' });
    // Audit A9: until the owner approves this agent rollout, the Copilot proposes nothing for it.
    const unreleased = new CopilotSession();
    expect(unreleased.say(request, intent.action(action))?.kind).not.toBe('PROPOSAL');
    expect(unreleased.pending).toBeNull();
    const session = new CopilotSession();
    session.agentRollout = PENDING_AGENT_CAPABILITIES;
    expect(session.say(request, intent.action(action)))
      .toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_RH_TRANSFER', input: { network: label, recipient: 'CONNECTED_OWNER' } } });
    const canonical = canonicalStrategy(session.pending!.command); expect(canonical.ok).toBe(true); if (!canonical.ok) return;
    const composition = composeStrategy(canonical.spec); expect(composition.ok).toBe(true); if (!composition.ok) return;
    expect(executionPlan(composition)).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'robinhood-transfer', fundsClass: 'TEST_FUNDS' });
  });
  it('preserves Solana Mainnet Orca liquidity across Copilot, channel canonicalization and the shared signing route', () => {
    const request = 'Please provide 0.01 SOL and 0.3 USDC to Orca on Solana at ticks -29952 to -25600', action = act.liquidity({ protocol: 'ORCA', network: 'SOLANA',
      deposits: [{ asset: 'SOL', maxAmount: '0.01' }, { asset: 'USDC', maxAmount: '0.3' }], rangeUnit: 'TICK', lower: '-29952', upper: '-25600' });
    // The public mainnet journey uses the owner's approved registry capability with no per-user rollout switch.
    const publicSession = new CopilotSession();
    expect(publicSession.say(request, intent.action(action))?.kind).toBe('PROPOSAL');
    expect(publicSession.pending).not.toBeNull();
    const session = new CopilotSession();
    session.agentRollout = PENDING_AGENT_CAPABILITIES;
    const reply = session.say(request, intent.action(action));
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_LIQUIDITY', input: { network: 'Solana', maxSol: '0.01', maxDevUsdc: '0.3' } } });
    const canonical = canonicalStrategy(session.pending!.command); expect(canonical.ok).toBe(true); if (!canonical.ok) return;
    const composition = composeStrategy(canonical.spec); expect(composition.ok).toBe(true); if (!composition.ok) return;
    expect(executionPlan(composition)).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'orca-liquidity-mainnet', fundsClass: 'REAL_FUNDS' });
  });
});
