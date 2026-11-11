// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createEmailDelivery, FLIGHT_CREATOR_BRIEF_URL, type DeliveryDeps } from './delivery';
import { FLIGHT_DEFAULT_CALENDAR } from '../campaign';
import { renderEmail, renderEmailForVersion, TEMPLATE_VERSIONS, type CardView, type EmailContext, type TemplateInput } from './templates';
import type { EmailRow } from './outbox';

const context = (language: 'EN' | 'PT'): EmailContext => ({ language, recipient: 'boarding@flofi-test.dev', origin: 'https://flofi.xyz',
  calendar: FLIGHT_DEFAULT_CALENDAR, unsubscribeUrl: 'https://flofi.xyz/board/unsubscribe?t=fixture' });
const card = (founding: boolean): CardView => ({ founding, seat: founding ? '#042' : '214E', handle: 'ana<script>', from: 'ETH', to: 'BASE',
  stepCount: 2, networkCount: 2, departedAt: '2026-11-12T12:30:00Z', publicUrl: 'https://flofi.xyz/card/abcdefghijkl',
  imageUrl: 'https://flofi.xyz/card/abcdefghijkl/image', downloadUrl: 'https://flofi.xyz/card/abcdefghijkl/image?download=1' });
const access = { accessUrl: `https://flofi.xyz/board/access?l=pt#t=${'A'.repeat(43)}`, code: '482913', codeMinutes: 4320, linkHours: 72,
  foundingOpen: true, group: 3 } as const;
const inputs: TemplateInput[] = [{ template: 'LIST_CONFIRMATION' }, { template: 'EVE' }, { template: 'GROUP_BOARDING', ...access },
  { template: 'ACCESS_REQUESTED', ...access, codeMinutes: 15 }, { template: 'CARD_FOUNDING', card: card(true), invites: ['FLF-7Q2K-9XMB', 'FLF-ABCD-EFGH', 'FLF-JKMN-PQRS'],
    invitesUrl: 'https://flofi.xyz/board#invites' }, { template: 'CARD_PASSENGER', card: card(false) }, { template: 'NEXT_FLIGHT' },
  { template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: FLIGHT_CREATOR_BRIEF_URL }];

