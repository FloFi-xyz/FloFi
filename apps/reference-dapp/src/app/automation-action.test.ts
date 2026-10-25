// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-MAINNET-PRODUCT-001: "Automate this workflow" on a legacy test-network Canvas workflow is refused in the public product, never
// prefilled onto a mainnet route; engineering certification keeps reading it. Pure reads: nothing is created.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkflow } from '../domain/copilot-test-fixtures';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import { canvasAutomationSteps } from './automation-action';

vi.mock('../server/session-principal', () => ({ currentWalletPrincipals: async () => [{ namespace: 'eip155', address: '0x1111111111111111111111111111111111111111' }] }));
afterEach(() => vi.unstubAllEnvs());

const TESTNET = buildWorkflow(['swap 50 USDC to WETH on Base Sepolia slippage 50 bps']);
const MAINNET = buildWorkflow(['swap 50 USDC to WETH on Base slippage 50 bps']);

describe('Automate this workflow in the Mainnet-only product', () => {
  it('refuses a test-network Canvas workflow on a hosted deployment, whatever the opt-in', async () => {
    vi.stubEnv('VERCEL', '1');
    expect(await canvasAutomationSteps(TESTNET)).toEqual({ ok: false, code: TEST_NETWORK_NOT_AVAILABLE });
    const mainnet = await canvasAutomationSteps(MAINNET);
    expect(mainnet.ok).toBe(true);
  });
  it('keeps reading it for engineering certification', async () => {
    const steps = await canvasAutomationSteps(TESTNET);
    expect(steps).toMatchObject({ ok: true, value: { ok: true, steps: [{ route: { network: 'base-sepolia' } }] } });
  });
});
