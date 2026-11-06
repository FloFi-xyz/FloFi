// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the production delegated-executor signer — an AWS KMS asymmetric key (KeySpec
 * ECC_SECG_P256K1, KeyUsage SIGN_VERIFY). The private key is generated inside KMS, is non-exportable and never reaches this process: FloFi
 * sends a 32-byte digest and receives a DER signature, which is normalized to low-s and given the recovery bit that reproduces the key's own
 * public key (any other result is refused). The key carries no authority of its own: it can only redeem the owner-signed delegations that
 * name its address, within their on-chain caveats.
 *
 *   isolation   one key per deployment environment, named by ARN (account and region bound); the application cannot create, delete,
 *               disable, rotate or export it — those are operator procedures (docs/deploy/DELEGATED-EXECUTION-PRODUCTION.md)
 *   least use   the API needs kms:GetPublicKey only; the executor worker needs kms:Sign and kms:GetPublicKey on that one key ARN
 *   audit       every Sign is recorded by CloudTrail; this provider also emits one structured audit event per signature (digest, address,
 *               key ARN, purpose) without any credential, and the executor persists the signed bytes before broadcast
 *   refs        a per-grant opaque reference (`aws-kms:evm.<random>`) so each grant row keeps its own reference while the key is shared;
 *               `destroy` never touches the key
 *
 * Requests use AWS Signature Version 4 over the KMS JSON API (no SDK dependency), with the standard AWS credential variables supplied
 * by the deployment's secret store. Solana (Ed25519) signing is not provided by this provider: there is no production Solana delegated
 * builder to sign for (see the capability matrix).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { DelegatedSignerProvider, EvmSignature } from './delegated-signer.js';

export type AwsCredentials = { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string };
const fail = (code: string): never => { throw new Error(code); };
const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

