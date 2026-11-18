// SPDX-License-Identifier: AGPL-3.0-only
import { requestLanguage } from '../../../server/request-language';
import { finopsCopy } from '../../../components/admin/finops-copy';
import { adminPage } from '../../../admin/page-context';
import { finopsPeriod } from '../../../admin/finops/economics';
import { configuredBillingScopes } from '../../../admin/finops/providers';
import { readFinopsReport } from '../../../admin/finops/report';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Section } from '../../../components/admin/admin-ui';
import { FinopsImports, FinopsScenario } from '../../../components/admin/finops-controls';
import { FinopsAi, FinopsCoverage, FinopsFilters, FinopsInfrastructure, FinopsOverview, FinopsRevenue, FinopsWorkflow,
  finopsFilterQuery } from '../../../components/admin/finops-views';

export default async function FinopsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { language } = await requestLanguage();
  const { copy } = finopsCopy(language);
  const { host, context, now } = page, filter = finopsPeriod(now, await searchParams);
  const report = await readFinopsReport(host, filter.period, now);
  const query = finopsFilterQuery(filter), reportUrl = '/admin/finops/report?' + query.toString();
  return <AdminShell active="finops" context={context} title={copy("FinOps & Unit Economics")}
    description={copy("Consolidated costs, operating indicators, and financial assumptions for FloFi.")}
    actions={<a className="admin-button" href={reportUrl}>{copy("Investor reporting")}</a>}>
    <FinopsFilters language={language} filter={filter} action="/admin/finops"/>
    <nav className="admin-actions admin-finops-no-print" aria-label={copy("FinOps sections")}>
      <a href="#finops-overview">{copy("Overview")}</a><a href="#finops-infrastructure">{copy("Infrastructure Costs")}</a><a href="#finops-ai">{copy("AI Economics")}</a>
      <a href="#finops-workflow">{copy("Workflow Economics")}</a><a href="#finops-revenue">{copy("Revenue & Margins")}</a><a href="#finops-growth">{copy("Growth Simulator")}</a>
    </nav>
    <FinopsOverview language={language} report={report}/>
    <FinopsInfrastructure language={language} report={report}/>
    {context.principal.role === 'OPERATOR' && report.ledger.status === 'available' ?
      <Section id="finops-imports" title={copy("Manage financial records")}><FinopsImports csrf={context.csrf}
        adapters={configuredBillingScopes(process.env, host.tenantId)} filter={{ range: filter.preset, ...Object.fromEntries(query) }}/></Section>
      : null}
    <FinopsAi language={language} report={report}/>
    <FinopsWorkflow language={language} report={report}/>
    <FinopsRevenue language={language} report={report}/>
    <Section id="finops-growth" title={copy("Growth Simulator")}><FinopsScenario/></Section>
    <FinopsCoverage language={language}/>
  </AdminShell>;
}
