// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001 browser-suite harness — MOCKED, LOOPBACK ONLY. Never a public provider, never a real key or identity.
 *
 * - Identity provider: `/google/*` (authorization code + PKCE S256, token endpoint, JWKS) and `/apple/*` (form_post ID token, JWKS).
 *   ID tokens are real RS256 JWTs signed by a key generated at start-up, so FloFi's server verification runs unchanged.
 * - Wallet provider: `/public/v1/*` emulates the Turnkey activities FloFi uses. Every request's `X-Stamp` is verified (ECDSA P-256 over
 *   the exact body); parent-key calls and per-organization session keys are authorized separately, as the provider does.
 *   Addresses are derived deterministically from ids; no private key exists anywhere in this harness.
 * - Ports +1 (export) and +2 (import) serve stand-ins for the provider's frames, speaking the iframe-stamper message protocol. The export
 *   frame shows a MOCKED notice, never a secret.
 */
import { createHash, createPublicKey, createSign, ECDH, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number(process.env.FLOFI_ACCOUNT_HARNESS_PORT ?? '8571');
const origin = `http://127.0.0.1:${port}`;
const appOrigin = process.env.FLOFI_ACCOUNT_HARNESS_APP_ORIGIN ?? '';
const parentKey = (process.env.FLOFI_ACCOUNT_HARNESS_PARENT_PUBLIC_KEY ?? '').toLowerCase();
const parentOrg = process.env.FLOFI_ACCOUNT_HARNESS_PARENT_ORG ?? '';
const googleClient = process.env.FLOFI_ACCOUNT_HARNESS_GOOGLE_CLIENT ?? '', googleSecret = process.env.FLOFI_ACCOUNT_HARNESS_GOOGLE_SECRET ?? '';
const appleClient = process.env.FLOFI_ACCOUNT_HARNESS_APPLE_CLIENT ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(appOrigin) || !/^0[23][0-9a-f]{64}$/.test(parentKey) || !parentOrg || !googleClient || !appleClient) throw new Error('ACCOUNT_HARNESS_CONFIG_INVALID');
export const E2E_OTP_CODE = '246810';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-1', alg: 'RS256', use: 'sig' };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(provider: 'google' | 'apple', sub: string, nonce: string, aud: string) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'e2e-1', typ: 'JWT' })}.${b64({ iss: `${origin}/${provider}`, aud, ...provider === 'google' ? { azp: aud } : {}, sub, nonce,
    email: `${sub}@flofi-e2e.test`, email_verified: provider === 'apple' ? 'true' : true, iat: now, exp: now + 600 })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
const payloadOf = (token: string) => { try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, string>; } catch { return {}; } };

// ---- Wallet provider state ----
type Org = { id: string; user: string; email: string | null; oidc: string | null; sessions: Set<string>;
  wallets: { walletId: string; accounts: { address: string; format: string }[] }[]; keys: { privateKeyId: string; addresses: { format: string; address: string }[] }[] };
const orgs = new Map<string, Org>(), otps = new Map<string, { email: string }>(), verifications = new Map<string, { email: string; key: string }>();
const id = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Buffer): string {
  let value = BigInt('0x' + bytes.toString('hex')), text = '';
  while (value > 0n) { text = ALPHABET[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
const evmAddress = (seed: string) => '0x' + createHash('sha256').update(`evm:${seed}`).digest('hex').slice(0, 40);
const solanaAddress = (seed: string) => base58(createHash('sha256').update(`solana:${seed}`).digest());
const address = (format: string, seed: string) => format === 'ADDRESS_FORMAT_ETHEREUM' ? evmAddress(seed) : solanaAddress(seed);

function stampKey(header: string | undefined, body: string): string | null {
  try {
    const stamp = JSON.parse(Buffer.from(header ?? '', 'base64url').toString()) as { publicKey: string; scheme: string; signature: string };
    if (stamp.scheme !== 'SIGNATURE_SCHEME_TK_API_P256' || !/^0[23][0-9a-f]{64}$/.test(stamp.publicKey)) return null;
    // ECDH.convertKey decompresses the SEC1 point; no private key is involved.
    const uncompressed = Buffer.from(ECDH.convertKey(stamp.publicKey, 'prime256v1', 'hex', 'hex', 'uncompressed') as string, 'hex');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: uncompressed.subarray(1, 33).toString('base64url'), y: uncompressed.subarray(33).toString('base64url') }, format: 'jwk' });
    return verify('sha256', Buffer.from(body), key, Buffer.from(stamp.signature, 'hex')) ? stamp.publicKey : null;
  } catch { return null; }
}
const completed = (type: string, organizationId: string, result: object) =>
  ({ activity: { id: id('activity'), organizationId, status: 'ACTIVITY_STATUS_COMPLETED', type, result } });
