// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinancialOutcome } from './financial-outcome';
import type { ExecutionLifecycle } from '../domain/execution-lifecycle';
import { LocaleProvider } from '../i18n/locale';
const progress = (values: { label: string; value: string }[] = []) => ({ steps: [{ id: 'bridge', action: 'Bridge', network: 'Base → Arbitrum', input: 'Quoted 1 USDC', operations: [{ id: 'destination' }] }], evidence: { operations: { destination: { values } }, knownCosts: [], attention: [] } }) as unknown as ExecutionLifecycle;
it('keeps unavailable destination amounts unknown and never substitutes the quote', () => {
  const html = renderToStaticMarkup(<FinancialOutcome progress={progress()}/>);
  expect(html).toContain('Destination amount not confirmed'); expect(html).not.toContain('Quoted 1 USDC'); expect(html).not.toContain('0 USDC');
});
it('shows precise recorded output, independent of quoted input, with bilingual labels', () => {
  const data = progress([{ label: 'Actual received', value: '0.988966 USDC' }]);
  const html = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><FinancialOutcome progress={data}/></LocaleProvider>);
  expect(html).toContain('0.988966 USDC'); expect(html).toContain('Resultado financeiro'); expect(html).not.toContain('Destination amount not confirmed');
});
