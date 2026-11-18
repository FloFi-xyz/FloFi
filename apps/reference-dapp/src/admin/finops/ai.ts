// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminHost } from '../host.ts';
import { modelUsage, readCopilotMetrics } from '../analytics/copilot.ts';
import { COPILOT_METRICS_RETENTION_DAYS } from '../../server/copilot-metrics-store.ts';
import { addDays, isoDay, type Indicator, type Period, unavailable } from './economics.ts';
import { ledgerMissing } from './store.ts';

type Provider = 'OPENAI' | 'ANTHROPIC';
type Surface = 'WEB' | 'TELEGRAM' | 'WHATSAPP' | 'CHANNEL';
export type Pricing = {
  provider: Provider;
  model: string;
  effective: string;
  currency: 'USD';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number | null;
  source: string;
};
const OPENAI_MODELS = 'https://developers.openai.com/api/docs/models/';
const ANTHROPIC_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const AI_PRICES: readonly Pricing[] = [
  { provider: 'OPENAI', model: 'gpt-5-mini-2025-08-07', effective: '2026-11-18', currency: 'USD', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: null, source: OPENAI_MODELS + 'gpt-5-mini' },
  { provider: 'OPENAI', model: 'gpt-5-nano-2025-08-07', effective: '2026-11-18', currency: 'USD', input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: null, source: OPENAI_MODELS + 'gpt-5-nano' },
  { provider: 'OPENAI', model: 'gpt-5.4-mini-2026-03-17', effective: '2026-11-18', currency: 'USD', input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: null, source: OPENAI_MODELS + 'gpt-5.4-mini' },
  { provider: 'ANTHROPIC', model: 'claude-sonnet-4-5-20250929', effective: '2026-11-18', currency: 'USD', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, source: ANTHROPIC_PRICING },
  { provider: 'ANTHROPIC', model: 'claude-haiku-4-5-20251001', effective: '2026-11-18', currency: 'USD', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, source: ANTHROPIC_PRICING },
  { provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', effective: '2026-11-18', currency: 'USD', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, source: ANTHROPIC_PRICING },
  { provider: 'ANTHROPIC', model: 'claude-opus-5-5', effective: '2026-11-18', currency: 'USD', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, source: ANTHROPIC_PRICING },
];
export const priceAt = (provider: Provider, model: string, day: string, prices = AI_PRICES): Pricing | null =>
  prices.filter(price => price.provider === provider && price.model === model && price.effective <= day)
    .sort((a, b) => b.effective.localeCompare(a.effective))[0] ?? null;

const COUNTERS = ['requests', 'successes', 'duration_ms', 'input_tokens', 'input_samples', 'output_tokens', 'output_samples',
  'cached_input_tokens', 'cached_input_samples', 'cache_write_tokens', 'cache_write_samples', 'reasoning_tokens', 'reasoning_samples'] as const;
export type AiUsage = { day: string; provider: Provider; model: string; surface: Surface } & Record<(typeof COUNTERS)[number], number>;
export function pricedUsage(usage: AiUsage, prices = AI_PRICES): number | null {
  const price = priceAt(usage.provider, usage.model, usage.day, prices);
  const writes = usage.cache_write_tokens;
  if (!price || !usage.requests || usage.input_samples !== usage.requests || usage.output_samples !== usage.requests ||
      usage.cached_input_samples !== usage.requests || usage.provider === 'ANTHROPIC' && usage.cache_write_samples !== usage.requests ||
      writes > 0 && price.cacheWrite === null) return null;
  const hit = usage.cached_input_tokens, uncached = usage.input_tokens - hit - writes;
  if (uncached < 0) return null;
  // Reasoning tokens are already in billed output. Measured cache dimensions are charged once.
  return (uncached * price.input + hit * price.cacheRead + writes * (price.cacheWrite ?? 0) + usage.output_tokens * price.output) / 1_000_000;
}

export async function readAiEconomics(host: AdminHost, period: Period, now: Date) {
  const oldest = addDays(isoDay(now), 1 - COPILOT_METRICS_RETENTION_DAYS);
  const from = period.from > oldest ? period.from : oldest;
  const query = await readCopilotMetrics(host, from, period.to, 'live', true);
  const { rows: legacy, truncated } = query;
  const interpretations = legacy.filter(row => row.kind === 'INTERPRETATION'), channelTurns = legacy.filter(row => row.kind === 'TURN' && row.surface === 'CHANNEL');
  const webTurns = interpretations.filter(row => row.surface === 'WEB');
  const channels = channelTurns.reduce((sum, row) => sum + row.events, 0);
  const web = webTurns.reduce((sum, row) => sum + row.events, 0);
  let ledgerAvailable = true;
  const result = await host.db.query<Record<string, unknown>>(`SELECT day::text, provider, model, surface, updated_at, ${COUNTERS.join(', ')}
    FROM finops_ai_daily_usage WHERE tenant_id = $1 AND day >= $2::date AND day < $3::date ORDER BY day DESC, provider, model, surface LIMIT 20_001`,
  [host.tenantId, from, period.to]).catch(error => {
    if (!ledgerMissing(error)) throw error;
    ledgerAvailable = false;
    return null;
  });
  const raw = result?.rows ?? [];
  const extendedTruncated = raw.length > 20_000;
  const rows = raw.slice(0, 20_000).map(row => ({ ...row, ...Object.fromEntries(COUNTERS.map(key => [key, Number(row[key])])) })) as (AiUsage & { updated_at: Date })[];
  const groups = new Map<string, { usage: AiUsage; estimate: number | null; pricedRequests: number }>();
  const byDay = new Map<string, { requests: number; pricedRequests: number; estimate: number | null }>();
  let requests = 0, inputSamples = 0, outputSamples = 0, successes = 0, duration = 0, pricedRequests = 0, estimate: number | null = null;
  for (const row of rows) {
    const cost = pricedUsage(row);
    requests += row.requests;
    inputSamples += row.input_samples;
    outputSamples += row.output_samples;
    successes += row.successes;
    duration += row.duration_ms;
    if (cost !== null) {
      estimate = (estimate ?? 0) + cost;
      pricedRequests += row.requests;
    }
    const day = byDay.get(row.day) ?? { requests: 0, pricedRequests: 0, estimate: null };
    day.requests += row.requests;
    if (cost !== null) { day.pricedRequests += row.requests; day.estimate = (day.estimate ?? 0) + cost; }
    byDay.set(row.day, day);
    const key = [row.provider, row.model, row.surface].join(':');
    const group = groups.get(key);
    if (!group) {
      const usage: AiUsage = { day: row.day, provider: row.provider, model: row.model, surface: row.surface,
        ...Object.fromEntries(COUNTERS.map(counter => [counter, row[counter]])) } as AiUsage;
      groups.set(key, { usage, estimate: cost, pricedRequests: cost === null ? 0 : row.requests });
      continue;
    }
    for (const counter of COUNTERS) group.usage[counter] += row[counter];
    if (cost !== null) { group.estimate = (group.estimate ?? 0) + cost; group.pricedRequests += row.requests; }
  }
  const toolCalls = interpretations.reduce((sum, row) => sum + row.tool_calls, 0);
  const toolFailures = interpretations.reduce((sum, row) => sum + row.tool_failures, 0);
  const freshness = [...legacy.map(row => row.updated_at), ...rows.map(row => row.updated_at)].reduce<Date | null>((latest, date) => !latest || date > latest ? date : latest, null);
  const estimateSource = 'Versioned standard USD rates × complete reported token categories for exact response models. Provider invoices are separate.';
  const costEstimate: Indicator = estimate === null ? unavailable(estimateSource)
    : { amount: estimate.toFixed(8), quality: 'PARTIAL', source: estimateSource + ' Captured model calls only.' };
  return {
    freshness: freshness?.toISOString() ?? null,
    coverage: { truncated: truncated || extendedTruncated, outsideRetention: period.from < oldest, ledgerAvailable }, calls: { requests, inputSamples, outputSamples, successes, pricedRequests,
      meanLatency: requests ? Math.round(duration / requests) : null }, chats: { web, channels, observed: web + channels },
    toolCalls, toolFailures, costEstimate,
    daily: [...byDay].map(([day, values]) => ({ day, ...values })),
    models: [...groups.values()].sort((a, b) => b.usage.requests - a.usage.requests),
    legacy: modelUsage(interpretations).map(({ model, surface, requests, inputTokens, outputTokens, usageSamples }) =>
      ({ model, surface, requests, inputTokens, outputTokens, usageSamples })),
  };
}
export type AiEconomics = Awaited<ReturnType<typeof readAiEconomics>>;
