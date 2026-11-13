// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): the Robinhood Chain Review of a 0x Gasless swap — the essentials visible (the swap, the
 * network fee with who pays it and in which token, the signatures), protocol details under Technical details — and the native-shortfall reasons.
 * Projection only: focused snapshots of the reviewed record, no transport.
 */
import { describe, expect, it } from 'vitest';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from './editor';
import { payableCosts } from './conversation-lifecycle';
import { projectSimulation, simulationError, type SimulationSource } from './simulation-presentation';
import { gaslessLifecycleState, gaslessUnavailableReason, INCLUDED_NETWORK_FEE_LABEL } from './gas-payment';
import { compactNetworkFee } from '../components/conversation-cards';
import { translate } from '../i18n/translate';

const context = createBaseSepoliaReviewContext(), now = Date.parse('2026-10-06T12:00:00Z');
const swap = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '100', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
const hash = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(swap)));
const USDG = '0x5fc5360d0b2f7ede3b27e8a1d5e3fa6a1be1d168', TSLA = '0x' + '7'.repeat(40), SETTLER = '0x' + '5c'.repeat(20), PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const quote = { workflowHash: hash, revision: swap.revision, nodeId: swap.nodes.at(-1)!.nodeId, inputSymbol: 'USDG', outputSymbol: 'TSLA', inputToken: USDG, outputToken: TSLA,
  inputDecimals: 6, outputDecimals: 18, amountIn: '100000000', expectedOut: '258908000000000000', minimumOut: '257613460000000000', slippageBps: 50, fee: 3000,
  provenance: 'PUBLIC_MAINNET', expiresAt: new Date(now + 60_000).toISOString() };
const zeroEx = (patch: object = {}) => ({ taker: '0x' + '1'.repeat(40), sellToken: USDG, buyToken: TSLA, settler: SETTLER, permit2: PERMIT2, sources: ['0x_RFQ'],
  gasFee: { token: USDG, amount: '420000' }, zeroExFee: null, trade: { hash: '0x' + 'ab'.repeat(32), deadline: Math.floor(now / 1000) + 300 },
  approval: { type: 'permit', value: '100000000', unlimited: false }, ...patch });
const source = (gas: object | undefined): SimulationSource => ({ kind: 'public', state: { busy: false, error: null, retired: false, recoveryOnly: false, available: true,
  run: { workflow: swap, quote: { ...quote, ...gas ? { gas } : {} }, attempts: [], outcome: null } } }) as unknown as SimulationSource;
const gasless = (patch: object = {}) => ({ owner: '0x' + '1'.repeat(40), mechanism: 'ZEROX_GASLESS_SWAP', nativeShort: true, unavailable: [], native: { balanceWei: '0', worstCaseWei: '4800000000000' },
  payment: { mechanism: 'ZEROX_GASLESS_SWAP' }, zeroEx: zeroEx(patch) });

