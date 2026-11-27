// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { reviewBlockView, shortDecimal } from './review-block';
import { swapBridgeReview } from './review-block-test-harness';

describe('board 06: what the owner is authorizing, in plain words', () => {
  it('at most 6 significant digits: a minimum is never overstated, a spend or fee never understated', () => {
    expect(shortDecimal('796123456789123', 18, 'down')).toBe('0.000796123');
    expect(shortDecimal('796123456789123', 18, 'up')).toBe('0.000796124');
    expect(shortDecimal('2000000', 6, 'up')).toBe('2');
    expect(shortDecimal('123456789', 6, 'down')).toBe('123.456');
    expect(shortDecimal('300000000000000', 18, 'down')).toBe('0.0003');
    expect(shortDecimal('0', 18, 'up')).toBe('0');
  });
  it('one line per step (verb, amount, asset, network), the final minimum, the fee ceiling, each token permission and the wallet requests', () => {
    const view = reviewBlockView(swapBridgeReview());
    expect(view.steps).toEqual([
      { key: 'Swap {0} → {1} · {2}', parameters: ['2 USDC', 'WETH', 'Base'], full: null },
      { key: 'Bridge {0} to {1}', parameters: ['0.000796124 WETH', 'Arbitrum One'], full: '0.000796123456789123 WETH' },
    ]);
    // The last step's exact delivery on Arbitrum One, shortened DOWN; the full value stays for the tooltip.
    expect(view.minimum).toEqual({ key: '{0}', parameters: ['0.000790555 WETH'], full: '0.000790555555555555 WETH' });
    expect(view.fee).toEqual({ key: '{0}', parameters: ['0.000454 ETH'], full: null });
    expect(view.permissions.map(p => [p.key, ...p.parameters])).toEqual([['{0} uses up to {1}', 'Uniswap', '2 USDC'], ['{0} uses up to {1}', 'Across', '0.000796124 WETH']]);
    expect(view.walletRequests).toEqual({ key: '{0}', parameters: ['1'], full: null });
  });
  it('never claims a total it does not know: a later request is quoted when due, a step-by-step count is a minimum', () => {
    const base = swapBridgeReview();
    const later = reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...base.groups[0]!, steps: [0, 0], calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }] },
      { ...base.groups[0]!, index: 1, steps: [1, 1], signing: 'WHEN_DUE', calls: null, approvals: null, fee: null }],
      counts: { ...base.counts, walletPrompts: 2, atLeast: true } }));
    expect(later.fee).toMatchObject({ key: '{0} + later requests, quoted when due', parameters: ['0.000454 ETH'] });
    expect(later.permissions.map(p => p.key)).toEqual(['{0} uses up to {1}', 'Later steps ask when they are due']);
    expect(later.walletRequests).toEqual({ key: 'at least {0}', parameters: ['2'], full: null });
    expect(reviewBlockView(swapBridgeReview({ counts: { ...base.counts, networkSwitches: 1 } })).walletRequests).toEqual({ key: '{0} + {1} network switch(es)', parameters: ['1', '1'], full: null });
    // An approval it cannot word is never reported as "no new permission".
    expect(reviewBlockView(swapBridgeReview({ steps: base.steps.map(s => ({ ...s, spend: null })) })).permissions.map(p => p.key))
      .toEqual(['A token approval is in this request (see Technical details)']);
    const unprepared = reviewBlockView(swapBridgeReview({ groups: base.groups.map(g => ({ ...g, calls: null, approvals: null, fee: null })),
      steps: base.steps.map(s => ({ ...s, minimum: null, expected: null })) }));
    expect(unprepared.fee?.key).toBe('Quoted when each request is due');
    expect(unprepared.permissions.map(p => p.key)).toEqual(['Asked when each step is due']);
    expect(unprepared.minimum?.key).toBe('Quoted when this step becomes due');
    expect(unprepared.steps[0]).toEqual({ key: 'Swap {0} · {1}', parameters: ['2 USDC', 'Base'], full: null });
    expect(reviewBlockView(swapBridgeReview({ groups: base.groups.map(g => ({ ...g, calls: [{ kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }], approvals: 0 })) })).permissions
      .map(p => p.key)).toEqual(['No new token permission']);
  });
  it('BUILD-FLOFI-MAINNET-EXEC-002 review round 2: a REQUIRED-sponsored request is not in "Network fee, at most"; an OFFERED one is', () => {
    const base = swapBridgeReview(), group = base.groups[0]!;
    const sponsor = (sponsorship: 'OFFERED' | 'REQUIRED') => ({ ...group.fee!, sponsorship });
    // The wallet may still pay an OFFERED fee (when it cannot take the sponsorship): its ceiling stays.
    expect(reviewBlockView(swapBridgeReview({ groups: [{ ...group, fee: sponsor('OFFERED') }] })).fee).toEqual({ key: '{0}', parameters: ['0.000454 ETH'], full: null });
    // REQUIRED: nothing is sent unless FloFi pays it, so the wallet pays none of it.
    expect(reviewBlockView(swapBridgeReview({ groups: [{ ...group, fee: sponsor('REQUIRED') }] })).fee).toEqual({ key: 'None from your wallet: FloFi offers to pay it', parameters: [], full: null });
    const second = { ...group, index: 1, steps: [1, 1] as const, fee: { ...group.fee!, maxWei: '1000000000000000' } };
    expect(reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...group, steps: [0, 0], fee: sponsor('REQUIRED') }, second] })).fee)
      .toEqual({ key: '{0}', parameters: ['0.001 ETH'], full: null });
    expect(reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...group, steps: [0, 0], fee: sponsor('REQUIRED') }, { ...second, signing: 'WHEN_DUE', calls: null, fee: null }] })).fee)
      .toEqual({ key: 'Later requests, quoted when due', parameters: [], full: null });
    expect(reviewBlockView(swapBridgeReview({ mode: 'GROUPED', groups: [{ ...group, steps: [0, 0], fee: sponsor('OFFERED') }, second] })).fee)
      .toEqual({ key: '{0}', parameters: ['0.001454 ETH'], full: null });
  });
});

