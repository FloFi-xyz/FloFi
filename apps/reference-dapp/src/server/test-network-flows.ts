// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: the execution boundary of the Mainnet-only product. The flows below run only on public test networks. In the
 * public product (`networkScope`) they keep exactly what preserves history and fails closed — reading a run, observing and reconciling an
 * attempt that already exists, recording a wallet result the owner's wallet already produced, invalidating an authorization — and refuse
 * everything that could start or advance a new authorization or signature (simulate, quote refresh, Review, begin, handoff, submit).
 *
 * Both the web runtime (`flow-runtime.ts`, every server action) and the API (`backend/app.ts`) apply it, so a hosted deployment refuses a
 * test-network operation whatever its flow configuration says. Plain-Node safe (the API loads it without the bundler resolution rule).
 */
import type { FlowName } from '../../backend/flows.ts';
import { networkScope } from './network-scope.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const TEST_NETWORK_FLOW_REFUSAL = 'TEST_NETWORK_NOT_AVAILABLE';
/** Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia, Robinhood Chain Testnet and Solana Devnet flows (every one of their methods). */
export const TEST_NETWORK_FLOWS: ReadonlySet<FlowName> = new Set<FlowName>(['robinhood-transfer', 'aave-supply', 'base-sepolia-swap', 'solana-devnet-swap',
  'orca-liquidity', 'uniswap-liquidity', 'crosschain-router-testnet', 'lending-composition', 'solana-devnet-composition', 'solana-devnet-transfer']);
/** Methods that read or close an existing run; none of them prepares, authorizes, signs or submits anything new. */
export const TEST_NETWORK_HISTORY_METHODS: ReadonlySet<string> = new Set(['mode', 'status', 'info', 'inspect', 'positions', 'observe', 'report', 'walletFailure',
  'walletTrace', 'invalidate', 'cancelPrepared', 'end']);
/** The refusal for `method` on `flow` in this deployment's scope, or null when the call may proceed. */
export function testNetworkFlowRefusal(flow: string, method: string, env: Env = process.env): string | null {
  if (!TEST_NETWORK_FLOWS.has(flow as FlowName) || TEST_NETWORK_HISTORY_METHODS.has(method)) return null;
  return networkScope(env) === 'ENGINEERING' ? null : TEST_NETWORK_FLOW_REFUSAL;
}
/** A read-only simulation preview starts nothing, but it is still a test-network simulation: refused in the public product. */
export const testNetworkPreviewRefusal = (flow: string, env: Env = process.env): string | null =>
  TEST_NETWORK_FLOWS.has(flow as FlowName) && networkScope(env) !== 'ENGINEERING' ? TEST_NETWORK_FLOW_REFUSAL : null;
