// SPDX-License-Identifier: AGPL-3.0-only
/** ADR-0010: the shared gas-mechanism policy, its configuration and the token-paid S1 claim. Pure; no network. */
import { describe, expect, it } from 'vitest';
import { assertReviewedMechanism, formatUnits, selectGasMechanism, SOLANA_MAINNET, tokenAmountText, TOKEN_GAS_BY_CHAIN } from './mechanism';
import { gasAbstractionReadiness, readCircleGasConfig, readGasAbstractionConfig, readKoraGasConfig, readZeroExGaslessConfig } from './config';
import { assertUserFundedSubmission, GAS_PAYER_CODES } from '../user-funded/gas-payer';

const OWNER = '0x1111111111111111111111111111111111111111';
const CIRCLE_V07 = '0x6c973ebe80dcd8660841d4356bf15c32460271c9';
const SIGNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', PAYMENT = '7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi', SOL_OWNER = 'Fp5ZsE3Ns8hN2kXc6q7Lq5ZrK9Wq2YkPq9Bq8bS3pJxP';

describe('selectGasMechanism (native first, token only when proven eligible)', () => {
  it('keeps native gas whenever it covers the fee, whatever the candidate says', () => {
    expect(selectGasMechanism({ chain: 'eip155:8453', nativeCovers: true, candidate: { mechanism: 'CIRCLE_USDC_PAYMASTER', eligible: true } }))
      .toEqual({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: false, unavailable: [] });
  });
  it('never switches on an unknown native balance', () => {
    expect(selectGasMechanism({ chain: SOLANA_MAINNET, nativeCovers: null, candidate: { mechanism: 'PIMLICO_KORA_SPL_FEE', eligible: true } }).mechanism).toBe('NATIVE_WALLET_GAS');
  });
  it('picks the chain\'s token mechanism when native gas is short and it is eligible', () => {
    expect(selectGasMechanism({ chain: 'eip155:4663', nativeCovers: false, candidate: { mechanism: 'ZEROX_GASLESS_SWAP', eligible: true } }))
      .toEqual({ mechanism: 'ZEROX_GASLESS_SWAP', nativeShort: true, unavailable: [] });
    expect(selectGasMechanism({ chain: SOLANA_MAINNET, nativeCovers: false, candidate: { mechanism: 'PIMLICO_KORA_SPL_FEE', eligible: true } }).mechanism).toBe('PIMLICO_KORA_SPL_FEE');
  });
  it('reports why the alternative is unavailable and stays native (short)', () => {
    expect(selectGasMechanism({ chain: 'eip155:1', nativeCovers: false, candidate: { mechanism: 'CIRCLE_USDC_PAYMASTER', eligible: false, code: 'CIRCLE_INSUFFICIENT_USDC' } }))
      .toEqual({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_INSUFFICIENT_USDC' }] });
    expect(selectGasMechanism({ chain: 'eip155:42161', nativeCovers: false }).unavailable).toEqual([{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'TOKEN_GAS_NOT_EVALUATED' }]);
  });
  it('never uses another chain\'s mechanism', () => {
    expect(selectGasMechanism({ chain: 'eip155:4663', nativeCovers: false, candidate: { mechanism: 'CIRCLE_USDC_PAYMASTER', eligible: true } }))
      .toEqual({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code: 'TOKEN_GAS_MECHANISM_MISMATCH' }] });
  });
  it('a chain without a token mechanism stays native', () => {
    expect(TOKEN_GAS_BY_CHAIN['eip155:10']).toBeUndefined();
    expect(selectGasMechanism({ chain: 'eip155:10', nativeCovers: false })).toEqual({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [] });
  });
  it('a reviewed mechanism that no longer applies needs a new Review', () => {
    expect(() => assertReviewedMechanism('CIRCLE_USDC_PAYMASTER', selectGasMechanism({ chain: 'eip155:8453', nativeCovers: true }))).toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
    expect(() => assertReviewedMechanism('NATIVE_WALLET_GAS', selectGasMechanism({ chain: 'eip155:8453', nativeCovers: true }))).not.toThrow();
  });
  it('formats token amounts exactly', () => {
    expect(formatUnits('42000', 6)).toBe('0.042');
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('0', 6)).toBe('0');
    expect(tokenAmountText({ token: 'x', symbol: 'USDC', decimals: 6, amount: '1234567' })).toBe('1.234567 USDC');
    expect(() => formatUnits('-1', 6)).toThrow('TOKEN_AMOUNT_INVALID');
  });
});

