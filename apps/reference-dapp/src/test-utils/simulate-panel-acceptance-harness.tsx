// SPDX-License-Identifier: AGPL-3.0-only
// Browser-only test entry. No production route imports this module.
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (post-merge red on main 0ea35d5): the Simulate panel (`ReviewSummaryPanel`, stage "simulate") through the
 * states it actually passes while an owner waits on it — the runtime's availability still being checked, a refused simulation, the waiting layout and
 * a valid result — with the props replaced in place (never unmounted), exactly as the Editor re-renders it. Nothing is simulated or signed here.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewSummaryPanel } from '../components/review-summary-panel';
import { SIMULATION_AVAILABILITY_CHECKING } from '../domain/simulation-presentation';
import type { SimulationSource } from '../domain/simulation-presentation';
import { reviewFixture } from './review-fixture';

type PanelState = 'checking' | 'blocked' | 'unavailable' | 'pending' | 'ready';
declare global {
  interface Window { flofiSimulatePanelAcceptance: { show(value: PanelState): void } }
}
function sourceFor(state: PanelState, fixture: ReturnType<typeof reviewFixture>): SimulationSource {
  const ready = fixture.source.state as Record<string, unknown>;
  const base = { ...ready, run: null, error: null, busy: false, available: true, availabilityKnown: true };
  const value = state === 'ready' ? { ...ready, availabilityKnown: true }
    : state === 'checking' ? { ...base, available: false, availabilityKnown: false }
    : state === 'blocked' ? { ...base, error: 'SIMULATION_FAILED' }
    // Availability answered: this network's simulation is not served here (main dc09621 post-merge red: the answer arriving after the focus).
    : state === 'unavailable' ? { ...base, available: false } : base;
  return { kind: 'public', state: value } as unknown as SimulationSource;
}
function Harness() {
  const [state, setState] = useState<PanelState>('checking');
  const [fixture] = useState(reviewFixture);
  useEffect(() => { window.flofiSimulatePanelAcceptance = { show: setState }; }, []);
  return <aside className="canvas-review-dock" aria-label="Simulation">
    <ReviewSummaryPanel stage="simulate" workflow={fixture.workflow} context={fixture.context} source={sourceFor(state, fixture)}
      authorization={state === 'ready' ? fixture.authorization : { ...fixture.authorization, key: null, ready: false }}
      wallet={fixture.wallet} unavailableReason={state === 'checking' ? SIMULATION_AVAILABILITY_CHECKING : null}
      technical={<aside className="simulation-summary panel" aria-label="Simulation Summary"><div role="region" aria-label="Expected result">{state === 'ready' ? 'Fixture result' : 'Fixture pending'}</div></aside>}/>
  </aside>;
}
export function mount(element: HTMLElement) { createRoot(element).render(<Harness/>); }
