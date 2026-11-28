// SPDX-License-Identifier: AGPL-3.0-only
/** The FloFi fee row of a completed execution: nothing while collection is inactive, the amount with Pay when due and active, "Paid" after. */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../i18n/locale';
import { PlatformFeeLine } from './platform-fee-line';

const f = vi.hoisted(() => ({ status: null as unknown, pay: vi.fn(), seen: [] as unknown[] }));
vi.mock('../state/platform-fee-settlement', () => ({ usePlatformFeeSettlement: (execution: unknown) => { f.seen.push(execution); return { status: f.status, busy: false, error: null, pay: f.pay }; } }));

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const line = { chainId: 'eip155:8453', address: NATIVE, decimals: 18, principal: '100000000000000000', fee: '800000000000000' };
const status = (over: { active?: boolean; state?: string | null; attention?: boolean } = {}) => ({ policyId: 'p', rateBps: 80, collection: { active: over.active ?? true, code: null },
  authorized: { status: 'FEEABLE', lines: [line], basisSha256: 'x' },
  ledger: over.state === null ? null : { state: over.state ?? 'DUE', lines: [line], transfers: [], transactions: [], code: null, attention: over.attention ?? false } });
const html = (language: 'EN' | 'PT' = 'EN', runKey = 'run-1') => renderToStaticMarkup(<LocaleProvider initialLanguage={language}><PlatformFeeLine runKey={runKey}/></LocaleProvider>);

describe('PlatformFeeLine', () => {
  it('renders nothing while collection is not active', () => {
    f.status = status({ active: false }); expect(html()).toBe('');
    f.status = null; expect(html()).toBe('');
  });
  it('shows the fee with a Pay button when collection is active and the fee is due, in English and Portuguese', () => {
    f.status = status();
    expect(html('EN')).toContain('FloFi fee (0.80%)'); expect(html('EN')).toContain('0.0008 ETH'); expect(html('EN')).toContain('>Pay</button>');
    expect(html('PT')).toContain('Taxa FloFi (0,80%)'); expect(html('PT')).toContain('0,0008 ETH'); expect(html('PT')).toContain('>Pagar</button>');
    f.status = status({ state: 'COLLECTION_FAILED' }); expect(html()).toContain('>Pay</button>');
  });
  it('offers no Pay while attention is required, pending, or already collected, and shows Paid after payment', () => {
    f.status = status({ attention: true }); expect(html()).not.toContain('<button');
    f.status = status({ state: 'COLLECTION_PENDING' }); expect(html()).not.toContain('<button');
    f.status = status({ state: 'COLLECTED' }); expect(html('EN')).toContain('Paid'); expect(html('PT')).toContain('Paga'); expect(html()).not.toContain('<button');
  });
  it('names the execution by run id or workflow run id, and nothing for an unknown id shape', () => {
    f.seen = []; f.status = status();
    html('EN', 'run-1'); html('EN', 'wfr_' + 'a'.repeat(26)); html('EN', 'bad id');
    expect(f.seen).toEqual([{ runId: 'run-1' }, { workflowRunId: 'wfr_' + 'a'.repeat(26) }, null]);
  });
});