// ── AWS Signature Version 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type SigV4Request = {
  readonly method: 'GET' | 'POST'; readonly host: string; readonly path: string;
  /** Already canonical (sorted, URI-encoded) query string, or ''. */
  readonly query: string;
  /** Headers to sign besides host and x-amz-date (names in any case). */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string; readonly region: string; readonly service: string; readonly credentials: AwsCredentials; readonly now: Date;
};
const amzDate = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** The request headers to send, including `x-amz-date`, the session token (when present) and `authorization`. */
export function sigV4Headers(request: SigV4Request): Record<string, string> {
  const { credentials: c } = request;
  if (!/^[A-Z0-9]{8,128}$/.test(c.accessKeyId) || !c.secretAccessKey) fail('SIGNER_KMS_CREDENTIALS_INVALID');
  const date = amzDate(request.now), day = date.slice(0, 8);
  const all: Record<string, string> = { host: request.host, 'x-amz-date': date };
  for (const [k, v] of Object.entries(request.headers)) all[k.toLowerCase()] = v;
  if (c.sessionToken) all['x-amz-security-token'] = c.sessionToken;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map(n => `${n}:${all[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [request.method, request.path, request.query, canonicalHeaders, signedHeaders, sha256Hex(request.body)].join('\n');
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + c.secretAccessKey, day), request.region), request.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const out: Record<string, string> = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host;
  return out;
}

// ── DER ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** SubjectPublicKeyInfo header of an uncompressed secp256k1 key: SEQUENCE { SEQUENCE { id-ecPublicKey, secp256k1 }, BIT STRING (65 bytes) }. */
const SECP256K1_SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';
/** The uncompressed public key (0x04 ‖ X ‖ Y) of a KMS `GetPublicKey` result; anything but exactly a secp256k1 SPKI is refused. */
export function secp256k1PublicKeyFromSpki(der: Uint8Array): Uint8Array {
  const hex = Buffer.from(der).toString('hex');
  if (der.length !== 88 || !hex.startsWith(SECP256K1_SPKI_PREFIX) || der[23] !== 0x04) fail('SIGNER_KMS_PUBLIC_KEY_INVALID');
  const point = Uint8Array.from(der.subarray(23));
  try { secp256k1.Point.fromBytes(point).assertValidity(); } catch { fail('SIGNER_KMS_PUBLIC_KEY_INVALID'); }
  return point;
}
/** `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }`, strictly (minimal lengths, positive integers, no trailing bytes). */
export function parseDerEcdsaSignature(der: Uint8Array): { readonly r: bigint; readonly s: bigint } {
  let at = 0;
  const byte = () => der[at++] ?? fail('SIGNER_KMS_SIGNATURE_INVALID');
  if (byte() !== 0x30) fail('SIGNER_KMS_SIGNATURE_INVALID');
  const total = byte();
  if (total >= 0x80 || total !== der.length - 2) fail('SIGNER_KMS_SIGNATURE_INVALID');
  const integer = (): bigint => {
    if (byte() !== 0x02) fail('SIGNER_KMS_SIGNATURE_INVALID');
    const length = byte();
    if (length === 0 || length > 33 || at + length > der.length) fail('SIGNER_KMS_SIGNATURE_INVALID');
    const bytes = der.subarray(at, at + length); at += length;
    if (bytes[0]! & 0x80) fail('SIGNER_KMS_SIGNATURE_INVALID');
    if (length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80)) fail('SIGNER_KMS_SIGNATURE_INVALID');
    return BigInt('0x' + Buffer.from(bytes).toString('hex'));
  };
  const r = integer(), s = integer();
  if (at !== der.length) fail('SIGNER_KMS_SIGNATURE_INVALID');
  return { r, s };
}
const N = secp256k1.Point.CURVE().n;
/**
 * A KMS DER signature over `digest` as an Ethereum signature: s normalized to the lower half (EIP-2), and the recovery bit that recovers
 * exactly `publicKey`. A signature that verifies under neither bit is refused (never broadcast).
 */
export function kmsSignatureToEvm(der: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): EvmSignature {
  const { r, s: raw } = parseDerEcdsaSignature(der);
  if (r <= 0n || r >= N || raw <= 0n || raw >= N) fail('SIGNER_KMS_SIGNATURE_INVALID');
  const s = raw > N / 2n ? N - raw : raw;
  const expected = Buffer.from(publicKey).toString('hex');
  for (const yParity of [0, 1] as const) {
    try {
      const recovered = new secp256k1.Signature(r, s).addRecoveryBit(yParity).recoverPublicKey(digest).toBytes(false);
      if (Buffer.from(recovered).toString('hex') === expected) return { yParity, r, s };
    } catch { /* try the other bit */ }
  }
  return fail('SIGNER_KMS_SIGNATURE_INVALID');
}
export const evmAddressOfPublicKey = (publicKey: Uint8Array): string => '0x' + Buffer.from(keccak_256(publicKey.subarray(1)).subarray(12)).toString('hex');

// ── Provider ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const KEY_ARN = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):(?:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|alias\/[A-Za-z0-9/_-]{1,250})$/;
const REF = /^aws-kms:evm\.[0-9a-f]{24}$/;
export type KmsAuditEvent = { readonly event: 'flofi.kms.sign'; readonly at: string; readonly keyArn: string; readonly address: string; readonly digest: string;
  readonly ref: string; readonly ok: boolean; readonly code: string | null };
export type KmsSignerConfig = {
  readonly region: string;
  /** The key ARN (or alias ARN) of the deployment's ECC_SECG_P256K1 signing key; its region must equal `region`. */
  readonly evmKeyArn: string;
  /** The deployment's AWS credentials (read per request so rotated secrets apply without a restart). */
  readonly credentials: () => AwsCredentials | Promise<AwsCredentials>;
  /** HTTPS endpoint override (VPC or FIPS endpoint); `http://127.0.0.1:<port>` only with `loopbackForTests`. Default: the regional endpoint. */
  readonly endpoint?: string;
  readonly loopbackForTests?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly audit?: (event: KmsAuditEvent) => void;
};
/** KMS error `__type` → a stable code; throttling and server errors are retryable (`SIGNER_KMS_UNAVAILABLE`). */
function kmsError(status: number, type: string): string {
  const name = type.split('#').pop() ?? '';
  if (status >= 500 || /Throttling|LimitExceeded|KMSInternal|DependencyTimeout/.test(name)) return 'SIGNER_KMS_UNAVAILABLE';
  if (/AccessDenied|NotAuthorized|UnrecognizedClient|InvalidSignature|ExpiredToken/.test(name)) return 'SIGNER_KMS_DENIED';
  if (/Disabled|KMSInvalidState|NotFound|InvalidKeyUsage|IncorrectKey/.test(name)) return 'SIGNER_KMS_KEY_UNAVAILABLE';
  return 'SIGNER_KMS_REQUEST_REFUSED';
}
export function awsKmsSignerProvider(config: KmsSignerConfig): DelegatedSignerProvider {
  const arn = KEY_ARN.exec(config.evmKeyArn);
  if (!arn || arn[1] !== config.region) fail('SIGNER_KMS_CONFIG_INVALID');
  const endpoint = new URL(config.endpoint ?? `https://kms.${config.region}.amazonaws.com/`);
  const loopback = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && config.loopbackForTests === true;
  if ((endpoint.protocol !== 'https:' && !loopback) || endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password) fail('SIGNER_KMS_CONFIG_INVALID');
  const fetchImpl = config.fetch ?? fetch, now = config.now ?? (() => new Date());
  async function call(target: 'Sign' | 'GetPublicKey', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const headers = sigV4Headers({ method: 'POST', host: endpoint.host, path: '/', query: '', body, region: config.region, service: 'kms',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${target}` }, credentials: await config.credentials(), now: now() });
    const response = await fetchImpl(endpoint.href, { method: 'POST', headers, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .catch(() => fail('SIGNER_KMS_UNAVAILABLE'));
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) fail(kmsError(response.status, typeof json?.__type === 'string' ? json.__type : ''));
    return json ?? fail('SIGNER_KMS_UNAVAILABLE');
  }
  let publicKey: Promise<Uint8Array> | null = null;
  const loadPublicKey = () => publicKey ??= (async () => {
    const r = await call('GetPublicKey', { KeyId: config.evmKeyArn });
    if (r.KeySpec !== 'ECC_SECG_P256K1' || r.KeyUsage !== 'SIGN_VERIFY' || !Array.isArray(r.SigningAlgorithms) || !r.SigningAlgorithms.includes('ECDSA_SHA_256')
      || typeof r.PublicKey !== 'string') fail('SIGNER_KMS_KEY_UNAVAILABLE');
    return secp256k1PublicKeyFromSpki(Buffer.from(r.PublicKey as string, 'base64'));
  })().catch(error => { publicKey = null; throw error; });
  const checkRef = (ref: string) => { if (!REF.test(ref)) fail('SIGNER_REF_INVALID'); };
  return {
    id: 'aws-kms', production: true,
    async create(namespace) {
      if (namespace !== 'eip155') fail('SIGNER_NAMESPACE_UNAVAILABLE');
      return { ref: `aws-kms:evm.${randomBytes(12).toString('hex')}`, address: evmAddressOfPublicKey(await loadPublicKey()) };
    },
    async address(ref) { checkRef(ref); return evmAddressOfPublicKey(await loadPublicKey()); },
    async signEvmDigest(ref, digest) {
      checkRef(ref);
      if (digest.length !== 32) fail('SIGNER_REQUEST_INVALID');
      const key = await loadPublicKey(), address = evmAddressOfPublicKey(key), digestHex = '0x' + Buffer.from(digest).toString('hex');
      const audit = (ok: boolean, code: string | null) => config.audit?.({ event: 'flofi.kms.sign', at: now().toISOString(), keyArn: config.evmKeyArn, address,
        digest: digestHex, ref, ok, code });
      try {
        const r = await call('Sign', { KeyId: config.evmKeyArn, Message: Buffer.from(digest).toString('base64'), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
        if (typeof r.Signature !== 'string' || r.SigningAlgorithm !== 'ECDSA_SHA_256') fail('SIGNER_KMS_SIGNATURE_INVALID');
        const signature = kmsSignatureToEvm(Buffer.from(r.Signature as string, 'base64'), digest, key);
        audit(true, null);
        return signature;
      } catch (error) { audit(false, error instanceof Error ? error.message : 'SIGNER_KMS_UNAVAILABLE'); throw error; }
    },
    async signSolanaMessage() { return fail('SIGNER_NAMESPACE_UNAVAILABLE'); },
    // The deployment's key is shared by its grants and is never deleted, disabled or rotated by the application.
    async destroy(ref) { checkRef(ref); },
  };
}
/** The standard AWS credential variables of the process environment (never logged); missing ones refuse. */
export function awsCredentialsFromEnv(env: Readonly<Record<string, string | undefined>>): AwsCredentials {
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? '';
  if (!accessKeyId || !secretAccessKey) fail('SIGNER_KMS_CREDENTIALS_MISSING');
  return env.AWS_SESSION_TOKEN ? { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN } : { accessKeyId, secretAccessKey };
}
