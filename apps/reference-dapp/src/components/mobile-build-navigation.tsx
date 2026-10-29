// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

/** Focus shortcuts only: the canvas, stores and chat remain mounted. */
export function MobileBuildNavigation({ stage = 'Build' }: { stage?: 'Build' | 'Simulate' | 'Execute' }) {
  const { t: tr } = useLocale();
  function focus(selector: string) {
    const target = document.querySelector<HTMLElement>(selector);
    // BUILD-FLOFI-CHAT-E2E-FIX-002: a summary kept in a collapsed details surface is opened before it is focused.
    const details = target?.closest('details');
    if (details && !details.open) details.open = true;
    if (target && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  const secondary = stage === 'Build' ? 'Copilot' : stage === 'Simulate' ? 'Review' : 'Execution Summary';
  return <nav className="mobile-build-navigation" aria-label={tr(stage === 'Build' ? 'Build workspace navigation' : stage === 'Simulate' ? 'Simulation workspace navigation' : 'Execution workspace navigation')}>
    <button type="button" onClick={() => focus('.workflow-workspace .canvas')}>{tr('Canvas')}</button>
    <button type="button" onClick={() => focus(stage === 'Build' ? '#mock-prompt' : stage === 'Simulate' ? '.simulation-summary' : '.execution-summary')}>{tr(secondary)}</button>
    {/* BUILD-FLOFI-CONVERSATIONAL-001: the same conversation continues below Simulate and Execute. */}
    {stage !== 'Build' && <button type="button" onClick={() => focus('#mock-prompt')}>{tr('Copilot')}</button>}
  </nav>;
}
