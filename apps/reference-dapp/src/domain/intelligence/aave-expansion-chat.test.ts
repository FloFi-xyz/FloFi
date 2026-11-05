// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: reserve grounding and safety notes in Chat, the lending display helpers and the restore owner rule. Scripted
 * model answers and committed fixtures only; nothing is simulated, signed or executed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CopilotSession, act, intent } from '../copilot-session.test-harness';
import { setActiveNetworkScope } from '../network-scope';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';
import { lendingCopy, lendingNetworkView, lendingSelectable, lendingReservesFor } from '../supply-authoring';
import { ownerByRecord } from '../sequence-restore';
import { translate } from '../../i18n/locale';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const mainnet = () => { const s = new CopilotSession(); s.walletChainId = 'eip155:8453'; return s; };

describe('Aave V3 expansion in Chat', () => {
  it('grounds a reserve written at the end of a sentence', () => {
    const reply = mainnet().say('Supply 0.01 WETH to Aave on Base.', intent.action(act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '0.01' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SUPPLY', input: { network: 'Base', asset: 'WETH', amount: '0.01' } } });
  });
  it('never turns a written "ETH" into a WETH supply silently: it asks first', () => {
    const reply = mainnet().say('Supply 0.5 of my ETH to Aave on Base', intent.action(act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '0.5' })))!;
    expect(reply.kind).not.toBe('PROPOSAL');
    expect(reply.text).toContain('Native ETH is not an Aave V3 reserve');
  });
  it('refuses a Supply cap copied from the swap amount (the delivered WETH is unknown until the swap settles)', () => {
    const reply = mainnet().say('Swap 100 USDC to WETH on Base then supply it to Aave', intent.composition([
      act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100' }), act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '100' })]))!;
    expect(reply.kind).not.toBe('PROPOSAL');
    expect(reply.text).toContain('the same number as the');
  });
});

describe('Aave V3 lending display helpers', () => {
  it('names mainnet reserves without "Aave test" wording, translated before the reserve is named', () => {
    const weth = lendingNetworkView('Ethereum', 'WETH');
    expect(lendingCopy('Your injected wallet must hold Aave test USDC and Base Sepolia ETH for gas.', weth)).toBe('Your injected wallet must hold WETH and Ethereum ETH for gas.');
    expect(lendingCopy('Your wallet needs more of the Aave test asset for this Supply.', weth, value => translate('PT', value))).toBe('Sua carteira precisa de mais deste ativo para este Supply.');
    expect(lendingCopy('Your wallet needs more Aave test USDC for this Supply.', lendingNetworkView('Base Sepolia'))).toBe('Your wallet needs more Aave test USDC for this Supply.');
  });
  it('shows every listed reserve without throwing, and every registry reserve of a mainnet market is selectable or refused explicitly', () => {
    for (const network of ['Ethereum', 'Base', 'Arbitrum One'] as const) for (const reserve of lendingReservesFor(network)) {
      expect(lendingNetworkView(network, reserve.symbol).asset).toBe(reserve.symbol);
      expect(typeof lendingSelectable(network, reserve)).toBe('boolean');
    }
    expect(lendingNetworkView('Base', 'NOT-A-RESERVE').asset).toBe(lendingReservesFor('Base')[0]!.symbol);
  });
});

describe('Sequence restore owner', () => {
  it('reads the executing wallet from each runtime record, normalised, and nothing else', () => {
    const evm = '0x' + 'aB'.repeat(20);
    expect(ownerByRecord('public', { attempts: [{ account: '0x' + '1'.repeat(40) }, { account: evm }] })).toBe(evm.toLowerCase());
    expect(ownerByRecord('supply', { review: { account: evm } })).toBe(evm.toLowerCase());
    expect(ownerByRecord('solana-swap', { review: { owner: 'So1anaOwner1111111111111111111111111111111' } })).toBe('So1anaOwner1111111111111111111111111111111');
    expect(ownerByRecord('router', { review: { account: evm } })).toBeNull();
    expect(ownerByRecord('public', { attempts: [] })).toBeNull();
  });
});
