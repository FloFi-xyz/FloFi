// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-FLIGHT-001: the two places Flight FloFi touches /app, both inert unless the person came from /board's "Board now":
 * - the request they typed on /board is put in the Build entry once, as an editable draft (never sent on its own);
 * - when a fresh Review of their workflow is ready, the server is asked to issue their boarding pass. The server decides, from its own
 *   record of their simulation; this never authorizes, signs or changes anything in the workflow.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '../i18n/locale';

export const FLIGHT_DRAFT_KEY = 'flofi.flight.draft';
export const FLIGHT_BOARDING_KEY = 'flofi.flight.boarding';
/**
 * Set by /board before sign-in ("Board now" or an invite): a new account's wallet onboarding then returns there instead of /app
 * (used once). Only these two exact paths are ever returned to.
 */
export const FLIGHT_RETURN_KEY = 'flofi.flight.return';
export const FLIGHT_RETURNS = ['/board?board=1', '/board?invite=1'] as const;
const storage = () => { try { return sessionStorage; } catch { return null; } };
/** Where wallet onboarding continues: back to /board after "Board now" or an invite, otherwise /app (as before). */
export function afterOnboardingPath(): string {
  const store = storage(), back = store?.getItem(FLIGHT_RETURN_KEY) ?? null;
  store?.removeItem(FLIGHT_RETURN_KEY);
  return (FLIGHT_RETURNS as readonly string[]).includes(back ?? '') ? back! : '/app';
}

/**
 * Once, where the Build entry opens: the request typed on /board becomes its draft (then removed from storage, so it is used only
 * once). Elsewhere (`setDraft` null: the dashboard, an approval) the draft waits for the Build entry.
 */
export function useFlightDraft(setDraft: ((text: string) => void) | null): void {
  const used = useRef(false);
  useEffect(() => {
    if (!setDraft || used.current) return;
    used.current = true;
    const store = storage(), text = store?.getItem(FLIGHT_DRAFT_KEY) ?? '';
    store?.removeItem(FLIGHT_DRAFT_KEY);
    const draft = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (draft) setDraft(draft);
  }, [setDraft]);
}

/**
 * After "Board now", the first ready Review asks for the pass, naming the workflow in Review; the server issues it from its own record
 * of that simulation (the route included). The notice links to it on /board.
 */
export function FlightBoarding({ readyKey, workflowId }: { readyKey: string | null; workflowId: string }) {
  const { t } = useLocale();
  const [issued, setIssued] = useState(false);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const store = storage();
    if (!readyKey || asked.current === readyKey || store?.getItem(FLIGHT_BOARDING_KEY) !== '1') return;
    asked.current = readyKey;
    void fetch('/api/board/pass', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId }) })
      .then(response => response.json() as Promise<{ ok: boolean; code?: string }>)
      .then(answer => {
        // Issued (or already issued): done. Not eligible: nothing to retry. Anything else (no recorded simulation yet): the next Review retries.
        if (answer.ok) { store?.removeItem(FLIGHT_BOARDING_KEY); setIssued(true); }
        else if (answer.code === 'FLIGHT_NOT_ELIGIBLE') store?.removeItem(FLIGHT_BOARDING_KEY);
      }).catch(() => { asked.current = null; });
  }, [readyKey, workflowId]);
  if (!issued) return null;
  return <p className="beta-notice" role="status">{t('Your Flight FloFi boarding pass is ready.')} <Link href="/board#pass">{t('See your boarding pass')}</Link></p>;
}
