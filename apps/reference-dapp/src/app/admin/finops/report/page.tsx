// SPDX-License-Identifier: AGPL-3.0-only
import { requestLanguage } from '../../../../server/request-language';
import { finopsCopy } from '../../../../components/admin/finops-copy';
import { adminPage } from '../../../../admin/page-context';
import { finopsPeriod } from '../../../../admin/finops/economics';
import { inclusiveEnd, readFinopsReport } from '../../../../admin/finops/report';
import { readReportFx } from '../../../../admin/finops/report-fx';
import { AdminShell, AdminUnavailable } from '../../../../components/admin/admin-shell';
import { Section } from '../../../../components/admin/admin-ui';
import { FinopsScenario } from '../../../../components/admin/finops-controls';
import { FinopsAi, FinopsCostBreakdown, FinopsCoverage, FinopsExchangeReference, FinopsFilters, FinopsOverview, FinopsRevenue, FinopsWorkflow,
  finopsFilterQuery } from '../../../../components/admin/finops-views';

export default async function FinopsInvestorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { language } = await requestLanguage();
  const { copy } = finopsCopy(language);
  const { host, context, now } = page, filter = finopsPeriod(now, await searchParams);
  const [data, fx] = await Promise.all([readFinopsReport(host, filter.period, now), readReportFx(filter.period, now)]);
  const report = { ...data, fx };
  const query = finopsFilterQuery(filter);
  return <AdminShell active="finops" context={context} title={copy("Investor Reporting")}
    description={`FloFi FinOps · ${copy('{0} to {1} UTC', filter.period.from, inclusiveEnd(filter.period))} · ${copy('USD with indicative BRL conversion')}`}
    actions={<a className="admin-button admin-finops-no-print" href={'/admin/finops?' + query.toString()}>{copy("Back to FinOps")}</a>}>
    <FinopsFilters language={language} filter={filter} action="/admin/finops/report"/>
    <article className="admin-finops-print" aria-label={copy("Investor financial report")}>
      <FinopsOverview language={language} report={report} mode="report"/>
      <FinopsExchangeReference rates={fx} language={language}/>
      <Section id="finops-provider-report" title={copy("Infrastructure cost breakdown")}><FinopsCostBreakdown language={language} report={report} mode="report"/></Section>
      <FinopsAi language={language} report={report} mode="report"/>
      <FinopsWorkflow language={language} report={report} mode="report"/>
      <FinopsRevenue language={language} report={report} mode="report"/>
      <Section id="finops-growth" title={copy("Scalability scenarios")} description={copy("Estimates are based on assumptions chosen for this report.")}>
        <FinopsScenario investor={{ csrf: context.csrf, filter: { range: filter.preset, ...Object.fromEntries(query) } }}/>
      </Section>
      <FinopsCoverage language={language} mode="report"/>
    </article>
  </AdminShell>;
}
