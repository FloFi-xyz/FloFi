// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the AWS KMS secp256k1 signer provider against a loopback KMS double (127.0.0.1 only). The
 * double verifies each request's Signature Version 4 with its own copy of the test secret and signs with a local secp256k1 key, returning
 * DER exactly as KMS does (including high-s values). Nothing here reaches AWS; these are test credentials of the documentation example.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { awsCredentialsFromEnv, awsKmsSignerProvider, evmAddressOfPublicKey, kmsSignatureToEvm, parseDerEcdsaSignature, secp256k1PublicKeyFromSpki,
  sigV4Headers, type KmsAuditEvent } from '../src/kms-signer.js';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const REGION = 'us-east-1', ARN = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const N = secp256k1.Point.CURVE().n;
const der = (r: bigint, s: bigint) => {
  const int = (v: bigint) => { let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex'); while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1);
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([0x02, b.length]), b]); };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};
const spki = (pub: Uint8Array) => Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), Buffer.from(pub)]);

describe('Signature Version 4', () => {
  it('reproduces the AWS documentation example (IAM ListUsers, 2015-08-30T12:36:00Z)', () => {
    const headers = sigV4Headers({ method: 'GET', host: 'iam.amazonaws.com', path: '/', query: 'Action=ListUsers&Version=2010-05-08', body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, region: 'us-east-1', service: 'iam', credentials: CREDS,
      now: new Date('2015-08-30T12:36:00Z') });
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, '
      + 'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers.host).toBeUndefined();
  });
  it('signs the session token when temporary credentials are used, and refuses malformed credentials', () => {
    const h = sigV4Headers({ method: 'POST', host: 'kms.us-east-1.amazonaws.com', path: '/', query: '', body: '{}', headers: {}, region: REGION, service: 'kms',
      credentials: { ...CREDS, sessionToken: 'token' }, now: new Date('2026-01-01T00:00:00Z') });
    expect(h['x-amz-security-token']).toBe('token');
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
    expect(() => sigV4Headers({ method: 'POST', host: 'h', path: '/', query: '', body: '', headers: {}, region: REGION, service: 'kms',
      credentials: { accessKeyId: 'bad id', secretAccessKey: 'x' }, now: new Date() })).toThrow('SIGNER_KMS_CREDENTIALS_INVALID');
  });
});

describe('DER and recovery', () => {
  const secret = secp256k1.utils.randomSecretKey(), pub = secp256k1.getPublicKey(secret, false);
  const digest = keccak_256(new TextEncoder().encode('flofi'));
  const sig = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
  const r = BigInt('0x' + Buffer.from(sig.subarray(1, 33)).toString('hex')), s = BigInt('0x' + Buffer.from(sig.subarray(33)).toString('hex'));
  it('parses strict DER and normalizes a high-s signature to low-s with the bit that recovers the KMS key', () => {
    expect(parseDerEcdsaSignature(der(r, s))).toEqual({ r, s });
    const low = kmsSignatureToEvm(der(r, s), digest, pub), high = kmsSignatureToEvm(der(r, N - s), digest, pub);
    expect(low).toEqual({ yParity: sig[0], r, s });
    expect(high).toEqual(low);
    expect(high.s <= N / 2n).toBe(true);
  });
  it('refuses a signature by another key, non-minimal or trailing DER, and a non-secp256k1 public key', () => {
    const other = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
    expect(() => kmsSignatureToEvm(der(r, s), digest, other)).toThrow('SIGNER_KMS_SIGNATURE_INVALID');
    expect(() => parseDerEcdsaSignature(Buffer.concat([der(r, s), Buffer.from([0])]))).toThrow('SIGNER_KMS_SIGNATURE_INVALID');
    expect(() => parseDerEcdsaSignature(Buffer.from('3008020200010202000101', 'hex'))).toThrow('SIGNER_KMS_SIGNATURE_INVALID');
    expect(secp256k1PublicKeyFromSpki(spki(pub))).toEqual(pub);
    // A P-256 SPKI (prime256v1 OID) is not a secp256k1 key.
    const p256 = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(pub)]);
    expect(() => secp256k1PublicKeyFromSpki(p256)).toThrow('SIGNER_KMS_PUBLIC_KEY_INVALID');
    expect(() => secp256k1PublicKeyFromSpki(spki(Buffer.alloc(65, 4)))).toThrow('SIGNER_KMS_PUBLIC_KEY_INVALID');
  });
});

