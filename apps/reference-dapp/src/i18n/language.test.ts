// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE, LANGUAGE_COOKIE, LANGUAGE_KEY, LANGUAGE_MIGRATION_KEY, cookieLanguage, englishPinnedPath, languageCookie, languageMigrationScript,
  resolveLanguage, type Language } from './language';

/**
 * P0 hotfix (locale contract): the one resolver the layouts, server actions and the Assistant read, and the one-time migration of a legacy
 * preference kept only in browser storage.
 */
describe('locale resolver', () => {
  it('the cookie is authoritative wherever it is set', () => {
    for (const path of ['/', '/app', '/app/dashboard', '/login', '/board', '/wallet', '/mcp/approve', null]) {
      expect(resolveLanguage('PT', path), String(path)).toEqual({ language: 'PT', chosen: true });
      expect(resolveLanguage('EN', path), String(path)).toEqual({ language: 'EN', chosen: true });
    }
  });
  it('defaults to English when nothing was chosen (DEFAULT_LANGUAGE unchanged), and an invalid cookie is no choice', () => {
    expect(DEFAULT_LANGUAGE).toBe('EN');
    for (const cookie of [undefined, null, '', 'pt', 'pt-BR', 'FR', 'PT ']) expect(resolveLanguage(cookie, '/app'), String(cookie)).toEqual({ language: 'EN', chosen: false });
  });
  it('pins the embedded MCP surface, FloFi Wallet and the admin console to English when they have no cookie', () => {
    for (const path of ['/mcp/approve', '/wallet', '/wallet/export', '/admin', '/admin/access']) expect(englishPinnedPath(path), path).toBe(true);
    for (const path of ['/', '/app', '/login', '/board', '/walletx', null]) expect(englishPinnedPath(path), String(path)).toBe(false);
  });
  it('reads the preference from a document.cookie string and writes the same cookie the server reads', () => {
    expect(cookieLanguage(`a=1; ${LANGUAGE_COOKIE}=PT; b=2`)).toBe('PT');
    expect(cookieLanguage(`${LANGUAGE_COOKIE}=EN`)).toBe('EN');
    for (const value of ['', 'a=1', `${LANGUAGE_COOKIE}=FR`, `x${LANGUAGE_COOKIE}=PT`, null]) expect(cookieLanguage(value), String(value)).toBeNull();
    expect(languageCookie('PT', true)).toBe(`${LANGUAGE_COOKIE}=PT; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(languageCookie('EN', false)).toBe(`${LANGUAGE_COOKIE}=EN; Path=/; Max-Age=31536000; SameSite=Lax`);
  });
});

/** Runs the migration script against a stub browser: its storage, its session storage and a cookie jar that may refuse cookies. */
function browser({ stored, cookie = null, accepts = true, migrated = null }: { stored: string | null; cookie?: Language | null; accepts?: boolean; migrated?: string | null }) {
  const local = new Map<string, string>(stored === null ? [] : [[LANGUAGE_KEY, stored]]), session = new Map<string, string>(migrated ? [[LANGUAGE_MIGRATION_KEY, migrated]] : []);
  const jar = new Map<string, string>(cookie ? [[LANGUAGE_COOKIE, cookie]] : []);
  const state = { reloaded: 0, visibility: '' };
  const storage = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } });
  const document = { documentElement: { style: { set visibility(value: string) { state.visibility = value; }, get visibility() { return state.visibility; } } } };
  Object.defineProperty(document, 'cookie', { get: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (line: string) => { if (!accepts) return; const pair = line.split(';')[0]!; const at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); } });
  const location = { protocol: 'https:', reload: () => { state.reloaded += 1; } };
  return { run: (rendered: Language) => new Function('localStorage', 'sessionStorage', 'document', 'location', languageMigrationScript(rendered))(storage(local), storage(session), document, location),
    state, jar, local, session };
}
describe('one-time migration of a legacy stored preference (before the first paint)', () => {
  it('a first visit with only a stored Portuguese writes the cookie and reloads once, hidden, so the page never flips', () => {
    const page = browser({ stored: 'PT' });
    page.run('EN');
    expect(page.jar.get(LANGUAGE_COOKIE)).toBe('PT'); expect(page.state).toEqual({ reloaded: 1, visibility: 'hidden' });
    // The reloaded request carries the cookie: the server renders Portuguese and the layout emits no migration (`chosen`).
    expect(resolveLanguage(page.jar.get(LANGUAGE_COOKIE), '/app')).toEqual({ language: 'PT', chosen: true });
  });
  it('does nothing when storage matches what was rendered, is empty or invalid (the default is not written as a preference)', () => {
    for (const stored of ['EN', null, 'FR', 'pt']) {
      const page = browser({ stored });
      page.run('EN');
      expect(page.jar.size, String(stored)).toBe(0); expect(page.state.reloaded, String(stored)).toBe(0);
    }
  });
  it('never overrides a cookie (the cookie wins; the provider aligns storage to it after hydration)', () => {
    const page = browser({ stored: 'PT', cookie: 'EN' });
    page.run('EN');
    expect(page.jar.get(LANGUAGE_COOKIE)).toBe('EN'); expect(page.state.reloaded).toBe(0);
  });
  it('a browser that refuses cookies is never reloaded (no loop), and a tab that already migrated this value never reloads again', () => {
    const refusing = browser({ stored: 'PT', accepts: false });
    refusing.run('EN');
    expect(refusing.state.reloaded).toBe(0); expect(refusing.state.visibility).toBe('');
    const again = browser({ stored: 'PT', migrated: 'PT' });
    again.run('EN');
    expect(again.state.reloaded).toBe(0);
  });
  it('is data only: it touches the language preference and nothing else', () => {
    const script = languageMigrationScript('EN');
    expect(script).not.toMatch(/fetch|XMLHttpRequest|eval|innerHTML|import\(|wallet|ethereum/i);
    expect(script).toContain(JSON.stringify(LANGUAGE_KEY)); expect(script).toContain(JSON.stringify(LANGUAGE_COOKIE));
  });
});
