// SPDX-License-Identifier: AGPL-3.0-only
import { requestLanguage } from '../../../server/request-language';
import { finopsCopy } from '../../../components/admin/finops-copy';
import { adminPage } from '../../../admin/page-context';
import { finopsPeriod } from '../../../admin/finops/economics';
import { configuredBillingScopes } from '../../../admin/finops/providers';
import { readFinopsReport } from '../../../admin/finops/report';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Section, TechnicalDetails } from '../../../components/admin/admin-ui';
import { FinopsImports, FinopsIntegrations, FinopsScenario } from '../../../components/admin/finops-controls';
import { FinopsAi, FinopsCoverage, FinopsFilters, FinopsInfrastructure, FinopsOverview, FinopsRevenue, FinopsWorkflow,
  finopsFilterQuery } from '../../../components/admin/finops-views';

const SECTIONS = [['overview', 'Financial overview'], ['expenses', 'Expenses & invoices'],
  ['integrations', 'Financial integrations'], ['economics', 'Workflow Economics']] as const;

export default async function FinopsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { language } = await requestLanguage();
  const { copy } = finopsCopy(language);
  const search = await searchParams;
  const { host, context, now } = page, filter = finopsPeriod(now, search);
  const area = SECTIONS.find(([id]) => id === search.section)?.[0] ?? 'overview';
  const report = await readFinopsReport(host, filter.period, now);
  const query = finopsFilterQuery(filter), reportUrl = '/admin/finops/report?' + query.toString();
  const financeUrl = (section: typeof area, csv = false) => {
    const next = new URLSearchParams(query);
    if (section !== 'overview') next.set('section', section);
    if (csv) next.set('entry', 'csv');
    return `/admin/finops?${next}${csv ? '#finops-imports' : ''}`;
  };
  const canImport = context.principal.role === 'OPERATOR' && report.ledger.status === 'available';
  return <AdminShell active="finops" context={context} title={copy("FinOps & Unit Economics")}
    actions={<>
      {canImport ? <a className="admin-button" data-variant="primary" href={financeUrl('expenses', true)}>{copy('Import CSV')}</a> : null}
      <a className="admin-button" href={reportUrl}>{copy("Investor reporting")}</a>
    </>}>
    <nav className="admin-segmented admin-finops-no-print" aria-label={copy("FinOps sections")}>
      {SECTIONS.map(([id, label]) => <a key={id} href={financeUrl(id)} aria-current={id === area ? 'true' : undefined}>{copy(label)}</a>)}
    </nav>
    <FinopsFilters language={language} filter={filter} action="/admin/finops" section={area}/>
    {area === 'overview' ? <>
      <FinopsOverview language={language} report={report}/>
      <FinopsRevenue language={language} report={report}/>
      <FinopsCoverage language={language}/>
    </> : null}
    {area === 'expenses' ? <>
      {canImport ? <Section id="finops-imports" title={copy('Invoice and CSV import')}>
        <FinopsImports csrf={context.csrf} csvOpen={search.entry === 'csv'}
          adapters={report.integrations.available || 'unreadable' in report.integrations ? [] : configuredBillingScopes(process.env, host.tenantId)}
          filter={{ range: filter.preset, ...Object.fromEntries(query) }}/>
      </Section> : null}
      <FinopsInfrastructure language={language} report={report}/>
    </> : null}
    {area === 'integrations' ? <Section id="finops-integrations" title={copy('Financial integrations')}>
      <FinopsIntegrations integrations={report.integrations} {...context.principal.role === 'OPERATOR' ? { csrf: context.csrf } : {}}/>
    </Section> : null}
    {area === 'economics' ? <>
      <FinopsWorkflow language={language} report={report}/>
      <FinopsAi language={language} report={report}/>
      <TechnicalDetails summary={copy('Growth Simulator')}><FinopsScenario/></TechnicalDetails>
    </> : null}
  </AdminShell>;
}
