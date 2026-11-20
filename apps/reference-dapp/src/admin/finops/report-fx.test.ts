// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brlOf, readReportFx } from './report-fx.ts';

const now = new Date('2026-11-22T14:00:00Z');
const openPeriod = { from: '2026-11-01', to: '2026-11-23' };
const quote = (day: string, cotacaoVenda: number) => ({ dataHoraCotacao: `${day} 13:11:01.100`, cotacaoVenda });
const friday = quote('2026-11-20', 5.41234), thursday = quote('2026-11-19', 5.402), octoberClose = quote('2026-10-30', 5.3);

function fixture() {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://olinda.bcb.gov.br');
    expect(url.pathname).toContain('CotacaoDolarPeriodo(');
    const cutoff = url.searchParams.get('@dataFinalCotacao');
    switch (cutoff) {
      case "'11-21-2026'":
        expect(url.searchParams.get('@dataInicial')).toBe("'11-17-2026'");
        return Response.json({ value: [friday, thursday] });
      case "'11-19-2026'": return Response.json({ value: [thursday] });
      case "'10-31-2026'": return Response.json({ value: [octoberClose] });
      default: throw new Error('Unexpected PTAX fixture cutoff');
    }
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Investor Reporting PTAX references', () => {
  it('uses a shared indicative weekend cutoff and the latest available observation', async () => {
    const fetcher = fixture();
    const fx = await readReportFx(openPeriod, now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fx.selected).toEqual(fx.indicative);
    expect(fx.indicative).toEqual({ asOf: '2026-11-21', policy: 'current-indicative',
      quote: { rate: '5.41234', publishedAt: friday.dataHoraCotacao } });
    expect(fx.previous).toEqual({ asOf: '2026-10-31', policy: 'historical-period-close',
      quote: { rate: '5.3', publishedAt: octoberClose.dataHoraCotacao } });
    expect(brlOf('0.17676573', fx.selected)).toBe('0.9567162311082');
    expect(brlOf('-0.17676573', fx.selected)).toBe('-0.9567162311082');
    expect(brlOf('0', fx.selected)).toBe('0');
    expect(brlOf(null, fx.selected)).toBeNull();
  });

  it('uses the last included UTC day for a closed selection', async () => {
    const fetcher = fixture();
    const fx = await readReportFx({ from: '2026-11-14', to: '2026-11-20' }, now, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fx.selected).toEqual({ asOf: '2026-11-19', policy: 'historical-period-close',
      quote: { rate: '5.402', publishedAt: thursday.dataHoraCotacao } });
    expect(fx.indicative.quote?.rate).toBe('5.41234');
  });

  it.each([
    { value: [], description: 'no published quote' },
    { value: [quote('2026-11-16', 5.4)], description: 'a stale quote' },
    { value: [quote('2026-11-22', 5.4)], description: 'a future quote' },
    { value: [friday, quote('2026-11-20', 5.5)], description: 'conflicting quotes' },
    { value: [quote('2026-11-20', 0)], description: 'a non-positive rate' },
  ])('does not produce BRL when the fixture has $description', async ({ value }) => {
    const fx = await readReportFx(openPeriod, now, async () => Response.json({ value }));
    expect(fx.selected.quote).toBeNull();
    expect(brlOf('5', fx.selected)).toBeNull();
  });

  it('blocks network reads in the loopback harness and supports injected fixtures there', async () => {
    vi.stubEnv('FLOFI_ADMIN_E2E', 'LOOPBACK_ONLY');
    vi.stubEnv('FLOFI_ENGINEERING_UI', 'LOOPBACK_ONLY');
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', network);
    expect((await readReportFx(openPeriod, now)).selected.quote).toBeNull();
    expect(network).not.toHaveBeenCalled();
    expect((await readReportFx(openPeriod, now, fixture())).selected.quote?.rate).toBe('5.41234');
    expect(network).not.toHaveBeenCalled();
  });
});
