// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the page's in-memory Saved Recipients. Only the account-session server actions fill it; a session that ended,
 * an invalidation (Disconnect, sign-in, account deletion, another account read) or an unavailable deployment leaves no recipient behind, and a
 * read started before an invalidation never lands in the next session. Nothing is written to Web Storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedRecipientView } from '../domain/saved-recipients';

const actions = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), rename: vi.fn(), remove: vi.fn() }));
vi.mock('../app/recipient-action', () => ({ listSavedRecipients: actions.list, saveRecipient: actions.save, renameSavedRecipient: actions.rename,
  removeSavedRecipient: actions.remove }));
const store = await import('./saved-recipients-store');

const at = '2026-11-15T12:00:00.000Z', EVM = '0x52908400098527886e0f7030069857d2e4169ee7', SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
const view = (id: string, label: string, address: string, ecosystem: 'EVM' | 'SOLANA'): SavedRecipientView =>
  ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem, createdAt: at, updatedAt: at, status: 'EXTERNAL' });
const maria = view('a', 'Maria', EVM, 'EVM'), solana = view('b', 'Minha Solana', SOL, 'SOLANA');
const storage = vi.fn();
beforeEach(() => {
  store.invalidateSavedRecipients();
  for (const action of Object.values(actions)) action.mockReset();
  vi.stubGlobal('localStorage', { getItem: storage, setItem: storage, removeItem: storage });
  vi.stubGlobal('sessionStorage', { getItem: storage, setItem: storage, removeItem: storage });
});
afterEach(() => { expect(storage).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('saved recipients store', () => {
  it('reads the account\'s list once for concurrent callers, and again only when stale or invalidated', async () => {
    actions.list.mockResolvedValue({ ok: true, value: [maria, solana] });
    expect(store.savedRecipientsSnapshot()).toEqual({ status: 'IDLE', recipients: [], code: null });
    const [a, b] = await Promise.all([store.loadSavedRecipients(), store.loadSavedRecipients({ ifStale: true })]);
    expect(a).toBe(b);
    expect(a).toEqual({ status: 'READY', recipients: [maria, solana], code: null });
    await store.loadSavedRecipients({ ifStale: true });
    expect(actions.list).toHaveBeenCalledTimes(1);
    store.invalidateSavedRecipients();
    expect(store.savedRecipientsSnapshot()).toEqual({ status: 'IDLE', recipients: [], code: null });
    await store.loadSavedRecipients({ ifStale: true });
    expect(actions.list).toHaveBeenCalledTimes(2);
  });

  it('an ended session or an unavailable deployment leaves no recipient; an error keeps only this session\'s list', async () => {
    actions.list.mockResolvedValueOnce({ ok: true, value: [maria] }).mockResolvedValueOnce({ ok: false, code: 'RECIPIENTS_REQUEST_FAILED' })
      .mockResolvedValueOnce({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' }).mockResolvedValueOnce({ ok: false, code: 'RECIPIENTS_UNAVAILABLE' })
      .mockRejectedValueOnce(new Error('network down: <html>'));
    await store.loadSavedRecipients();
    expect(await store.loadSavedRecipients()).toEqual({ status: 'ERROR', recipients: [maria], code: 'RECIPIENTS_REQUEST_FAILED' });
    expect(await store.loadSavedRecipients()).toEqual({ status: 'SIGNED_OUT', recipients: [], code: 'ACCOUNT_SESSION_REQUIRED' });
    expect(await store.loadSavedRecipients()).toEqual({ status: 'UNAVAILABLE', recipients: [], code: 'RECIPIENTS_UNAVAILABLE' });
    // A thrown action never surfaces its text: a closed code only.
    expect(await store.loadSavedRecipients()).toEqual({ status: 'ERROR', recipients: [], code: 'RECIPIENTS_REQUEST_FAILED' });
  });

  it('a read started before an invalidation (sign-out, another account) never lands afterwards', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    actions.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = store.loadSavedRecipients();
    expect(store.savedRecipientsSnapshot().status).toBe('LOADING');
    store.invalidateSavedRecipients();
    resolve({ ok: true, value: [maria] });
    await pending;
    expect(store.savedRecipientsSnapshot()).toEqual({ status: 'IDLE', recipients: [], code: null });
  });

  it('saves, renames and removes through the server; an address already saved returns that record and changes nothing', async () => {
    actions.list.mockResolvedValue({ ok: true, value: [maria] });
    await store.loadSavedRecipients();
    actions.save.mockResolvedValueOnce({ ok: true, value: solana }).mockResolvedValueOnce({ ok: false, code: 'RECIPIENT_EXISTS', existing: maria })
      .mockResolvedValueOnce({ ok: false, code: 'RECIPIENT_LABEL_TAKEN' }).mockResolvedValueOnce({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' });
    expect(await store.saveRecipientReference({ label: 'Minha Solana', address: SOL })).toEqual({ ok: true, value: solana });
    expect(await store.saveRecipientReference({ label: 'Other', address: EVM })).toEqual({ ok: false, code: 'RECIPIENT_EXISTS', existing: maria });
    expect(store.savedRecipientsSnapshot().recipients).toEqual([maria, solana]);
    expect(await store.saveRecipientReference({ label: 'maria', address: '0x' + '1'.repeat(40) })).toEqual({ ok: false, code: 'RECIPIENT_LABEL_TAKEN' });
    expect(store.savedRecipientsSnapshot().recipients).toEqual([maria, solana]);
    const renamed = { ...solana, label: 'Família' };
    actions.rename.mockResolvedValueOnce({ ok: true, value: renamed });
    expect(await store.renameRecipientReference(solana.id, 'Família')).toEqual({ ok: true, value: renamed });
    expect(store.savedRecipientsSnapshot().recipients).toEqual([maria, renamed]);
    actions.remove.mockResolvedValueOnce({ ok: true, value: null }).mockResolvedValueOnce({ ok: false, code: 'RECIPIENT_NOT_FOUND' });
    expect(await store.removeRecipientReference(maria.id)).toEqual({ ok: true, value: null });
    expect(await store.removeRecipientReference(renamed.id)).toEqual({ ok: false, code: 'RECIPIENT_NOT_FOUND' });
    expect(store.savedRecipientsSnapshot()).toEqual({ status: 'READY', recipients: [], code: null });
    // The session ended while saving: everything goes.
    actions.list.mockResolvedValue({ ok: true, value: [maria] });
    await store.loadSavedRecipients();
    expect(await store.saveRecipientReference({ label: 'X', address: SOL })).toEqual({ ok: false, code: 'ACCOUNT_SESSION_REQUIRED' });
    expect(store.savedRecipientsSnapshot()).toEqual({ status: 'SIGNED_OUT', recipients: [], code: 'ACCOUNT_SESSION_REQUIRED' });
  });

  it('matches a bound destination to a saved recipient only by exact canonical address', () => {
    expect(store.savedRecipientForAddress('0x52908400098527886E0F7030069857D2E4169EE7', [maria, solana])).toBe(maria);
    expect(store.savedRecipientForAddress(EVM, [maria, solana])).toBe(maria);
    expect(store.savedRecipientForAddress('0x52908400098527886E0F7030069857D2E4169Ee7', [maria])).toBeNull(); // not the EIP-55 spelling
    expect(store.savedRecipientForAddress(SOL, [maria, solana])).toBe(solana);
    expect(store.savedRecipientForAddress(SOL.toLowerCase(), [solana])).toBeNull();
    expect(store.savedRecipientForAddress('Maria', [maria])).toBeNull();
    expect(store.savedRecipientForAddress(null, [maria])).toBeNull();
  });
});
