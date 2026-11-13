// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the sponsor's durable spending ledger and single-use sponsorship grants, on the `ExecutionStorage` port (files
 * locally, PostgreSQL in the cloud), so every sponsored network fee is recorded and the sponsor's funds are bounded.
 *
 *  - Ledger, per network and UTC day (`gas-sponsor-<network>-<yyyymmdd>.jsonl`): a RESERVE of an operation's worst-case cost before the sponsor
 *    signs or a paymaster answers, then a SETTLE with the actual fee observed on chain. The day's spend is Σ (settled ? actual : reserved); a
 *    reservation that would exceed the operator's daily budget is refused (the operation stays user-funded). Abuse protection is on the sponsor's
 *    funds — per-operation cap, daily budget, exact reviewed calls, single-use grants — never a quota on what a person may build or execute.
 *  - Grant (`gas-grant-<id>.jsonl`): created by FloFi when it prepares a sponsorable request for the owner's exact reviewed calls; it names the
 *    owner, the network, the calls' hash and an expiry. The paymaster proxy sponsors only an operation of that owner whose calls are exactly
 *    those, and records each sponsored operation hash on the grant (reconciliation finds the one that landed by it).
 * Nothing here signs, sends or holds a key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';

const fail = (code: string): never => { throw new Error(code); };
const networkKey = (network: string) => network.replace(/[^A-Za-z0-9]+/g, '-');
const day = (at: Date) => at.toISOString().slice(0, 10).replaceAll('-', '');
type LedgerLine = { readonly kind: 'RESERVE'; readonly id: string; readonly amount: string; readonly at: string } |
  { readonly kind: 'SETTLE'; readonly id: string; readonly amount: string; readonly reference: string; readonly at: string };
