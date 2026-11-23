// SPDX-License-Identifier: AGPL-3.0-only
import { adminPermits } from '../../../admin/guard';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Section } from '../../../components/admin/admin-ui';
import { StudioReview } from '../../../components/admin/studio-review';
import { requestLanguage } from '../../../server/request-language';
import { studioCertificationInstalled, studioCertificationQueue } from '../../../studio/certification-store';

export default async function StudioReviewPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { language } = await requestLanguage();
  const pt = language === 'PT';
  const installed = await studioCertificationInstalled(page.host.db);
  const rows = installed ? await studioCertificationQueue(page.host.db, page.host.tenantId) : [];
  const empty = installed ? (pt ? 'Nenhum pedido de certificação.' : 'No certification submissions.')
    : (pt ? 'A certificação requer a migração 0036.' : 'Certification requires migration 0036.');
  return <AdminShell active="studio" context={page.context} title="Studio certification"
    description={pt ? 'Revise evidências de mainnet, certifique metadados e gerencie a publicação.' : 'Review mainnet evidence, certify metadata and manage publication.'}>
    <Section id="studio-certification-queue" title={pt ? 'Integrações submetidas' : 'Submitted integrations'}>
      {rows.length === 0 ? <p className="admin-hint">{empty}</p> : rows.map(row => <StudioReview key={`${row.project_id}.${row.slug}.${row.version}`}
        row={row} pt={pt} csrf={page.context.csrf} canWrite={adminPermits(page.context, 'write')}/>)}
    </Section>
  </AdminShell>;
}
