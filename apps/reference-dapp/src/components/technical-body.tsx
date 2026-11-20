// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';

/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (TEC-01): the content of an opened "Technical details" scrolls inside its own bounded area, so opening it
 * never stretches the page, pushes the workflow out of view or moves the footer's action. A focusable, named region (keyboard users can scroll it).
 * When the owner opens it, the panel it sits in scrolls just enough to show it (the page itself is never scrolled). Presentation only:
 * what it holds is unchanged, and opening, closing or scrolling it requests nothing.
 */
export function TechnicalBody({ children, label = 'Technical details' }: { children: ReactNode; label?: string }) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const details = ref.current?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    const summary = details.querySelector(':scope > summary');
    // Only the owner's own opening (a click or Enter/Space on the summary) reveals the content — never a panel re-created already open.
    const reveal = () => window.requestAnimationFrame(() => {
      const body = ref.current;
      if (!details.open || !body) return;
      // Scroll only the nearest scrolling panel (the docked Review on a desktop); the page itself is never scrolled.
      let pane = body.parentElement;
      while (pane && pane !== document.body && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
      if (!pane || pane === document.body) return;
      const below = body.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom;
      if (below > 0) pane.scrollTo({ top: pane.scrollTop + below + 8, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    summary?.addEventListener('click', reveal);
    return () => summary?.removeEventListener('click', reveal);
  }, []);
  return <div ref={ref} className="technical-body" role="region" aria-label={t(label)} tabIndex={0}>{children}</div>;
}

/** One labelled group of technical facts ("Operations", "Amounts and limits", …); a group with nothing to show is never rendered. */
export function TechnicalGroup({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useLocale();
  // A group named by its own heading (not a landmark): an opened Review adds no page-level regions, also in the run view.
  const id = useId();
  return <div className="technical-group" role="group" aria-labelledby={id}><h4 id={id}>{t(title)}</h4>{children}</div>;
}
