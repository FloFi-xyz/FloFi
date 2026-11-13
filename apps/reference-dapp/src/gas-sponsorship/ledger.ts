// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the sponsor's durable spending ledger and single-use sponsorship grants, on the `ExecutionStorage` port (files
 * locally, PostgreSQL in the cloud), so every sponsored network fee is recorded and the sponsor's funds are bounded.
 *
 *  - Ledger, per network and UTC day of the grant (`gas-sponsor-<network>-<yyyymmdd>.jsonl`): ONE reservation per grant (its owner nonce is
 *    pinned, so at most one of its operations can land), raised to the largest worst-case cost the paymaster signed for it, then a SETTLE with
 *    the actual fee observed on chain. The day's spend is Σ (settled ? actual : reserved): an unsettled reservation counts for its WHOLE day
 *    (BUILD-FLOFI-MAINNET-EXEC-002 review, round 2: a time-limited hold gave an owner who never reports back the budget again after an hour,
 *    and a paymaster signature can stay valid longer). The trade-off is availability, never funds: a signature the wallet refused or abandoned
 *    keeps its worst case reserved until the day ends, so operators size the daily budget for it (docs/deploy/GAS-SPONSORSHIP.md). A
 *    reservation that would exceed the operator's daily budget is refused (the operation stays user-funded). Abuse protection is on the
 *    sponsor's funds — per-operation cap, daily budget, exact reviewed calls, pinned nonce, bounded fees — never a quota on what a person may
 *    build or execute.
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
/**
 * `RELEASE`: written by an earlier build when a sponsorship was refused after reserving. Still readable (a ledger holding one is not corrupt),
 * but it frees nothing any more (review round 2: a concurrent request's refusal could release the reservation of an answer already handed to a
 * wallet), so its reservation keeps counting for the day like any other unsettled one.
 */
type LedgerLine = { readonly kind: 'RESERVE'; readonly id: string; readonly amount: string; readonly at: string } |
  { readonly kind: 'SETTLE'; readonly id: string; readonly amount: string; readonly reference: string; readonly at: string } |
  { readonly kind: 'RELEASE'; readonly id: string; readonly amount: '0'; readonly at: string };