describe('gas abstraction configuration (off by default, fail closed, pinned hosts)', () => {
  it('everything is off with an empty environment', () => {
    expect(gasAbstractionReadiness(readGasAbstractionConfig({}))).toEqual({ circle: 'CIRCLE_GAS_NOT_ENABLED', kora: 'KORA_NOT_ENABLED', zeroEx: 'ZEROX_GASLESS_NOT_ENABLED' });
  });
  it('Circle: all three mainnets by default, a subset when listed, never another chain', () => {
    expect(readCircleGasConfig({ FLOFI_CIRCLE_USDC_GAS: 'enabled' })).toEqual({ enabled: true, chains: ['eip155:1', 'eip155:8453', 'eip155:42161'] });
    expect(readCircleGasConfig({ FLOFI_CIRCLE_USDC_GAS: 'enabled', FLOFI_CIRCLE_USDC_GAS_CHAINS: 'eip155:8453' })).toEqual({ enabled: true, chains: ['eip155:8453'] });
    expect(readCircleGasConfig({ FLOFI_CIRCLE_USDC_GAS: 'enabled', FLOFI_CIRCLE_USDC_GAS_CHAINS: 'eip155:4663' })).toEqual({ enabled: false, code: 'CIRCLE_GAS_CONFIGURATION_INVALID' });
    expect(readCircleGasConfig({ FLOFI_CIRCLE_USDC_GAS: 'yes' })).toEqual({ enabled: false, code: 'CIRCLE_GAS_CONFIGURATION_INVALID' });
  });
  it('Kora: pinned host, mainnet path, pinned signer and payment address', () => {
    const env = { FLOFI_KORA_TOKEN_GAS: 'enabled', FLOFI_PIMLICO_KORA_RPC_URL: 'https://solana.pimlico.io/v1/mainnet/rpc?apikey=test-key', FLOFI_KORA_SIGNER: SIGNER, FLOFI_KORA_PAYMENT_ADDRESS: PAYMENT };
    const config = readKoraGasConfig(env);
    expect(config.enabled && config.feeTokens.map(t => t.symbol)).toEqual(['USDC', 'USDT']);
    expect(config.enabled && config.loopback).toBe(false);
    expect(readKoraGasConfig({ ...env, FLOFI_PIMLICO_KORA_RPC_URL: 'https://evil.example/v1/mainnet/rpc' }).enabled).toBe(false);
    expect(readKoraGasConfig({ ...env, FLOFI_PIMLICO_KORA_RPC_URL: 'https://solana.pimlico.io/v1/devnet/rpc?apikey=k' }).enabled).toBe(false);
    expect(readKoraGasConfig({ ...env, FLOFI_KORA_SIGNER: undefined }).enabled).toBe(false);
    expect(readKoraGasConfig({ ...env, FLOFI_KORA_FEE_TOKENS: 'USDT' })).toMatchObject({ enabled: true, feeTokens: [{ symbol: 'USDT' }] });
    expect(readKoraGasConfig({ ...env, FLOFI_KORA_FEE_TOKENS: 'BONK' }).enabled).toBe(false);
    expect(readKoraGasConfig({ ...env, FLOFI_PIMLICO_KORA_RPC_URL: 'http://127.0.0.1:8571/rpc' })).toMatchObject({ enabled: true, loopback: true });
  });
  it('0x: key required, api.0x.org only (or the loopback harness)', () => {
    expect(readZeroExGaslessConfig({ FLOFI_ZEROX_GASLESS: 'enabled' })).toEqual({ enabled: false, code: 'ZEROX_API_KEY_NOT_CONFIGURED' });
    expect(readZeroExGaslessConfig({ FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: 'test-key-123' }))
      .toEqual({ enabled: true, apiUrl: 'https://api.0x.org', apiKey: 'test-key-123', chains: ['eip155:4663'], loopback: false });
    expect(readZeroExGaslessConfig({ FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: 'test-key-123', FLOFI_ZEROX_API_URL: 'https://api.0x.org.evil.example' }).enabled).toBe(false);
    expect(readZeroExGaslessConfig({ FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: 'test-key-123', FLOFI_ZEROX_API_URL: 'http://127.0.0.1:8581' }))
      .toMatchObject({ enabled: true, apiUrl: 'http://127.0.0.1:8581', loopback: true });
  });
  it('readiness never exposes a URL, key or pin', () => {
    const text = JSON.stringify(gasAbstractionReadiness(readGasAbstractionConfig({ FLOFI_ZEROX_GASLESS: 'enabled', FLOFI_ZEROX_API_KEY: 'secret-key-value' })));
    expect(text).not.toContain('secret-key-value');
    expect(text).not.toContain('0x.org');
  });
});

