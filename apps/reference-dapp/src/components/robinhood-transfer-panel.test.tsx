// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-7702-TRANSFER-001 (review round 2): a reconciled transfer offers its Evidence Bundle whether the owner's wallet sent it directly or
 * MetaMask relayed it for the owner's Smart Account; the relayed result says the relayer paid the network fee and the owner paid none and kept
 * their nonce, in either language. Presentation only: the record comes from the transfer store as it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RobinhoodTransferPanel } from './robinhood-transfer-panel';
import { LocaleProvider } from '../i18n/locale';

const s = vi.hoisted(() => ({ run: null as unknown }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: { nodes: [] } } }) }));
vi.mock('../state/robinhood-transfer-store', () => ({ useRobinhoodTransfer: () => s.run }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => ({ account: null, chainId: null }) }));

const RELAYER = '0x' + 'c'.repeat(40);
const direct = { nonceBefore: '7', nonceAfter: '8', blockNumber: '123', fee: '21000000000000', balanceBefore: '1000000000000000000', balanceAfter: '999979000000000000' };
const relayed = { ...direct, nonceAfter: '7', submission: 'RELAYED', gasPayer: RELAYER, networkFee: '42000000000000' };
function reconciled(facts: Record<string, unknown>) {
  const record = { evidence: { bundle: { environment: 'ROBINHOOD_MAINNET' }, proof: 'evidence-of-this-transfer' }, verdict: 'MATCHED', authorization: null,
    attempt: { reconciled: true, state: 'RECONCILED', transactionHash: '0x' + 'a'.repeat(64) }, observations: [{ facts }], journal: { entries: [] } };
  s.run = { record, error: null, busy: false, retired: false };
  return record;
}
const page = (language: 'EN' | 'PT') => renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language,
  children: createElement(RobinhoodTransferPanel, { view: 'execute' }) }));
const evidenceLink = (html: string) => /<a download="flofi-rh-demo-001-evidence\.json" href="data:application\/json;charset=utf-8,([^"]+)">([^<]+)<\/a>/.exec(html);

beforeEach(() => { s.run = null; });

describe('a reconciled Smart Account transfer', () => {
  it('relayed by MetaMask: offers the same Evidence Bundle as a direct transfer and says the owner paid no fee and kept their nonce', () => {
    const record = reconciled(relayed), html = page('EN');
    expect(html).toContain(`Transfer reconciled. MetaMask relayed it for your Smart Account: the relayer ${RELAYER} paid the network fee (0.000042 ETH); you paid no network fee and this transfer did not use your nonce.`);
    const link = evidenceLink(html);
    expect(link?.[2]).toBe('Download Evidence Bundle'); expect(JSON.parse(decodeURIComponent(link![1]!.replaceAll('&quot;', '"')))).toEqual(record.evidence);
    expect(html).not.toContain('Exactly one owner-signed transaction'); expect(html).not.toContain('Download execution record');
  });
  it('sent directly: unchanged (owner-signed result and the Evidence Bundle)', () => {
    reconciled(direct); const html = page('EN');
    expect(html).toContain('Transfer reconciled. Exactly one owner-signed transaction, nonce 7 → 8');
    expect(evidenceLink(html)?.[2]).toBe('Download Evidence Bundle'); expect(html).not.toContain('MetaMask relayed it');
  });
  it('in Portuguese the relayed result says it is you who paid no network fee', () => {
    reconciled(relayed); const html = page('PT');
    expect(html).toContain(`Transferência reconciliada. A MetaMask a retransmitiu pela sua Smart Account: o retransmissor ${RELAYER} pagou a taxa de rede (0.000042 ETH); você não pagou nenhuma taxa de rede e esta transferência não usou o seu nonce.`);
    expect(evidenceLink(html)).not.toBeNull();
  });
});
