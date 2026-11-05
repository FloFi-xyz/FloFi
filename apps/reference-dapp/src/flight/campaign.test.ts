// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-FLIGHT-001: the campaign's rules without a database (phases, access, inputs, invite codes, route and events). */
import { describe, expect, it } from 'vitest';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { decideAccess, FLIGHT_BOARDING_OPENS_AT, FLIGHT_LIST_CLOSES_AT, flightPhase, flightRoute, inviteCodeFrom, listFor, normalizeEmail, normalizeHandle,
  normalizeInviteCode, parseClientEvent, passengerSeat, foundingSeat, visibleSteps } from './campaign';
import { flightClockHarness } from './host';
import { rateLimitClient } from './rate-limit-client';
import { simulationRecord } from './simulation-record';
import { csvCell } from '../../backend/flight-admin';

type Node = SemanticWorkflow['nodes'][number];
const node = (nodeId: string, actionType: string, chainId: string, protocols: string[], destination?: string): Node => ({
  nodeId, actionType, actionSchemaVersion: '1.0.0', chainId, requiredCapabilities: [], adapterConstraints: { adapters: [], protocols },
  inputs: destination ? [{ name: 'asset-out', kind: 'ASSET', value: { chainId: destination } }] : [], expectedOutputs: [], dependencies: [], userConstraints: [],
  failurePolicy: 'HALT', requiredAuthorizationClass: 'WALLET', lockedParameters: [], editableBounds: [] } as unknown as Node);