describe('the 0x Gasless Review on Robinhood Chain', () => {
  it('shows the fee taken out of the swap in the swap\'s token, the signatures, and no ETH fee or pool fee', () => {
    const view = projectSimulation(swap, context, source(gasless()), now);
    expect(view.status).toBe('ready');
    expect(view.steps[0]).toMatchObject({ input: '100 USDG', result: '0.258908 TSLA', minimum: '0.25761346 TSLA', provider: '0x' });
    expect(view.fees).toEqual([{ label: INCLUDED_NETWORK_FEE_LABEL, value: '0.42 USDG', treatment: 'INCLUDED',
      note: 'Paid from your USDG: 0x takes it out of the swap, so no ETH is needed. The amounts you receive are after this fee.' }]);
    expect(view.steps[0]!.details).toEqual(expect.arrayContaining([{ label: 'Signatures', value: '2 (token approval, then the trade)' },
      { label: 'Executed by', value: `0x Settler ${SETTLER}` }, { label: 'Route sources', value: '0x_RFQ' }, { label: 'Token approval by signature', value: `Permit2 ${PERMIT2} may spend at most 100 USDG` }]));
    // The venue disclosure is a technical caveat; nothing says "free", "no fees", "gasless" or "sponsored".
    expect(view.warnings).toEqual([expect.objectContaining({ severity: 'info', technical: true, message: expect.stringContaining('0x\'s settlement contract') })]);
    expect(JSON.stringify(view)).not.toMatch(/\bfree\b|no fees|gasless|sponsor/i);
    // The compact chat card shows the included fee (never dropped), and the payable costs know the network cost.
    expect(compactNetworkFee(view.fees)).toEqual({ estimate: null, maximum: null, unreadable: false, included: '0.42 USDG' });
    expect(payableCosts(view.fees).unknown).toEqual([]);
  });
  it('flags an unlimited approval visibly, shows 0x\'s own fee and one signature when Permit2 is already allowed', () => {
    const unlimited = projectSimulation(swap, context, source(gasless({ approval: { type: 'permit', value: ((1n << 256n) - 1n).toString(), unlimited: true } })), now);
    expect(unlimited.warnings).toEqual(expect.arrayContaining([{ severity: 'attention', message: 'This approval lets Permit2 spend any amount of USDG from this wallet until you change or revoke it.' }]));
    const single = projectSimulation(swap, context, source(gasless({ approval: null, zeroExFee: { token: TSLA, amount: '1000000000000' } })), now);
    expect(single.steps[0]!.details.some(line => line.label === 'Signatures')).toBe(false);
    expect(single.fees).toEqual(expect.arrayContaining([expect.objectContaining({ label: '0x fee (included in the swap)', value: '0.000001 TSLA', treatment: 'INCLUDED' })]));
  });
  it('says before anything is signed that ETH is short and why paying in tokens is not available', () => {
    const view = projectSimulation(swap, context, source({ owner: '0x' + '1'.repeat(40), mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, zeroEx: null,
      unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code: 'ZEROX_GASLESS_APPROVAL_UNAVAILABLE' }], native: { balanceWei: '0', worstCaseWei: '4800000000000' },
      payment: { mechanism: 'NATIVE_WALLET_GAS' } }), now);
    expect(view.fees).toEqual(expect.arrayContaining([{ label: 'Maximum network fee', value: '0.0000048 ETH', note: 'Paid in ETH by your wallet, separate from the swap output.', treatment: 'CEILING' }]));
    expect(view.warnings.map(w => w.message)).toEqual(expect.arrayContaining([
      'This wallet does not have enough ETH for the network fee of this swap. Add ETH on this network before you authorize.',
      'This token cannot be approved with a signature, and approving it needs ETH.']));
    expect(view.warnings.map(w => w.message)).not.toContain('This is a pool quote. Network fees and exact transaction simulation are not available yet.');
  });
  it('reads in Portuguese, with "taxa de rede" and the paying token, never "grátis" or "patrocinado"', () => {
    const view = projectSimulation(swap, context, source(gasless()), now);
    const fee = view.fees[0]!;
    expect(translate('PT', fee.label)).toBe('Taxa de rede (incluída no swap)');
    expect(translate('PT', fee.note!)).toBe('Paga em USDG: a 0x desconta do próprio swap, então não é preciso ETH. Os valores que você recebe já descontam esta taxa.');
    expect(translate('PT', '{0}, included in the swap', '0.42 USDG')).toBe('0.42 USDG, incluída no swap');
    expect(translate('PT', `Permit2 ${PERMIT2} may spend at most 100 USDG`)).toBe(`O Permit2 ${PERMIT2} pode gastar no máximo 100 USDG`);
    expect(translate('PT', `Permit2 ${PERMIT2} may spend any amount of USDG`)).toBe(`O Permit2 ${PERMIT2} pode gastar qualquer quantia de USDG`);
    for (const line of [...view.fees.map(f => f.label), ...view.warnings.map(w => w.message), ...view.steps[0]!.details.map(d => d.label)])
      expect(translate('PT', line), line).not.toMatch(/grátis|sem taxas|patrocinad/i);
  });
  it('words every refusal and outcome of the gasless path', () => {
    expect(simulationError('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED')).toMatch(/How the network fee is paid changed/);
    expect(simulationError('ZEROX_SIGNER_MISMATCH')).toMatch(/signature did not match/);
    expect(simulationError('ZEROX_TRADE_REVERTED')).toMatch(/none of your tokens moved/);
    expect(simulationError('ZEROX_ORDER_EXPIRED')).toMatch(/expired/);
    expect(simulationError('ZEROX_OWNER_NOT_EOA')).toMatch(/standard wallet account/);
    expect(gaslessUnavailableReason('ZEROX_PROVIDER_HTTP_500')).toBe('The provider did not answer. Try again shortly.');
    expect(gaslessUnavailableReason('ZEROX_SETTLER_MISMATCH')).toBe('FloFi could not verify the provider quote for this swap.');
    expect([['SIGNING', false], ['SUBMITTED', false], ['UNKNOWN', false], ['CONFIRMED', false], ['CONFIRMED', true], ['FAILED', false], ['REJECTED', false], ['ABANDONED', false]]
      .map(([state, reconciled]) => gaslessLifecycleState(state as string, reconciled as boolean))).toEqual(['PREPARED', 'HASH', 'UNKNOWN', 'PENDING', 'CONFIRMED', 'FAILED', 'REJECTED', null]);
  });
});