const failed = (type: string, organizationId: string) => ({ activity: { id: id('activity'), organizationId, status: 'ACTIVITY_STATUS_FAILED', type, result: {} } });
const session = (org: Org, key: string) => { org.sessions.add(key); return `${b64({ alg: 'none' })}.${b64({ organization_id: org.id, user_id: org.user, public_key: key, exp: Math.floor(Date.now() / 1000) + 3600 })}.mock`; };

function provider(path: string, body: Record<string, unknown>, signer: string | null): [number, unknown] {
  const parameters = (body.parameters ?? {}) as Record<string, unknown>, organizationId = String(body.organizationId ?? ''), type = String(body.type ?? '');
  const parent = signer === parentKey;
  const org = orgs.get(organizationId);
  const member = !!org && !!signer && org.sessions.has(signer);
  if (!signer) return [401, { message: 'invalid stamp' }];
  switch (path) {
    case 'submit/init_otp': if (!parent || organizationId !== parentOrg) return [403, {}];
      { const otpId = id('otp'); otps.set(otpId, { email: String(parameters.contact) }); return [200, completed(type, organizationId, { initOtpResult: { otpId } })]; }
    case 'submit/verify_otp': {
      if (!parent) return [403, {}];
      const otp = otps.get(String(parameters.otpId));
      if (!otp || parameters.otpCode !== E2E_OTP_CODE) return [200, failed(type, organizationId)];
      otps.delete(String(parameters.otpId));
      const token = `vt.${randomBytes(18).toString('base64url')}`; verifications.set(token, { email: otp.email, key: String(parameters.publicKey) });
      return [200, completed(type, organizationId, { verifyOtpResult: { verificationToken: token } })];
    }
    case 'query/list_verified_suborgs': case 'query/list_suborgs': {
      if (!parent) return [403, {}];
      const value = String(body.filterValue ?? ''), oidc = body.filterType === 'OIDC_TOKEN' ? `${payloadOf(value).iss}|${payloadOf(value).sub}` : null;
      return [200, { organizationIds: [...orgs.values()].filter(o => oidc ? o.oidc === oidc : o.email === value).map(o => o.id) }];
    }
    case 'query/list_users': return parent || member ? [200, { users: org ? [{ userId: org.user, userName: 'FloFi user' }] : [] }] : [403, {}];
    case 'submit/create_sub_organization': {
      if (!parent) return [403, {}];
      const root = ((parameters.rootUsers as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
      const oauth = ((root.oauthProviders as { oidcToken: string }[] | undefined) ?? [])[0];
      const created: Org = { id: id('org'), user: id('user'), email: typeof root.userEmail === 'string' ? root.userEmail : null,
        oidc: oauth ? `${payloadOf(oauth.oidcToken).iss}|${payloadOf(oauth.oidcToken).sub}` : null, sessions: new Set(), wallets: [], keys: [] };
      if ((root.apiKeys as unknown[] | undefined)?.length) return [400, { message: 'no API keys expected' }];
      orgs.set(created.id, created);
      return [200, completed(type, organizationId, { createSubOrganizationResultV7: { subOrganizationId: created.id, rootUserIds: [created.user] } })];
    }
    case 'submit/otp_login': {
      const verification = verifications.get(String(parameters.verificationToken));
      if (!parent || !org || !verification || verification.key !== parameters.publicKey || verification.email !== org.email) return [200, failed(type, organizationId)];
      return [200, completed(type, organizationId, { otpLoginResult: { session: session(org, String(parameters.publicKey)) } })];
    }
    case 'submit/oauth_login': {
      const token = payloadOf(String(parameters.oidcToken)), key = String(parameters.publicKey);
      // The provider's binding: the token's nonce is sha256(the session public key).
      if (!parent || !org || org.oidc !== `${token.iss}|${token.sub}` || token.nonce !== createHash('sha256').update(key).digest('hex')) return [200, failed(type, organizationId)];
      return [200, completed(type, organizationId, { oauthLoginResult: { session: session(org, key) } })];
    }
    case 'submit/create_wallet': {
      if (!member) return [403, {}];
      const walletId = id('wallet'), accounts = ((parameters.accounts as { addressFormat: string }[] | undefined) ?? []).map(entry => ({ format: entry.addressFormat, address: address(entry.addressFormat, walletId) }));
      org!.wallets.push({ walletId, accounts });
      return [200, completed(type, organizationId, { createWalletResult: { walletId, addresses: accounts.map(entry => entry.address) } })];
    }
    case 'submit/init_import_private_key': return member && parameters.userId === org!.user ? [200, completed(type, organizationId, { initImportPrivateKeyResult: { importBundle: `mock-import-bundle-${randomBytes(8).toString('hex')}` } })] : [403, {}];
    case 'submit/import_private_key': {
      if (!member || typeof parameters.encryptedBundle !== 'string' || !parameters.encryptedBundle.startsWith('mock-encrypted:')) return [200, failed(type, organizationId)];
      const privateKeyId = id('key'), format = ((parameters.addressFormats as string[] | undefined) ?? [])[0] ?? '';
      const addresses = [{ format, address: address(format, parameters.encryptedBundle) }];
      org!.keys.push({ privateKeyId, addresses });
      return [200, completed(type, organizationId, { importPrivateKeyResult: { privateKeyId, addresses } })];
    }
    case 'submit/export_wallet': case 'submit/export_wallet_account': case 'submit/export_private_key': {
      if (!member || typeof parameters.targetPublicKey !== 'string') return [403, {}];
      const result = path.endsWith('export_wallet') ? 'exportWalletResult' : path.endsWith('account') ? 'exportWalletAccountResult' : 'exportPrivateKeyResult';
      return [200, completed(type, organizationId, { [result]: { exportBundle: `mock-export-bundle:${path.split('/')[1]}` } })];
    }
    case 'query/list_wallet_accounts': return parent || member ? [200, { accounts: (org?.wallets ?? []).flatMap(wallet => wallet.accounts.map(entry =>
      ({ walletId: wallet.walletId, address: entry.address, addressFormat: entry.format }))) }] : [403, {}];
    case 'query/list_wallets': return parent || member ? [200, { wallets: (org?.wallets ?? []).map(wallet => ({ walletId: wallet.walletId, walletName: 'w', imported: false, exported: false })) }] : [403, {}];
    case 'query/list_private_keys': return parent || member ? [200, { privateKeys: (org?.keys ?? []).map(key => ({ ...key, imported: true, exported: false })) }] : [403, {}];
    default: return [404, { message: `unsupported ${path}` }];
  }
}

const FRAME = (kind: 'import' | 'export') => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px "IBM Plex Mono",monospace;background:#15181F;color:#F4F5F7}textarea{box-sizing:border-box;width:100%;height:96px;border:0;background:#1C2029;color:#F4F5F7;padding:10px;resize:none}
p{margin:8px 10px;color:#A4ABB8}strong{color:#F5B94A}</style></head><body>
${kind === 'import' ? '<p><strong>MOCKED</strong> test frame standing in for the provider’s secure field</p><textarea aria-label="Private key" spellcheck="false"></textarea>'
    : '<p id="out"><strong>MOCKED</strong> export frame. The provider’s real frame shows the secret here; this test harness has none.</p>'}
<script>
let port=null;const key=[...crypto.getRandomValues(new Uint8Array(33))].map(b=>b.toString(16).padStart(2,'0')).join('');
const reply=(type,value,requestId)=>port&&port.postMessage({type,value,requestId});
addEventListener('message',e=>{if(e.data&&e.data.type==='TURNKEY_INIT_MESSAGE_CHANNEL'&&e.ports[0]){port=e.ports[0];port.onmessage=handle;reply('PUBLIC_KEY_READY',key);}});
async function handle(e){const {type,requestId}=e.data||{};
 if(type==='APPLY_SETTINGS')return reply('SETTINGS_APPLIED',true,requestId);
 if(type==='INJECT_IMPORT_BUNDLE')return reply('BUNDLE_INJECTED',true,requestId);
 if(type==='EXTRACT_KEY_ENCRYPTED_BUNDLE'){const t=document.querySelector('textarea');const v=(t&&t.value||'').trim();if(!v)return reply('ERROR','empty key',requestId);
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));t.value='';return reply('ENCRYPTED_BUNDLE_EXTRACTED','mock-encrypted:'+[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''),requestId);}
 if(type==='INJECT_WALLET_EXPORT_BUNDLE'||type==='INJECT_KEY_EXPORT_BUNDLE'){document.getElementById('out').innerHTML='<strong>MOCKED</strong> '+(type==='INJECT_WALLET_EXPORT_BUNDLE'?'recovery phrase':'private key')+' would be shown here by the provider. No secret exists in this test.';return reply('BUNDLE_INJECTED',true,requestId);}
 reply('ERROR','unsupported',requestId);}
</script></body></html>`;

const authorizePage = (provider: 'google' | 'apple', params: URLSearchParams) => {
  const users = provider === 'google' ? ['e2e-google-ana', 'e2e-google-bruno'] : ['e2e-apple-carla'];
  const buttons = users.map(user => `<button name="user" value="${user}">Continue as ${user} (MOCKED)</button>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>MOCKED ${provider} sign-in</title></head><body style="font:16px sans-serif;padding:32px">
<h1>MOCKED ${provider === 'google' ? 'Google' : 'Apple'} sign-in (loopback test identity provider)</h1>
<form method="post" action="/${provider}/consent">${[...params].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`).join('')}${buttons}
<button name="user" value="__cancel">Cancel</button></form></body></html>`;
};
const codes = new Map<string, { sub: string; nonce: string; challenge: string; redirect: string }>();

async function read(request: IncomingMessage): Promise<string> { let body = ''; for await (const chunk of request) body += chunk; return body; }
function send(response: ServerResponse, status: number, body: string, type = 'application/json', headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': type, 'access-control-allow-origin': appOrigin, 'access-control-allow-headers': 'content-type, x-stamp',
    'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store', ...headers });
  response.end(body);
}
// Like the provider's own frames, each stand-in frame is served at the root of its own origin: export on port + 1, import on port + 2.
for (const [offset, kind] of [[1, 'export'], [2, 'import']] as const)
  createServer((_, response) => send(response, 200, FRAME(kind), 'text/html; charset=utf-8')).listen(port + offset, '127.0.0.1');
createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', origin);
  try {
    if (request.method === 'OPTIONS') return send(response, 204, '');
    if (url.pathname === '/google/jwks' || url.pathname === '/apple/jwks') return send(response, 200, JSON.stringify({ keys: [jwk] }));
    if (url.pathname === '/google/authorize' || url.pathname === '/apple/authorize') return send(response, 200, authorizePage(url.pathname.startsWith('/google') ? 'google' : 'apple', url.searchParams), 'text/html; charset=utf-8');
    if (url.pathname === '/google/consent' || url.pathname === '/apple/consent') {
      const form = new URLSearchParams(await read(request)), redirect = form.get('redirect_uri') ?? '', state = form.get('state') ?? '', user = form.get('user') ?? '';
      if (!redirect.startsWith(`${appOrigin}/auth/callback/`)) return send(response, 400, 'redirect refused', 'text/plain');
      if (url.pathname === '/google/consent') {
        if (form.get('client_id') !== googleClient) return send(response, 400, 'client refused', 'text/plain');
        const target = new URL(redirect);
        if (user === '__cancel') target.searchParams.set('error', 'access_denied');
        else { const code = randomBytes(16).toString('hex'); codes.set(code, { sub: user, nonce: form.get('nonce') ?? '', challenge: form.get('code_challenge') ?? '', redirect }); target.searchParams.set('code', code); }
        target.searchParams.set('state', state);
        return send(response, 303, '', 'text/plain', { location: target.toString() });
      }
      if (form.get('client_id') !== appleClient) return send(response, 400, 'client refused', 'text/plain');
      const fields = user === '__cancel' ? { state, error: 'user_cancelled_authorize' } : { state, code: randomBytes(8).toString('hex'), id_token: idToken('apple', user, form.get('nonce') ?? '', appleClient) };
      return send(response, 200, `<!doctype html><html><body><form id="f" method="post" action="${redirect}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('')}</form>
<script>document.getElementById('f').submit()</script></body></html>`, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/google/token' && request.method === 'POST') {
      const form = new URLSearchParams(await read(request)), entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!entry || form.get('client_id') !== googleClient || form.get('client_secret') !== googleSecret || entry.challenge !== challenge || form.get('redirect_uri') !== entry.redirect)
        return send(response, 400, JSON.stringify({ error: 'invalid_grant' }));
      return send(response, 200, JSON.stringify({ id_token: idToken('google', entry.sub, entry.nonce, googleClient), token_type: 'Bearer' }));
    }
    const match = /^\/public\/v1\/((?:submit|query)\/[a-z_]+)$/.exec(url.pathname);
    if (match && request.method === 'POST') {
      const raw = await read(request);
      const [status, value] = provider(match[1]!, JSON.parse(raw) as Record<string, unknown>, stampKey(request.headers['x-stamp'] as string | undefined, raw));
      return send(response, status, JSON.stringify(value));
    }
    if (url.pathname === '/health') return send(response, 200, '{"ok":true}');
    send(response, 404, '{}');
  } catch (error) { send(response, 500, JSON.stringify({ message: String(error) })); }
}).listen(port, '127.0.0.1');
