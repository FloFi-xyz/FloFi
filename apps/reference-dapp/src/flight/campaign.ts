// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the Flight FloFi launch campaign's rules, as the team-approved Claude Artifact "Flight FloFi" (version
 * 1793892357-f7d9, board "Landing · Handoff para o Alrimar") states them. Pure: no database, no request, no clock of its own.
 *
 * - The beta list closes on 11 Nov 2026 at 23:59 BRT (`closes_at`); boarding starts on 12 Nov 2026 at 9:00 BRT (BUILD-FLOFI-UX-005, moved from
 *   16/17 Nov). Both instants are the campaign calendar (`FlightCalendar`): the defaults below, or the deployment's
 *   `FLOFI_FLIGHT_LIST_CLOSES_AT` / `FLOFI_FLIGHT_BOARDING_OPENS_AT`, read when a request is served (`flightCalendar`).
 * - "Board now" checks the list, the person's boarding group and invites. A boarded person's first valid simulation issues their boarding
 *   pass ("simulation_ok = cartão emitido"); the first 100 passes are numbered Founding seats (#001–#100, in boarding order), later ones
 *   are passenger passes. A Founding pass carries 3 invites ("bring three people on board, no list needed").
 * - The campaign gates only its own benefit (the pass): /app stays open to everyone.
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 (team decisions of 9 Nov 2026, artifact version 1794236006-f919, "00 · Comece aqui"):
 * - Invited creators get a test flight from 11 Nov 14:00 to 18:00 BRT (`FLOFI_FLIGHT_CREATORS_OPEN_AT`): they simulate and see a card
 *   marked TEST that is never stored, numbered or shared; everyone boards for real when boarding opens ("Ninguém pega número Founding antes
 *   da lista"). Email 2 goes out on 11 Nov at 20:00 BRT (`FLOFI_FLIGHT_EVE_EMAIL_AT`).
 * - Only a Founding seat earned by someone who boarded straight from the beta list carries 3 invites: an invited person (a Founding member's
 *   guest or a creator) never gets invites of their own, so invites never propagate.
 * - No public aggregate count of people: no list size, boardings or seats left anywhere public. Only each card's own number is shown.
 */
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

/** The approved calendar: the list closes 11 Nov 2026 23:59 BRT, boarding opens 12 Nov 2026 9:00 BRT (UTC-3). */
export const FLIGHT_LIST_CLOSES_AT = Date.parse('2026-11-11T23:59:00-03:00');
export const FLIGHT_BOARDING_OPENS_AT = Date.parse('2026-11-12T09:00:00-03:00');
/** The creators' test flight opens 11 Nov 2026 14:00 BRT and lasts four hours (14:00 to 18:00, Email 6 and "Comece aqui"). */
export const FLIGHT_CREATORS_OPEN_AT = Date.parse('2026-11-11T14:00:00-03:00');
export const CREATOR_TEST_FLIGHT_MS = 4 * 60 * 60 * 1000;
/** Email 2 ("Boarding starts tomorrow") goes out 11 Nov 2026 20:00 BRT. */
export const FLIGHT_EVE_EMAIL_AT = Date.parse('2026-11-11T20:00:00-03:00');
export const FOUNDING_SEATS = 100;
export const FOUNDING_INVITES = 3;
/** The privacy notice shown next to the list form (recorded with each entry). */
export const FLIGHT_NOTICE_VERSION = '2026-11-09'; // BUILD-FLOFI-FLIGHT-LAUNCH-001: campaign email, access links, public cards.
/** How long a recorded simulation can still issue a pass. */
export const SIMULATION_EVIDENCE_MS = 2 * 60 * 60 * 1000;
export const DEPARTURES_SHOWN = 5;
export const MAX_ROUTE_STEPS_SHOWN = 4;

/**
 * The instants the campaign turns on (epoch milliseconds): the beta list closing, boarding opening, the creators' test flight opening and
 * Email 2's send time. `creatorsOpenAt` and `eveEmailAt` are optional for callers that predate them (the defaults apply).
 */
export type FlightCalendar = { readonly listClosesAt: number; readonly boardingOpensAt: number; readonly creatorsOpenAt?: number; readonly eveEmailAt?: number };
export const FLIGHT_DEFAULT_CALENDAR: Required<FlightCalendar> = Object.freeze({ listClosesAt: FLIGHT_LIST_CLOSES_AT, boardingOpensAt: FLIGHT_BOARDING_OPENS_AT,
  creatorsOpenAt: FLIGHT_CREATORS_OPEN_AT, eveEmailAt: FLIGHT_EVE_EMAIL_AT });
/** The calendar with every instant filled: a missing creators' opening or Email 2 time is derived so it never contradicts the calendar given. */
export function fullCalendar(calendar: FlightCalendar): Required<FlightCalendar> {
  const creatorsOpenAt = calendar.creatorsOpenAt ?? Math.min(FLIGHT_CREATORS_OPEN_AT, calendar.boardingOpensAt);
  const eveEmailAt = calendar.eveEmailAt ?? Math.min(FLIGHT_EVE_EMAIL_AT, calendar.boardingOpensAt);
  return { listClosesAt: calendar.listClosesAt, boardingOpensAt: calendar.boardingOpensAt, creatorsOpenAt, eveEmailAt };
}
/**
 * An instant written as ISO 8601 with an explicit offset or Z (e.g. 2026-11-12T09:00:00-03:00): never a local time open to the server's
 * zone, and never a date the platform parser would roll over (31 Nov, 30 Feb, 24:00). Undefined when unset, null when unreadable.
 */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
function instant(value: string | undefined): number | null | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const match = INSTANT.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0, fraction = '0', sign, offsetHours = 0, offsetMinutes = 0] = match.slice(1)
    .map((part, index) => part === undefined ? undefined : index === 6 || index === 7 ? part : Number(part)) as [number, number, number, number, number,
      number | undefined, string | undefined, string | undefined, number | undefined, number | undefined];
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHours > 14 || offsetMinutes > 59) return null;
  const offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  return Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0'))) - offset * 60_000;
}
/**
 * The deployment's campaign calendar. `FLOFI_FLIGHT_LIST_CLOSES_AT` and `FLOFI_FLIGHT_BOARDING_OPENS_AT` (server-only, read on every call,
 * never inlined into a build) override the approved defaults; an unset variable keeps its default. Fail-closed: a set value that is not
 * a valid ISO instant with an offset, or a pair whose list would close after boarding opens, gives no calendar at all (`calendar: null`:
 * the campaign is then unavailable, so a mistyped postponement can never open boarding early). `invalid` names what was refused.
 */
