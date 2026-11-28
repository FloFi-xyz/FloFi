// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R06/R07): a delegated automation's execution history reads every spent and received amount at six
 * significant digits ("≈" before the sign when shortened, PT with its decimal comma), the exact recorded amount one tap away. Rendering calls no
 * server action.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExecutionView } from '../delegation/views';

vi.mock('../app/delegation-action', () => {
  const never = async () => { throw new Error('NOT_CALLED_BY_RENDER'); };
  return { authorizationReview: never, authorizationRevoke: never, authorizationSign: never, delegatedAutomationCreate: never, delegatedAutomationPreview: never,
    delegationEnabled: never, delegationOverview: never };
});
vi.mock('./delegation-browser', () => ({ assertPasskey: vi.fn(), passkeysSupported: () => false }));
const { ExecutionRow } = await import('./delegated-automations');
const { LocaleProvider } = await import('../i18n/locale');

const execution = (spent: string, received: string): ExecutionView => ({ executionId: 'exe-1', authorizationId: 'auth-1', revision: 1, ruleId: 'rule-1', occurrenceId: 'occ-1',
  workflowRunId: null, state: 'SETTLED', code: null, attention: false, currentStep: 0, stepCount: 1, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:01:00.000Z',
  settledAt: '2026-11-20T10:01:00.000Z', evidenceLevel: null, steps: [{ step: 0, state: 'SETTLED', chain: 'eip155:8453', network: 'Base', credentialId: 'credential-0001',
    grantId: 'grant-0001', mechanism: 'EVM', grantCommitment: 'commitment', submissions: [], code: null, provenance: null,
    spent: [{ asset: 'eip155:8453/erc20:usdc', symbol: 'USDC', chain: 'eip155:8453', amount: spent }],
    received: [{ asset: 'eip155:8453/slip44:60', symbol: 'ETH', chain: 'eip155:8453', amount: received }] }] });
const render = (e: ExecutionView, language: 'EN' | 'PT' = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(ExecutionRow, { e }) }));

describe('delegated automation history amounts', () => {
  it('reads six significant digits with the exact amount one tap away, never the recorded 18 digits', () => {
    const html = render(execution('25', '0.057923834925903535'));
    expect(html).toContain(' · −25 USDC'); expect(html).toContain('>≈ +0.0579238 ETH</button>');
    expect(html).toContain('title="+0.057923834925903535 ETH"'); expect(html).not.toMatch(/>\+?0\.057923834925903535 ETH</);
  });
  it('PT uses the decimal comma; no trailing zeros; a tiny amount never reads 0', () => {
    expect(render(execution('0.040000000000000000', '0.039961699395000574'), 'PT')).toContain('>≈ +0,0399617 ETH</button>');
    expect(render(execution('0.040000000000000000', '0.000000123456789'))).toContain(' · −0.04 USDC');
    expect(render(execution('1', '0.000000123456789'))).toContain('>≈ +0.000000123457 ETH</button>');
  });
});
