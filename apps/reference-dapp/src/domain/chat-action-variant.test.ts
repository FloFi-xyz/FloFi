// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { chatActionVariant } from './chat-action-variant';
import { conversationCopy } from './conversation-copy';
import { ASSIST_COPY } from './copilot-assist';
import { learningCopy } from './copilot-learning-copy';
import { translate } from '../i18n/translate';
import { walletNetworkTarget } from '../state/wallet-connection';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { NETWORKS } from './network-registry';
import { setActiveNetworkScope } from './network-scope';

describe('chatActionVariant: how a FloFi chat answer looks (presentation only)', () => {
  for (const language of ['EN', 'PT'] as const) {
    const c = conversationCopy(language), a = ASSIST_COPY[language], l = learningCopy(language);
    it(`${language}: FloFi's next lifecycle step is primary`, () => {
      for (const label of [c.review, c.addAnother, c.confirmYes, c.executeYes, c.continueYes, c.continueAccept, c.applyEdit, c.checkStatus, c.startNew,
        a.resumeOption, a.confirmOption, a.recipientSaveOption, translate(language, 'Connect wallet'), translate(language, 'Switch to {0}', 'Base')]) {
        expect([label, chatActionVariant(label)]).toEqual([label, 'primary']);
      }
    });
    it(`${language}: undo, discard and delete are destructive`, () => {
      for (const label of [c.undo, c.discardEdit, l.forgetAllOptions[0]]) expect([label, chatActionVariant(label)]).toEqual([label, 'destructive']);
    });
    it(`${language}: declines and every other answer stay secondary choices`, () => {
      for (const label of [c.confirmNo, c.executeNo, c.modify, a.recipientNotNowOption, l.forgetAllOptions[1]]) expect([label, chatActionVariant(label)]).toEqual([label, 'secondary']);
    });
  }
  it('a network switch is primary only for a destination FloFi itself offers (`walletNetworkTarget`, as in app-shell), in either language', () => {
    const chains = [...new Set([...NETWORKS.map(network => network.chain), ...EVM_WALLET_NETWORKS.map(network => network.chain)])];
    const offered = new Set<string>();
    try {
      for (const scope of ['ENGINEERING', 'PUBLIC_MAINNET'] as const) {
        setActiveNetworkScope(scope);
        for (const chain of chains) { const target = walletNetworkTarget(chain); if (target) offered.add(target.label); }
      }
    } finally { setActiveNetworkScope(null); }
    expect([...offered]).toEqual(expect.arrayContaining(['Base', 'Ethereum', 'Solana', 'Robinhood Chain']));
    for (const name of offered) for (const language of ['EN', 'PT'] as const) {
      const label = translate(language, 'Switch to {0}', name);
      expect([label, chatActionVariant(label)]).toEqual([label, 'primary']);
    }
    for (const label of ['Switch to anything', 'Trocar para qualquer coisa', 'Switch to Base and send everything', 'Switch to base', 'Switch to Optimism',
      'Switch to Arbitrum Sepolia', translate('PT', 'Switch to {0}', 'my wallet')]) expect([label, chatActionVariant(label)]).toEqual([label, 'secondary']);
  });
  it('treats unknown, model-written and partial labels as secondary choices', () => {
    for (const label of ['USDC', 'Base → Arbitrum One', 'Step 2: Swap', 'Alice', '', 'Switch to ', 'Trocar para ', 'Switch to anything', 'Review', 'Review workflow now']) {
      expect([label, chatActionVariant(label)]).toEqual([label, 'secondary']);
    }
    expect(chatActionVariant('  Review workflow ')).toBe('primary');
  });
});
