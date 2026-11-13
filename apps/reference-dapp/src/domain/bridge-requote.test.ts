// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-MAINNET-EXEC-002: the in-place re-quote after a refusal at the execution boundary, and the material values it shows. */
import { describe, expect, it } from 'vitest';
import type { RouterRecord } from '../server/router-service';
import type { UniversalRecord } from '../server/universal-router/service';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { bridgeReviewChanges, refreshBridgeAfterApproval, REQUOTE_IN_PLACE, requotableInPlace } from './bridge-review-recovery';
import { editorReducer, initialEditor } from './editor';

const routerReview = (patch: { minimumOutput?: string; feeTotal?: string; total?: string; recipient?: string } = {}) => ({
  format: 'flofi.router-review.v1', recipient: patch.recipient ?? '0x' + '1'.repeat(40),
  route: { routingProvider: 'across', minimumOutput: patch.minimumOutput ?? '1992704', expectedOutput: patch.minimumOutput ?? '1992704', feeTotal: patch.feeTotal ?? '7296',
    inputToken: { decimals: 6, symbol: 'USDC' }, outputToken: { decimals: 6, symbol: 'USDC' } },
  fees: { totalUpperBoundWei: patch.total ?? '2109815012630', executionFeeUpperBoundWei: '2080000000000' } }) as unknown as RouterRecord['review'];
const record = (patch: Partial<RouterRecord>) => ({ verdict: 'PENDING', phase: 'PREPARED', requote: true, attempts: [], ...patch }) as unknown as RouterRecord;

describe('BUILD-FLOFI-MAINNET-EXEC-002 in-place re-quote', () => {
  it('lists only the material values that moved, a minimum rounded down and a fee maximum rounded up', () => {
    expect(bridgeReviewChanges(routerReview(), routerReview())).toEqual([]);
    const next = routerReview({ minimumOutput: '1992691', feeTotal: '7309', total: '3018000000001' });
    expect(bridgeReviewChanges(routerReview(), next)).toEqual([
      { label: 'Minimum', before: '1.9927 USDC', after: '1.99269 USDC' },
      { label: 'Receives ≈', before: '1.9927 USDC', after: '1.99269 USDC' },
      { label: 'Provider fee', before: '0.007296 USDC', after: '0.007309 USDC' },
      { label: 'Network fee, at most', before: '0.00000210982 ETH', after: '0.00000301801 ETH' }]);
    expect(bridgeReviewChanges(routerReview(), routerReview({ recipient: '0x' + '2'.repeat(40) }))).toEqual([
      { label: 'Destination', before: '0x' + '1'.repeat(40), after: '0x' + '2'.repeat(40) }]);
  });
  it('a universal Review compares its own minimum, expected output, network-fee maximum, recipient and provider', () => {
    const universal = (minimum: string, fee: string) => ({ format: 'flofi.universal-bridge-review.v1', recipient: '8xYk2P'.padEnd(44, '1'),
      route: { provider: 'relay', minimumOutput: minimum, expectedOutput: '2000000', outputToken: { decimals: 6, symbol: 'USDC' } },
      feePolicy: { networkFeeUpperBound: fee, networkFeeDecimals: 18, networkFeeSymbol: 'ETH' } }) as unknown as UniversalRecord['review'];
    expect(bridgeReviewChanges(universal('1990000', '1000'), universal('1989000', '1000'))).toEqual([{ label: 'Minimum', before: '1.99 USDC', after: '1.989 USDC' }]);
    expect(bridgeReviewChanges(universal('1990000', '1000'), routerReview())).toEqual([]);
  });
  it('re-quotes in place only a pending run back at Review with no deposit attempted', () => {
    expect(requotableInPlace(record({}))).toBe(true);
    expect(requotableInPlace(record({ requote: false }))).toBe(false);
    expect(requotableInPlace(record({ phase: 'AUTHORIZED' }))).toBe(false);
    expect(requotableInPlace(record({ verdict: 'FAILED' }))).toBe(false);
    expect(requotableInPlace(record({ attempts: [{ step: 'APPROVAL', state: 'CONFIRMED' }] as never }))).toBe(true);
    expect(requotableInPlace(record({ attempts: [{ step: 'DEPOSIT', state: 'PENDING' }] as never }))).toBe(false);
    expect(requotableInPlace(record({ attempts: [{ step: 'DEPOSIT', state: 'CANCELLED' }] as never }))).toBe(true);
    expect(requotableInPlace(null)).toBe(false);
  });
  it('review round 2: Simulate refreshes in place past a deposit that never reached the chain (after a confirmed unwrap or approval)', () => {
    const workflow = editorReducer(initialEditor(), { type: 'ADD_ROUTER_BRIDGE', input: { source: 'Base', destination: 'Arbitrum', token: 'USDC', amount: '2', recipient: '',
      slippage: '50', routing: 'AUTO' }, source: 'CANVAS', baseRevision: 0 }, createBaseSepoliaReviewContext()).workflow;
    const run = (attempts: unknown[], requote = false) => record({ requote, attempts: attempts as never, workflow: workflow as never });
    expect(refreshBridgeAfterApproval(run([{ step: 'UNWRAP', state: 'CONFIRMED', reconciled: true }, { step: 'DEPOSIT', state: 'CANCELLED' }]), workflow, false)).toBe(true);
    expect(refreshBridgeAfterApproval(run([{ step: 'APPROVAL', state: 'CONFIRMED', reconciled: true }, { step: 'DEPOSIT', state: 'NOT_FOUND' }]), workflow, false)).toBe(true);
    expect(refreshBridgeAfterApproval(run([{ step: 'DEPOSIT', state: 'CANCELLED' }], true), workflow, false)).toBe(true);
    // A deposit that may have reached the chain is never refreshed over.
    expect(refreshBridgeAfterApproval(run([{ step: 'UNWRAP', state: 'CONFIRMED', reconciled: true }, { step: 'DEPOSIT', state: 'SUBMISSION_RESULT_UNKNOWN' }]), workflow, false)).toBe(false);
    expect(refreshBridgeAfterApproval(run([{ step: 'DEPOSIT', state: 'CONFIRMED' }], true), workflow, false)).toBe(false);
  });
  it('covers every refusal that leaves the reviewed request unsent and re-quotable (including the fee codes production hit)', () => {
    for (const code of ['ROUTE_CHANGED', 'ROUTER_L1_FEES_CHANGED_REVIEW_REQUIRED', 'ROUTER_FEES_CHANGED_REVIEW_REQUIRED', 'UNIVERSAL_L1_FEES_CHANGED_REVIEW_REQUIRED',
      'ROUTER_STATE_CHANGED_REVIEW_REQUIRED', 'ROUTER_GAS_CHANGED_REVIEW_REQUIRED', 'ROUTER_REVIEW_EXPIRED', 'UNIVERSAL_REVIEW_EXPIRED'])
      expect(REQUOTE_IN_PLACE.test(code), code).toBe(true);
    for (const code of ['ROUTER_SUBMISSION_UNKNOWN', 'ROUTER_WRONG_OWNER', 'ROUTER_INSUFFICIENT_GAS_ETH']) expect(REQUOTE_IN_PLACE.test(code), code).toBe(false);
  });
});