describe('Flight launch email copy and immutable queued versions', () => {
  it('freezes the exact original v1 renderer so retries of queued messages keep their recorded HTML', () => {
    // Only the erased TypeScript calendar type changed; every executable byte remains pinned to the deployed renderer.
    const original = readFileSync(new URL('./templates-v1.ts', import.meta.url), 'utf8').replace(
      "// Legacy renderers retain their calendar shape; current campaign rules have no creator phase.\ntype FlightCalendar = import('../campaign.ts').FlightCalendar & { readonly creatorsOpenAt: number };",
      "import type { FlightCalendar } from '../campaign.ts';");
    expect(createHash('sha256').update(original).digest('hex')).toBe('f21e6a491ad535c54e16e17340d19700aa9714c8f26ed818b196187403c779da');
    const current = renderEmailForVersion(inputs[4]!, context('PT'), 2), queued = renderEmailForVersion(inputs[4]!, context('PT'), 1);
    expect(current.text).toContain('Você recebeu este e-mail porque embarcou no Flight FloFi.');
    expect(queued.text).toContain('Você está recebendo isto porque entrou na lista beta');
    expect(queued).toEqual(renderEmailForVersion(inputs[4]!, context('PT'), 1));
  });
  it('freezes deployed v2 executable bytes and preserves both old renderers for queued noncreator messages', () => {
    const original = readFileSync(new URL('./templates-v2.ts', import.meta.url), 'utf8').replace(
      "// Frozen v2 renderer: the legacy calendar field is supplied only for compatibility inspection.\ntype FlightCalendar = import('../campaign.ts').FlightCalendar & { readonly creatorsOpenAt: number };",
      "import type { FlightCalendar } from '../campaign.ts';");
    expect(createHash('sha256').update(original).digest('hex')).toBe('cc645467b3699f476e254d9bef35a07896abf72c06262bc9bd95e0a553b57565');
    for (const input of inputs.filter(value => value.template !== 'CREATOR_INVITE')) for (const language of ['EN', 'PT'] as const) {
      const current = renderEmail(input, context(language));
      expect(renderEmailForVersion(input, context(language), 2)).toEqual(current);
      expect(renderEmailForVersion(input, context(language), 1)).toEqual(renderEmailForVersion(input, context(language), 1));
    }
    expect(TEMPLATE_VERSIONS.CREATOR_INVITE).toBe(3);
    expect(TEMPLATE_VERSIONS.EARLY_LIST).toBe(1);
  });
  it('renders Email 0 independently of Email 1 and records the Forms source in both languages', () => {
    for (const language of ['EN', 'PT'] as const) {
      const early = renderEmailForVersion({ template: 'EARLY_LIST' }, context(language), 1);
      expect(early.text).toContain(language === 'PT' ? 'formulário de inscrição' : 'signup form');
      expect(early.text).toContain(language === 'PT' ? 'na ordem em que se inscreveu' : 'in the order you signed up');
      expect(early.html).toContain('boarding@flofi-test.dev');
      expect(early.html).not.toContain('<script>');
      expect(early).not.toEqual(renderEmailForVersion({ template: 'LIST_CONFIRMATION' }, context(language), 1));
    }
    expect(() => renderEmailForVersion({ template: 'EARLY_LIST' }, context('EN'), 2)).toThrow('EMAIL_TEMPLATE_VERSION_UNSUPPORTED');
  });
  it('renders the nine technical templates in both languages and refuses unsupported versions', () => {
    const allInputs: TemplateInput[] = [...inputs, { template: 'EARLY_LIST' }];
    expect(allInputs.map(input => input.template).sort()).toEqual(Object.keys(TEMPLATE_VERSIONS).sort());
    for (const input of allInputs) for (const language of ['EN', 'PT'] as const) {
      const rendered = renderEmailForVersion(input, context(language), TEMPLATE_VERSIONS[input.template]);
      expect(rendered.html).toContain(`<html lang="${language === 'PT' ? 'pt-BR' : 'en'}">`);
      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).toContain(context(language).unsubscribeUrl);
      expect(rendered.text).toContain(language === 'PT' ? 'Política de Privacidade' : 'Privacy Policy');
      expect(rendered.text).toContain(language === 'PT' ? 'DeFi envolve risco.' : 'DeFi involves risk.');
      for (const version of [0, -1, 99, Number.NaN]) expect(() => renderEmailForVersion(input, context(language), version)).toThrow('EMAIL_TEMPLATE_VERSION_UNSUPPORTED');
    }
    const pt = inputs.map(input => renderEmail(input, context('PT')).html).join('\n');
    expect(pt).not.toMatch(/Flight FloFi · (Beta list|Final call|Now boarding|On board|Next flight|Invited)|aria-label="(ON THE LIST|NEXT FLIGHT|OPEN)"/);
    expect(pt).not.toMatch(/color:#93A6FF/); // The airport flap letters are white in the new renderer.
  });
  it('describes returning linked-wallet authentication and keeps email recovery, one-use codes and expirations', () => {
    for (const language of ['EN', 'PT'] as const) {
      const rendered = renderEmail(inputs[2]!, context(language));
      expect(rendered.text).toContain(language === 'PT' ? 'entre com a carteira já vinculada' : 'sign in with your linked wallet');
      expect(rendered.text).toContain('Privy');
      expect(rendered.text).toContain(language === 'PT' ? 'não precisa informar o e-mail novamente' : 'won’t need to enter your email again');
      expect(rendered.text).toContain(language === 'PT' ? '72 horas' : '72 hours');
      expect(rendered.text).toContain('482913');
      expect(renderEmail(inputs[3]!, context(language)).text).toContain(language === 'PT' ? '15 minutos' : '15 minutes');
    }
    expect(renderEmail(inputs[2]!, context('EN')).text).not.toContain('connecting the same wallet is enough');
  });
  it('uses the supplied Portuguese copy, real card PNG at 528 px, correct seats and proven boarding footers', () => {
    const founding = renderEmail(inputs[4]!, context('PT')), passenger = renderEmail(inputs[5]!, context('PT'));
    expect(founding.subject).toBe('Você é Founding Member #042 ✈️');
    expect(founding.text).toContain('Seu assento numerado e o seu @ no mural de Founding Members');
    expect(passenger.text).toContain('Os assentos Founding acabaram');
    for (const rendered of [founding, passenger]) {
      expect(rendered.text).toContain('Você recebeu este e-mail porque embarcou no Flight FloFi.');
      expect(rendered.html).toContain('src="https://flofi.xyz/card/abcdefghijkl/image" width="528"');
      expect(rendered.html).toContain('max-width:528px;height:auto');
      expect(rendered.html).toContain('https://flofi.xyz/card/abcdefghijkl/image?download=1');
      expect(rendered.html).toContain('@ana&lt;script&gt;');
      expect(rendered.html).not.toContain('<svg');
    }
    expect(founding.html).toContain('FOUNDING #042');
    expect(passenger.html).toContain('ASSENTO 214E');
    expect(passenger.text).not.toContain('FLF-');
    const noInvites = renderEmail({ template: 'CARD_FOUNDING', card: card(true), invites: [], invitesUrl: 'https://flofi.xyz/board#invites' }, context('PT'));
    expect(noInvites.preheader).not.toContain('convites');
    expect(noInvites.text).not.toMatch(/3 convites|Enviar convite/);
    expect(() => renderEmail({ template: 'CARD_FOUNDING', card: card(true), invites: ['FLF-7Q2K-9XMB'], invitesUrl: 'https://flofi.xyz/board#invites' }, context('PT'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
    const creator = renderEmail(inputs[7]!, context('PT'));
    expect(creator.subject).toBe('Seu convite para o Flight FloFi ✈️');
    expect(creator.text).toContain('depois da primeira simulação bem-sucedida');
    expect(renderEmail(inputs[7]!, context('EN')).text).toContain('after your first successful simulation');
    expect(creator.text).not.toMatch(/\bTEST\b|quarta-feira|voo de teste/);
    expect(creator.html).toContain(FLIGHT_CREATOR_BRIEF_URL);
  });
  it('holds retired creator versions and renders only the current launch copy under its original idempotency key', async () => {
    const send = vi.fn(), secret = randomBytes(32).toString('base64url');
    const deps = { tenantId: 'default', calendar: FLIGHT_DEFAULT_CALENDAR, secret, origin: 'https://flofi.xyz', provider: { send },
      outbox: { isSuppressed: async () => false }, db: { query: async (sql: string) => ({ rows: sql.includes('flight_early_list_imports') ? [] : [{ redeemed_at: null }] }) },
      store: {}, access: {}, logger: {}, now: () => FLIGHT_DEFAULT_CALENDAR.boardingOpensAt } as unknown as DeliveryDeps;
    const delivery = createEmailDelivery(deps);
    const row: EmailRow = { emailId: `fem_${'0'.repeat(32)}`, template: 'CREATOR_INVITE', templateVersion: 1, category: 'CAMPAIGN',
      recipient: 'creator@flofi-test.dev', language: 'PT', trigger: 'CREATOR_INVITE', batchKey: null, entryId: null, passId: null,
      inviteCode: 'FLF-7Q2K-9XMB', state: 'SENDING', attempts: 1, leaseToken: null, createdAt: '2026-11-10T12:00:00Z', firstAttemptAt: null };
    const at = FLIGHT_DEFAULT_CALENDAR.boardingOpensAt - 60_000;
    for (const version of [1, 2, 99]) await expect(delivery.render({ ...row, templateVersion: version }, at)).rejects.toThrow('TEMPLATE_VERSION_REVIEW');
    const updated = await delivery.render({ ...row, templateVersion: 3 }, at);
    expect(updated.kind).toBe('SEND');
    if (updated.kind !== 'SEND') throw Error('EXPECTED_RENDERED_EMAIL');
    expect(updated.email.html).toContain(FLIGHT_CREATOR_BRIEF_URL);
    expect(updated.email.idempotencyKey).toBe(row.emailId);
    expect(updated.email.text).not.toMatch(/\bTEST\b|quarta-feira|voo de teste/);
    expect(await delivery.render({ ...row, templateVersion: 3 }, at)).toEqual(updated);
    expect(send).not.toHaveBeenCalled(); // Rendering itself cannot send or resend a campaign.
  });
});
