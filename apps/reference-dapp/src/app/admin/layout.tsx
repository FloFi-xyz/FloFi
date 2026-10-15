// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import './admin.css';

/** BUILD-ADMIN-001: the private console's own frame. It shares nothing with the product workspace; every page guards itself. */
export const metadata: Metadata = { title: 'FloFi Admin', robots: { index: false, follow: false } };
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await connection();
  return <div className="admin-root">{children}</div>;
}
