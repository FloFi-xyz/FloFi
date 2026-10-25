// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FLOWS, type FlowName } from '../../backend/flows.ts';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import { TEST_NETWORK_FLOW_REFUSAL, TEST_NETWORK_FLOWS, TEST_NETWORK_HISTORY_METHODS, testNetworkFlowRefusal, testNetworkPreviewRefusal } from './test-network-flows';

const PUBLIC = {}, ENGINEERING = { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }, HOSTED_OPT_IN = { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', RAILWAY_PROJECT_ID: 'p' };
const flows = Object.keys(FLOWS) as FlowName[];
/** A flow serves a test network when its name or its disabled code says so (the flows are named per network). */
const namedTestnet = (flow: FlowName) => /sepolia|testnet|devnet|aave-supply|orca-liquidity$|uniswap-liquidity$|lending-composition|robinhood-transfer$/.test(flow);

describe('BUILD-FLOFI-MAINNET-PRODUCT-001: test-network flows start nothing new in the public product', () => {
  it('classifies every flow: exactly the test-network flows are listed', () => {
    expect([...TEST_NETWORK_FLOWS].sort()).toEqual(flows.filter(namedTestnet).sort());
    expect(TEST_NETWORK_FLOW_REFUSAL).toBe(TEST_NETWORK_NOT_AVAILABLE);
  });
  it('refuses every method that could prepare, authorize, sign or submit, and keeps history readable', () => {
    for (const flow of TEST_NETWORK_FLOWS) for (const method of Object.keys(FLOWS[flow].methods)) {
      const history = TEST_NETWORK_HISTORY_METHODS.has(method);
      expect(testNetworkFlowRefusal(flow, method, PUBLIC), `${flow}.${method}`).toBe(history ? null : TEST_NETWORK_NOT_AVAILABLE);
      expect(testNetworkFlowRefusal(flow, method, HOSTED_OPT_IN), `${flow}.${method} hosted`).toBe(history ? null : TEST_NETWORK_NOT_AVAILABLE);
      expect(testNetworkFlowRefusal(flow, method, ENGINEERING), `${flow}.${method} engineering`).toBeNull();
    }
    // The history methods never prepare a transaction: reads, observation of an existing attempt, recording a result the wallet already produced.
    for (const method of ['simulate', 'review', 'begin', 'handoff', 'submit', 'refresh', 'recoverReview', 'prepare', 'price', 'beginSwap', 'submitSwap',
      'prepareLiquidity', 'reviewLiquidity', 'beginLiquidity', 'submitLiquidity']) expect(TEST_NETWORK_HISTORY_METHODS.has(method), method).toBe(false);
    expect(testNetworkPreviewRefusal('base-sepolia-swap', PUBLIC)).toBe(TEST_NETWORK_NOT_AVAILABLE);
    expect(testNetworkPreviewRefusal('base-sepolia-swap', ENGINEERING)).toBeNull();
  });
  it('never refuses a mainnet flow', () => {
    for (const flow of flows.filter(f => !TEST_NETWORK_FLOWS.has(f))) for (const method of Object.keys(FLOWS[flow].methods)) {
      expect(testNetworkFlowRefusal(flow, method, PUBLIC), `${flow}.${method}`).toBeNull();
      expect(testNetworkPreviewRefusal(flow, PUBLIC)).toBeNull();
    }
  });
});