describe('S1 with token-paid fees (ADR-0010)', () => {
  const circle = { mechanism: 'CIRCLE_USDC_PAYMASTER' as const, relayer: CIRCLE_V07, pinnedRelayers: [CIRCLE_V07], token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '250000' };
  it('Circle: the owner\'s own user operation naming the pinned paymaster', () => {
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: circle })).not.toThrow();
  });
  it('Circle: refuses another paymaster, an unpinned relayer, a zero amount, or another sender', () => {
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `0x${'22'.repeat(20)}00`, tokenFee: circle })).toThrow(GAS_PAYER_CODES.sponsored);
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: { ...circle, pinnedRelayers: [] } })).toThrow(GAS_PAYER_CODES.relayerNotPinned);
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: { ...circle, amount: '0' } })).toThrow(GAS_PAYER_CODES.tokenFeeInvalid);
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: `0x${'33'.repeat(20)}`, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: circle })).toThrow(GAS_PAYER_CODES.notOwner);
    expect(() => assertUserFundedSubmission({ kind: 'EVM_WALLET_BATCH', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: circle })).toThrow(GAS_PAYER_CODES.tokenFeeInvalid);
  });
  it('Circle: a FloFi-controlled relayer is refused', () => {
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00`, tokenFee: circle, flofiControlled: [CIRCLE_V07] }))
      .toThrow(GAS_PAYER_CODES.flofiControlled);
  });
  it('Kora: the fee payer is the pinned Kora signer, nothing else sponsored', () => {
    const kora = { mechanism: 'PIMLICO_KORA_SPL_FEE' as const, relayer: SIGNER, pinnedRelayers: [SIGNER], token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1200' };
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: SIGNER, ownerWallet: SOL_OWNER, tokenFee: kora })).not.toThrow();
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: PAYMENT, ownerWallet: SOL_OWNER, tokenFee: kora })).toThrow(GAS_PAYER_CODES.notOwner);
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: SIGNER, ownerWallet: SOL_OWNER })).toThrow(GAS_PAYER_CODES.notOwner);
    expect(() => assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: SIGNER, ownerWallet: SOL_OWNER, tokenFee: { ...kora, relayer: SOL_OWNER, pinnedRelayers: [SOL_OWNER] } }))
      .toThrow(GAS_PAYER_CODES.tokenFeeInvalid);
  });
  it('0x: only with a token-fee claim', () => {
    const settler = `0x${'44'.repeat(20)}`;
    const zeroEx = { mechanism: 'ZEROX_GASLESS_SWAP' as const, relayer: settler, pinnedRelayers: [settler], token: `0x${'55'.repeat(20)}`, amount: '13226' };
    expect(() => assertUserFundedSubmission({ kind: 'EVM_GASLESS_INTENT', feePayer: settler, ownerWallet: OWNER, tokenFee: zeroEx })).not.toThrow();
    expect(() => assertUserFundedSubmission({ kind: 'EVM_GASLESS_INTENT', feePayer: settler, ownerWallet: OWNER })).toThrow(GAS_PAYER_CODES.tokenFeeInvalid);
  });
  it('without a token-fee claim the original rule is unchanged', () => {
    expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: OWNER, ownerWallet: OWNER, sponsorship: `${CIRCLE_V07}00` })).toThrow(GAS_PAYER_CODES.sponsored);
    expect(() => assertUserFundedSubmission({ kind: 'EVM_TRANSACTION', feePayer: OWNER, ownerWallet: OWNER })).not.toThrow();
  });
});
