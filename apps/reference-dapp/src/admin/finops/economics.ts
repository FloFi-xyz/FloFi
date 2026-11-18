// SPDX-License-Identifier: AGPL-3.0-only

export const DAY_MS = 86_400_000;
const SCALE = 100_000_000n;
const UNITS = /^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;
export const FINOPS_ENVIRONMENTS = ['production', 'shared', 'preview', 'development'] as const;
export const FINOPS_PERIODS = ['current', 'previous', '7d', '30d', 'custom'] as const;
export type Period = { from: string; to: string };
export type PeriodFilter = { preset: (typeof FINOPS_PERIODS)[number]; period: Period; valid: boolean };
export type Quality = 'VERIFIED' | 'METERED' | 'ESTIMATED' | 'PARTIAL' | 'UNAVAILABLE';

type Category = 'infrastructure' | 'ai' | 'external' | 'sponsorship' | 'relayer' | 'operating' | 'revenue';
type Scope = { readonly provider: string; readonly name: string; readonly category: Category; readonly variable: boolean; readonly required: boolean };
const scope = (provider: string, name: string, category: Category, variable = false, required = true): Scope =>
  ({ provider, name, category, variable, required });

/** Register a separate scope when a provider invoice bills two economically distinct FloFi services. */
export const FINOPS_SCOPES = {
  'neon-postgres': scope('Neon', 'PostgreSQL', 'infrastructure'),
  'neon-storage': scope('Neon', 'Object Storage and related services', 'infrastructure'),
  'railway-api': scope('Railway', 'flofi-api', 'infrastructure'),
  'railway-worker': scope('Railway', 'flofi-worker', 'infrastructure'),
  'vercel': scope('Vercel', 'FloFi web', 'infrastructure'),
  'circleci': scope('CircleCI', 'FloFi certification', 'infrastructure'),
  'openai': scope('OpenAI', 'FloFi project', 'ai', true),
  'anthropic': scope('Anthropic', 'FloFi workspace', 'ai', true),
  'rpc': scope('RPC providers', 'Mainnet endpoints', 'external', true),
  'defi-api': scope('DeFi API providers', 'Routes, quotes and external APIs', 'external', true),
  'gas-sponsorship': scope('Gas sponsorship', 'FloFi-paid sponsorship', 'sponsorship', true),
  'relayer': scope('Relayers', 'FloFi-paid relay charges', 'relayer', true),
  'resend': scope('Resend', 'Email delivery', 'operating', true),
  'domain': scope('Domain and DNS', 'FloFi domain and DNS', 'operating'),
  'other-ai': scope('Other AI providers', 'FloFi AI usage', 'ai', true, false),
  'other-infrastructure': scope('Other infrastructure', 'FloFi shared infrastructure', 'infrastructure', false, false),
  'other-operating': scope('Other providers', 'FloFi operational expenses', 'operating', true, false),
  'fee-revenue': scope('FloFi', 'Reconciled platform fee revenue', 'revenue'),
} satisfies Record<string, Scope>;
export type ScopeId = keyof typeof FINOPS_SCOPES;
export const scopeIds = Object.keys(FINOPS_SCOPES) as ScopeId[];
export const isScopeId = (value: unknown): value is ScopeId => typeof value === 'string' && Object.hasOwn(FINOPS_SCOPES, value);
export const ENTRY_SOURCES = ['INVOICE', 'USAGE', 'ASSUMPTION', 'ACCOUNTING'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];
type LedgerSource = EntrySource | 'PROVIDER_COST';
const priority: Record<LedgerSource, number> = { INVOICE: 4, ACCOUNTING: 4, PROVIDER_COST: 3, USAGE: 2, ASSUMPTION: 1 };
const qualityFor: Record<LedgerSource, Quality> = {
  INVOICE: 'VERIFIED', ACCOUNTING: 'VERIFIED', PROVIDER_COST: 'VERIFIED', USAGE: 'METERED', ASSUMPTION: 'ESTIMATED',
};
export type Entry = {
  scope: ScopeId;
  environment: (typeof FINOPS_ENVIRONMENTS)[number];
  period: Period;
  source: LedgerSource;
  reference: string;
  currency: string;
  net: string;
  gross: string | null;
  credits: string | null;
  discounts: string | null;
  taxes: string | null;
  fxUsd: string | null;
  fxSource: string | null;
  coverage: 'FULL' | 'PARTIAL';
  notes: string | null;
};
export type LedgerRecord = Entry & { id: string; updatedAt: string };
export type Indicator = { amount: string | null; quality: Quality; source: string };
export type ScopeTotal = { id: ScopeId; amount: string | null; quality: Quality; complete: boolean; updatedAt: string | null; sources: LedgerSource[] };

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.some(item => item === value);
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export function validDay(input: unknown): input is string {
  if (typeof input !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(input)) return false;
  const date = new Date(input + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && isoDay(date) === input;
}
const stamp = (day: string) => Date.parse(day + 'T00:00:00Z');
export const addDays = (day: string, days: number) => isoDay(new Date(stamp(day) + days * DAY_MS));
export const periodDays = ({ from, to }: Period) => (stamp(to) - stamp(from)) / DAY_MS;
export const intersects = (a: Period, b: Period) => a.from < b.to && b.from < a.to;
export const contains = (outer: Period, inner: Period) => outer.from <= inner.from && inner.to <= outer.to;

export function finopsPeriod(now: Date, params: { range?: unknown; from?: unknown; to?: unknown }): PeriodFilter {
  const today = isoDay(now), to = addDays(today, 1), first = today.slice(0, 7) + '-01';
  const current = { from: first, to };
  switch (params.range) {
    case undefined: case 'current': return { preset: 'current', period: current, valid: true };
    case 'previous': return { preset: 'previous', period: { from: addDays(first, -1).slice(0, 7) + '-01', to: first }, valid: true };
    case '7d': return { preset: '7d', period: { from: addDays(today, -6), to }, valid: true };
    case '30d': return { preset: '30d', period: { from: addDays(today, -29), to }, valid: true };
    case 'custom': {
      const { from, to: last } = params;
      if (!validDay(from) || !validDay(last) || from > last || last > today) break;
      const period = { from, to: addDays(last, 1) };
      if (periodDays(period) <= 366) return { preset: 'custom', period, valid: true };
      break;
    }
  }
  return { preset: 'current', period: current, valid: false };
}
export const endOfMonth = (now: Date) => isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

export function units(value: string): bigint {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, '0'))) * (value.startsWith('-') ? -1n : 1n);
}
export function decimal(value: bigint): string {
  const positive = value < 0n ? -value : value;
  const fraction = (positive % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return (value < 0n ? '-' : '') + String(positive / SCALE) + (fraction ? '.' + fraction : '');
}
export function divide(numerator: bigint, denominator: bigint): bigint {
  const magnitude = numerator < 0n ? -numerator : numerator;
  return ((magnitude + denominator / 2n) / denominator) * (numerator < 0n ? -1n : 1n);
}

export class FinopsValidationError extends Error {
  constructor(readonly field: string) { super('FINOPS_ENTRY_INVALID'); }
}
function amount(input: unknown, field: string, required = false): string | null {
  if (!required && [undefined, null, ''].includes(input as undefined)) return null;
  if (typeof input !== 'string' || !UNITS.test(input)) throw new FinopsValidationError(field);
  return decimal(units(input));
}
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,79}$/;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
function text(input: unknown, field: string, pattern: RegExp, required = false): string | null {
  if (!required && [undefined, null, ''].includes(input as undefined)) return null;
  if (typeof input !== 'string' || !pattern.test(input.trim())) throw new FinopsValidationError(field);
  return input.trim();
}

