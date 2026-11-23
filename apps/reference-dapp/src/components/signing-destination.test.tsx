// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (P2): a bridge handed off to /approve (chat, MCP, Telegram) whose receiving wallet is not
 * resolved says so ONCE (the signing status; never again under Simulate), worded for this page — it names the destination network and the
 * kind of wallet, offers what this page can do (connect a wallet of that ecosystem, read the account's wallets again) and sends a choice or a
 * typed address to the Canvas — and never mentions a Bridge card, which /approve does not have. PT and EN.
 *
 * MOCKED: the Review fixture, the wallet and the actions are test doubles; nothing is connected, signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SigningSurface, type SigningSurfaceProps } from './signing-surface';
import { useExecutionControls, type ExecutionControlsState } from '../state/execution-controls';
import { reviewFixture, reviewNow } from '../test-utils/review-fixture';
import { LocaleProvider, type Language } from '../i18n/locale';
import { translate } from '../i18n/translate';
import { DESTINATION_ISSUE, destinationIssueMessage, type DestinationIssue } from '../domain/destination-wallet';

type Destination = Pick<SigningSurfaceProps, 'destinationIssue' | 'destinationLoading' | 'destinationActions' | 'simulationReason'>;
function View({ data, destination }: { data: ExecutionControlsState; destination: Destination }) {
  const controls = useExecutionControls(data);
  return <SigningSurface {...data} {...destination} controls={controls} workflowName="Bridge" gated={false} simulationDisabled simulate={vi.fn()}/>;
}
/** A handed-off bridge before its simulation: nothing reviewed yet, so Simulate is the action and the destination is what blocks it. */
const unsimulated = (): ExecutionControlsState => {
  const fixture = reviewFixture();
  return { ...fixture, authorization: { ...fixture.authorization, key: null, manifest: null, policy: null },
    execution: { ready: false, started: false, start: null, prompt: null, expiresAt: null } };
};
const message = (issue: DestinationIssue, language: Language) => translate(language, destinationIssueMessage(issue, 'approve'), 'Solana', 'Solana');
const escaped = (text: string) => renderToStaticMarkup(<>{text}</>);
/** Where the text is SHOWN (a text node), as opposed to the disabled Simulate button's own description of why it is disabled. */
const occurrences = (html: string, text: string) => html.split(`>${escaped(text)}<`).length - 1;
const described = (html: string, text: string) => html.split(`aria-description="${escaped(text)}"`).length - 1;
function render(issue: DestinationIssue, language: Language = 'EN', actions: Destination['destinationActions'] = null) {
  const shown = message(issue, language);
  return { shown, html: renderToStaticMarkup(<LocaleProvider initialLanguage={language}><View data={unsimulated()} destination={{ destinationIssue: shown,
    destinationLoading: issue === DESTINATION_ISSUE.LOADING, destinationActions: actions, simulationReason: shown }}/></LocaleProvider>) };
}
const actions = (retry: boolean) => ({ connect: { label: 'Connect a Solana wallet', run: vi.fn(async () => true) }, retry: retry ? vi.fn() : null });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(reviewNow); });
afterEach(() => vi.useRealTimers());

describe('BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: /approve destination message', () => {
  it.each(['EN', 'PT'] as const)('each blocking reason is shown exactly once, names the network, and never a Bridge card (%s)', language => {
    for (const issue of Object.values(DESTINATION_ISSUE)) {
      const { shown, html } = render(issue, language);
      expect(occurrences(html, shown), issue).toBe(1);
      // The disabled Simulate keeps it as its accessible description (not a second live announcement, not a tooltip).
      expect(described(html, shown), issue).toBe(1);
      expect(html).not.toContain(`title="${escaped(shown)}"`);
      expect(shown).toContain('Solana');
      expect(html).not.toMatch(/Bridge card|card de Bridge/);
      expect(shown).toMatch(language === 'PT' ? /Nada foi assinado ou enviado\.$/ : /Nothing was signed or sent\.$/);
    }
  });
  it('says what is missing and the next action: Connect here, Try again after a failed read, the Canvas for a choice or a typed address', () => {
    const required = render(DESTINATION_ISSUE.REQUIRED, 'EN', actions(false));
    expect(required.html).toContain('Destination wallet needed');
    expect(required.shown).toBe('To receive the tokens on Solana, connect a Solana wallet here, or open the Canvas to enter its public address. Nothing was signed or sent.');
    expect(required.html).toContain('>Connect a Solana wallet</button>'); expect(required.html).not.toContain('>Try again</button>');
    const unavailable = render(DESTINATION_ISSUE.UNAVAILABLE, 'EN', actions(true));
    expect(unavailable.shown).toMatch(/^FloFi could not read your account’s wallets for Solana\. Try again, connect a Solana wallet here/);
    expect(unavailable.html).toContain('>Try again</button>'); expect(unavailable.html).toContain('>Connect a Solana wallet</button>');
    expect(render(DESTINATION_ISSUE.CHOOSE).shown).toMatch(/Open the Canvas to choose the one that receives the tokens/);
    const loading = render(DESTINATION_ISSUE.LOADING);
    expect(loading.html).toContain('Checking your wallets'); expect(loading.html).not.toContain('Destination wallet needed');
    expect(loading.shown).toMatch(/continues by itself/);
    const pt = render(DESTINATION_ISSUE.UNAVAILABLE, 'PT', actions(true));
    expect(pt.html).toContain('>Tentar novamente</button>'); expect(pt.html).toContain('>Conectar uma carteira Solana</button>');
    expect(pt.shown).toBe('A FloFi não conseguiu ler as carteiras da sua conta para Solana. Tente novamente, conecte uma carteira Solana aqui ou abra o Canvas para informar o endereço público dela. Nada foi assinado ou enviado.');
  });
  it('a different reason under Simulate (not the status) is still shown: only the same message is not repeated', () => {
    const shown = message(DESTINATION_ISSUE.REQUIRED, 'EN'), other = 'Simulation is not available for this workflow.';
    const html = renderToStaticMarkup(<LocaleProvider initialLanguage="EN"><View data={unsimulated()} destination={{ destinationIssue: shown, simulationReason: other }}/></LocaleProvider>);
    expect(occurrences(html, shown)).toBe(1);
    expect(html).toContain(other);
  });
  it('the Editor (with its Bridge card) keeps its own wording; the two surfaces never share a sentence', () => {
    for (const issue of Object.values(DESTINATION_ISSUE)) {
      expect(destinationIssueMessage(issue, 'editor')).not.toBe(destinationIssueMessage(issue, 'approve'));
      expect(destinationIssueMessage(issue, 'approve')).not.toMatch(/Bridge card/);
      for (const surface of ['editor', 'approve'] as const) expect(translate('PT', destinationIssueMessage(issue, surface))).not.toBe(destinationIssueMessage(issue, surface));
    }
  });
});
