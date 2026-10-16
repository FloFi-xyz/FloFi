// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from 'next/navigation';
import { adminSignInState } from '../../../admin/page-context';
import { AdminBrand } from '../../../components/admin/admin-brand';
import { AdminSignIn } from '../../../components/admin/admin-sign-in';
import { AdminUnavailable } from '../../../components/admin/admin-shell';

/** BUILD-ADMIN-001: the only console page reachable without an admin session. */
export default async function AdminLoginPage() {
  const state = await adminSignInState();
  if (!state.available) return <AdminUnavailable code={state.code}/>;
  if (state.signedIn) redirect('/admin');
  return <div className="admin-sign-in">
    <AdminBrand/>
    <AdminSignIn/>
  </div>;
}