export function validateEntry(input: Record<string, unknown>, providerSource = false): Entry {
  const { scope: id, environment, start, end, currency, source, coverage } = input;
  if (!isScopeId(id)) throw new FinopsValidationError('scope');
  if (!oneOf(FINOPS_ENVIRONMENTS, environment)) throw new FinopsValidationError('environment');
  if (!validDay(start) || !validDay(end) || start >= end || periodDays({ from: start, to: end }) > 366) throw new FinopsValidationError('period');
  if (typeof currency !== 'string' || !CURRENCIES.has(currency)) throw new FinopsValidationError('currency');
  if (!oneOf(ENTRY_SOURCES, source) && !(source === 'PROVIDER_COST' && providerSource)) throw new FinopsValidationError('source');
  if ((source === 'ACCOUNTING') !== (FINOPS_SCOPES[id].category === 'revenue')) throw new FinopsValidationError('source');
  if (coverage !== 'FULL' && coverage !== 'PARTIAL') throw new FinopsValidationError('coverage');
  const net = amount(input.net, 'net', true)!;
  const gross = amount(input.gross, 'gross'), credits = amount(input.credits, 'credits');
  const discounts = amount(input.discounts, 'discounts'), taxes = amount(input.taxes, 'taxes');
  const components = [credits, discounts, taxes];
  if (components.some(value => value !== null && units(value) < 0n) || gross !== null && units(gross) < 0n) throw new FinopsValidationError('components');
  // Partial invoice detail is permitted and displayed as such. Check the arithmetic when every component is supplied.
  if (gross !== null && credits !== null && discounts !== null && taxes !== null &&
    units(net) !== units(gross) - units(credits) - units(discounts) + units(taxes)) throw new FinopsValidationError('net');
  const fxUsd = amount(input.fxUsd, 'fxUsd'), fxSource = text(input.fxSource, 'fxSource', REFERENCE);
  if (Boolean(fxUsd) !== Boolean(fxSource) || fxUsd !== null && (units(fxUsd) <= 0n || currency === 'USD')) throw new FinopsValidationError('fxUsd');
  return { scope: id, environment, period: { from: start, to: end }, source, currency, net, gross, credits, discounts, taxes, fxUsd, fxSource, coverage,
    reference: text(input.reference, 'reference', REFERENCE, true)!, notes: text(input.notes, 'notes', /^[^\p{Cc}]{1,400}$/u) };
}

