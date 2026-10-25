// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assertRunOwnership, normalizePrincipal, PAYMENT_OWNERSHIP, ROUTER_OWNERSHIP, UNIVERSAL_OWNERSHIP } from './run-ownership.ts';
import { FLOWS } from '../../backend/flows.ts';

/** BUILD-JOURNEY-001: one ownership rule for the API and local server actions. */
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), RUN = 'xroute-' + 'c'.repeat(32), S = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq',
  OTHER = 'HjcWJor6kDs1WtUp9CqaxiC3pq3pZyToQU7rPU5kbbqi';
const ownerOf = async (id: string) => { if (id !== RUN) throw new Error('ROUTER_RUN_NOT_FOUND'); return A; };
const check = (method: string, args: unknown[], principal: string | null) => assertRunOwnership(ROUTER_OWNERSHIP, method, args, principal, ownerOf);

describe('BUILD-JOURNEY-001 run ownership', () => {
  it('lets the owner call every Router method on its own run', async () => {
    await check('simulate', [{}, A], A);
    for (const method of ROUTER_OWNERSHIP.runArgument) await check(method, method === 'begin' ? [RUN, A, {}] : [RUN], A);
    await check('info', [], null);
    await check('mode', [], null);
  });
  it('refuses another wallet on every run method, a claimed owner that is not the principal, and a missing session', async () => {
    for (const method of ROUTER_OWNERSHIP.runArgument)
      await expect(check(method, method === 'begin' ? [RUN, B, {}] : [RUN], B)).rejects.toThrow('RUN_OWNER_MISMATCH');
    await expect(check('simulate', [{}, A], B)).rejects.toThrow('RUN_OWNER_MISMATCH');
    await expect(check('begin', [RUN, B, {}], A)).rejects.toThrow('RUN_OWNER_MISMATCH');
    for (const method of ['simulate', ...ROUTER_OWNERSHIP.runArgument]) await expect(check(method, [RUN, A], null)).rejects.toThrow('WALLET_SESSION_REQUIRED');
    await expect(check('status', [RUN], 'not-an-address')).rejects.toThrow('WALLET_SESSION_REQUIRED');
    await expect(check('status', ['xroute-' + 'd'.repeat(32)], A)).rejects.toThrow('ROUTER_RUN_NOT_FOUND');
  });
  it('fails closed for a method the policy does not declare', async () => {
    await expect(check('somethingNew', [RUN], A)).rejects.toThrow('RUN_OWNERSHIP_UNDECLARED');
  });
  // BUILD-RH-002: the four Robinhood Chain routes are Router flows with the same ownership policy.
  // BUILD-BASE-001: so is the Router's Arbitrum One → Base route.
  const ROBINHOOD_ROUTES = ['crosschain-router-arbitrum-to-base', 'crosschain-router-arbitrum-to-robinhood', 'crosschain-router-base-to-robinhood', 'crosschain-router-robinhood-to-arbitrum',
    'crosschain-router-robinhood-to-base', 'crosschain-router-ethereum-to-base', 'crosschain-router-base-to-ethereum',
    'crosschain-router-ethereum-to-arbitrum', 'crosschain-router-arbitrum-to-ethereum', 'crosschain-router-ethereum-to-robinhood', 'crosschain-router-robinhood-to-ethereum'] as const;
  it('covers every method of the Router flows and the payment flow and leaves other flows unchanged', () => {
    for (const [flow, policy] of [['crosschain-router', ROUTER_OWNERSHIP], ['crosschain-router-testnet', ROUTER_OWNERSHIP], ...ROBINHOOD_ROUTES.map(route => [route, ROUTER_OWNERSHIP] as const),
      ['pix-payment', PAYMENT_OWNERSHIP], ['crosschain-universal', UNIVERSAL_OWNERSHIP]] as const) {
      const definition = FLOWS[flow];
      expect(definition.ownership?.policy).toBe(policy);
      for (const method of Object.keys(definition.methods))
        expect(policy.open.includes(method) || Object.hasOwn(policy.ownerArgument, method) || policy.runArgument.includes(method)).toBe(true);
    }
    expect(Object.values(FLOWS).filter(f => f.ownership).map(f => f.name).sort()).toEqual(['crosschain-router', ...ROBINHOOD_ROUTES, 'crosschain-router-testnet', 'pix-payment',
      'crosschain-universal'].sort());
  });
  it('accepts only lower-case EVM principals and (BUILD-CROSSCHAIN-UNIVERSAL-001) base58 Solana keys', () => {
    expect(normalizePrincipal(A)).toBe(A);
    expect(normalizePrincipal(A.toUpperCase().replace('0X', '0x'))).toBeNull();
    expect(normalizePrincipal(undefined)).toBeNull();
    expect(normalizePrincipal([A])).toBeNull();
    expect(normalizePrincipal(S)).toBe(S);
    expect(normalizePrincipal('not a key!')).toBeNull();
  });
  it('a Solana run belongs to its exact (case-sensitive) Solana key; an EVM-owned run never matches a Solana principal', async () => {
    const run = 'xuni-' + 'e'.repeat(32), solanaOwner = async () => S;
    await assertRunOwnership(UNIVERSAL_OWNERSHIP, 'simulate', [{}, S], S, solanaOwner);
    await assertRunOwnership(UNIVERSAL_OWNERSHIP, 'submit', [run, 'AA=='], S, solanaOwner);
    await assertRunOwnership(UNIVERSAL_OWNERSHIP, 'discover', [{}], null, solanaOwner);
    await expect(assertRunOwnership(UNIVERSAL_OWNERSHIP, 'submit', [run, 'AA=='], OTHER, solanaOwner)).rejects.toThrow('RUN_OWNER_MISMATCH');
    await expect(assertRunOwnership(UNIVERSAL_OWNERSHIP, 'submit', [run, 'AA=='], S.toLowerCase(), solanaOwner)).rejects.toThrow('WALLET_SESSION_REQUIRED');
    await expect(assertRunOwnership(UNIVERSAL_OWNERSHIP, 'simulate', [{}, S.toLowerCase()], S, solanaOwner)).rejects.toThrow('RUN_OWNER_MISMATCH');
    await expect(check('status', [RUN], S)).rejects.toThrow('RUN_OWNER_MISMATCH');
  });
});
