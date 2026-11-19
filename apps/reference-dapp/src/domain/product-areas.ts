// SPDX-License-Identifier: AGPL-3.0-only
import { dashboardRoute } from '../lib/dashboard/routes';
import { secondaryWorkspaceRoute } from './secondary-workspaces';

/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX, references A2/B2/C2): the global navigation names product AREAS, never the internal stages of
 * an operation. Each area is an existing destination of the persistent product shell: Operate is the workspace (/app: Chat entry and the Editor),
 * Dashboard and My Workflows are the existing pages. Navigation only — nothing here creates, simulates, authorizes or signs anything, and the open
 * workflow stays in the shared workflow store while another area is shown.
 */
export const PRODUCT_AREAS = [
  { id: 'operate', label: 'Operate', href: '/app' },
  { id: 'dashboard', label: 'Dashboard', href: '/app/dashboard' },
  { id: 'workflows', label: 'My Workflows', href: '/app/workflows' },
] as const;
export type ProductArea = typeof PRODUCT_AREAS[number]['id'];

/** The area the current page belongs to; null on pages outside the three areas (e.g. Automations, Credentials). */
export function productArea(pathname: string | null | undefined, section?: string | null): ProductArea | null {
  if (dashboardRoute(pathname) || section === 'Dashboard') return 'dashboard';
  const secondary = secondaryWorkspaceRoute(pathname);
  if (secondary) return secondary.id === 'workflows' ? 'workflows' : null;
  const path = pathname?.replace(/\/$/, '') ?? null;
  return path === null || path === '' || path === '/app' || path === '/__engineering' || path === '/approve' ? 'operate' : null;
}
