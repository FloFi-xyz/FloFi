// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { ORCA_WHIRLPOOLS_DEVNET } from '@defi-workflow-engine/action-registry';
import { reconciledRemaining } from './copilot-reconciled-context';
import type { JupiterRecord } from '../server/jupiter-service';
import type { SolanaCompositionView } from '../server/solana-composition-service';
const owner = 'owner-a';
const swap = (verdict = 'RECONCILED', wallet = owner) => ({ id: 'swap-a', evidence: {}, review: { owner: wallet, chain: ORCA_WHIRLPOOLS_DEVNET.chain, output: { symbol: 'devUSDC', decimals: 6 } },
  observations: [{ verdict, outputReceived: '4500000' }] }) as unknown as JupiterRecord;
const composition = (phase = 'COMPLETED', verdict = 'RECONCILED', wallet = owner) => ({ phase, record: { review: { owner: wallet }, binding: { token: 1, received: '4500000' } },
  swap: swap(), liquidity: { observations: [{ verdict, effects: { depositedA: '1000000', depositedB: '2000000' } }] } }) as unknown as SolanaCompositionView;
it('takes only reconciled output of the connected wallet, never a recovered record of another wallet', () => {
  expect(reconciledRemaining(owner, swap(), null)).toEqual([{ token: 'devUSDC', amount: '4.5' }]);
  expect(reconciledRemaining(null, swap(), null)).toEqual([]);
  expect(reconciledRemaining('other', swap(), null)).toEqual([]);
  expect(reconciledRemaining(owner, swap('PENDING'), null)).toEqual([]);
});
it('subtracts the reconciled deposit and keeps unfinished composition output reserved', () => {
  expect(reconciledRemaining(owner, null, composition())).toEqual([{ token: 'devUSDC', amount: '2.5' }]);
  expect(reconciledRemaining(owner, null, composition('PARTIAL'))).toEqual([{ token: 'devUSDC', amount: '4.5' }]);
  expect(reconciledRemaining(owner, null, composition('COMPLETED', 'PENDING'))).toEqual([]);
  expect(reconciledRemaining(owner, null, composition('COMPLETED', 'RECONCILED', 'other'))).toEqual([]);
  expect(reconciledRemaining(owner, swap(), composition('BOUND'))).toEqual([]);
});
