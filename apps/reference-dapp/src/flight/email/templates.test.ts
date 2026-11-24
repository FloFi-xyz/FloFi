// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createEmailDelivery, FLIGHT_CREATOR_BRIEF_URL, type DeliveryDeps } from './delivery';
import { FLIGHT_DEFAULT_CALENDAR } from '../campaign';
import { emailLanguage, escapeHtml, LAUNCH_LANGUAGE, LAUNCH_UPGRADABLE_FROM, renderAccessRecovery, renderEmail, renderEmailForVersion, TEMPLATE_VERSIONS, type CardView, type EmailContext, type TemplateInput } from './templates';
import { ACCESS_RECOVERY_VERSION } from '../access';
/** The approved boarding-recovery copy (EN and PT text), frozen at ACCESS_RECOVERY_VERSION. */
const RECOVERY_COPY_SHA256 = 'be66e9bbcf477eafaa84f3ca010f3ee9ab97d50c2ab4f1c916273d2061e6486e';
import { renderEmail as renderEmailV2 } from './templates-v2';
import { renderEmail as renderEmailV3 } from './templates-v3';
import { renderEmail as renderEmailV4 } from './templates-v4';
import { renderEmail as renderEmailV5 } from './templates-v5';
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
      const current = input.template === 'GROUP_BOARDING' ? renderEmailV4(input, context(language)) : renderEmail(input, context(language));
      expect(renderEmailForVersion(input, context(language), 2)).toEqual(current);
      expect(renderEmailForVersion(input, context(language), 1)).toEqual(renderEmailForVersion(input, context(language), 1));
    }
    expect(TEMPLATE_VERSIONS.CREATOR_INVITE).toBe(6);
    expect(TEMPLATE_VERSIONS.EARLY_LIST).toBe(1);
  });
  it('freezes the deployed v3 renderer and leaves every unrelated template unchanged', () => {
    expect(createHash('sha256').update(readFileSync(new URL('./templates-v3.ts', import.meta.url))).digest('hex'))
      .toBe('af3a3425bc18700e502da188b9a0d08e978ade2ca831bdadab08fde1803390a5');
    expect(TEMPLATE_VERSIONS).toEqual({ EARLY_LIST: 1, LIST_CONFIRMATION: 2, EVE: 2, GROUP_BOARDING: 3, ACCESS_REQUESTED: 2,
      CARD_FOUNDING: 2, CARD_PASSENGER: 2, NEXT_FLIGHT: 2, CREATOR_INVITE: 6 });
    for (const language of ['EN', 'PT'] as const) {
      for (const input of [...inputs, { template: 'EARLY_LIST' } as const]) {
        if (input.template === 'GROUP_BOARDING') expect(renderEmailV4(input, context(language))).toEqual(renderEmailV3(input, context(language)));
        else if (input.template !== 'CREATOR_INVITE') expect(renderEmail(input, context(language))).toEqual(renderEmailV3(input, context(language)));
        else {
          const old = renderEmailForVersion(input, context(language), 3);
          expect(old).toEqual(renderEmailV3(input, context(language)));
          expect(old.text).toContain(language === 'PT' ? 'poste seu cartão no X' : 'post your card on X');
        }
      }
    }
  });
  it('freezes the deployed v4 renderer: only Email 6 (v5) and Email 3 (v3) change for the 13/11 boarding', () => {
    expect(createHash('sha256').update(readFileSync(new URL('./templates-v4.ts', import.meta.url))).digest('hex'))
      .toBe('531f8e5f36d34a79d19a8de9ba19386a5ffa6ec179c5a528cf7f872302da20aa');
    for (const language of ['EN', 'PT'] as const) for (const input of [...inputs, { template: 'EARLY_LIST' } as const]) {
      const current = renderEmail(input, context(language)), frozen = renderEmailV4(input, context(language));
      if (input.template === 'CREATOR_INVITE' || input.template === 'GROUP_BOARDING') expect(current).not.toEqual(frozen);
      else expect(current).toEqual(frozen);
    }
    const retired = renderEmailForVersion(inputs[7]!, context('PT'), 4);
    expect(retired).toEqual(renderEmailV4(inputs[7]!, context('PT')));
    expect(retired.preheader).toBe('Seu código e como embarcar na quinta.');
    // Queued Email 3 v2 rows keep the frozen v2 renderer (byte-identical to v4's Email 3).
    expect(renderEmailForVersion(inputs[2]!, context('PT'), 2)).toEqual(renderEmailV2(inputs[2] as Parameters<typeof renderEmailV2>[0], { ...context('PT'),
      calendar: { ...context('PT').calendar, creatorsOpenAt: Date.parse('2026-11-11T14:00:00-03:00') } }));
  });
  it('freezes the deployed v5 renderer: only Email 6 (v6) changes for the 24/11 guest invitation', () => {
    expect(createHash('sha256').update(readFileSync(new URL('./templates-v5.ts', import.meta.url))).digest('hex'))
      .toBe('e3a71d555ab8f2dba0ec177998cb8d5a50edc75fef39f2bb5cc271daae0fdea5');
    for (const language of ['EN', 'PT'] as const) for (const input of [...inputs, { template: 'EARLY_LIST' } as const]) {
      const current = renderEmail(input, context(language)), frozen = renderEmailV5(input, context(language));
      if (input.template === 'CREATOR_INVITE') {
        expect(current).not.toEqual(frozen);
        expect(renderEmailForVersion(input, context(language), 5)).toEqual(frozen);
        expect(renderEmailForVersion(input, context(language), 6)).toEqual(current);
      } else expect(current).toEqual(frozen);
    }
  });
  it('renders the approved 13/11 Email 3 v3 copy in HTML and plain text, block by block; never in the requested access email', () => {
    const copy = {
      PT: { preheader: 'Estamos começando, e queremos testar com você.', title: 'Seu grupo está embarcando.',
        opening: ['A FloFi está começando, e este é o primeiro voo. Atrasamos um dia para corrigir alguns erros antes de abrir.',
          'Queremos entender, com quem usa DeFi de verdade, onde a FloFi já ajuda e onde ainda deixa a desejar. A sua opinião agora vale muito.'],
        tryLabel: 'O que dá para testar hoje',
        lines: ['Trocar tokens na Ethereum, Base, Arbitrum One, Robinhood Chain (inclusive tokens de ações) e Solana.',
          'Levar tokens de uma rede para outra, inclusive entre as redes EVM e a Solana.', 'Enviar tokens para outra carteira.',
          'Emprestar USDC na Aave e prover liquidez, nas redes que suportam.'],
        small: 'Comece com valores pequenos: é mainnet, com dinheiro de verdade. Você revisa e assina cada passo na sua carteira.',
        gate: 'PORTÃO', gateValue: 'ABERTO', button: 'Embarcar agora →', feedbackLabel: 'Depois de testar',
        feedback: 'Responda este e-mail contando como foi: onde você travou e o que esperava encontrar. Lemos todas as respostas.',
        code: 'Código de 6 dígitos', founding: 'Founding Members', old: 'O seu portão abriu.' },
      EN: { preheader: 'We’re just getting started, and we want to test it with you.', title: 'Your group is boarding.',
        opening: ['FloFi is just getting started, and this is the first flight. We held boarding back one day to fix a few bugs before opening.',
          'We want to learn, from people who really use DeFi, where FloFi already helps and where it still falls short. Your opinion matters a lot right now.'],
        tryLabel: 'What you can try today',
        lines: ['Swap tokens on Ethereum, Base, Arbitrum One, Robinhood Chain (including stock tokens) and Solana.',
          'Move tokens between networks, including between EVM networks and Solana.', 'Send tokens to another wallet.',
          'Lend USDC on Aave and provide liquidity, on the networks that support them.'],
        small: 'Start with small amounts: this is mainnet, with real money. You review and sign every step in your wallet.',
        gate: 'GATE', gateValue: 'OPEN', button: 'Board now →', feedbackLabel: 'After you try it',
        feedback: 'Reply to this email and tell us how it went: where you got stuck and what you expected to find. We read every reply.',
        code: '6-digit code', founding: 'Founding Members', old: 'Your gate is open.' },
    } as const;
    for (const language of ['PT', 'EN'] as const) {
      const c = copy[language], rendered = renderEmail(inputs[2]!, context(language));
      const html = decode(rendered.html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([,.:])/g, '$1'), text = rendered.text.replace(/\s+/g, ' ');
      expect(rendered.preheader).toBe(c.preheader);
      expect(rendered.subject).toBe(language === 'PT' ? 'Seu grupo está embarcando ✈️' : 'Your group is boarding ✈️');
      expect(rendered.html).toContain(`>${c.preheader}</div>`); // the hidden preheader
      // Every block, in this order, in both MIME parts: title, two opening paragraphs, what to try, small amounts, gate, button, 72 h note,
      // feedback, code, Founding Members.
      const order = (whole: string, title: boolean) => [...title ? [c.title] : [], ...c.opening, c.tryLabel, ...c.lines, c.small, ...title ? [c.gateValue.split('').join(' ')] : [],
        c.feedbackLabel, c.feedback, c.founding].map(part => whole.indexOf(part));
      for (const [whole, title] of [[html, true], [text, false]] as const) {
        const positions = order(whole, title);
        expect(positions.every(position => position >= 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        expect(whole).not.toContain(c.old);
      }
      expect(html.indexOf(c.small)).toBeLessThan(html.indexOf(c.button));
      expect(html.indexOf(c.button)).toBeLessThan(html.indexOf(c.feedback));
      expect(html.indexOf(c.feedback)).toBeLessThan(html.indexOf(c.code));
      // The two opening paragraphs have the style of a body paragraph; nothing else changed: access link, code and its lifetimes, footer.
      for (const paragraph of c.opening) expect(rendered.html).toContain(`line-height:1.55;color:#3A4658">${paragraph}</p>`);
      expect(rendered.html).toContain(`href="${access.accessUrl}"`);
      expect(rendered.text).toContain('482913');
      expect(rendered.text).toContain(language === 'PT' ? 'vale por 72 horas' : 'works for 72 hours');
      expect(rendered.text).toContain(language === 'PT' ? 'DeFi envolve risco.' : 'DeFi involves risk.');
      expect(rendered.html).toContain(context(language).unsubscribeUrl);
      // The requested access email keeps its earlier copy, in every renderer.
      for (const access of [renderEmail(inputs[3]!, context(language)), renderEmailForVersion(inputs[3]!, context(language), TEMPLATE_VERSIONS.ACCESS_REQUESTED)]) {
        expect(access.text).toContain(c.old);
        for (const part of [c.preheader, ...c.opening, c.tryLabel, c.feedback]) expect(access.text).not.toContain(part);
      }
      // Queued v2 rows keep the v2 copy (byte-identical, frozen renderer).
      expect(renderEmailForVersion(inputs[2]!, context(language), 2).text).toContain(c.old);
    }
  });
  it('enqueues emails 3, 4a, 4b, 5 and 6 in Portuguese for the 13/11 launch; every other email keeps the stored locale', () => {
    expect(LAUNCH_LANGUAGE).toEqual({ GROUP_BOARDING: 'PT', CARD_FOUNDING: 'PT', CARD_PASSENGER: 'PT', NEXT_FLIGHT: 'PT', CREATOR_INVITE: 'PT' });
    // In-place moves of unsent rows: only to the current version, never from a retired Email 6 copy (v1–v5 are held and superseded).
    expect(LAUNCH_UPGRADABLE_FROM).toEqual({ GROUP_BOARDING: [2, 3], CARD_FOUNDING: [2], CARD_PASSENGER: [2], NEXT_FLIGHT: [2], CREATOR_INVITE: [6] });
    expect(Object.keys(LAUNCH_UPGRADABLE_FROM).sort()).toEqual(Object.keys(LAUNCH_LANGUAGE).sort());
    for (const [template, from] of Object.entries(LAUNCH_UPGRADABLE_FROM))
      expect(Math.max(...from!)).toBe(TEMPLATE_VERSIONS[template as keyof typeof TEMPLATE_VERSIONS]);
    for (const template of Object.keys(TEMPLATE_VERSIONS) as (keyof typeof TEMPLATE_VERSIONS)[]) for (const stored of ['EN', 'PT'] as const)
      expect(emailLanguage(template, stored)).toBe(template in LAUNCH_LANGUAGE ? 'PT' : stored);
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
    for (const version of [1, 2, 3, 4, 5, 99]) await expect(delivery.render({ ...row, templateVersion: version }, at)).rejects.toThrow('TEMPLATE_VERSION_REVIEW');
    const updated = await delivery.render({ ...row, templateVersion: 6 }, at);
    expect(updated.kind).toBe('SEND');
    if (updated.kind !== 'SEND') throw Error('EXPECTED_RENDERED_EMAIL');
    expect(updated.email.html).toContain(FLIGHT_CREATOR_BRIEF_URL);
    expect(updated.email.idempotencyKey).toBe(row.emailId);
    expect(updated.email.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/flofi\.xyz\/api\/board\/unsubscribe\?t=.+>$/);
    expect(updated.email.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(updated.email.text).not.toMatch(/\bTEST\b|quarta-feira|voo de teste/);
    expect(await delivery.render({ ...row, templateVersion: 6 }, at)).toEqual(updated);
    expect(send).not.toHaveBeenCalled(); // Rendering itself cannot send or resend a campaign.
  });
});

// Approved v5 guest copy (13/11), now historical: independent expectations for both MIME alternatives of the frozen v5 renderer.
const approved = {
  EN: {
    subject: 'Your invite to the FloFi beta ✈️', preheader: 'Your code, and how to board.', headline: 'Thanks for coming aboard.',
    intro: "You're one of the first people to use FloFi outside our team. It's still early: this is a first version, and we want to learn from how you use it. Please start with small amounts, since it runs on mainnet with real funds.",
    steps: ['Go to flofi.xyz/board, tap "I have an invite code" and enter your code and email.',
      'Connect your wallet, write what you want to do, check the simulation and sign only what makes sense to you.',
      'Tell us how it went: where you got stuck, what was slow, what made you hesitate before signing. Reply to this email or message Dayane on WhatsApp or Telegram.'],
    cta: 'Read the guest brief', note: 'After your first route, your boarding card arrives by email. If you enjoy it and feel like sharing, it really helps us, but it is entirely up to you. Your code is personal and works once.',
    reason: "You're getting this because the FloFi team invited you to the closed beta.", codeLabel: 'Invite code', boardingLabel: 'Boarding', boarding: 'OPEN',
    risk: 'DeFi involves risk. A simulation does not guarantee price or outcome. FloFi never holds your keys or your funds.',
  },
  PT: {
    subject: 'Seu convite para o beta da FloFi ✈️', preheader: 'Seu código e como embarcar.', headline: 'Obrigada por embarcar com a gente.',
    intro: 'Você está entre as primeiras pessoas a usar a FloFi fora do nosso time. Ainda estamos no começo: é uma primeira versão, e queremos aprender com o seu uso. Comece com valores pequenos, porque é mainnet, com dinheiro de verdade.',
    steps: ['Entra em flofi.xyz/board, toca em "I have an invite code" e digita o seu código e o seu e-mail.',
      'Conecta a sua carteira, escreve o que quer fazer, confere a simulação e assina só o que fizer sentido pra você.',
      'Conta pra nós como foi: onde travou, o que demorou, o que te deixou em dúvida antes de assinar. Pode responder este e-mail ou mandar mensagem pra Dayane no WhatsApp ou no Telegram.'],
    cta: 'Ler o brief do convidado', note: 'Depois da sua primeira rota, o seu cartão de embarque chega por e-mail. Se você curtir e quiser compartilhar, ajuda muito, mas fica totalmente a seu critério. O seu código é pessoal e funciona uma vez só.',
    reason: 'Você recebeu este e-mail porque o time da FloFi enviou um convite para você para o beta fechado.', codeLabel: 'CÓDIGO DE CONVITE', boardingLabel: 'EMBARQUE', boarding: 'ABERTO',
    risk: 'DeFi envolve risco. A simulação não garante preço nem resultado. A FloFi nunca guarda suas chaves nem seus fundos.',
  },
};
const brief = 'https://cooked-goat-9ec.notion.site/Flight-FloFi-Brief-do-criador-4147b5d0a5fd81afb15ffdeb090a6450';
const decode = (html: string) => html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// Dayane's approved guest copy of 24/11 (canvas "Flight FloFi · Convite dos convidados", Board 02): only headline, intro, steps 2–3 and note change.
const approvedV6 = {
  PT: { headline: 'Abrimos o acesso para o seu grupo.',
    intro: 'Obrigada por topar testar. Você está entre as primeiras pessoas a usar a FloFi fora do nosso time. Estamos construindo a FloFi agora e queremos fazer isso junto com quem usa DeFi de verdade. Comece com valores pequenos, porque é mainnet, com dinheiro de verdade.',
    steps: ['Conecta a sua carteira e faz a sua missão: qual operação você faz toda semana em DeFi e que mais te cansa? Faz ela na FloFi. Confere a simulação e assina só o que fizer sentido para você.',
      'Conta para nós como foi: o que você esperava encontrar, onde travou e o que faria você usar a FloFi toda semana. Pode responder este e-mail ou chamar a Dayane no WhatsApp ou no Telegram. Se quiser, ela faz uma call de 20 min e acompanha o seu teste.'],
    note: 'O seu código é pessoal e funciona uma vez só.' },
  EN: { headline: 'We opened access for your group.',
    intro: "Thanks for agreeing to test. You're one of the first people to use FloFi outside our team. We're building FloFi right now and want to do it with people who really use DeFi. Please start with small amounts, since it runs on mainnet with real funds.",
    steps: ['Connect your wallet and take on your mission: which DeFi operation do you do every week that tires you out the most? Do it on FloFi. Check the simulation and sign only what makes sense to you.',
      "Tell us how it went: what you expected to find, where you got stuck and what would make you use FloFi every week. Reply to this email or message Dayane on WhatsApp or Telegram. If you like, she'll join a 20-minute call while you test."],
    note: 'Your code is personal and works once.' },
} as const;
describe('Email 6 approved guest copy v6 (render only; no enqueue or provider)', () => {
  for (const language of ['PT', 'EN'] as const) it(`renders the exact ${language} v6 copy and keeps every other v5 element`, () => {
    const v5 = approved[language], v6 = approvedV6[language], code = language === 'PT' ? 'FLF-7Q2K-9XMB' : 'FLF-ABCD-EFGH';
    const rendered = renderEmail({ template: 'CREATOR_INVITE', code, briefUrl: brief }, context(language));
    expect(renderEmailForVersion({ template: 'CREATOR_INVITE', code, briefUrl: brief }, context(language), 6)).toEqual(rendered);
    // Unchanged: subject, preheader, step 1, CTA and its single destination, both panels, reason, risk, privacy and unsubscribe.
    expect(rendered.subject).toBe(v5.subject);
    expect(rendered.preheader).toBe(v5.preheader);
    const htmlText = decode(rendered.html.replace(/<[^>]+>/g, ''));
    const steps: readonly string[] = [v5.steps[0]!, ...v6.steps];
    for (const text of [v5.preheader, v6.headline, v6.intro, ...steps, v5.cta, v6.note, v5.reason, v5.risk]) {
      expect(htmlText).toContain(text);
      expect(rendered.text).toContain(text);
    }
    expect(rendered.html).toContain(`>${escapeHtml(v6.headline)}</h1>`);
    expect(rendered.html).toContain(`>${escapeHtml(v6.intro)}</p>`);
    for (const [index, step] of steps.entries()) {
      expect(rendered.text).toContain(`${index + 1}. ${step}`);
      expect(rendered.html).toContain(`>${escapeHtml(step)}</td>`);
      expect(htmlText.indexOf(step)).toBeLessThan(index === 2 ? htmlText.indexOf(v5.cta) : htmlText.indexOf(steps[index + 1]!));
    }
    expect(rendered.html).toContain(`>${escapeHtml(v6.note)}</`);
    expect(rendered.html.match(/background:#F5F8FB/g)).toHaveLength(1);
    expect(rendered.html).toContain(`aria-label="${code}"`);
    expect(rendered.html).toContain(`aria-label="${v5.boarding}"`);
    expect(rendered.text).toContain(`${v5.codeLabel} = ${code}`);
    expect(rendered.text).toContain(`${v5.boardingLabel} = ${v5.boarding}`);
    expect(rendered.html.match(new RegExp(`href="${brief}"`, 'g'))).toHaveLength(1);
    expect(rendered.text).toContain(`${v5.cta}: ${brief}`);
    expect(rendered.html.indexOf(escapeHtml(v6.note))).toBeGreaterThan(rendered.html.indexOf(brief));
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('https://flofi.xyz/privacy');
      expect(part).toContain(context(language).unsubscribeUrl);
      // The retired v5 sentences are gone.
      for (const old of [v5.headline, v5.intro, v5.steps[1]!, v5.steps[2]!, v5.note]) expect(decode(part)).not.toContain(old);
    }
    expect(rendered.text).not.toMatch(/<[^>]+>|&(?:quot|amp|lt|gt|#39);/);
    // Same layout as v5: the HTML differs from the frozen v5 renderer only inside the five approved fields.
    const frozen = renderEmailV5({ template: 'CREATOR_INVITE', code, briefUrl: brief }, context(language));
    const blank = (html: string, texts: readonly string[]) => texts.reduce((all, text) => all.split(escapeHtml(text)).join('§'), html);
    expect(blank(rendered.html, [v6.headline, v6.intro, ...v6.steps, v6.note])).toBe(blank(frozen.html, [v5.headline, v5.intro, v5.steps[1]!, v5.steps[2]!, v5.note]));
  });
});
describe('Email 6 approved guest copy v5, historical (render only; no enqueue or provider)', () => {
  for (const language of ['PT', 'EN'] as const) it(`renders the exact ${language} copy, one panel and CTA in HTML and plain text`, () => {
    const copy = approved[language], code = language === 'PT' ? 'FLF-7Q2K-9XMB' : 'FLF-ABCD-EFGH';
    const rendered = renderEmailForVersion({ template: 'CREATOR_INVITE', code, briefUrl: brief }, context(language), 5);
    expect(FLIGHT_CREATOR_BRIEF_URL).toBe(brief);
    expect(rendered.subject).toBe(copy.subject);
    expect(rendered.preheader).toBe(copy.preheader);
    const htmlText = decode(rendered.html.replace(/<[^>]+>/g, ''));
    for (const text of [copy.preheader, copy.headline, copy.intro, ...copy.steps, copy.cta, copy.note, copy.reason, copy.risk]) {
      expect(htmlText).toContain(text);
      expect(rendered.text).toContain(text);
    }
    expect(rendered.html).toMatch(/<h1[^>]*>/);
    expect(rendered.html).toContain('max-width:600px');
    expect(rendered.html.match(/background:#F5F8FB/g)).toHaveLength(1);
    expect(rendered.html).toContain(`aria-label="${code}"`);
    expect(rendered.html).toContain(`aria-label="${copy.boarding}"`);
    expect(rendered.html).not.toContain('NOV 12');
    expect(rendered.text).toContain(`${copy.codeLabel} = ${code}`);
    expect(rendered.text).toContain(`${copy.boardingLabel} = ${copy.boarding}`);
    for (const part of [rendered.preheader, rendered.text]) expect(part).not.toMatch(/quinta|Thursday|sexta|Friday|a partir das 9h|from 9:00/i);
    for (const [index, step] of copy.steps.entries()) {
      expect(rendered.text).toContain(`${index + 1}. ${step}`);
      expect(htmlText.indexOf(step)).toBeLessThan(index === 2 ? htmlText.indexOf(copy.cta) : htmlText.indexOf(copy.steps[index + 1]!));
      expect(rendered.html).toContain(`text-align:center">${index + 1}</div>`);
    }
    expect(rendered.html.match(new RegExp(`href="${brief}"`, 'g'))).toHaveLength(1);
    expect(rendered.html.indexOf(copy.note)).toBeGreaterThan(rendered.html.indexOf(brief));
    expect(rendered.text).toContain(`${copy.cta}: ${brief}`);
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('https://flofi.xyz/privacy');
      expect(part).toContain(context(language).unsubscribeUrl);
      expect(part).not.toMatch(/test flight|voo de teste|\bTEST\b|09:00[–-]10:00|post.*(?:on X|no X)|creator brief|brief do criador|wa\.me|t\.me/i);
    }
    expect(rendered.text).not.toMatch(/<[^>]+>|&(?:quot|amp|lt|gt|#39);/);
  });
  it('rejects malformed personal codes and unapproved destinations, and escapes dynamic HTML', () => {
    for (const code of ['FLF-0000-0000', 'FLF-7Q2K-9XM<script>', 'placeholder', ''])
      expect(() => renderEmail({ template: 'CREATOR_INVITE', code, briefUrl: brief }, context('PT'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
    expect(() => renderEmail({ template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: 'https://example.org' }, context('EN'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
    const unsubscribeUrl = 'https://flofi.xyz/board/unsubscribe?t="<tag>&x=1';
    const rendered = renderEmail({ template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: brief }, { ...context('EN'), unsubscribeUrl });
    expect(rendered.html).toContain('href="https://flofi.xyz/board/unsubscribe?t=&quot;&lt;tag&gt;&amp;x=1"');
    expect(rendered.html).not.toContain('<tag>');
    expect(rendered.text).toContain(unsubscribeUrl);
  });
});

describe('BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 boarding recovery copy', () => {
  const input = { seat: { founding: true, label: '#001' }, methods: [{ kind: 'wallet' as const, hint: '0x1a2b…9f0e' }, { kind: 'google' as const, hint: 'o***@gmail.com' }] };
  it('names the sign-in method of the account that holds the pass, in both languages, and carries no link, code or token', () => {
    for (const language of ['EN', 'PT'] as const) {
      const email = renderAccessRecovery(input, context(language));
      expect(email.subject).toBe(language === 'PT' ? 'Você já embarcou no Flight FloFi ✈️' : 'You already boarded Flight FloFi ✈️');
      expect(email.text).toContain('0x1a2b…9f0e');
      expect(email.text).toContain(language === 'PT' ? 'como Founding Member #001' : 'as Founding Member #001');
      expect(email.html).toContain('https://flofi.xyz/login');
      expect(`${email.html}\n${email.text}`).not.toMatch(/\/board\/access|#t=|\b\d{6}\b/);
    }
    // No account can be told apart: general guidance only.
    expect(renderAccessRecovery({ seat: null, methods: [] }, context('EN')).text).toContain('The same sign-in method you used when you boarded.');
    expect(() => renderAccessRecovery({ seat: null, methods: [{ kind: 'google', hint: '<script>' }] }, context('EN'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
  });
  it('is frozen at its own version: a copy change needs a new ACCESS_RECOVERY_VERSION', () => {
    const digest = createHash('sha256').update(JSON.stringify(['EN', 'PT'].map(language => renderAccessRecovery(input, context(language as 'EN' | 'PT')).text))).digest('hex');
    expect(ACCESS_RECOVERY_VERSION).toBe(100);
    expect(digest).toBe(RECOVERY_COPY_SHA256);
  });
});
