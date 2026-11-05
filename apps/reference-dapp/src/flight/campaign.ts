// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the Flight FloFi launch campaign's rules, as the team-approved Claude Artifact "Flight FloFi" (version
 * 1793892357-f7d9, board "Landing · Handoff para o Alrimar") states them. Pure: no database, no request, no clock of its own.
 *
 * - The beta list closes on 16 Nov 2026 at 23:59 BRT (`closes_at`); boarding starts on 17 Nov 2026 at 9:00 BRT.
 * - "Board now" checks the list, the person's boarding group and invites. A boarded person's first valid simulation issues their boarding
 *   pass ("simulation_ok = cartão emitido"); the first 100 passes are numbered Founding seats (#001–#100, in boarding order), later ones
 *   are passenger passes. A Founding pass carries 3 invites ("bring three people on board, no list needed").
 * - The campaign gates only its own benefit (the pass): /app stays open to everyone.
 */
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

export const FLIGHT_LIST_CLOSES_AT = Date.parse('2026-11-16T23:59:00-03:00');
export const FLIGHT_BOARDING_OPENS_AT = Date.parse('2026-11-17T09:00:00-03:00');
export const FOUNDING_SEATS = 100;
export const FOUNDING_INVITES = 3;
/** The privacy notice shown next to the list form (recorded with each entry). */
export const FLIGHT_NOTICE_VERSION = '2026-11-05';
/** How long a recorded simulation can still issue a pass. */
export const SIMULATION_EVIDENCE_MS = 2 * 60 * 60 * 1000;
export const DEPARTURES_SHOWN = 5;
export const MAX_ROUTE_STEPS_SHOWN = 4;

/** FINAL_CALL until the list closes; GATE_CLOSED until boarding; BOARDING after (the approved posts' "Gate closed. Boarding starts tomorrow"). */
export type FlightPhase = 'FINAL_CALL' | 'GATE_CLOSED' | 'BOARDING';
export function flightPhase(now: number): FlightPhase {
  return now < FLIGHT_LIST_CLOSES_AT ? 'FINAL_CALL' : now < FLIGHT_BOARDING_OPENS_AT ? 'GATE_CLOSED' : 'BOARDING';
}
/** The list a new entry joins: the beta list while it is open, the next flight's list afterwards. */
export const listFor = (phase: FlightPhase): 'FIRST' | 'NEXT' => phase === 'FINAL_CALL' ? 'FIRST' : 'NEXT';

/** What "Board now" answers for a person (the handoff's access_result: list · invite · batch_closed · not_listed), or their pass. */
export type FlightOrigin = 'LIST' | 'INVITE' | 'CREATOR';
export type FlightAccess =
  | { readonly kind: 'boarded'; readonly passId: string }
  | { readonly kind: 'eligible'; readonly origin: FlightOrigin }
  | { readonly kind: 'batch_closed'; readonly batch: number; readonly opensAt: number }
  | { readonly kind: 'not_listed' }
  | { readonly kind: 'not_yet'; readonly opensAt: number };
export const accessResultDetail = (access: FlightAccess): 'list' | 'invite' | 'batch_closed' | 'not_listed' | null =>
  access.kind === 'eligible' ? (access.origin === 'LIST' ? 'list' : 'invite') : access.kind === 'batch_closed' ? 'batch_closed'
    : access.kind === 'not_listed' ? 'not_listed' : null;
export const eventOrigin = (origin: FlightOrigin | null): 'list' | 'invite' | 'creator' | 'none' =>
  origin === 'LIST' ? 'list' : origin === 'INVITE' ? 'invite' : origin === 'CREATOR' ? 'creator' : 'none';

/** The access decision for one account at `now` (BOARDING phase); `entry` is its verified email's beta-list entry, if any. */
export function decideAccess(input: { readonly now: number; readonly passId: string | null; readonly invite: 'FOUNDING' | 'CREATOR' | null;
  readonly entry: { readonly flight: 'FIRST' | 'NEXT'; readonly batch: number | null; readonly opensAt: number | null } | null }): FlightAccess {
  if (input.passId) return { kind: 'boarded', passId: input.passId };
  if (flightPhase(input.now) !== 'BOARDING') return { kind: 'not_yet', opensAt: FLIGHT_BOARDING_OPENS_AT };
  if (input.invite) return { kind: 'eligible', origin: input.invite === 'FOUNDING' ? 'INVITE' : 'CREATOR' };
  if (input.entry?.flight === 'FIRST') {
    const opensAt = input.entry.opensAt ?? FLIGHT_BOARDING_OPENS_AT;
    if (input.now >= opensAt) return { kind: 'eligible', origin: 'LIST' };
    return { kind: 'batch_closed', batch: input.entry.batch ?? 1, opensAt };
  }
  return { kind: 'not_listed' };
}

// Validation of what people type. Addresses are compared lower-cased; nothing else about them is inferred.
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 6 && email.length <= 254 && EMAIL.test(email) && /\.[a-z]{2,}$/.test(email) ? email : null;
}
/** An X handle: up to 15 letters, digits or underscores (the card's "@handle", 15 characters plus the @). */
export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const INVITE_CODE = /^FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/\s+/g, '');
  const dashed = /^FLF[2-9A-HJ-NP-Z]{8}$/.test(code) ? `FLF-${code.slice(3, 7)}-${code.slice(7)}` : code;
  return INVITE_CODE.test(dashed) ? dashed : null;
}
/** A fresh invite code from 40 random bits (32-letter alphabet without 0, 1, I, O). */
export function inviteCodeFrom(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new Error('FLIGHT_INVITE_ENTROPY');
  const letters = [...bytes.slice(0, 8)].map(byte => INVITE_ALPHABET[byte % 32]).join('');
  return `FLF-${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** Passenger seats (after the 100 Founding seats) are the boarding number in the middle seat: the approved card's "214E". */
export const passengerSeat = (boardingNo: number) => `${boardingNo}E`;
export const foundingSeat = (seat: number) => `#${String(seat).padStart(3, '0')}`;

// The route a pass shows: networks as the card's codes, steps as action plus app and network (never an amount).
const CODES: Readonly<Record<string, { code: string; name: string }>> = {
  'eip155:1': { code: 'ETH', name: 'Ethereum' }, 'eip155:8453': { code: 'BASE', name: 'Base' }, 'eip155:42161': { code: 'ARB', name: 'Arbitrum' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { code: 'SOL', name: 'Solana' }, 'eip155:4663': { code: 'RH', name: 'Robinhood Chain' },
};
const ACTIONS: Readonly<Record<string, string>> = {
  'asset.swap.exact-input': 'Swap', 'asset.bridge': 'Bridge', 'asset.transfer': 'Transfer', 'asset.liquidity.concentrated': 'Add liquidity',
  'asset.liquidity.uniswap-v3': 'Add liquidity', 'asset.liquidity.prepare': 'Prepare liquidity', supply: 'Lend', borrow: 'Borrow', repay: 'Repay',
  withdraw: 'Withdraw',
};
const APPS: Readonly<Record<string, string>> = {
  uniswap: 'Uniswap', 'uniswap-v3': 'Uniswap', 'aave-v3': 'Aave', jupiter: 'Jupiter', 'orca-whirlpools': 'Orca', 'across.direct': 'Across',
  'lifi.rest': 'LI.FI', lifi: 'LI.FI', 'cow-protocol': 'CoW Protocol', 'flofi.router': 'FloFi Router', 'flofi.router.universal': 'FloFi Router',
};
export type FlightStep = { readonly action: string; readonly detail: string };
export type FlightRoute = { readonly from: string; readonly to: string; readonly steps: readonly FlightStep[]; readonly stepCount: number;
  readonly networkCount: number };
type Node = SemanticWorkflow['nodes'][number];
const destinationOf = (node: Node) => {
  const output = node.inputs.find(input => input.name === 'asset-out');
  return output && output.kind === 'ASSET' && typeof (output.value as { chainId?: unknown }).chainId === 'string' ? (output.value as { chainId: string }).chainId : node.chainId;
};
/**
 * The pass route of a canonical workflow, in its execution order (`ordered`), or null when a step is on a network the campaign does not
 * name (FloFi runs on mainnets only: a test network never earns a pass) or the workflow has no step.
 */
export function flightRoute(ordered: readonly Node[]): FlightRoute | null {
  const steps = ordered.filter(node => !node.actionType.startsWith('mock-'));
  if (!steps.length) return null;
  const networks: string[] = [];
  const projected: FlightStep[] = [];
  for (const node of steps) {
    const source = CODES[node.chainId], target = CODES[destinationOf(node)];
    if (!source || !target) return null;
    for (const code of [source.code, target.code]) if (!networks.includes(code)) networks.push(code);
    const crossing = source.code !== target.code;
    const action = crossing && node.actionType === 'asset.swap.exact-input' ? 'Bridge' : ACTIONS[node.actionType] ?? 'Step';
    const ids = [...node.adapterConstraints.protocols, ...node.adapterConstraints.adapters.map(adapter => adapter.id)];
    const app = ids.map(id => APPS[id] ?? APPS[id.split('.')[0]!]).find(Boolean);
    projected.push({ action, detail: crossing ? `${source.name} → ${target.name}` : app ? `${app} · ${source.name}` : source.name });
  }
  const first = steps[0]!, last = steps.at(-1)!;
  return { from: CODES[first.chainId]!.code, to: CODES[destinationOf(last)]!.code, steps: projected, stepCount: projected.length, networkCount: networks.length };
}
/** The approved card shows up to 4 steps; a longer route shows 3 and "+N steps" (the board's proposal for more than 4). */
export function visibleSteps(route: Pick<FlightRoute, 'steps'>): { readonly shown: readonly FlightStep[]; readonly more: number } {
  return route.steps.length <= MAX_ROUTE_STEPS_SHOWN ? { shown: route.steps, more: 0 } : { shown: route.steps.slice(0, 3), more: route.steps.length - 3 };
}

/** Campaign events (the handoff's funnel), each with its closed details. */
export const FLIGHT_EVENTS = {
  list_join: ['first', 'next'], board_click: [''], access_result: ['list', 'invite', 'batch_closed', 'not_listed'], route_example_click: ['eth_base', 'eth_sol', 'arb_base'],
  prompt_submit: [''], simulation_ok: ['founding', 'passenger'], share_click: ['founding', 'passenger', 'not_listed'], invite_redeem: [''],
} as const satisfies Record<string, readonly string[]>;
export type FlightEvent = keyof typeof FLIGHT_EVENTS;
/** The events a browser may report (the others are recorded by the server where they happen). */
export const CLIENT_EVENTS: readonly FlightEvent[] = ['board_click', 'route_example_click', 'prompt_submit', 'share_click'];
export function parseClientEvent(value: unknown): { event: FlightEvent; detail: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { event, detail = '' } = value as { event?: unknown; detail?: unknown };
  if (typeof event !== 'string' || !(CLIENT_EVENTS as readonly string[]).includes(event) || typeof detail !== 'string') return null;
  return (FLIGHT_EVENTS[event as FlightEvent] as readonly string[]).includes(detail) ? { event: event as FlightEvent, detail } : null;
}