export function flightCalendarFrom(env: Readonly<Record<string, string | undefined>>): { readonly calendar: Required<FlightCalendar> | null; readonly invalid: readonly string[] } {
  const closes = instant(env.FLOFI_FLIGHT_LIST_CLOSES_AT), opens = instant(env.FLOFI_FLIGHT_BOARDING_OPENS_AT);
  const creators = instant(env.FLOFI_FLIGHT_CREATORS_OPEN_AT), eve = instant(env.FLOFI_FLIGHT_EVE_EMAIL_AT);
  const invalid = [...(closes === null ? ['FLOFI_FLIGHT_LIST_CLOSES_AT'] : []), ...(opens === null ? ['FLOFI_FLIGHT_BOARDING_OPENS_AT'] : []),
    ...(creators === null ? ['FLOFI_FLIGHT_CREATORS_OPEN_AT'] : []), ...(eve === null ? ['FLOFI_FLIGHT_EVE_EMAIL_AT'] : [])];
  if (invalid.length) return { calendar: null, invalid };
  const listClosesAt = closes ?? FLIGHT_LIST_CLOSES_AT, boardingOpensAt = opens ?? FLIGHT_BOARDING_OPENS_AT;
  if (listClosesAt > boardingOpensAt) return { calendar: null, invalid: ['FLOFI_FLIGHT_LIST_CLOSES_AT', 'FLOFI_FLIGHT_BOARDING_OPENS_AT'] };
  // The creators' test flight and Email 2 must come before boarding: a value after it is refused, never silently moved.
  const full = fullCalendar({ listClosesAt, boardingOpensAt, ...typeof creators === 'number' ? { creatorsOpenAt: creators } : {}, ...typeof eve === 'number' ? { eveEmailAt: eve } : {} });
  const late = [...(full.creatorsOpenAt > boardingOpensAt ? ['FLOFI_FLIGHT_CREATORS_OPEN_AT'] : []), ...(full.eveEmailAt > boardingOpensAt ? ['FLOFI_FLIGHT_EVE_EMAIL_AT'] : [])];
  if (late.length) return { calendar: null, invalid: late };
  return { calendar: full, invalid };
}

