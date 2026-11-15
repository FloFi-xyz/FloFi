// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { FlightConsole } from '../../../components/admin/flight-console';

export default async function AdminFlightPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  return <AdminShell active="flight" context={page.context} title="Flight FloFi"
    description="The Flight FloFi campaign: registrations, boarding, cards and email delivery. Subscriber addresses and exports are available to operators only.">
    <FlightConsole csrf={page.context.csrf} operator={page.context.principal.role === 'OPERATOR'}/>
  </AdminShell>;
}
