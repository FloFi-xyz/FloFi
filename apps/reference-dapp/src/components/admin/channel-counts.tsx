// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): the Overview's "Completed executions by channel" section (server component, no client
 * script). Aggregate counts only, for the page's environment and the chosen period; what the figures leave out is said next to them, and a
 * read failure is a closed code, never an estimate. The counting and attribution rules are `admin/analytics/channels.ts`.
 */
import { CHANNEL_LABELS, CHANNEL_PERIOD_LABELS, CHANNEL_PERIODS, CHANNELS, type ChannelCounts as Counts, type ChannelCountsResult,
  type ChannelPeriod } from '../../admin/analytics/channels';
import { ENVIRONMENT_LABELS, type AnalyticsEnvironment } from '../../admin/analytics/networks';
import { withParams, type AnalyticsParams } from '../../admin/analytics/view';
import type { Language } from '../../i18n/language';
import { Section } from './admin-ui';
import { finopsCopy } from './finops-copy';

/** What the figures of one environment leave out, in reading order. */
function channelNotes(data: Counts, environment: AnalyticsEnvironment, language: Language): string[] {
  const { copy, count, time } = finopsCopy(language), tally = data.byEnvironment[environment], compositions = data.compositionsWithoutRecord[environment];
  return [
    copy('Each count is one unique workflow run that completed and reconciled. A Batch Payment counts once, however many recipients it pays; ' +
      'simulations, quotes, approval requests, retries and individual steps are never counted.'),
    copy('An execution belongs to the period it started in.'),
    copy('FloFi Web counts workflow runs started from the Editor, and combines Web Chat and the Editor: no record says which of the two started a run.'),
    copy('One-step runs started directly in the app have no origin record and are shown as Unknown origin.'),
    copy("A one-step run started from an approval keeps its channel only while that approval's record of the run exists: an approval records at " +
      'most 16 runs, and approvals may be removed by retention. Otherwise it is shown as Unknown origin.'),
    copy('Executions without a recorded origin, including earlier history, are shown as Unknown origin.'),
    ...tally.automation ? [copy('{0} completed executions requested by automation rules are not attributed to a channel.', count(tally.automation))] : [],
    ...data.unrecognizedEnvironment ? [copy('{0} completed executions have no recognized environment and are not counted.', count(data.unrecognizedEnvironment))] : [],
    ...data.coverage.truncated && data.coverage.coveredFrom ? [copy('This period holds more runs than one view reads: single-flow executions are counted only ' +
      'from {0} on, so every figure is a lower bound.', time(data.coverage.coveredFrom.toISOString()))] : [],
    ...data.workflowRunsTruncated ? [copy('Not every group of completed workflow runs could be read at once, so every figure is a lower bound.')] : [],
    ...compositions ? [copy('{0} composition executions are not indexed yet: until they are, their step runs may be counted as separate executions.',
      count(compositions))] : [],
  ];
}

export function ChannelCounts({ result, period, environment, params, language }: { result: ChannelCountsResult; period: ChannelPeriod;
  environment: AnalyticsEnvironment; params: AnalyticsParams; language: Language }) {
  const { copy, count } = finopsCopy(language);
  const title = copy('Completed executions by channel'), periodLabel = copy(CHANNEL_PERIOD_LABELS[period.id]);
  const nav = <nav className="admin-segmented" aria-label={copy('Period')}>
    {CHANNEL_PERIODS.map(id => <a key={id} href={withParams('/admin', params, { channels: id })} aria-current={period.id === id ? 'true' : undefined}>
      {copy(CHANNEL_PERIOD_LABELS[id])}</a>)}
  </nav>;
  const data = result.ok ? result.value : null, tally = data?.byEnvironment[environment] ?? null;
  const partial = data !== null && (data.coverage.truncated || data.workflowRunsTruncated);
  const value = (n: number) => partial ? copy('At least {0}', count(n)) : count(n);
  return <Section id="admin-channels" title={title} description={`${copy(ENVIRONMENT_LABELS[environment])} · ${periodLabel} · UTC`} actions={nav}>
    {!data || !tally ? <p className="admin-alert" data-tone="bad" role="alert">{copy('Completed execution counts are unavailable.')} <code>{result.ok ? '' : result.code}</code></p>
      : <>
        {tally.total === 0 ? <p className="admin-empty">{copy('No completed executions in this period.')}</p> : <div className="admin-table-wrap"><table className="admin-table">
          <caption className="admin-sr">{`${title} · ${periodLabel}`}</caption>
          <thead><tr><th scope="col">{copy('Channel')}</th><th scope="col" className="num">{copy('Completed executions')}</th></tr></thead>
          <tbody>
            {CHANNELS.map(channel => <tr key={channel}><th scope="row">{copy(CHANNEL_LABELS[channel])}</th><td className="num">{value(tally.counts[channel])}</td></tr>)}
            <tr><th scope="row"><strong>{copy('Total')}</strong></th><td className="num"><strong>{value(tally.total)}</strong></td></tr>
          </tbody>
        </table></div>}
        <div className="admin-note" role="note">{channelNotes(data, environment, language).map(note => <p key={note}>{note}</p>)}</div>
      </>}
    {period.invalid ? <p className="admin-diff">{copy('The requested period was not recognized, so the last 30 days are shown.')}</p> : null}
  </Section>;
}
