// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet's browser side of the embedded-wallet provider (Turnkey). Wallet origin only. Since
 * BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet is legacy and export-only: its create, import and signing calls were removed (Privy does those now).
 *
 * - Key: `@turnkey/indexed-db-stamper` keeps a non-extractable WebCrypto P-256 key in the wallet origin's IndexedDB. FloFi's product
 *   origin cannot read this storage. Unlocking binds a 15-minute provider session to this key's public half; requests are stamped with it.
 * - Every request goes to the wallet origin's own relay (`/api/wallet/provider/*`), which checks session, key, organization, activity and
 *   signer before forwarding the exact bytes. Nothing here broadcasts a transaction.
 * - Export uses the provider's own iframe; the key or phrase is shown only there.
 */

type Json = Record<string, unknown>;
export type TurnkeyFrames = { readonly exportIframeUrl: string; readonly importIframeUrl: string };
const fail = (code: string): never => { throw new Error(code); };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

type Stamper = { init(): Promise<void>; getPublicKey(): string | null; stamp(payload: string): Promise<{ stampHeaderName: string; stampHeaderValue: string }>;
  sign(payload: string, format?: string): Promise<string>; clear(): Promise<void>; resetKeyPair?(): Promise<void> };
let stamper: Promise<Stamper> | null = null;
async function sessionStamper(): Promise<Stamper> {
  stamper ??= (async () => {
    const { IndexedDbStamper } = await import('@turnkey/indexed-db-stamper');
    const instance = new IndexedDbStamper() as unknown as Stamper;
    await instance.init();
    return instance;
  })().catch(error => { stamper = null; throw error; });
  return stamper;
}
/** This wallet origin's key (compressed P-256, hex). Created on first use; its private half never leaves WebCrypto. */
export async function walletPublicKey(): Promise<string> {
  const key = (await sessionStamper()).getPublicKey();
  return typeof key === 'string' && /^0[23][0-9a-f]{64}$/.test(key) ? key : fail('MANAGED_SESSION_KEY_UNAVAILABLE');
}
/** A raw P-256 signature (r‖s, hex) over `message` with the wallet key: Turnkey's client signature for login or sign-up. */
export async function clientSignatureOver(message: string): Promise<string> {
  const signature = await (await sessionStamper()).sign(message, 'raw');
  return /^[0-9a-f]{128}$/.test(signature) ? signature : fail('MANAGED_SESSION_KEY_UNAVAILABLE');
}
/** Forgets the wallet key (lock / sign-out). A new key is created on the next unlock; the old provider session can no longer be stamped. */
export async function forgetWalletKey(): Promise<void> {
  try { await (await sessionStamper()).clear(); } catch { /* nothing stored */ } finally { stamper = null; }
}

async function request(path: string, body: Json, message?: string, extraHeaders: Readonly<Record<string, string>> = {}): Promise<Json> {
  const raw = JSON.stringify(body), stamp = await (await sessionStamper()).stamp(raw);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders, [stamp.stampHeaderName]: stamp.stampHeaderValue };
  if (message !== undefined) headers['x-flofi-message'] = btoa(String.fromCharCode(...new TextEncoder().encode(message))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const response = await fetch(`/api/wallet/provider/${path}`, { method: 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer', headers, body: raw })
    .catch(() => fail('MANAGED_PROVIDER_UNAVAILABLE'));
  const value = await response.json().catch(() => null) as Json | null;
  if (!response.ok) fail(value && typeof value.code === 'string' && CODE.test(value.code) ? value.code : response.status === 401 || response.status === 403 ? 'WALLET_UNLOCK_REQUIRED' : 'MANAGED_PROVIDER_REQUEST_FAILED');
  return value ?? fail('MANAGED_PROVIDER_REQUEST_FAILED');
}
type ActivityOptions = { readonly headers?: Readonly<Record<string, string>>; readonly onSubmitted?: () => void };
async function activity(path: string, type: string, organizationId: string, parameters: Json, message?: string, options: ActivityOptions = {}): Promise<Json> {
  let current = (await request(`submit/${path}`, { type, timestampMs: String(Date.now()), organizationId, parameters }, message, options.headers)).activity as Json | undefined;
  // From here on the provider has the activity: a later failure cannot prove that nothing was signed.
  options.onSubmitted?.();
  for (let attempt = 0; current && (current.status === 'ACTIVITY_STATUS_CREATED' || current.status === 'ACTIVITY_STATUS_PENDING') && attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** Math.min(attempt, 3)));
    current = (await request('query/get_activity', { organizationId, activityId: current.id })).activity as Json | undefined;
  }
  if (!current || current.status !== 'ACTIVITY_STATUS_COMPLETED') fail('MANAGED_ACTIVITY_NOT_COMPLETED');
  const result = (current!.result ?? {}) as Json, prefix = path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) + 'Result';
  const key = Object.keys(result).find(name => name.startsWith(prefix));
  return key && result[key] && typeof result[key] === 'object' ? result[key] as Json : fail('MANAGED_RESPONSE_INVALID');
}

