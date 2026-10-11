// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The backend runs on Node 24's native TypeScript support, not through a bundler: every module it reaches must
 * resolve with explicit extensions. This loads the real entry modules in a plain Node process (no database,
 * no network) so an extensionless import can never ship a backend that crashes at startup.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('BUILD-CLOUD-001 backend entry point loads under plain Node', () => {
  it('imports app, flows and every flow service without a bundler', async () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      "const f = await import('./backend/flows.ts'); await import('./backend/app.ts'); console.log(Object.keys(f.FLOWS).sort().join(','));"],
    { cwd, timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
    // BUILD-RH-002 adds the Robinhood Chain swap, mainnet transfer, liquidity and the four Robinhood bridge routes; BUILD-BASE-001 the Base
    // mainnet swap, transfer, liquidity and Aave flows and the Router's Arbitrum One → Base route.
    expect(stdout.trim()).toBe('aave-supply,base-aave,base-liquidity,base-mainnet-transfer,base-sepolia-swap,base-swap,crosschain-router,crosschain-router-arbitrum-to-base,' +
      'crosschain-router-arbitrum-to-robinhood,crosschain-router-base-to-robinhood,' +
      'crosschain-router-robinhood-to-arbitrum,crosschain-router-robinhood-to-base,crosschain-router-testnet,jupiter-swap,lending-composition,orca-liquidity,pix-payment,' +
      'robinhood-liquidity,robinhood-mainnet-transfer,robinhood-swap,robinhood-transfer,solana-devnet-swap,uniswap-liquidity');
  });
  it('refuses to start without configuration instead of running unconfigured', async () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const result = await promisify(execFile)(process.execPath, ['backend/main.ts', 'api'], { cwd, timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } })
      .then(() => ({ code: 0, stdout: '' }), (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('"stage":"config","error_code":"DATABASE_URL_REQUIRED"');
  });
});
