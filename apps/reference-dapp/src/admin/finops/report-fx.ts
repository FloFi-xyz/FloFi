// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, isoDay, scaledDecimal, units, validDay, type Period } from './economics.ts';
import { financialJson, financialObject, requestFinancial } from './sync-transport.ts';

export const PTAX_SOURCE = 'Banco Central do Brasil · PTAX sell rate';
export const PTAX_REFERENCE = 'https://dadosabertos.bcb.gov.br/pt_BR/dataset/dolar-americano-usd-todos-os-boletins-diarios';
const ENDPOINT = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)';
type Quote = { readonly rate: string; readonly publishedAt: string };
export type ReportFx = { readonly asOf: string; readonly policy: 'current-indicative' | 'historical-period-close'; readonly quote: Quote | null };

async function ptax(asOf: string, fetcher: typeof fetch): Promise<Quote | null> {
  const from = addDays(asOf, -4);
  const dateArgument = (day: string) => "'" + day.slice(5) + '-' + day.slice(0, 4) + "'";
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ '@dataInicial': dateArgument(from), '@dataFinalCotacao': dateArgument(asOf),
    '$select': 'cotacaoVenda,dataHoraCotacao', '$format': 'json' }).toString();
  try {
    const result = financialJson(await requestFinancial(url, {}, fetcher, AbortSignal.timeout(3_000), 12_000));
    if (!financialObject(result)) return null;
    const { value } = result;
    if (!Array.isArray(value) || value.length > 5) return null;
    const days = new Set<string>();
    const quotes: Quote[] = [];
    for (const row of value) {
      if (!financialObject(row)) return null;
      const { dataHoraCotacao: publishedAt, cotacaoVenda: rate } = row;
      if (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(publishedAt)
        || typeof rate !== 'number' || !/^\d{1,5}(?:\.\d{1,5})?$/.test(String(rate)) || rate <= 0) return null;
      const day = publishedAt.slice(0, 10);
      if (!validDay(day) || day < from || day > asOf || days.has(day)) return null;
      days.add(day);
      quotes.push({ rate: String(rate), publishedAt });
    }
    return quotes.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1) ?? null;
  } catch { return null; }
}

/** Keep the indicative cutoff fixed throughout a UTC day, using completed PTAX observation days only. */
export async function readReportFx(period: Period, now: Date, fetcher?: typeof fetch) {
  const today = isoDay(now), indicativeAsOf = addDays(today, -1);
  const selectedAsOf = period.to <= today ? addDays(period.to, -1) : indicativeAsOf;
  const previousAsOf = addDays(today.slice(0, 7) + '-01', -1);
  const offline = process.env.FLOFI_ADMIN_E2E === 'LOOPBACK_ONLY' && process.env.FLOFI_ENGINEERING_UI === 'LOOPBACK_ONLY';
  const cutoffs = new Set([indicativeAsOf, selectedAsOf, previousAsOf]);
  // Module callers can inject a fixture. The browser harness has no injectable network path.
  const reads = new Map([...cutoffs].map(day => [day, offline && !fetcher ? Promise.resolve(null) : ptax(day, fetcher ?? fetch)]));
  const rate = async (asOf: string, policy: ReportFx['policy']): Promise<ReportFx> => ({ asOf, policy, quote: await reads.get(asOf) ?? null });
  const [indicative, selected, previous] = await Promise.all([
    rate(indicativeAsOf, 'current-indicative'),
    rate(selectedAsOf, period.to <= today ? 'historical-period-close' : 'current-indicative'),
    rate(previousAsOf, 'historical-period-close'),
  ]);
  return { indicative, selected, previous };
}
export type ReportFxSet = Awaited<ReturnType<typeof readReportFx>>;

/** USD and PTAX are decimal strings. Multiply exactly, leaving presentation rounding to Intl. */
export function brlOf(usd: string | null, fx: ReportFx | undefined): string | null {
  if (usd === null || !fx?.quote) return null;
  const [whole, fraction = ''] = usd.split('.');
  return scaledDecimal(BigInt(whole + fraction) * units(fx.quote.rate), fraction.length + 8);
}
