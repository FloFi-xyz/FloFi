// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the compact execution indicator inside an existing Canvas card — an icon and a short label, with
 * the step's full phase words as its accessible description. Positioned over the card's top edge (CSS), so it never changes the card's size or
 * the Canvas layout. Presentation only: it has no action and starts nothing.
 */
import { useLocale } from '../i18n/locale';
import { CANVAS_VISUAL_LABEL, type CanvasNodeExecution } from '../domain/canvas-execution';

function Icon({ visual }: { visual: CanvasNodeExecution['visual'] }) {
  const common = { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (visual) {
    case 'done': return <svg {...common}><path d="m3.5 8.5 3 3 6-7"/></svg>;
    case 'failed': return <svg {...common}><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>;
    case 'attention': return <svg {...common}><path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3m0 2v.01"/></svg>;
    case 'wallet': return <svg {...common}><rect x="2" y="4" width="12" height="9" rx="1.5"/><path d="M10 8.5h4M4 4l6-2v2"/></svg>;
    case 'authorize': return <svg {...common}><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 14a4.5 4.5 0 0 1 9 0"/></svg>;
    case 'pending': return <svg {...common}><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>;
    case 'active': return <svg {...common}><circle cx="8" cy="8" r="5.5" strokeDasharray="20 15" className="canvas-execution-spin"/></svg>;
    default: return null;
  }
}

export function CanvasExecutionBadge({ execution, vertical = false }: { execution: CanvasNodeExecution; vertical?: boolean }) {
  const { t } = useLocale();
  if (execution.visual === 'waiting') return null;
  const full = t(execution.text.key, ...execution.text.args);
  return <span className="canvas-execution-badge" data-visual={execution.visual} data-vertical={vertical || undefined} title={full}>
    <Icon visual={execution.visual}/>
    <span className="canvas-execution-badge-label" aria-hidden="true">{t(CANVAS_VISUAL_LABEL[execution.visual])}</span>
    <span className="sr-only">{t('Execution status: {0}', full)}</span>
  </span>;
}