describe('BUILD-FLOFI-FLIGHT-001 campaign rules', () => {
  it('keeps the approved dates: the list closes 16 Nov 23:59 BRT and boarding opens 17 Nov 9:00 BRT', () => {
    expect(new Date(FLIGHT_LIST_CLOSES_AT).toISOString()).toBe('2026-11-17T02:59:00.000Z');
    expect(new Date(FLIGHT_BOARDING_OPENS_AT).toISOString()).toBe('2026-11-17T12:00:00.000Z');
    expect([FLIGHT_LIST_CLOSES_AT - 1, FLIGHT_LIST_CLOSES_AT, FLIGHT_BOARDING_OPENS_AT - 1, FLIGHT_BOARDING_OPENS_AT].map(flightPhase))
      .toEqual(['FINAL_CALL', 'GATE_CLOSED', 'GATE_CLOSED', 'BOARDING']);
    expect([listFor('FINAL_CALL'), listFor('GATE_CLOSED'), listFor('BOARDING')]).toEqual(['FIRST', 'NEXT', 'NEXT']);
  });

  it('decides access from the list, the group, invites and an existing pass, and never before boarding', () => {
    const now = FLIGHT_BOARDING_OPENS_AT + 1, later = Date.parse('2026-11-19T12:00:00Z');
    expect(decideAccess({ now: FLIGHT_BOARDING_OPENS_AT - 1, passId: null, invite: 'CREATOR', entry: null }).kind).toBe('not_yet');
    expect(decideAccess({ now, passId: 'flp_x', invite: null, entry: null })).toEqual({ kind: 'boarded', passId: 'flp_x' });
    expect(decideAccess({ now, passId: null, invite: 'FOUNDING', entry: null })).toEqual({ kind: 'eligible', origin: 'INVITE' });
    expect(decideAccess({ now, passId: null, invite: 'CREATOR', entry: null })).toEqual({ kind: 'eligible', origin: 'CREATOR' });
    expect(decideAccess({ now, passId: null, invite: null, entry: { flight: 'FIRST', batch: null, opensAt: null } })).toEqual({ kind: 'eligible', origin: 'LIST' });
    expect(decideAccess({ now, passId: null, invite: null, entry: { flight: 'FIRST', batch: 3, opensAt: later } })).toEqual({ kind: 'batch_closed', batch: 3, opensAt: later });
    expect(decideAccess({ now: later, passId: null, invite: null, entry: { flight: 'FIRST', batch: 3, opensAt: later } }).kind).toBe('eligible');
    expect(decideAccess({ now, passId: null, invite: null, entry: { flight: 'NEXT', batch: null, opensAt: null } })).toEqual({ kind: 'not_listed' });
    expect(decideAccess({ now, passId: null, invite: null, entry: null })).toEqual({ kind: 'not_listed' });
  });

  it('accepts only well-formed addresses, handles and invite codes', () => {
    expect(normalizeEmail('  Ana.Souza+beta@Example.COM ')).toBe('ana.souza+beta@example.com');
    for (const bad of ['', 'a@b', 'no-at.example.com', 'a b@example.com', 'x@-bad.com', `${'a'.repeat(250)}@x.io`, 42, null]) expect(normalizeEmail(bad)).toBeNull();
    expect(normalizeHandle('@longesthandle15')).toBe('longesthandle15');
    for (const bad of ['', '@', 'has space', 'sixteen_chars_xx', 'émoji', 7]) expect(normalizeHandle(bad)).toBeNull();
    expect(normalizeInviteCode(' flf-abcd-efgh ')).toBe('FLF-ABCD-EFGH');
    expect(normalizeInviteCode('FLFABCDEFGH')).toBe('FLF-ABCD-EFGH');
    for (const bad of ['FLF-ABCD-EFG0', 'FLF-ABCD-EFGI', 'XYZ-ABCD-EFGH', '']) expect(normalizeInviteCode(bad)).toBeNull();
    const code = inviteCodeFrom(new Uint8Array([0, 1, 2, 3, 31, 32, 33, 255]));
    expect(normalizeInviteCode(code)).toBe(code);
    expect(() => inviteCodeFrom(new Uint8Array(4))).toThrow('FLIGHT_INVITE_ENTROPY');
  });

  it('shows the approved seat formats: Founding #001–#100, passengers in the middle seat', () => {
    expect([foundingSeat(1), foundingSeat(42), foundingSeat(100)]).toEqual(['#001', '#042', '#100']);
    expect(passengerSeat(214)).toBe('214E');
  });

  it('projects a route into the card’s codes and steps, never an amount, and only on mainnets', () => {
    const route = flightRoute([node('a', 'supply', 'eip155:8453', ['aave-v3']), node('b', 'asset.bridge', 'eip155:1', ['across.direct'], 'eip155:42161'),
      node('c', 'asset.swap.exact-input', 'eip155:4663', ['uniswap']), node('d', 'asset.swap.exact-input', 'eip155:42161', ['flofi.router.universal'], 'eip155:8453')]);
    expect(route).toEqual({ from: 'BASE', to: 'BASE', stepCount: 4, networkCount: 4, steps: [
      { action: 'Lend', detail: 'Aave · Base' }, { action: 'Bridge', detail: 'Ethereum → Arbitrum' }, { action: 'Swap', detail: 'Uniswap · Robinhood Chain' },
      { action: 'Bridge', detail: 'Arbitrum → Base' }] });
    expect(JSON.stringify(route)).not.toMatch(/\d{3,}/);
    expect(flightRoute([node('t', 'asset.swap.exact-input', 'eip155:84532', ['uniswap'])])).toBeNull();
    expect(flightRoute([node('m', 'mock-step', 'eip155:1', [])])).toBeNull();
    // More than four steps: three and "+N steps" (the board's proposal).
    const long = { steps: Array.from({ length: 6 }, (_, i) => ({ action: 'Swap', detail: `#${i}` })) };
    expect(visibleSteps(long)).toEqual({ shown: long.steps.slice(0, 3), more: 3 });
    expect(visibleSteps({ steps: long.steps.slice(0, 4) }).more).toBe(0);
  });

  it('records the route the server simulated: simulate on every flow, prepare on the catalog swaps; never a testnet or another method', () => {
    const swap = node('s', 'asset.swap.exact-input', 'eip155:8453', ['uniswap']), bridge = { ...node('b', 'asset.bridge', 'eip155:8453', ['across.direct'], 'eip155:42161'),
      dependencies: ['s'] } as unknown as Node;
    const workflow = { workflowId: 'wf-1', revision: 4, nodes: [bridge, swap] };
    // The one financial step every mainnet service simulates (a mock step beside it is not a step).
    const step = { ...bridge, dependencies: [] } as unknown as Node, mock = node('m', 'mock-note', 'eip155:8453', []);
    expect(simulationRecord({ flow: 'crosschain-universal', method: 'simulate', args: [{ ...workflow, nodes: [mock, step] }, '0xowner'], value: { id: 'uni-1', status: 'SIMULATED' } }))
      .toEqual({ flow: 'crosschain-universal', runId: 'uni-1', workflowId: 'wf-1', revision: 4, route: { from: 'BASE', to: 'ARB', stepCount: 1, networkCount: 2,
        steps: [{ action: 'Bridge', detail: 'Base → Arbitrum' }] } });
    // A workflow carrying more than one financial step records nothing: no step the service did not simulate can reach a pass.
    expect(simulationRecord({ flow: 'crosschain-universal', method: 'simulate', args: [workflow], value: { id: 'uni-2' } })).toBeNull();
    // A catalog swap's prepare counts once the owner's own preflight is in it (keyed by its execution id), never as a bare quote.
    const executionId = 'bas-' + 'a'.repeat(24);
    expect(simulationRecord({ flow: 'base-swap', method: 'prepare', args: [{ ...workflow, nodes: [swap] }], value: { quote: { executionId, ownerReview: { account: '0x1' } } } }))
      .toMatchObject({ runId: executionId, route: { from: 'BASE', to: 'BASE', stepCount: 1 } });
    expect(simulationRecord({ flow: 'base-swap', method: 'prepare', args: [{ ...workflow, nodes: [swap] }], value: { quote: { executionId } } })).toBeNull();
    for (const call of [
      { flow: 'base-swap', method: 'quote', args: [workflow], value: { id: 'x' } },
      { flow: 'base-sepolia-swap', method: 'prepare', args: [{ ...workflow, nodes: [node('t', 'asset.swap.exact-input', 'eip155:84532', ['uniswap'])] }], value: { quote: { executionId: 'pub-1' } } },
      { flow: 'pix-payment', method: 'simulate', args: [{ amount: '10' }], value: { id: 'pay-1' } },
      { flow: 'jupiter-swap', method: 'simulate', args: [workflow], value: null },
      { flow: 'Bad Flow', method: 'simulate', args: [workflow], value: { id: 'x' } },
    ]) expect(simulationRecord(call)).toBeNull();
    // Nothing the browser sent besides the simulated workflow reaches the record (an amount, a label): the route is fixed codes only.
    expect(JSON.stringify(simulationRecord({ flow: 'crosschain-universal', method: 'simulate', args: [{ ...workflow, nodes: [step] }], value: { id: 'u', amount: '123456789' } })))
      .not.toMatch(/\d{4,}/);
  });

  it('rate-limits a client by its IPv4 address or its IPv6 /64, and writes exported addresses as text', () => {
    expect(['203.0.113.7', '::ffff:203.0.113.7', '2001:db8:1:2::1', '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '[2001:db8::5]:443', 'fe80::1%eth0', 'junk', '']
      .map(rateLimitClient)).toEqual(['203.0.113.7', '203.0.113.7', '2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:0:0::/64', 'fe80:0:0:0::/64', null, null]);
    expect(['=cmd@x.io', '+1@x.io', '-a@x.io', '@x', 'ana@x.io', 'EN'].map(csvCell)).toEqual(["'=cmd@x.io", "'+1@x.io", "'-a@x.io", "'@x", 'ana@x.io', 'EN']);
  });

  it('honours the loopback test clock only off hosted deployments', () => {
    const harness = { FLOFI_FLIGHT_CLOCK_HARNESS: 'MOCKED_LOOPBACK_ONLY' };
    expect(flightClockHarness(harness)).toBe(true);
    for (const hosted of [{ VERCEL: '1' }, { RAILWAY_PROJECT_ID: 'p' }, { FLOFI_DEPLOYMENT: 'hosted' }]) expect(flightClockHarness({ ...harness, ...hosted })).toBe(false);
    expect(flightClockHarness({ FLOFI_FLIGHT_CLOCK_HARNESS: 'on' })).toBe(false);
    expect(flightClockHarness({})).toBe(false);
  });

  it('accepts only the closed browser events', () => {
    expect(parseClientEvent({ event: 'route_example_click', detail: 'eth_sol' })).toEqual({ event: 'route_example_click', detail: 'eth_sol' });
    expect(parseClientEvent({ event: 'board_click' })).toEqual({ event: 'board_click', detail: '' });
    for (const bad of [{ event: 'simulation_ok', detail: 'founding' }, { event: 'list_join', detail: 'first' }, { event: 'share_click', detail: 'x' }, { event: 'nope' }, null])
      expect(parseClientEvent(bad)).toBeNull();
  });
});
