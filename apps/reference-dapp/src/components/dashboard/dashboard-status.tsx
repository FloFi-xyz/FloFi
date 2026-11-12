// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import { useLocale } from '../../i18n/locale';
import type { DashboardStatus } from '../../lib/dashboard/types';

// Presentation only: the existing projection remains the authority for status.
const tones: Record<DashboardStatus, string> = {
  Completed: 'complete',
  'Completed with attention': 'attention',
  'In progress': 'progress',
  'Needs attention': 'attention',
  'Partially completed': 'attention',
  Failed: 'failed',
  Unresolved: 'attention',
  'Transaction not submitted': 'neutral',
  'Not started': 'neutral',
};
/** P0 approved UX (board 16 §5): each presentation tone on the Design System status pair it maps to. */
const TAG_TONE: Readonly<Record<string, StatusTone>> = { complete: 'success', attention: 'attention', progress: 'soon', failed: 'danger', neutral: 'neutral' };

export type StatusTone = 'neutral' | 'soon' | 'testing' | 'attention' | 'success' | 'danger';
/**
 * P0 approved UX (boards 09–15): a status tag. It is text on a quiet pill, never a control: no border, no pointer, no hover. "Coming soon"
 * (`soon`) and "In testing" (`testing`) replace any disabled button for something that does not exist yet.
 */
export function StatusTag({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className="ux-tag" data-tone={tone}>{children}</span>;
}

export function DashboardStatusBadge({ status }: { status: DashboardStatus }) {
  const { t: tr } = useLocale();
  return <span className={`ux-tag dashboard-status dashboard-status-${tones[status]}`} data-tone={TAG_TONE[tones[status]]}><span className="dashboard-status-marker" aria-hidden="true"/>{tr(status)}</span>;
}