const lines = <T,>(bytes: Uint8Array | null): T[] => utf8(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
const validLedger = (bytes: Uint8Array) => {
  for (const line of lines<LedgerLine>(bytes)) if (!['RESERVE', 'SETTLE'].includes(line.kind) || typeof line.id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(line.amount)) fail('GAS_SPONSOR_LEDGER_CORRUPT');
};

export type SponsorLedger = ReturnType<typeof createSponsorLedger>;
export function createSponsorLedger(storage: ExecutionStorage, now: () => Date = () => new Date()) {
  const { log, leases } = storage;
  const name = (network: string, at: Date) => `gas-sponsor-${networkKey(network)}-${day(at)}.jsonl`;
  /** Σ (settled ? actual : reserved) of the day, and whether `id` is already reserved. */
  const spent = (entries: readonly LedgerLine[]) => {
    const reserved = new Map<string, bigint>(), settled = new Map<string, bigint>();
    for (const e of entries) (e.kind === 'RESERVE' ? reserved : settled).set(e.id, BigInt(e.amount));
    let total = 0n;
    for (const [id, amount] of reserved) total += settled.get(id) ?? amount;
    return { total, reserved };
  };
  return {
    /** Reserves `amount` (a worst-case cost) under `id` within `budget` for today; idempotent for the same id. Refused: GAS_SPONSOR_BUDGET_EXHAUSTED. */
    async reserve(network: string, id: string, amount: bigint, budget: bigint): Promise<void> {
      if (amount <= 0n) fail('GAS_SPONSOR_COST_INVALID');
      const at = now(), file = name(network, at);
      await leases.hold(`gas-sponsor-${networkKey(network)}`, async () => {
        const prior = await log.read(file), entries = lines<LedgerLine>(prior), state = spent(entries);
        if (state.reserved.has(id)) return;
        if (state.total + amount > budget) fail('GAS_SPONSOR_BUDGET_EXHAUSTED');
        const next = utf8(prior) + JSON.stringify({ kind: 'RESERVE', id, amount: amount.toString(), at: at.toISOString() }) + '\n';
        if (prior === null) { if (!await log.create(file, new TextEncoder().encode(next))) fail('GAS_SPONSOR_BUSY'); }
        else await log.extend(file, new TextEncoder().encode(next), validLedger);
      });
    },
    /** Records the fee actually paid for a reserved operation (from the chain), once. */
    async settle(network: string, id: string, amount: bigint, reference: string, reservedAt: Date = now()): Promise<void> {
      const file = name(network, reservedAt);
      await leases.hold(`gas-sponsor-${networkKey(network)}`, async () => {
        const prior = await log.read(file), entries = lines<LedgerLine>(prior);
        if (!entries.some(e => e.kind === 'RESERVE' && e.id === id)) fail('GAS_SPONSOR_RESERVATION_MISSING');
        if (entries.some(e => e.kind === 'SETTLE' && e.id === id)) return;
        await log.extend(file, new TextEncoder().encode(utf8(prior) + JSON.stringify({ kind: 'SETTLE', id, amount: amount.toString(), reference, at: now().toISOString() }) + '\n'),
          validLedger);
      });
    },
    /** Today's spend on a network (reserved worst cases, replaced by actual fees once settled). */
    async spentToday(network: string): Promise<bigint> { return spent(lines<LedgerLine>(await log.read(name(network, now())))).total; },
  };
}

/** The canonical hash of an exact call list (target, value, data), as reviewed and as an operation must carry it. */
export function callsHash(calls: readonly { readonly target: string; readonly value: bigint | string; readonly data: string }[]): string {
  return '0x' + createHash('sha256').update(JSON.stringify(calls.map(c => [c.target.toLowerCase(), BigInt(c.value).toString(), c.data.toLowerCase()]))).digest('hex');
}
export type SponsorshipGrant = { readonly kind: 'GRANT'; readonly id: string; readonly network: string; readonly owner: string; readonly callsHash: string;
  readonly createdAt: string; readonly expiresAt: string };
export type GrantUse = { readonly kind: 'SPONSORED'; readonly userOpHash: string; readonly maxCost: string; readonly at: string };
export const GRANT_ID = /^[0-9a-f]{32}$/;
/** At most this many final sponsorships per grant: one owner nonce lets only one land (a wallet may ask again after a lost answer). */
export const GRANT_MAX_USES = 3;
export function createGrantStore(storage: ExecutionStorage, now: () => Date = () => new Date()) {
  const { log, leases } = storage, file = (id: string) => `gas-grant-${id}.jsonl`;
  const validGrant = (bytes: Uint8Array) => {
    const [grant, ...uses] = lines<SponsorshipGrant | GrantUse>(bytes);
    if (!grant || grant.kind !== 'GRANT' || uses.some(u => u.kind !== 'SPONSORED' || !/^0x[0-9a-f]{64}$/.test(u.userOpHash)) || uses.length > GRANT_MAX_USES) fail('GAS_SPONSOR_GRANT_CORRUPT');
  };
  return {
    async create(input: { network: string; owner: string; callsHash: string; ttlSeconds: number }): Promise<SponsorshipGrant> {
      const at = now(), grant: SponsorshipGrant = { kind: 'GRANT', id: randomBytes(16).toString('hex'), network: input.network, owner: input.owner.toLowerCase(),
        callsHash: input.callsHash, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + input.ttlSeconds * 1000).toISOString() };
      if (!await log.create(file(grant.id), new TextEncoder().encode(JSON.stringify(grant) + '\n'))) fail('GAS_SPONSOR_GRANT_EXISTS');
      return grant;
    },
    async read(id: string): Promise<{ grant: SponsorshipGrant; uses: readonly GrantUse[] } | null> {
      if (!GRANT_ID.test(id)) return null;
      const bytes = await log.read(file(id));
      if (!bytes) return null;
      validGrant(bytes);
      const [grant, ...uses] = lines<SponsorshipGrant | GrantUse>(bytes);
      return { grant: grant as SponsorshipGrant, uses: uses as GrantUse[] };
    },
    /** Records a final sponsorship of the grant (an operation hash); refused past `GRANT_MAX_USES` or after expiry. Idempotent per hash. */
    async use(id: string, userOpHash: string, maxCost: bigint): Promise<void> {
      await leases.hold(`gas-grant-${id}`, async () => {
        const bytes = await log.read(file(id));
        if (!bytes) fail('GAS_SPONSOR_GRANT_UNKNOWN');
        validGrant(bytes!);
        const [grant, ...uses] = lines<SponsorshipGrant | GrantUse>(bytes);
        if (Date.parse((grant as SponsorshipGrant).expiresAt) <= now().getTime()) fail('GAS_SPONSOR_GRANT_EXPIRED');
        if ((uses as GrantUse[]).some(u => u.userOpHash === userOpHash)) return;
        if (uses.length >= GRANT_MAX_USES) fail('GAS_SPONSOR_GRANT_USED');
        await log.extend(file(id), new TextEncoder().encode(utf8(bytes) + JSON.stringify({ kind: 'SPONSORED', userOpHash, maxCost: maxCost.toString(), at: now().toISOString() }) + '\n'),
          validGrant);
      });
    },
  };
}
export type GrantStore = ReturnType<typeof createGrantStore>;
