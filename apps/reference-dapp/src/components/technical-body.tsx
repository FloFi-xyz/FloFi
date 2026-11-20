// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';

/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002 (TEC-01): the content of an opened "Technical details" scrolls inside its own bounded area, so opening it
 * never stretches the page, pushes the workflow out of view or moves the footer's action. A focusable, named region (keyboard users can scroll it).
 * When the owner opens it, its content is scrolled into view inside the panel (nearest edge only; the page itself never moves). Presentation only:
 * what it holds is unchanged, and opening, closing or scrolling it requests nothing.
 */
export function TechnicalBody({ children, label = 'Technical details' }: { children: ReactNode; label?: string }) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const details = ref.current?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    const reveal = () => {
      if (!details.open || !ref.current) return;
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      ref.current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    };
    details.addEventListener('toggle', reveal);
    return () => details.removeEventListener('toggle', reveal);
  }, []);
  return <div ref={ref} className="technical-body" role="region" aria-label={t(label)} tabIndex={0}>{children}</div>;
}

/** One labelled group of technical facts ("Operations", "Amounts and limits", …); a group with nothing to show is never rendered. */
export function TechnicalGroup({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useLocale();
  return <section className="technical-group" aria-label={t(title)}><h4>{t(title)}</h4>{children}</section>;
}
