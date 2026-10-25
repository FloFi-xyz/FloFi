// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the MOCKED loopback deployment — the verified deployment with the synthetic Relay Depository code pin
 * the in-memory test chains carry. Accepted by the service only with MOCKED provenance (a public run always uses the verified pins).
 */
import { createHash } from 'node:crypto';
import { UNIVERSAL_ROUTER_DEPLOYMENT, type UniversalRouterDeployment } from '@defi-workflow-engine/action-registry';

export const MOCK_DEPOSITORY_CODE = '0x60aa60aa', MOCK_TOKEN_CODE = '0x60bb60bb';
const codeSha = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
export function mockedUniversalDeployment(): UniversalRouterDeployment {
  const evm = Object.fromEntries(Object.entries(UNIVERSAL_ROUTER_DEPLOYMENT.evm).map(([chain, d]) => [chain, { ...d, relayDepositoryCodeSha256: codeSha(MOCK_DEPOSITORY_CODE) }]));
  return { ...UNIVERSAL_ROUTER_DEPLOYMENT, evm, solana: { ...UNIVERSAL_ROUTER_DEPLOYMENT.solana } };
}
/** The loopback harness port serving the MOCKED chains and provider APIs (browser tests); tests in-process inject their own transports. */
export const UNIVERSAL_HARNESS_PORT = 8566;
