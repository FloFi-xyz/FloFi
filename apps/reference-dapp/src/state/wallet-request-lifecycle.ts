// SPDX-License-Identifier: AGPL-3.0-only
/** A wallet promise owns only its submission, never navigation or observation. No timers, retries or send calls. */
type ProviderEvents = {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};
export async function watchWalletResponse<T>(provider: ProviderEvents, response: () => Promise<T>, interrupted: () => void): Promise<T> {
  const events = ['accountsChanged', 'chainChanged', 'disconnect'];
  let reported = false;
  const listener = () => { if (!reported) { reported = true; interrupted(); } };
  for (const event of events) provider.on?.(event, listener);
  try { return await response(); }
  finally { for (const event of events) provider.removeListener?.(event, listener); }
}
export type DurableWalletReport = { runId: string; attemptId: string; owner: string; kind: 'HASH' | 'REJECTED'; hash?: string; code?: string; rejectionCode?: number; network?: string };
const KEY = 'flofi:wallet-result-outbox:v1';
export function walletResultStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
export function readWalletReports(storage: Pick<Storage, 'getItem'> | null, owner: string): DurableWalletReport[] {
  if (!storage) return [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r): r is DurableWalletReport => !!r && typeof r === 'object' &&
      typeof r.runId === 'string' && /^(xuni|xroute)-[a-f0-9]{32}$/.test(r.runId) && typeof r.attemptId === 'string' && r.attemptId.startsWith(r.runId + '.') &&
      r.owner === owner && (r.kind === 'REJECTED' && [4001, 4100, 4200].includes(r.rejectionCode) || r.kind === 'HASH' && typeof r.hash === 'string' && /^0x[0-9a-f]{64}$/.test(r.hash))) : [];
  } catch { return []; }
}
export function rememberWalletReport(storage: Pick<Storage, 'getItem' | 'setItem'> | null, report: DurableWalletReport): void {
  if (!storage) return;
  // Browser storage is a delivery aid, never financial authority. The server still validates every report and attempt identity.
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    const entries = Array.isArray(raw) ? raw.filter(r => r && typeof r === 'object' && r.attemptId !== report.attemptId) : [];
    storage.setItem(KEY, JSON.stringify([...entries, report]));
  } catch { /* Server nonce discovery remains available when browser storage is unavailable. */ }
}
export function forgetWalletReport(storage: Pick<Storage, 'getItem' | 'setItem'> | null, attemptId: string): void {
  if (!storage) return;
  try { const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]'); if (Array.isArray(raw)) storage.setItem(KEY, JSON.stringify(raw.filter(r => r?.attemptId !== attemptId))); } catch { /* Retain for a later read. */ }
}
