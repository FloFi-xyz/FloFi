// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-P1 pool conversational reliability (Mainnet-only): the interpreter of the public product is never primed with a test network or test token
 * example, and a model's own question that names devUSDC is never shown in the public product. Engineering certification keeps its examples.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicText } from '../domain/network-scope';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const instructions = async (scope: string) => {
  vi.stubEnv('FLOFI_NETWORK_SCOPE', scope); vi.resetModules();
  return (await import('./copilot-service')).COPILOT_INSTRUCTIONS_V2;
};

describe('the interpreter instructions follow the deployment scope', () => {
  it('public product: no Devnet request example, no "devUSDC on Solana Devnet", ranges as digits with the percentage forms', async () => {
    const text = await instructions('');
    expect(text).not.toContain('Swap 0.1 SOL to devUSDC on Solana Devnet');
    expect(text).not.toContain('with the swapped devUSDC');
    expect(text).not.toContain('devUSDC on Solana Devnet');
    expect(text).toContain('Flofi runs on mainnets only and declines them');
    for (const form of ['"±10%"', '"10% range"', '"faixa de 10%"', 'rangeUnit FULL', 'digits only']) expect(text).toContain(form);
    expect(text).toContain('report the whole open liquidity request again');
  });
  it('engineering certification keeps the Solana Devnet examples', async () => {
    const text = await instructions('ENGINEERING_TESTNETS');
    expect(text).toContain('Swap 0.1 SOL to devUSDC on Solana Devnet and add liquidity with these tokens in a 10% range');
    expect(text).toContain('Buy amounts spend USDC (devUSDC on Solana Devnet)');
  });
});

describe('a model question naming the Devnet test token is never shown in the public product', () => {
  it.each(['Is 1 devUSDC per SOL the lower or upper price? What should the other bound be?', 'What lower and upper prices in devUSDC per SOL should I use?'])('%s', text => {
    expect(publicText(text, 'PUBLIC_MAINNET')).toBeNull();
    expect(publicText(text, 'ENGINEERING')).toBe(text);
  });
  it('mainnet wording is kept', () => expect(publicText('What lower and upper prices in USDC per SOL should I use?', 'PUBLIC_MAINNET')).not.toBeNull());
});