// KAN-20: a Solana Batch Payment prepared by the Review — its fee ceiling in SOL with the token-account deposits it includes at most, one wallet request,
// and no token permission (the owner's wallet signs the transfers themselves). EVM Reviews carry no `feeNote` (unchanged).
describe('KAN-20: the Review block of a Solana Batch Payment', () => {
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', OWNER = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
  const recipients = ['CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH', '92yJ8DJi8fbWhAjeK39QZWR1skhE39MzE4etRiWMzntw'];
  const usdc = (units: string) => ({ asset: `${SOLANA}/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, units, decimals: 6, symbol: 'USDC', text: `${Number(units) / 1e6} USDC` });
  const batch = (maximumAccountCreationLamports: string) => ({ atomic: true as const, asset: { symbol: 'USDC', decimals: 6 }, total: '3000000', estimatedFeeLamports: '5000',
    accountCreationLamports: '0', maximumAccountCreationLamports, maximumNetworkCostLamports: String(5000n + BigInt(maximumAccountCreationLamports)),
    requiredLamports: '6000000', transactionBytes: 530 });
  const solanaReview = (deposits: string) => swapBridgeReview({ owner: OWNER, stepCount: 2,
    groups: [{ index: 0, chain: SOLANA, network: 'Solana', strategy: 'SOLANA_SIGN_ALL', steps: [0, 1], signing: 'UPFRONT', interactions: 1, setup: [], downgrades: [],
      calls: null, approvals: null, fee: null, healthFactorAfter: null, solanaBatch: batch(deposits) }],
    steps: recipients.map((recipient, index) => ({ index, action: 'transfer', network: 'Solana', chain: SOLANA, provider: null, spend: usdc(String((index + 1) * 1_000_000)),
      basis: 'EXACT' as const, boundTo: null, expected: null, minimum: null, recipient })),
    counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 0, networkSwitches: 0, oneTimeSetup: [] } });
  it('the fee ceiling in SOL (fee + deposits at most), the deposits note, recipients verbatim, one request and no token permission', () => {
    const view = reviewBlockView(solanaReview('4078560'));
    expect(view.fee).toEqual({ key: '{0}', parameters: ['0.00408356 SOL'], full: null });
    expect(view.feeNote).toEqual({ key: 'Includes up to {0} in deposits for recipients who need a token account.', parameters: ['0.00407856 SOL'], full: null });
    expect(view.steps.map(step => step.parameters[1])).toEqual(recipients);
    expect(view.permissions).toEqual([{ key: 'No new token permission', parameters: [], full: null }]);
    expect(view.walletRequests).toEqual({ key: '{0}', parameters: ['1'], full: null });
  });
  it('no deposit to pay: the network fee alone and no note; an EVM Review has no note at all', () => {
    const view = reviewBlockView(solanaReview('0'));
    expect(view.fee).toEqual({ key: '{0}', parameters: ['0.000005 SOL'], full: null });
    expect(view.feeNote).toBeNull();
    expect(reviewBlockView(swapBridgeReview())).not.toHaveProperty('feeNote');
  });
});