type Frame = { init(): Promise<string>; clear(): void; injectKeyExportBundle(bundle: string, organizationId: string, format?: string, address?: string): Promise<boolean>;
  injectWalletExportBundle(bundle: string, organizationId: string): Promise<boolean>; applySettings(settings: Json): Promise<boolean> };
async function frame(url: string, container: HTMLElement, id: string): Promise<Frame> {
  const { IframeStamper } = await import('@turnkey/iframe-stamper');
  return new IframeStamper({ iframeUrl: url, iframeContainer: container, iframeElementId: id }) as unknown as Frame;
}
const FRAME_STYLE = { styles: { padding: '12px', borderRadius: '12px', fontSize: '14px', fontFamily: 'IBM Plex Mono, monospace', width: '100%', height: '120px',
  overflowWrap: 'anywhere', resize: 'none' } };

export type ExportGrant = { readonly organizationId: string; readonly source: 'wallet' | 'wallet-account' | 'private-key'; readonly resource: string;
  readonly address: string; readonly keyFormat: 'HEXADECIMAL' | 'SOLANA' };
/** The provider's export frame in `container`: the provider encrypts the phrase or key to the frame's own key, and only the frame shows it. */
export async function openExportFrame(frames: TurnkeyFrames, grant: ExportGrant, container: HTMLElement): Promise<{ close(): void }> {
  const instance = await frame(frames.exportIframeUrl, container, `flofi-export-${grant.source}`);
  try {
    const targetPublicKey = await instance.init();
    const parameters = grant.source === 'wallet' ? { walletId: grant.resource, targetPublicKey } : grant.source === 'wallet-account'
      ? { address: grant.resource, targetPublicKey } : { privateKeyId: grant.resource, targetPublicKey };
    const path = grant.source === 'wallet' ? 'export_wallet' : grant.source === 'wallet-account' ? 'export_wallet_account' : 'export_private_key';
    const type = grant.source === 'wallet' ? 'ACTIVITY_TYPE_EXPORT_WALLET' : grant.source === 'wallet-account' ? 'ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT' : 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY';
    const bundle = (await activity(path, type, grant.organizationId, parameters)).exportBundle;
    if (typeof bundle !== 'string') fail('MANAGED_EXPORT_UNAVAILABLE');
    const shown = grant.source === 'wallet' ? await instance.injectWalletExportBundle(bundle as string, grant.organizationId)
      : await instance.injectKeyExportBundle(bundle as string, grant.organizationId, grant.keyFormat, grant.address);
    if (!shown) fail('MANAGED_EXPORT_UNAVAILABLE');
    await instance.applySettings(FRAME_STYLE).catch(() => false);
  } catch (error) { instance.clear(); throw error instanceof Error && CODE.test(error.message) ? error : new Error('MANAGED_EXPORT_UNAVAILABLE'); }
  return { close: () => instance.clear() };
}
