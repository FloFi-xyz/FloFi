// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * P0 hotfix (Flight transition): the board's frame. While the board checks a person's access ("Board now", or the arrival back from
 * sign-in), the page shows FloFi's branded checking state instead of the board: from the first paint on an arrival the server knows will
 * be checked, so no board is painted and then replaced, and no half-ready board (a disabled button, a status line) shows while /app loads.
 * The board stays mounted underneath (hidden: not painted, not focusable), so its check runs and its state survives; it is shown again
 * only when the person stays on the board (not on the list, a group still closed, a pass, a refusal).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { FlightTransition } from './flight-transition';

type Checking = (on: boolean) => void;
const FrameContext = createContext<Checking>(() => undefined);
/** Show (true) or leave (false) the checking state. Outside a frame it does nothing. */
export const useBoardChecking = () => useContext(FrameContext);

export function BoardFrame({ checking: initial, message, children }: { checking: boolean; message: string; children: ReactNode }) {
  const [checking, setChecking] = useState(initial);
  // Only a state the person's own action started fades in and takes focus; the arrival state is the page's first paint.
  const [started, setStarted] = useState(false);
  const [toggle] = useState<Checking>(() => (on: boolean) => { setChecking(on); if (on) setStarted(true); });
  // A page restored from the back/forward cache after it left for /app or sign-in shows the board again, never a stale checking state.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) setChecking(false); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  return <FrameContext.Provider value={toggle}>
    {checking && <FlightTransition message={message} focus={started} fade={started}/>}
    <div hidden={checking} data-flight-board-content="">{children}</div>
  </FrameContext.Provider>;
}
