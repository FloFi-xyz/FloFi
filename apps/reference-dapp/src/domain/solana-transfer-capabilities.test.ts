// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic capability checks recovered from the original continuation probe; no scratchpad or public-chain access.
import { expect, it } from 'vitest';
import { composeStrategy } from '../engine/strategy-engine';
import { handoffFindings, executionPlan } from '../mcp/execution';
import { codeCapabilities, supportedAssets, supportedNetworks } from '../engine/capability-catalog';
it('exposes executable SOL/SPL capabilities and requires explicit Solana recipients', () => {
  for (const strategy of [{ action: 'transfer', network: 'solana', asset: 'usdc', amount: '1.5', recipient: 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH' },
    { action: 'transfer', network: 'solana-devnet', asset: 'SOL', amount: '0.01', recipient: 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH' },
    { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.01' },
    { action: 'transfer', network: 'solana', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1', recipient: 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH', decimals: 6, tokenProgram: 'spl-token' }]) {
    const c = composeStrategy(strategy);
    if (!('recipient' in strategy)) {
      expect(c.ok).toBe(false);
      continue;
    }
    expect(c.ok).toBe(true);
    if (!c.ok) continue;
    expect(handoffFindings(c)).toEqual({ preExecution: [], blockers: [] });
    expect(executionPlan(c)).toMatchObject({ kind: 'SINGLE_FLOW', flow: strategy.network === 'solana-devnet' ? 'solana-devnet-transfer' : 'solana-transfer' });
  }
  expect(codeCapabilities('ENGINEERING').filter(r => r.network.startsWith('solana') && r.action === 'transfer')).toHaveLength(2);
  expect(supportedNetworks('ENGINEERING').filter(n => n.id.startsWith('solana'))).toHaveLength(2);
  expect(supportedAssets('ENGINEERING', 'solana').filter(a => a.actions.includes('transfer')).map(a => a.symbol)).toEqual(expect.arrayContaining(['SOL', 'USDC', 'USDT']));
});