export const entryQuality = (entry: Entry): Quality => entry.coverage === 'PARTIAL' || usdOf(entry) === null ? 'PARTIAL' : qualityFor[entry.source];
export const usdOf = (entry: Entry): bigint | null => entry.currency === 'USD' ? units(entry.net)
  : entry.fxUsd === null ? null : divide(units(entry.net) * units(entry.fxUsd), SCALE);

/** Higher-authority whole records supersede overlapping lower-authority rows. Indivisible rows are never prorated. */
export function selectRecords(records: readonly LedgerRecord[]): LedgerRecord[] {
  const selected: LedgerRecord[] = [];
  const sorted = [...records].sort((a, b) => priority[b.source] - priority[a.source] || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  const byScope = new Map<string, LedgerRecord[]>();
  for (const row of sorted) {
    const key = row.scope + '/' + row.environment, group = byScope.get(key) ?? [];
    if (group.some(existing => intersects(existing.period, row.period))) continue;
    group.push(row);
    byScope.set(key, group);
    selected.push(row);
  }
  return selected;
}

function covers(period: Period, entries: readonly LedgerRecord[]): boolean {
  let covered = period.from;
  for (const entry of [...entries].sort((a, b) => a.period.from.localeCompare(b.period.from))) {
    if (entry.period.from > covered) return false;
    if (entry.period.to > covered) covered = entry.period.to;
  }
  return covered >= period.to;
}
function qualityOf(qualities: readonly Quality[]): Quality {
  if (qualities.includes('PARTIAL') || qualities.includes('UNAVAILABLE')) return 'PARTIAL';
  if (qualities.includes('ESTIMATED')) return 'ESTIMATED';
  if (qualities.includes('METERED')) return 'METERED';
  return 'VERIFIED';
}

export function totalsFor(records: readonly LedgerRecord[], period: Period, completeRead: boolean): ScopeTotal[] {
  const selected = selectRecords(records.filter(row => intersects(row.period, period)));
  return scopeIds.map(id => {
    const overlapping = selected.filter(row => row.scope === id);
    const contained = overlapping.filter(row => contains(period, row.period));
    const converted = contained.flatMap(row => { const usd = usdOf(row); return usd === null ? [] : [usd]; });
    // Preview/development are FloFi expenses too, but cannot certify missing production/shared coverage.
    const required = contained.filter(row => row.coverage === 'FULL' && (row.environment === 'production' || row.environment === 'shared'));
    const complete = completeRead && converted.length === contained.length && contained.length === overlapping.length && covers(period, required);
    return { id, amount: converted.length ? decimal(converted.reduce((a, b) => a + b, 0n)) : null,
      quality: converted.length ? complete ? qualityOf(contained.map(entryQuality)) : 'PARTIAL' : 'UNAVAILABLE',
      complete, updatedAt: overlapping.map(row => row.updatedAt).sort().at(-1) ?? null, sources: [...new Set(contained.map(row => row.source))] };
  });
}

export function consolidate(totals: readonly ScopeTotal[], predicate: (scope: Scope) => boolean, source: string): Indicator {
  const included = totals.filter(record => {
    const spec = FINOPS_SCOPES[record.id];
    return predicate(spec) && (spec.required || record.amount !== null || record.updatedAt !== null);
  });
  const amounts = included.flatMap(item => item.amount === null ? [] : [units(item.amount)]);
  return { amount: amounts.length ? decimal(amounts.reduce((a, b) => a + b, 0n)) : null,
    quality: amounts.length ? qualityOf(included.map(item => item.quality)) : 'UNAVAILABLE', source };
}

export const unavailable = (source: string): Indicator => ({ amount: null, quality: 'UNAVAILABLE', source });
export function perUnit(total: Indicator, count: number, source: string, completeDenominator: boolean): Indicator {
  return total.amount === null || !Number.isSafeInteger(count) || count <= 0 ? unavailable(source)
    : { amount: decimal(divide(units(total.amount), BigInt(count))), quality: completeDenominator ? total.quality : 'PARTIAL', source };
}
export function difference(revenue: Indicator, costs: Indicator, source: string): Indicator {
  // A margin on incomplete expenses would bias the result, so require both sides.
  if (revenue.amount === null || costs.amount === null ||
    !['VERIFIED', 'METERED', 'ESTIMATED'].includes(revenue.quality) || !['VERIFIED', 'METERED', 'ESTIMATED'].includes(costs.quality)) return unavailable(source);
  return { amount: decimal(units(revenue.amount) - units(costs.amount)), quality: qualityOf([revenue.quality, costs.quality]), source };
}
