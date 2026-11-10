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
    const original = readFileSync(new URL('./templates-v1.ts', import.meta.url));
    expect(createHash('sha256').update(original).digest('hex')).toBe('f21e6a491ad535c54e16e17340d19700aa9714c8f26ed818b196187403c779da');
    const current = renderEmailForVersion(inputs[4]!, context('PT'), 2), queued = renderEmailForVersion(inputs[4]!, context('PT'), 1);
    expect(current.text).toContain('Você recebeu este e-mail porque embarcou no Flight FloFi.');
    expect(queued.text).toContain('Você está recebendo isto porque entrou na lista beta');
    expect(queued).toEqual(renderEmailForVersion(inputs[4]!, context('PT'), 1));
  });
  it('renders all eight technical templates in both languages and refuses unsupported versions', () => {
    expect(inputs.map(input => input.template).sort()).toEqual(Object.keys(TEMPLATE_VERSIONS).sort());
    for (const input of inputs) for (const language of ['EN', 'PT'] as const) {
      const rendered = renderEmailForVersion(input, context(language), TEMPLATE_VERSIONS[input.template]);
      expect(rendered.html).toContain(`<html lang="${language === 'PT' ? 'pt-BR' : 'en'}">`);
      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).toContain(context(language).unsubscribeUrl);
      expect(rendered.text).toContain(language === 'PT' ? 'Política de Privacidade' : 'Privacy Policy');
      expect(rendered.text).toContain(language === 'PT' ? 'DeFi envolve risco.' : 'DeFi involves risk.');
      for (const version of [0, -1, 3, Number.NaN]) expect(() => renderEmailForVersion(input, context(language), version)).toThrow('EMAIL_TEMPLATE_VERSION_UNSUPPORTED');
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
    expect(creator.text).toContain('O seu cartão oficial sai depois da sua primeira rota.');
    expect(renderEmail(inputs[7]!, context('EN')).text).toContain('Your official card comes out after your first route.');
    expect(creator.html).toContain(FLIGHT_CREATOR_BRIEF_URL);
  });
  it('dispatches the stored version in the real delivery renderer, preserving v1 creator links and refusing unknown versions', async () => {
    const send = vi.fn(), secret = randomBytes(32).toString('base64url');
    const deps = { tenantId: 'default', calendar: FLIGHT_DEFAULT_CALENDAR, secret, origin: 'https://flofi.xyz', provider: { send },
      outbox: { isSuppressed: async () => false }, db: { query: async () => ({ rows: [{ redeemed_at: null }] }) },
      store: {}, access: {}, logger: {}, now: () => FLIGHT_DEFAULT_CALENDAR.boardingOpensAt } as unknown as DeliveryDeps;
    const delivery = createEmailDelivery(deps);
    const row: EmailRow = { emailId: `fem_${'0'.repeat(32)}`, template: 'CREATOR_INVITE', templateVersion: 1, category: 'CAMPAIGN',
      recipient: 'creator@flofi-test.dev', language: 'PT', trigger: 'CREATOR_INVITE', batchKey: null, entryId: null, passId: null,
      inviteCode: 'FLF-7Q2K-9XMB', state: 'SENDING', attempts: 1, leaseToken: null, createdAt: '2026-11-10T12:00:00Z', firstAttemptAt: null };
    const original = await delivery.render(row, FLIGHT_DEFAULT_CALENDAR.creatorsOpenAt);
    const updated = await delivery.render({ ...row, templateVersion: 2 }, FLIGHT_DEFAULT_CALENDAR.creatorsOpenAt);
    expect(original.kind).toBe('SEND'); expect(updated.kind).toBe('SEND');
    if (original.kind !== 'SEND' || updated.kind !== 'SEND') throw Error('EXPECTED_RENDERED_EMAIL');
    expect(original.email.html).toContain('https://claude.ai/artifact/Ed64YTYtYmUWVgnT8NEZD5');
    expect(updated.email.html).toContain(FLIGHT_CREATOR_BRIEF_URL);
    expect(original.email.idempotencyKey).toBe(row.emailId);
    expect(updated.email.idempotencyKey).toBe(row.emailId);
    expect((await delivery.render(row, FLIGHT_DEFAULT_CALENDAR.creatorsOpenAt))).toEqual(original);
    await expect(delivery.render({ ...row, templateVersion: 99 }, FLIGHT_DEFAULT_CALENDAR.creatorsOpenAt)).rejects.toThrow('EMAIL_TEMPLATE_VERSION_UNSUPPORTED');
    expect(send).not.toHaveBeenCalled(); // Rendering itself cannot send or resend a campaign.
  });
});
