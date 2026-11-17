// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef } from 'react';
import { adoptSettlementRead, SETTLEMENT_SYNC_MS, settlementSyncDue, type SettlementRecord } from '../domain/settlement-sync';

/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (EXEC-02): while the shown bridge run settles, re-read its DURABLE record (`read`: the store's status
 * read — a database read, never a chain observation) every `SETTLEMENT_SYNC_MS` while the page is visible, and once when it becomes visible again,
 * so every surface follows the worker's reconciliation without "Check status" (which stays as the manual fallback).
 *
 * An answer is adopted only if nothing else changed the store since the read started (`epoch`: any operation — a check, an execution, opening
 * another run — advances it), the same run is still shown, and the answer does not move the run back (`adoptSettlementRead`). The read is
 * owner-scoped by the server (the store's status action); the router store's `accept` also checks the signed-in wallet. Stops by itself once
 * the run is final. Nothing is observed, retried, signed or submitted.
 */
export function useSettlementSync<T extends SettlementRecord>(input: {
  readonly record: T | null; readonly busy: () => boolean; readonly epoch: () => number; readonly visible: () => string | undefined;
  readonly read: (record: T) => Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false } | null>; readonly accept: (value: T) => void;
}): void {
  const latest = useRef(input); latest.current = input;
  const due = settlementSyncDue(input.record), id = input.record?.id ?? null;
  useEffect(() => {
    if (!due || !id || typeof document === 'undefined') return;
    let stopped = false, reading = false;
    const tick = async () => {
      const now = latest.current, shown = now.record;
      if (stopped || reading || document.visibilityState !== 'visible' || now.busy() || !shown || shown.id !== id) return;
      reading = true;
      const epoch = now.epoch();
      try {
        const result = await now.read(shown).catch(() => null);
        const current = latest.current;
        if (stopped || !result?.ok || current.epoch() !== epoch || current.visible() !== id || current.busy()) return;
        if (adoptSettlementRead(current.record, result.value)) current.accept(result.value);
      } finally { reading = false; }
    };
    const timer = window.setInterval(() => { void tick(); }, SETTLEMENT_SYNC_MS);
    const visible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [due, id]);
}