describe('AWS KMS provider against a loopback KMS double', () => {
  const secret = secp256k1.utils.randomSecretKey(), pub = secp256k1.getPublicKey(secret, false);
  let server: Server, endpoint = '';
  const seen: { target: string; body: Record<string, unknown> }[] = [];
  let mode: 'ok' | 'throttle' | 'denied' | 'wrong-spec' | 'high-s' = 'ok';
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const target = String(req.headers['x-amz-target'] ?? '').replace('TrentService.', ''), body = JSON.parse(raw) as Record<string, unknown>;
        // Verify SigV4 with the double's own copy of the secret (any tampering or wrong secret fails here).
        const expected = sigV4Headers({ method: 'POST', host: String(req.headers.host), path: '/', query: '', body: raw, region: REGION, service: 'kms',
          headers: { 'content-type': String(req.headers['content-type']), 'x-amz-target': String(req.headers['x-amz-target']) }, credentials: CREDS,
          now: new Date(String(req.headers['x-amz-date']).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) });
        const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' }); res.end(JSON.stringify(json)); };
        if (req.headers.authorization !== expected.authorization) return send(400, { __type: 'InvalidSignatureException' });
        seen.push({ target, body });
        if (mode === 'throttle') return send(400, { __type: 'ThrottlingException' });
        if (mode === 'denied') return send(400, { __type: 'AccessDeniedException' });
        if (body.KeyId !== ARN) return send(400, { __type: 'NotFoundException' });
        if (target === 'GetPublicKey') return send(200, { KeyId: ARN, KeySpec: mode === 'wrong-spec' ? 'ECC_NIST_P256' : 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
          SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: spki(pub).toString('base64') });
        if (target === 'Sign' && body.MessageType === 'DIGEST' && body.SigningAlgorithm === 'ECDSA_SHA_256') {
          const digest = Buffer.from(String(body.Message), 'base64');
          const sig = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
          const r = BigInt('0x' + Buffer.from(sig.subarray(1, 33)).toString('hex')), s = BigInt('0x' + Buffer.from(sig.subarray(33)).toString('hex'));
          return send(200, { KeyId: ARN, SigningAlgorithm: 'ECDSA_SHA_256', Signature: der(r, mode === 'high-s' ? N - s : s).toString('base64') });
        }
        return send(400, { __type: 'ValidationException' });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  const provider = (audit?: (e: KmsAuditEvent) => void) => awsKmsSignerProvider({ region: REGION, evmKeyArn: ARN, credentials: () => CREDS, endpoint, loopbackForTests: true,
    ...(audit ? { audit } : {}) });

  it('derives the address from the KMS public key, gives each grant its own reference, and signs digests that recover to that address', async () => {
    mode = 'ok';
    const events: KmsAuditEvent[] = [], p = provider(e => events.push(e));
    expect(p).toMatchObject({ id: 'aws-kms', production: true });
    const a = await p.create('eip155'), b = await p.create('eip155');
    expect(a.address).toBe(evmAddressOfPublicKey(pub));
    expect(b.address).toBe(a.address);
    expect(a.ref).not.toBe(b.ref);
    expect(a.ref).toMatch(/^aws-kms:evm\.[0-9a-f]{24}$/);
    for (const m of ['ok', 'high-s'] as const) {
      mode = m;
      const digest = keccak_256(new TextEncoder().encode(`tx-${m}`));
      const sig = await p.signEvmDigest(a.ref, digest);
      expect(sig.s <= N / 2n).toBe(true);
      const recovered = new secp256k1.Signature(sig.r, sig.s).addRecoveryBit(sig.yParity).recoverPublicKey(digest).toBytes(false);
      expect(evmAddressOfPublicKey(recovered)).toBe(a.address);
    }
    expect(events.map(e => [e.event, e.ok, e.address, e.keyArn])).toEqual([['flofi.kms.sign', true, a.address, ARN], ['flofi.kms.sign', true, a.address, ARN]]);
    expect(JSON.stringify(events)).not.toContain(CREDS.secretAccessKey);
    const sign = seen.filter(x => x.target === 'Sign').at(-1)!.body;
    expect(sign).toMatchObject({ KeyId: ARN, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
    // destroy never touches the shared key: no KMS request is made.
    const before = seen.length; await p.destroy(a.ref); expect(seen.length).toBe(before);
  });
  it('maps KMS failures to stable codes (throttling is retryable) and audits the failure', async () => {
    const events: KmsAuditEvent[] = [];
    mode = 'ok'; const p = provider(e => events.push(e)); const { ref } = await p.create('eip155');
    mode = 'throttle'; await expect(p.signEvmDigest(ref, new Uint8Array(32))).rejects.toThrow('SIGNER_KMS_UNAVAILABLE');
    mode = 'denied'; await expect(p.signEvmDigest(ref, new Uint8Array(32))).rejects.toThrow('SIGNER_KMS_DENIED');
    expect(events.map(e => [e.ok, e.code])).toEqual([[false, 'SIGNER_KMS_UNAVAILABLE'], [false, 'SIGNER_KMS_DENIED']]);
    mode = 'wrong-spec'; await expect(provider().create('eip155')).rejects.toThrow('SIGNER_KMS_KEY_UNAVAILABLE');
    mode = 'ok';
  });
  it('refuses wrong credentials (the double rejects the signature), other namespaces, bad references and bad digests', async () => {
    mode = 'ok';
    const wrong = awsKmsSignerProvider({ region: REGION, evmKeyArn: ARN, credentials: () => ({ ...CREDS, secretAccessKey: 'other' }), endpoint, loopbackForTests: true });
    await expect(wrong.create('eip155')).rejects.toThrow('SIGNER_KMS_DENIED');
    const p = provider();
    await expect(p.create('solana')).rejects.toThrow('SIGNER_NAMESPACE_UNAVAILABLE');
    await expect(p.signSolanaMessage('aws-kms:evm.' + '0'.repeat(24), new Uint8Array(1))).rejects.toThrow('SIGNER_NAMESPACE_UNAVAILABLE');
    await expect(p.signEvmDigest('memory:' + '0'.repeat(32), new Uint8Array(32))).rejects.toThrow('SIGNER_REF_INVALID');
    await expect(p.signEvmDigest('aws-kms:evm.' + '0'.repeat(24), new Uint8Array(31))).rejects.toThrow('SIGNER_REQUEST_INVALID');
  });
  it('refuses configuration that is not a regional ARN, an ARN of another region, or a plaintext non-loopback endpoint', () => {
    const base = { region: REGION, evmKeyArn: ARN, credentials: () => CREDS };
    expect(() => awsKmsSignerProvider({ ...base, evmKeyArn: '1234abcd-12ab-34cd-56ef-1234567890ab' })).toThrow('SIGNER_KMS_CONFIG_INVALID');
    expect(() => awsKmsSignerProvider({ ...base, region: 'eu-west-1' })).toThrow('SIGNER_KMS_CONFIG_INVALID');
    expect(() => awsKmsSignerProvider({ ...base, endpoint: 'http://kms.example.com/' })).toThrow('SIGNER_KMS_CONFIG_INVALID');
    expect(() => awsKmsSignerProvider({ ...base, endpoint: 'http://127.0.0.1:1/' })).toThrow('SIGNER_KMS_CONFIG_INVALID');
    expect(() => awsKmsSignerProvider({ ...base, evmKeyArn: 'arn:aws:kms:us-east-1:111122223333:alias/flofi-executor' })).not.toThrow();
  });
  it('reads credentials only from the standard AWS variables', () => {
    expect(() => awsCredentialsFromEnv({})).toThrow('SIGNER_KMS_CREDENTIALS_MISSING');
    expect(awsCredentialsFromEnv({ AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'B' })).toEqual({ accessKeyId: 'A', secretAccessKey: 'B' });
    expect(awsCredentialsFromEnv({ AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'B', AWS_SESSION_TOKEN: 'C' })).toEqual({ accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' });
  });
});
