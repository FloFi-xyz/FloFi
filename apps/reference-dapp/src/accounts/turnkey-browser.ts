// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: the browser side of the embedded-wallet provider (Turnkey), loaded only by the wallet screens.
 *
 * - Session key: the provider's IndexedDB stamper keeps a non-extractable WebCrypto P-256 key in this browser. Sign-in binds the
 *   provider session to its public key; requests are stamped with it. FloFi's server never sees the private half.
 * - Create: the provider generates an HD wallet (one EVM or one Solana account) inside its enclave and returns only addresses.
 * - Import: the key is typed into the provider's own iframe (another origin). The iframe encrypts it to the provider's enclave;
 *   FloFi's page receives and forwards only that ciphertext. FloFi renders no private-key field of its own.
 * - Export: the provider encrypts the phrase or key to the export iframe's own key; only that iframe can decrypt and show it.
 *   FloFi's page relays ciphertext it cannot read, never stores or logs it, and never touches the clipboard.
 */
import type { WalletEcosystem } from '../wallet/wallet-registry';
import type { TurnkeyBrowserConfig } from './turnkey-server';

type Json = Record<string, unknown>;
export type ManagedContext = { readonly organizationId: string; readonly userId: string };
export type ExportRequest = { readonly organizationId: string; readonly source: 'wallet' | 'wallet-account' | 'private-key'; readonly resource: string;
  readonly address: string; readonly keyFormat: 'HEXADECIMAL' | 'SOLANA' };
const fail = (code: string): never => { throw new Error(code); };
const RESOURCE = /^[A-Za-z0-9-]{8,64}$/;

type Stamper = { init(): Promise<void>; getPublicKey(): string | null; stamp(payload: string): Promise<{ stampHeaderName: string; stampHeaderValue: string }>; clear(): Promise<void> };
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
/** This browser's provider session public key (compressed P-256, hex). Creates the key on first use; it never leaves as a secret. */
export async function sessionPublicKey(): Promise<string> {
  const key = (await sessionStamper()).getPublicKey();
  return typeof key === 'string' && /^0[23][0-9a-f]{64}$/.test(key) ? key : fail('MANAGED_SESSION_KEY_UNAVAILABLE');
}
/** Forgets this browser's provider session key (sign-out). A new key is created on the next sign-in. */
export async function clearSessionKey(): Promise<void> {
  try { await (await sessionStamper()).clear(); } catch { /* nothing stored */ } finally { stamper = null; }
}

/**
 * FloFi's pages connect only to their own origin: stamped requests go through the same-origin relay, which checks the account session,
 * the activity and the organization, then forwards the exact bytes. The relay cannot forge or alter the stamp.
 */
async function request(_config: TurnkeyBrowserConfig, path: string, body: Json): Promise<Json> {
  const raw = JSON.stringify(body), stamp = await (await sessionStamper()).stamp(raw);
  const response = await fetch(`/api/account/provider${path.replace(/^\/public\/v1/, '')}`, { method: 'POST', credentials: 'same-origin', referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json', [stamp.stampHeaderName]: stamp.stampHeaderValue }, body: raw }).catch(() => fail('MANAGED_PROVIDER_UNAVAILABLE'));
  const value = await response.json().catch(() => null) as Json | null;
  if (value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(value.code) && !response.ok) fail(value.code);
  if (response.status === 401 || response.status === 403) fail('MANAGED_SESSION_EXPIRED');
  return response.ok && value ? value : fail('MANAGED_PROVIDER_REQUEST_FAILED');
}
async function activity(config: TurnkeyBrowserConfig, path: string, type: string, organizationId: string, parameters: Json): Promise<Json> {
  let current = (await request(config, `/public/v1/submit/${path}`, { type, timestampMs: String(Date.now()), organizationId, parameters })).activity as Json | undefined;
  for (let attempt = 0; current && (current.status === 'ACTIVITY_STATUS_CREATED' || current.status === 'ACTIVITY_STATUS_PENDING') && attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** Math.min(attempt, 3)));
    current = (await request(config, '/public/v1/query/get_activity', { organizationId, activityId: current.id })).activity as Json | undefined;
  }
  if (!current || current.status !== 'ACTIVITY_STATUS_COMPLETED') fail('MANAGED_ACTIVITY_NOT_COMPLETED');
  const result = (current!.result ?? {}) as Json, key = Object.keys(result).find(name => name.startsWith(path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())));
  return key && result[key] && typeof result[key] === 'object' ? result[key] as Json : fail('MANAGED_RESPONSE_INVALID');
}

