// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { useLocale } from '../i18n/locale';

/** BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (E11, P2-04, A10): the workspace pane shown on a phone-width screen. */
export type MobilePane = 'plan' | 'conversation';

/** The shown pane, the stage it belongs to and how many FloFi replies the owner had in view when the pane last changed. */
export type MobilePaneState = { readonly pane: MobilePane; readonly stage: string; readonly seen: number };
/**
 * The state for this render: a new stage shows its Plan (with every reply so far counted as seen); a conversation that got shorter (a new
 * workflow) counts from its new length. Otherwise unchanged (the same object, so a render does not loop).
 */
export function currentMobilePane(state: MobilePaneState, stage: string, replies: number): MobilePaneState {
  if (state.stage !== stage) return { pane: 'plan', stage, seen: replies };
  return replies < state.seen ? { ...state, seen: replies } : state;
}
/** A FloFi reply arrived while the Plan was shown: the Conversation tab says so until it is opened. */
export const mobilePaneUnread = (state: MobilePaneState, replies: number) => state.pane === 'plan' && replies > state.seen;
/** The shell's pane: `show` records the replies in view at that moment, so only a later reply marks the Conversation tab. */
export function useMobilePane(stage: string, replies: number) {
  const [stored, setStored] = useState<MobilePaneState>(() => ({ pane: 'plan', stage, seen: replies }));
  const state = currentMobilePane(stored, stage, replies);
  // Derived from the stage and the conversation during render (React's "adjust state when a prop changes"); converges at once.
  if (state !== stored) setStored(state);
  return { pane: state.pane, unread: mobilePaneUnread(state, replies),
    show: (pane: MobilePane) => setStored(current => ({ ...currentMobilePane(current, stage, replies), pane, seen: replies })) };
}

/**
 * On a phone-width screen (up to 800 px, where this navigation is shown), a Plan / Conversation switch shows one pane at a time (the stage or the
 * FloFi Assistant) instead of a tall Canvas above the chat. Both panes stay mounted (the Canvas, its selection, the stores and the conversation
 * are untouched); the shell's `data-mobile-pane` only hides the other one (CSS). A reply that arrives while Plan is shown marks the Conversation
 * tab until it is opened. On Simulate and Execute the stage's summary shortcut stays (it opens the Plan first). Wider screens are unchanged.
 */
export function MobileBuildNavigation({ stage = 'Build', pane = 'plan', onPane, unread = false }: { stage?: 'Build' | 'Simulate' | 'Execute'; pane?: MobilePane;
  onPane?: (pane: MobilePane) => void; unread?: boolean }) {
  const { t: tr } = useLocale();
  // The composer stays in view above an on-screen keyboard: when the visible height shrinks around the focused field, it is scrolled back in.
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    if (!viewport) return;
    const keep = () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || field.id !== 'mock-prompt' || !window.matchMedia('(max-width: 800px)').matches) return;
      const bottom = viewport.offsetTop + viewport.height - 8, box = field.getBoundingClientRect();
      if (box.bottom > bottom) window.scrollBy({ top: box.bottom - bottom, behavior: 'instant' });
    };
    viewport.addEventListener('resize', keep);
    return () => viewport.removeEventListener('resize', keep);
  }, []);
  function show(next: MobilePane) {
    // Synchronously, so a shortcut that focuses something in the pane finds it displayed.
    if (next !== pane) flushSync(() => onPane?.(next));
  }
  function focus(selector: string) {
    show('plan');
    const target = document.querySelector<HTMLElement>(selector);
    // BUILD-FLOFI-CHAT-E2E-FIX-002: a summary kept in a collapsed details surface is opened before it is focused.
    for (let details = target?.closest('details'); details; details = details.parentElement?.closest('details') ?? null) if (!details.open) details.open = true;
    if (target && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  // Tabs pattern: Left/Right (and Home/End) move between the two tabs and select them; focus stays on the tab.
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'plan' : event.key === 'ArrowRight' || event.key === 'End' ? 'conversation' : null;
    if (!next) return;
    event.preventDefault();
    show(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-pane="${next}"]`)?.focus();
  }
  const tab = (id: MobilePane, label: string) => <button type="button" role="tab" data-pane={id} aria-selected={pane === id} tabIndex={pane === id ? 0 : -1}
    data-unread={id === 'conversation' && unread && pane !== id || undefined} onClick={() => show(id)} onKeyDown={key}>
    {tr(label)}{id === 'conversation' && unread && pane !== id && <><span className="mobile-pane-unread" aria-hidden="true"/><span className="sr-only">{tr('New reply')}</span></>}
  </button>;
  const summary = stage === 'Simulate' ? 'Review' : stage === 'Execute' ? 'Execution Summary' : null;
  return <nav className="mobile-build-navigation" aria-label={tr(stage === 'Build' ? 'Editor navigation' : stage === 'Simulate' ? 'Simulation workspace navigation' : 'Execution workspace navigation')}>
    <div role="tablist" className="mobile-pane-tabs">{tab('plan', 'Plan')}{tab('conversation', 'Conversation')}</div>
    {/* The stage's own summary shortcut (Review, Execution Summary), as before: it shows the Plan and focuses the summary. */}
    {summary && <button type="button" onClick={() => focus(stage === 'Simulate' ? '.review-panel-approved, .simulation-summary' : '.execution-summary')}>{tr(summary)}</button>}
  </nav>;
}