/** FINAL_CALL until the list closes; GATE_CLOSED until boarding; BOARDING after (the approved posts' "Gate closed. Boarding starts tomorrow"). */
export type FlightPhase = 'FINAL_CALL' | 'GATE_CLOSED' | 'BOARDING';
export function flightPhase(now: number, calendar: FlightCalendar = FLIGHT_DEFAULT_CALENDAR): FlightPhase {
  return now < calendar.listClosesAt ? 'FINAL_CALL' : now < calendar.boardingOpensAt ? 'GATE_CLOSED' : 'BOARDING';
}
/** The list a new entry joins: the beta list while it is open, the next flight's list afterwards. */
export const listFor = (phase: FlightPhase): 'FIRST' | 'NEXT' => phase === 'FINAL_CALL' ? 'FIRST' : 'NEXT';

/** What "Board now" answers for a person (the handoff's access_result: list · invite · batch_closed · not_listed), or their pass. */
export type FlightOrigin = 'LIST' | 'INVITE' | 'CREATOR';
export type FlightAccess =
  | { readonly kind: 'boarded'; readonly passId: string }
  /** An invited creator during the test flight: simulations show a TEST card, never stored, numbered or shared. */
  | { readonly kind: 'test_flight'; readonly endsAt: number }
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
  readonly entry: { readonly flight: 'FIRST' | 'NEXT'; readonly batch: number | null; readonly opensAt: number | null } | null;
  readonly calendar?: FlightCalendar }): FlightAccess {
  const calendar = fullCalendar(input.calendar ?? FLIGHT_DEFAULT_CALENDAR);
  if (input.passId) return { kind: 'boarded', passId: input.passId };
  if (flightPhase(input.now, calendar) !== 'BOARDING') {
    const endsAt = Math.min(calendar.creatorsOpenAt + CREATOR_TEST_FLIGHT_MS, calendar.boardingOpensAt);
    if (input.invite === 'CREATOR' && input.now >= calendar.creatorsOpenAt && input.now < endsAt) return { kind: 'test_flight', endsAt };
    return { kind: 'not_yet', opensAt: calendar.boardingOpensAt };
  }
  if (input.invite) return { kind: 'eligible', origin: input.invite === 'FOUNDING' ? 'INVITE' : 'CREATOR' };
  if (input.entry?.flight === 'FIRST') {
    // A group whose recorded opening is earlier than boarding (created for the previous calendar) boards when boarding opens.
    const opensAt = input.entry.opensAt ?? calendar.boardingOpensAt;
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
/**
 * Whether a newly issued pass carries the 3 Founding invites: a Founding seat whose holder boarded straight from the beta list. Invited
 * people (a Founding member's guest, a creator) never get invites, so invites do not propagate (team decision, 9 Nov 2026).
 */
export const carriesInvites = (input: { readonly foundingSeat: number | null; readonly origin: FlightOrigin }): boolean =>
  input.foundingSeat !== null && input.origin === 'LIST';
/** A card's public link id: 12 letters of RFC 4648 base32 (60 random bits), lower case, never sequential. */
export const CARD_PUBLIC_ID = /^[a-z2-7]{12}$/;
export function cardPublicIdFrom(bytes: Uint8Array): string {
  if (bytes.length < 12) throw new Error('FLIGHT_CARD_ENTROPY');
  return [...bytes.slice(0, 12)].map(byte => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join('');
}
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