const ACCOUNT_PARAMS: Readonly<Record<WalletEcosystem, Json>> = Object.freeze({
  evm: { curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' },
  solana: { curve: 'CURVE_ED25519', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/501'/0'/0'", addressFormat: 'ADDRESS_FORMAT_SOLANA' },
});
/** Creates a new HD wallet with one account in the person's own provider organization. Returns its public address only. */
export async function createManagedWallet(config: TurnkeyBrowserConfig, context: ManagedContext, ecosystem: WalletEcosystem): Promise<{ walletId: string; address: string }> {
  const result = await activity(config, 'create_wallet', 'ACTIVITY_TYPE_CREATE_WALLET', context.organizationId,
    { walletName: `FloFi ${ecosystem === 'evm' ? 'EVM' : 'Solana'} wallet ${new Date().toISOString().slice(0, 10)}`, accounts: [ACCOUNT_PARAMS[ecosystem]], mnemonicLength: 12 });
  const address = Array.isArray(result.addresses) && typeof result.addresses[0] === 'string' ? result.addresses[0] : fail('MANAGED_RESPONSE_INVALID');
  return { walletId: typeof result.walletId === 'string' && RESOURCE.test(result.walletId) ? result.walletId : fail('MANAGED_RESPONSE_INVALID'), address: address as string };
}

type Frame = { init(): Promise<string>; clear(): void; injectImportBundle(bundle: string, organizationId: string, userId: string): Promise<boolean>;
  extractKeyEncryptedBundle(format?: string): Promise<string>; injectKeyExportBundle(bundle: string, organizationId: string, format?: string, address?: string): Promise<boolean>;
  injectWalletExportBundle(bundle: string, organizationId: string): Promise<boolean>; applySettings(settings: Json): Promise<boolean> };
async function frame(url: string, container: HTMLElement, id: string): Promise<Frame> {
  const { IframeStamper } = await import('@turnkey/iframe-stamper');
  return new IframeStamper({ iframeUrl: url, iframeContainer: container, iframeElementId: id }) as unknown as Frame;
}
const FRAME_STYLE = { styles: { padding: '12px', borderRadius: '12px', fontSize: '14px', fontFamily: 'IBM Plex Mono, monospace', width: '100%', height: '120px',
  overflowWrap: 'anywhere', resize: 'none' } };

/**
 * Opens the provider's import frame inside `container`. The person types the key there; `submit` asks the frame for the key encrypted
 * to the provider's enclave and imports that ciphertext. Nothing typed into the frame is readable by this page.
 */
export async function openImportFrame(config: TurnkeyBrowserConfig, context: ManagedContext, ecosystem: WalletEcosystem, container: HTMLElement) {
  const instance = await frame(config.importIframeUrl, container, `flofi-import-${ecosystem}`);
  try {
    await instance.init();
    const init = await activity(config, 'init_import_private_key', 'ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY', context.organizationId, { userId: context.userId });
    if (typeof init.importBundle !== 'string' || !await instance.injectImportBundle(init.importBundle, context.organizationId, context.userId)) fail('MANAGED_IMPORT_UNAVAILABLE');
    await instance.applySettings(FRAME_STYLE).catch(() => false);
  } catch (error) { instance.clear(); throw error; }
  return {
    async submit(): Promise<{ privateKeyId: string; address: string }> {
      const encryptedBundle = await instance.extractKeyEncryptedBundle(ecosystem === 'evm' ? 'HEXADECIMAL' : 'SOLANA').catch(() => fail('MANAGED_IMPORT_KEY_INVALID'));
      const result = await activity(config, 'import_private_key', 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY', context.organizationId, { userId: context.userId,
        privateKeyName: `FloFi imported ${ecosystem === 'evm' ? 'EVM' : 'Solana'} key ${Date.now()}`, encryptedBundle,
        curve: ecosystem === 'evm' ? 'CURVE_SECP256K1' : 'CURVE_ED25519', addressFormats: [ecosystem === 'evm' ? 'ADDRESS_FORMAT_ETHEREUM' : 'ADDRESS_FORMAT_SOLANA'] });
      const addresses = Array.isArray(result.addresses) ? result.addresses as Json[] : [];
      const address = addresses.find(entry => typeof entry?.address === 'string')?.address;
      return { privateKeyId: typeof result.privateKeyId === 'string' && RESOURCE.test(result.privateKeyId) ? result.privateKeyId : fail('MANAGED_RESPONSE_INVALID'),
        address: typeof address === 'string' ? address : fail('MANAGED_RESPONSE_INVALID') };
    },
    close: () => instance.clear(),
  };
}

/** Opens the provider's export frame inside `container` and has the provider reveal the phrase or key there, for this owner only. */
export async function openExportFrame(config: TurnkeyBrowserConfig, grant: ExportRequest, container: HTMLElement): Promise<{ close(): void }> {
  const instance = await frame(config.exportIframeUrl, container, `flofi-export-${grant.source}`);
  try {
    const targetPublicKey = await instance.init();
    const parameters = grant.source === 'wallet' ? { walletId: grant.resource, targetPublicKey } : grant.source === 'wallet-account'
      ? { address: grant.resource, targetPublicKey } : { privateKeyId: grant.resource, targetPublicKey };
    const path = grant.source === 'wallet' ? 'export_wallet' : grant.source === 'wallet-account' ? 'export_wallet_account' : 'export_private_key';
    const type = grant.source === 'wallet' ? 'ACTIVITY_TYPE_EXPORT_WALLET' : grant.source === 'wallet-account' ? 'ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT' : 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY';
    const bundle = (await activity(config, path, type, grant.organizationId, parameters)).exportBundle;
    if (typeof bundle !== 'string') fail('MANAGED_EXPORT_UNAVAILABLE');
    const shown = grant.source === 'wallet' ? await instance.injectWalletExportBundle(bundle as string, grant.organizationId)
      : await instance.injectKeyExportBundle(bundle as string, grant.organizationId, grant.keyFormat, grant.address);
    if (!shown) fail('MANAGED_EXPORT_UNAVAILABLE');
    await instance.applySettings(FRAME_STYLE).catch(() => false);
  } catch (error) { instance.clear(); throw error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error : new Error('MANAGED_EXPORT_UNAVAILABLE'); }
  return { close: () => instance.clear() };
}
