// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the platform guide points only to real FloFi screens and never applies a change on a chat channel or MCP. */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchPlatformTopic, platformAnswer, platformGuide, PLATFORM_PATHS, PLATFORM_TOPICS } from './platform-guide';
import { secondaryWorkspaceRoute } from '../secondary-workspaces';
import { dashboardRoute } from '../../lib/dashboard/routes';

const APP = new URL('../../app/', import.meta.url);
describe('platform guide', () => {
  it('links only to pages that exist in the app router', () => {
    for (const [key, path] of Object.entries(PLATFORM_PATHS)) {
      const routed = path === '/app' || path === '/connections' || secondaryWorkspaceRoute(path) !== null || dashboardRoute(path) !== null;
      expect([key, routed]).toEqual([key, true]);
      const page = new URL(`(product)${path}/page.tsx`, APP);
      expect([path, existsSync(page)]).toEqual([path, true]);
    }
  });
  it('recognizes the owner\'s configuration questions in PT and EN', () => {
    const cases: [string, string][] = [['Como conecto minha Phantom?', 'CONNECT_WALLET'], ['Quero usar minha MetaMask.', 'CONNECT_WALLET'],
      ['Onde vejo minhas automações?', 'AUTOMATIONS'], ['Como revogo uma autorização?', 'AUTHORIZATIONS'], ['Quero salvar uma carteira como favorita.', 'SAVED_WALLETS'],
      ['Como vejo as transações anteriores?', 'HISTORY'], ['Não quero mais receber essas notificações.', 'NOTIFICATIONS'], ['Quais redes vocês suportam?', 'SUPPORTED_NETWORKS'],
      ['how do I connect my wallet?', 'CONNECT_WALLET'], ['where can I see my automations?', 'AUTOMATIONS'], ['how do I delete my account?', 'DELETE_ACCOUNT'],
      ['Quero mudar a configuração dessa automação.', 'AUTOMATIONS'], ['onde ficam meus destinatários salvos?', 'SAVED_RECIPIENTS']];
    for (const [text, topic] of cases) expect([text, matchPlatformTopic(text)]).toEqual([text, topic]);
    // Requests are not configuration questions.
    expect(matchPlatformTopic('swap 1 ETH to USDC on Base')).toBeNull();
    // A question about the user's own workflow is answered from its canonical facts (eval Q11), not by FloFi's guide.
    expect(matchPlatformTopic('Which networks does this use?')).toBeNull();
    expect(matchPlatformTopic('quais redes meu fluxo usa?')).toBeNull();
    expect(matchPlatformTopic('which networks are supported?')).toBe('SUPPORTED_NETWORKS');
    expect(matchPlatformTopic('envia 10 USDC para 0x1111111111111111111111111111111111111111')).toBeNull();
    expect(matchPlatformTopic('quero mandar 5 USDC para minha carteira')).toBeNull();
  });
  it('never applies a change outside the web app, and every answer is complete in both languages', () => {
    for (const topic of PLATFORM_TOPICS) for (const language of ['EN', 'PT'] as const) {
      const answer = platformAnswer(topic, language, 'TELEGRAM');
      expect(answer.modes).not.toContain('APPLY_CHANGE');
      expect(answer.text.length).toBeGreaterThan(60);
      if (answer.link) expect(Object.values(PLATFORM_PATHS)).toContain(answer.link.path);
    }
    expect(platformGuide('EN').every(entry => !entry.modes.includes('APPLY_CHANGE') && !entry.modes.includes('PREPARE_CHANGE'))).toBe(true);
    expect(platformAnswer('SAVED_RECIPIENTS', 'PT', 'WEB').modes).toContain('APPLY_CHANGE');
    expect(platformAnswer('SUPPORTED_NETWORKS', 'EN').text).toMatch(/Base/);
  });
});
