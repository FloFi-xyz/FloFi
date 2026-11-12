// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FLIGHT_REFUSAL_COPY, FLIGHT_REFUSAL_HREF, FLIGHT_REFUSAL_MESSAGES, flightRefusal, flightRefusalCode, flightRefusalMessage, flightRefusalTitleOf } from './flight-refusal';
import { simulationError, simulationStatusPresentation, type SimulationPresentation } from './simulation-presentation';
import { buildEstimateFailureMessage } from './build-estimate';
import { translate } from '../i18n/locale';
import { portuguese } from '../i18n/pt';

/** P0 (owner test 2026-11-12): BETA_WALLET_NOT_LINKED reached the Editor as "Simulation failed" with a generic sentence. */
describe('Flight refusals in plain words', () => {
  it('names the owner test refusal and its next action instead of a failed simulation', () => {
    const message = simulationError('BETA_WALLET_NOT_LINKED');
    expect(message).not.toMatch(/could not complete this simulation/);
    expect(message).toMatch(/not linked to your FloFi account/); expect(message).toMatch(/Credentials/); expect(message).toMatch(/Board now/);
    const view: SimulationPresentation = { status: 'blocked', message, expiresAt: null, steps: [], fees: [], warnings: [] };
    expect(simulationStatusPresentation(view)).toEqual({ label: 'Wallet not linked to your FloFi account', message, tone: 'blocked' });
    expect(flightRefusal('BETA_WALLET_NOT_LINKED')).toMatchObject({ action: 'LINK_WALLET' });
    expect(FLIGHT_REFUSAL_HREF.LINK_WALLET).toBe('/app/credentials');
  });
  it('classifies every Flight code and nothing else (no provider text, no prefix tricks)', () => {
    for (const code of Object.keys(FLIGHT_REFUSAL_MESSAGES)) {
      expect(flightRefusalCode(code)).toBe(code); expect(flightRefusalCode(`${code}:detail`)).toBe(code);
      expect(flightRefusalTitleOf(flightRefusalMessage(code)!)).toBeTruthy();
    }
    for (const other of ['SIMULATION_FAILED', 'XBETA_WALLET_NOT_LINKED', 'BETA_SOMETHING_ELSE', 'provider said BETA_WALLET_NOT_LINKED', '', 'beta_wallet_not_linked'])
      expect(flightRefusalCode(other)).toBeNull();
  });
  it('never claims that earlier work was not sent, and session codes keep tracking statements', () => {
    for (const message of Object.values(FLIGHT_REFUSAL_MESSAGES)) expect(message).not.toMatch(/nothing was sent/i);
    expect(FLIGHT_REFUSAL_MESSAGES.BETA_SESSION_REQUIRED).toMatch(/anything already sent stays tracked/);
    expect(FLIGHT_REFUSAL_MESSAGES.BETA_ACCESS_REVOKED).toMatch(/anything already sent stays tracked/i);
  });
  it('the quote endpoint shares the classification (it used to read "quote provider or network is unavailable")', () => {
    expect(buildEstimateFailureMessage('BETA_ACCESS_UNAVAILABLE')).toBe(FLIGHT_REFUSAL_MESSAGES.BETA_ACCESS_UNAVAILABLE);
    expect(buildEstimateFailureMessage('BETA_WALLET_NOT_LINKED')).toBe(FLIGHT_REFUSAL_MESSAGES.BETA_WALLET_NOT_LINKED);
  });
  it('has Brazilian Portuguese for every title and sentence', () => {
    for (const text of FLIGHT_REFUSAL_COPY) {
      expect(Object.hasOwn(portuguese, text), text).toBe(true);
      expect(translate('PT', text)).not.toMatch(/\bA aguardar|utilizador|ecrã|registo\b/);
    }
  });
});

/** P0 (2026-11-12): provider answers at Simulate are classified as what they are, before the balance rules. */
describe('bridge and liquidity refusals at Simulate', () => {
  it('a provider liquidity answer is not "your balance is too low", and a minimum is not a generic failure', () => {
    expect(simulationError('RELAY_INSUFFICIENT_LIQUIDITY')).toMatch(/does not have enough liquidity/);
    expect(simulationError('RELAY_INSUFFICIENT_LIQUIDITY')).not.toMatch(/balance/);
    expect(simulationError('RELAY_AMOUNT_TOO_LOW')).toMatch(/below the bridge provider’s minimum/);
    expect(simulationError('BRIDGE_BELOW_MINIMUM')).toMatch(/below the bridge provider’s minimum/);
    expect(simulationError('ROUTER_NO_EXECUTABLE_ROUTE')).toMatch(/No bridge route that FloFi can verify and execute/);
    expect(simulationError('UNIVERSAL_NO_EXECUTABLE_ROUTE')).toMatch(/No bridge route that FloFi can verify and execute/);
    // They speak for this step only: an earlier step of the workflow may already have been sent.
    expect(simulationError('RELAY_AMOUNT_TOO_LOW')).toMatch(/this step was not simulated or sent/);
  });
  it('lending liquidity and non-bridge codes keep their own wording', () => {
    for (const code of ['BORROW_INSUFFICIENT_LIQUIDITY', 'WITHDRAW_INSUFFICIENT_LIQUIDITY']) expect(simulationError(code)).not.toMatch(/bridge provider/);
    expect(simulationError('SWAP_AMOUNT_TOO_LOW')).not.toMatch(/bridge provider/);
  });
  it('delivery outcomes after a deposit never read "nothing was sent"', () => {
    for (const code of ['ROUTER_FILL_BELOW_MINIMUM', 'UNIVERSAL_DELIVERY_BELOW_MINIMUM']) expect(simulationError(code)).not.toMatch(/nothing was simulated or sent|was not simulated or sent/);
  });
  it('the native-fee and token-balance rules are unchanged', () => {
    expect(simulationError('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE')).toBe('Add funds for the network fee, then simulate again.');
    expect(simulationError('INSUFFICIENT_INPUT_BALANCE')).toBe('Your available balance is too low for this workflow.');
  });
});
