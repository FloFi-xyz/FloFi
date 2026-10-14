// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../components/admin/admin-shell';

/** BUILD-ADMIN-001: the console's landing page. Phase C replaces this frame with the operational overview. */
export default async function AdminOverviewPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  return <AdminShell active="overview" context={page.context} title="Overview" description="Platform-wide operational view.">
    <p className="admin-note">Operational analytics are not available in this build stage.</p>
  </AdminShell>;
}
