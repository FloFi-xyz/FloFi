// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001 / BUILD-FLOFI-PRIVY-UX-001: FloFi Wallet's browser client is legacy and export-only. It keeps the wallet
// origin's key (unlock) and the provider's export frame, and offers no way to create, import or sign: those happen with Privy in FloFi.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@turnkey/indexed-db-stamper', () => ({ IndexedDbStamper: class {
  async init() { /* key ready */ }
  getPublicKey() { return '02' + 'ab'.repeat(32); }
  async stamp() { return { stampHeaderName: 'X-Stamp', stampHeaderValue: 'stamp-value' }; }
  async sign() { return 'cd'.repeat(64); }
  async clear() { /* forgotten */ }
} }));
const client = await import('./provider-client');

describe('FloFi Wallet browser client (legacy, export only)', () => {
  it('exports only the unlock key, its signature over FloFi’s unlock messages, forgetting the key, and the export frame', () => {
    expect(Object.keys(client).sort()).toEqual(['clientSignatureOver', 'forgetWalletKey', 'openExportFrame', 'walletPublicKey']);
  });
  it('keeps the unlock key in the wallet origin’s non-extractable stamper', async () => {
    await expect(client.walletPublicKey()).resolves.toBe('02' + 'ab'.repeat(32));
    await expect(client.forgetWalletKey()).resolves.toBeUndefined();
  });
});