const lines = <T,>(bytes: Uint8Array | null): T[] => utf8(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
const validLedger = (bytes: Uint8Array) => {
  for (const line of lines<LedgerLine>(bytes)) if (!['RESERVE', 'SETTLE', 'RELEASE'].includes(line.kind) || typeof line.id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(line.amount)) fail('GAS_SPONSOR_LEDGER_CORRUPT');
};

export type SponsorLedger = ReturnType<typeof createSponsorLedger>;
export function createSponsorLedger(storage: ExecutionStorage, now: () => Date = () => new Date()) {
  const { log, leases } = storage;
  const name = (network: string, at: Date) => `gas-sponsor-${networkKey(network)}-${day(at)}.jsonl`;
  /** Σ (settled ? actual : reserved) of the day — an unsettled reservation counts for the whole day (a legacy RELEASE frees nothing); and each id's reservation. */
  const spent = (entries: readonly LedgerLine[]) => {
    const reserved = new Map<string, bigint>(), settled = new Map<string, bigint>();
    for (const e of entries) {
      if (e.kind === 'RESERVE') reserved.set(e.id, BigInt(e.amount));
      else if (e.kind === 'SETTLE') settled.set(e.id, BigInt(e.amount));
    }
    let total = 0n;
    for (const [id, amount] of reserved) total += settled.get(id) ?? amount;
    return { total, reserved, settled };
  };
  const append = async (file: string, prior: Uint8Array | null, line: LedgerLine) => {
    const next = utf8(prior) + JSON.stringify(line) + '\n';
    if (prior === null) { if (!await log.create(file, new TextEncoder().encode(next))) fail('GAS_SPONSOR_BUSY'); }
    else await log.extend(file, new TextEncoder().encode(next), validLedger);
  };
  return {
    /**
     * Reserves `amount` (a worst-case cost) under `id` (a grant) within `budget` on the day of `on` (the grant's creation). Idempotent; a larger
     * amount for the same id raises its reservation by the difference (only one operation of a grant can land). Refused: GAS_SPONSOR_BUDGET_EXHAUSTED.
     */
    async reserve(network: string, id: string, amount: bigint, budget: bigint, on: Date = now()): Promise<void> {
      if (amount <= 0n) fail('GAS_SPONSOR_COST_INVALID');
      const file = name(network, on);
      await leases.hold(`gas-sponsor-${networkKey(network)}`, async () => {
        const prior = await log.read(file), state = spent(lines<LedgerLine>(prior)), held = state.reserved.get(id) ?? null;
        if (state.settled.has(id)) fail('GAS_SPONSOR_GRANT_USED');
        if (held !== null && held >= amount) return;
        // The grant's earlier reservation (it counts all day) is replaced (raised), never added twice.
        if (state.total - (held ?? 0n) + amount > budget) fail('GAS_SPONSOR_BUDGET_EXHAUSTED');
        await append(file, prior, { kind: 'RESERVE', id, amount: amount.toString(), at: now().toISOString() });
      });
    },
    /** Records the fee actually paid for a reserved grant (from the chain), once. */
    async settle(network: string, id: string, amount: bigint, reference: string, on: Date = now()): Promise<void> {
      const file = name(network, on);
      await leases.hold(`gas-sponsor-${networkKey(network)}`, async () => {
        const prior = await log.read(file), entries = lines<LedgerLine>(prior);
        if (!entries.some(e => e.kind === 'RESERVE' && e.id === id)) fail('GAS_SPONSOR_RESERVATION_MISSING');
        if (entries.some(e => e.kind === 'SETTLE' && e.id === id)) return;
        await append(file, prior, { kind: 'SETTLE', id, amount: amount.toString(), reference, at: now().toISOString() });
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
/**
 * `maxFeePerGas` / `callGasLimit`: the preparation's own fee ceiling and execution-gas allowance; an operation asking for more is refused (a
 * sponsored operation never pays more per gas, or for more execution, than the owner's reviewed batch would have).
 */
export type SponsorshipGrant = { readonly kind: 'GRANT'; readonly id: string; readonly network: string; readonly owner: string; readonly callsHash: string;
  readonly maxFeePerGas: string; readonly callGasLimit: string; readonly createdAt: string; readonly expiresAt: string };
/** `nonce`: the owner operation nonce of the grant's first sponsorship; every later one must use it, so at most one of them can land. */
export type GrantUse = { readonly kind: 'SPONSORED'; readonly userOpHash: string; readonly nonce: string; readonly maxCost: string; readonly at: string };
export const GRANT_ID = /^[0-9a-f]{32}$/;
/** At most this many final sponsorships per grant: one owner nonce lets only one land (a wallet may ask again after a lost answer). */
export const GRANT_MAX_USES = 3;
export function createGrantStore(storage: ExecutionStorage, now: () => Date = () => new Date()) {
  const { log, leases } = storage, file = (id: string) => `gas-grant-${id}.jsonl`;
  const validGrant = (bytes: Uint8Array) => {
    const [grant, ...uses] = lines<SponsorshipGrant | GrantUse>(bytes);
    if (!grant || grant.kind !== 'GRANT' || uses.some(u => u.kind !== 'SPONSORED' || !/^0x[0-9a-f]{64}$/.test(u.userOpHash)) || uses.length > GRANT_MAX_USES ||
        new Set(uses.map(u => (u as GrantUse).nonce)).size > 1) fail('GAS_SPONSOR_GRANT_CORRUPT');
  };
  return {
    async create(input: { network: string; owner: string; callsHash: string; maxFeePerGas: bigint; callGasLimit: bigint; ttlSeconds: number }): Promise<SponsorshipGrant> {
      if (input.maxFeePerGas <= 0n || input.callGasLimit <= 0n) fail('GAS_SPONSOR_GRANT_INVALID');
      const at = now(), grant: SponsorshipGrant = { kind: 'GRANT', id: randomBytes(16).toString('hex'), network: input.network, owner: input.owner.toLowerCase(),
        callsHash: input.callsHash, maxFeePerGas: input.maxFeePerGas.toString(), callGasLimit: input.callGasLimit.toString(), createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + input.ttlSeconds * 1000).toISOString() };
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
    /**
     * Records a final sponsorship of the grant (an operation hash and its owner nonce); refused past `GRANT_MAX_USES`, after expiry, or with
     * another nonce than the grant's first sponsorship (GAS_SPONSOR_NONCE_CHANGED). Idempotent per hash.
     */
    async use(id: string, userOpHash: string, nonce: bigint, maxCost: bigint): Promise<void> {
      await leases.hold(`gas-grant-${id}`, async () => {
        const bytes = await log.read(file(id));
        if (!bytes) fail('GAS_SPONSOR_GRANT_UNKNOWN');
        validGrant(bytes!);
        const [grant, ...uses] = lines<SponsorshipGrant | GrantUse>(bytes);
        if (Date.parse((grant as SponsorshipGrant).expiresAt) <= now().getTime()) fail('GAS_SPONSOR_GRANT_EXPIRED');
        if ((uses as GrantUse[]).some(u => u.userOpHash === userOpHash)) return;
        if (uses.length >= GRANT_MAX_USES) fail('GAS_SPONSOR_GRANT_USED');
        if (uses.length && (uses[0] as GrantUse).nonce !== nonce.toString()) fail('GAS_SPONSOR_NONCE_CHANGED');
        await log.extend(file(id), new TextEncoder().encode(utf8(bytes) + JSON.stringify({ kind: 'SPONSORED', userOpHash, nonce: nonce.toString(), maxCost: maxCost.toString(),
          at: now().toISOString() }) + '\n'), validGrant);
      });
    },
  };
}
export type GrantStore = ReturnType<typeof createGrantStore>;
