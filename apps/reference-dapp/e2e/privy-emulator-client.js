// SPDX-License-Identifier: AGPL-3.0-only
/* global window, document, location, localStorage, fetch, btoa, atob, TextDecoder, setTimeout */
/**
 * BUILD-FLOFI-PRIVY-UX-001 — MOCKED, LOOPBACK ONLY: the browser half of the Privy stand-in (e2e/privy-emulator.ts), injected by the browser
 * suite into the page (`addInitScript`). It implements FloFi's `PrivyDriver` (src/accounts/privy-client.tsx), which FloFi uses only when its
 * server runs in MOCKED loopback mode on a loopback host. It talks only to `/__privy-e2e/*` on the page's own origin, which the test routes to
 * the emulator. Like Privy, it asks the person before every signature and every export: a dialog the test answers with Approve or Cancel
 * (Cancel is Privy's "user exited"). The identity a sign-in uses comes from `window.__FLOFI_PRIVY_E2E_IDENTITY__`, set by the test.
 */
(() => {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  const KEY = 'flofi-e2e-privy-token';
  const state = { ready: false, authenticated: false, userId: null, embedded: [] };
  let snapshot = Object.freeze({ ...state, embedded: Object.freeze([]) });
  const listeners = new Set(), logins = new Set(), errors = new Set();
  // Like FloFi's bridge, a login event with no listener yet is kept for the first one (Privy reports it while it initializes).
  let pendingLogin = null;
  const emitLogin = event => { if (!logins.size) { pendingLogin = event; return; } for (const listener of [...logins]) listener(event); };
  let flofi = null;
  const token = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const publish = () => { snapshot = Object.freeze({ ...state, embedded: Object.freeze(state.embedded.map(wallet => Object.freeze({ ...wallet }))) }); for (const listener of [...listeners]) listener(); };
  async function call(path, input = {}) {
    const response = await fetch(`/__privy-e2e/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token(), ...input }) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || 'Privy request failed');
    return value;
  }
  const signedIn = user => { state.authenticated = true; state.userId = user.id; state.embedded = user.embedded; publish(); };
  async function refresh() { if (token()) signedIn(await call('user')); }
  async function login(input) {
    try {
      const { token: value, user } = await call('login', input);
      localStorage.setItem(KEY, value); signedIn(user);
      emitLogin({ wasAlreadyAuthenticated: false });
    } catch (error) { for (const listener of [...errors]) listener('PRIVY_SIGN_IN_FAILED'); throw error; }
  }
  const identity = () => window.__FLOFI_PRIVY_E2E_IDENTITY__ || {};
  /** Privy's own confirmation screen, played by a dialog the test answers. */
  function confirm(kind, title, detail) {
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'Privy confirmation (MOCKED)'); dialog.dataset.privyE2e = kind;
      dialog.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647;max-width:420px;padding:16px;background:#111;color:#fff;border:1px solid #888;border-radius:12px;font:14px sans-serif';
      const heading = document.createElement('h2'); heading.textContent = title; heading.style.cssText = 'margin:0 0 8px;font-size:16px';
      const text = document.createElement('p'); text.textContent = detail; text.dataset.privyE2eDetail = 'true';
      const approve = document.createElement('button'), cancel = document.createElement('button');
      approve.type = cancel.type = 'button'; approve.textContent = 'Approve'; cancel.textContent = 'Cancel';
      const close = () => dialog.remove();
      approve.onclick = () => { close(); resolve(); };
      cancel.onclick = () => { close(); reject(new Error('User exited the modal')); };
      dialog.append(heading, text, approve, cancel);
      document.body.append(dialog);
    });
  }
  const review = value => value ? `${value.title} — ${value.action} — ${value.description}` : '';
  const bytesToBase64 = bytes => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
  window.__FLOFI_PRIVY_E2E__ = {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attachFloFi(value) { flofi = value; },
    get flofi() { return flofi; },
    getAccessToken: async () => token(),
    onLogin(listener) {
      logins.add(listener);
      if (pendingLogin) { const event = pendingLogin; pendingLogin = null; setTimeout(() => { if (logins.has(listener)) listener(event); }, 0); }
      return () => logins.delete(listener);
    },
    onLoginError(listener) { errors.add(listener); return () => errors.delete(listener); },
    async loginWithOAuth(provider) {
      if (provider !== 'google' || !identity().google) throw new Error('OAuth sign-in failed');
      await login({ method: 'google', subject: identity().google });
    },
    async sendEmailCode(email) { await call('send-code', { email }); },
    async loginWithEmailCode(code) { await login({ method: 'email', email: identity().email, code }); },
    loginWithWallet() {
      const wallet = identity().wallet;
      if (!wallet) { for (const listener of [...errors]) listener('PRIVY_USER_CANCELLED'); return; }
      void login({ method: 'wallet', chain: wallet.chain || 'ethereum', address: wallet.address }).catch(() => undefined);
    },
    async createWallet(ecosystem) { const { address } = await call('wallets/create', { ecosystem }); await refresh(); return { address }; },
    async importWallet(ecosystem, privateKey) { const { address } = await call('wallets/import', { ecosystem, privateKey }); await refresh(); return { address }; },
    async exportWallet(ecosystem, address) {
      await confirm('export', 'Export your wallet (MOCKED)', `${ecosystem} ${address}: no secret is shown by this stand-in.`);
      await call('wallets/export', { address });
    },
    async signEvmTransaction(address, tx, value) {
      await confirm('evm-transaction', 'Sign a transaction', review(value));
      return (await call('sign/evm', { address, tx })).signature;
    },
    async signEvmMessage(address, message) {
      await confirm('evm-message', 'Sign a message', message);
      return (await call('sign/evm-message', { address, message })).signature;
    },
    async signSolanaTransaction(address, transaction, value) {
      await confirm('solana-transaction', 'Sign a transaction', review(value));
      return base64ToBytes((await call('sign/solana', { address, transaction: bytesToBase64(transaction) })).signedTransaction);
    },
    async signSolanaMessage(address, message) {
      await confirm('solana-message', 'Sign a message', new TextDecoder().decode(message));
      return base64ToBytes((await call('sign/solana-message', { address, message: bytesToBase64(message) })).signature);
    },
    async logout() {
      await call('logout').catch(() => undefined);
      try { localStorage.removeItem(KEY); } catch { /* nothing kept */ }
      state.authenticated = false; state.userId = null; state.embedded = []; publish();
    },
  };
  // Like Privy's SDK, the session left in this browser is restored on load; FloFi decides whether to use it.
  // Like Privy's login `onComplete`, a session that already existed when the page loaded is reported once, as `wasAlreadyAuthenticated`.
  void refresh().catch(() => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }).finally(() => {
    state.ready = true; publish();
    if (state.authenticated) setTimeout(() => emitLogin({ wasAlreadyAuthenticated: true }), 0);
  });
})();
