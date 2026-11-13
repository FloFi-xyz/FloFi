// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0010 §4: a Kora Review shows who pays the network fee and in which token (the owner, in USDC, to Pimlico), never SOL, never "free";
// the fee payer and payment address stay under Technical details.
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor } from './editor';
import { projectSimulation, simulationError, type SimulationSource } from './simulation-presentation';
import { MATERIAL_STEP_DETAILS } from '../components/conversation-cards';
import { translate } from '../i18n/translate';

const context = createBaseSepoliaReviewContext(), now = Date.parse('2026-11-13T12:00:00Z'), expiry = new Date(now + 60_000).toISOString();
const workflow = editorReducer(initialEditor(), { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '100', slippage: '50', source: 'CHAT', baseRevision: 0 }, context).workflow;
const snapshot = (kind: SimulationSource['kind'], state: object): SimulationSource => ({ kind, state: { busy: false, error: null, retired: false, ...state } }) as SimulationSource;
const gas = { mechanism: 'PIMLICO_KORA_SPL_FEE', feePayer: 'KoraFeePayer1111111111111111111111111111111', paymentAddress: 'KoraPayment11111111111111111111111111111111', amount: '3100',
  token: { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } };
const FORBIDDEN = /\b(free|no fees?|gasless|sponsored)\b/i;

describe('Kora network fee in the Review', () => {
  it('shows the swap\'s network fee as a USDC ceiling paid to Pimlico, with no SOL fee or deposit line', () => {
    const result = projectSimulation(workflow, context, snapshot('solana-swap', { record: { provenance: 'PUBLIC_MAINNET', error: null, verdict: 'PENDING', review: {
      format: 'gryloo.jupiter-review.v1', workflow, expiresAt: expiry, cluster: 'mainnet-beta', input: { symbol: 'USDC', decimals: 6 }, output: { symbol: 'SOL', decimals: 9 }, slippageBps: 50,
      quote: { otherAmountThreshold: '95000000', outAmount: '100000000', priceImpactPct: '0', routePlan: [] }, estimatedFeeLamports: '10000',
      simulationResult: { inputSpent: '10000000', outputReceived: '100000000', accountCreationLamports: '0', feeLamports: '10000' }, gas } } }), now);
    expect(result.fees).toEqual([{ label: 'Network fee', value: '0.0031 USDC', note: 'Paid from your USDC to Pimlico.', treatment: 'CEILING' }]);
    // Protocol details only under Technical details (not material step details).
    const details = result.steps[0]?.details ?? [];
    expect(details).toContainEqual({ label: 'Network fee payer (Pimlico)', value: gas.feePayer });
    expect(details.filter(line => MATERIAL_STEP_DETAILS.includes(line.label))).toEqual([]);
    expect(JSON.stringify(result.fees)).not.toMatch(FORBIDDEN);
    expect(translate('PT', 'Paid from your USDC to Pimlico.')).toBe('Paga com os seus USDC à Pimlico.');
  });
  it('shows the transfer\'s network fee in USDT with no SOL deposit lines', () => {
    const result = projectSimulation(workflow, context, snapshot('solana-transfer', { record: { provenance: 'PUBLIC_MAINNET', error: null, verdict: 'PENDING', review: {
      workflow, expiresAt: expiry, recipient: 'Recipient1111111111111111111111111111111111', amount: '12000000', asset: { symbol: 'USDC', mint: gas.token.mint, decimals: 6, program: 'spl-token', verified: true },
      token: { program: 'spl-token' }, estimatedFeeLamports: '10000', accountCreationLamports: '0', maximumAccountCreationLamports: '0',
      gas: { ...gas, token: { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 } } } } }), now);
    expect(result.fees).toEqual([{ label: 'Network fee', value: '0.0031 USDT', note: 'Paid from your USDT to Pimlico.', treatment: 'CEILING' }]);
  });
  it('explains every Kora refusal in plain words, in English and Portuguese, never as free or sponsored', () => {
    for (const code of ['KORA_FEE_TOKEN_BALANCE_INSUFFICIENT', 'KORA_PAYMENT_INSUFFICIENT', 'KORA_OPERATION_UNSUPPORTED', 'KORA_PROVIDER_UNAVAILABLE', 'KORA_UNREACHABLE',
      'KORA_NOT_ENABLED', 'KORA_SIGNER_MISMATCH', 'KORA_PAYMENT_ACCOUNT_MISSING', 'KORA_FEE_ABOVE_CAP', 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED']) {
      const message = simulationError(code), pt = translate('PT', message);
      expect(message).not.toMatch(FORBIDDEN);
      expect(pt).not.toBe(message);
      expect(pt).not.toMatch(/grátis|sem taxas|patrocinad/i);
    }
    expect(simulationError('KORA_FEE_TOKEN_BALANCE_INSUFFICIENT')).toContain('USDC or USDT');
  });
});
