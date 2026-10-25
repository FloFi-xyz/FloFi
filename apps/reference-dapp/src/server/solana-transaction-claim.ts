// SPDX-License-Identifier: AGPL-3.0-only
import { utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';

/**
 * HOTFIX-WORKFLOW-CONCURRENCY-001: a durable, exclusive claim of one Solana transaction identity (a reviewed message hash or an owner
 * signature) by one run. Exclusive creation makes the first claim atomic across tabs, processes and restarts without any owner-level
 * lease; the same run may claim again (an interrupted step retried) and any other run is refused, so one on-chain transaction is never
 * tracked by two runs. `released` lets a new run take over an identity whose holder provably never had it signed and broadcast (an
 * attempt cancelled before any signature was recorded); the claim log keeps every holder, newest last.
 */
export async function solanaTransactionClaim(storage: ExecutionStorage, name: string, id: string, refusal: string,
  released?: (holder: string) => Promise<boolean>): Promise<void> {
  const line = new TextEncoder().encode(id + '\n');
  if (await storage.log.create(name, line)) return;
  await storage.leases.hold(`claim-${name}`, async () => {
    const text = utf8(await storage.log.read(name)), holder = text.trimEnd().split('\n').at(-1);
    if (holder === id) return;
    if (!holder || !released || !await released(holder)) throw new Error(refusal);
    await storage.log.extend(name, new TextEncoder().encode(text + id + '\n'), bytes => { if (!utf8(bytes).endsWith('\n')) throw new Error(refusal); });
  });
}
