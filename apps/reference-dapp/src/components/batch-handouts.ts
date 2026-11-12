// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Final review (P1): the hand-out token of each wallet batch this browser received (workflow-runs/service.ts `handedTo`), per approval and group.
 * The server hands a prepared batch again — or prepares it again once it can no longer execute — only to the browser that presents it, so a
 * second device or wallet instance never receives (and executes) the same group. The Editor and /approve share it (same origin, same storage).
 * Storage that cannot be written only means this browser cannot ask again for the same batch; it never sends anything by itself.
 */
const HANDOUTS_KEY = 'flofi.batch-handouts.v1';
const HANDOUTS_LIMIT = 64;
const read = (): Record<string, string> => {
  try { const v = JSON.parse(localStorage.getItem(HANDOUTS_KEY) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {}; }
  catch { return {}; }
};
export function batchHandout(approvalId: string, group: number): string | undefined {
  const token = read()[`${approvalId}:${group}`];
  return typeof token === 'string' ? token : undefined;
}
export function keepBatchHandout(approvalId: string, group: number, token: string | null | undefined): void {
  if (typeof token !== 'string' || !token) return;
  try {
    const all = read(), key = `${approvalId}:${group}`;
    delete all[key];
    const kept = Object.entries({ ...all, [key]: token }).slice(-HANDOUTS_LIMIT);
    localStorage.setItem(HANDOUTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* storage unavailable: this browser cannot ask for the same batch again */ }
}
