// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0010 §4: FloFi Wallet signs a Kora transaction in the owner's own slot (slot 1, behind Pimlico's fee payer), every other slot unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base58Encode } from '@defi-workflow-engine/reference-compiler';

const KORA = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)), OWNER = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const key = (address: string) => { let n = 0n; for (const c of address) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
  return Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * (31 - i))) & 0xffn)); };
// v0 message: header [2 signers, 1 read-only signer, 0], keys [Kora, owner], blockhash, no instructions, no lookups.
const message = Uint8Array.from([0x80, 2, 1, 0, 2, ...key(KORA), ...key(OWNER), ...new Array(32).fill(7), 0, 0]);
const unsigned = Uint8Array.from([2, ...new Array(128).fill(0), ...message]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const inSlot = (slot: number) => { const bytes = unsigned.slice(); bytes.fill(5, 1 + 64 * slot, 65 + 64 * slot); return bytes; };
const SIGNING = { flow: 'jupiter-swap', runId: 'jupiter-' + 'c'.repeat(32) };

async function setup(signed: Uint8Array) {
  vi.resetModules();
  vi.stubGlobal('window', new EventTarget());
  const solana = await import('./solana-wallet'), channel = await import('./flofi-wallet-channel'), module = await import('./flofi-solana-wallet');
  const deps = { request: vi.fn(async () => ({ signedTransaction: b64(signed) })), connected: vi.fn() };
  const wallet = module.createFloFiSolanaWallet(OWNER, module.FLOFI_WALLET_NAME, deps as never);
  solana.registerSolanaWallet(wallet);
  return { solana, channel, module, deps };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('FloFi Wallet behind Pimlico\'s Kora fee payer', () => {
  it('finds the owner\'s slot among the signers and accepts only its own signature there', async () => {
    const { module } = await setup(inSlot(1));
    expect(module.ownerSignerSlot(unsigned, OWNER)).toBe(1);
    expect(module.ownerSignerSlot(unsigned, KORA)).toBe(0);
    expect(module.ownerSignerSlot(unsigned, base58Encode(new Uint8Array(32).fill(3)))).toBeNull();
    expect(module.signedSameTransaction(unsigned, inSlot(1), 1)).toBe(true);
    // Kora's slot filled, nothing in the owner's slot, or both: refused.
    expect(module.signedSameTransaction(unsigned, inSlot(0), 1)).toBe(false);
    const both = inSlot(1); both.fill(5, 1, 65);
    expect(module.signedSameTransaction(unsigned, both, 1)).toBe(false);
    const changed = inSlot(1); changed[changed.length - 3] ^= 1;
    expect(module.signedSameTransaction(unsigned, changed, 1)).toBe(false);
    expect(module.signedSameTransaction(unsigned, inSlot(1), 2)).toBe(false);
  });
  it('signs a bound Kora run in slot 1 through the Wallet Standard flow', async () => {
    const { solana, channel, deps } = await setup(inSlot(1));
    const session = await solana.connectSolanaWallet('FloFi Wallet');
    channel.bindFloFiSigning(session.wallet, SIGNING);
    expect(await solana.signWithSolanaWallet(session, b64(unsigned))).toBe(b64(inSlot(1)));
    expect(deps.request).toHaveBeenCalledTimes(1);
  });
  it('drops an answer that signed Kora\'s slot instead of the owner\'s', async () => {
    const { solana, channel } = await setup(inSlot(0));
    const session = await solana.connectSolanaWallet('FloFi Wallet');
    channel.bindFloFiSigning(session.wallet, SIGNING);
    await expect(solana.signWithSolanaWallet(session, b64(unsigned))).rejects.toThrow();
  });
});
