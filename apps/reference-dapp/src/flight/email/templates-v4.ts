// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the eight technical Flight FloFi templates (1, 2, 3, 4a, 4b, 5, 6) of the team-approved Claude Artifact "Flight FloFi"
 * (version 1794236006-f919, section 04 "E-mails"), as versioned templates. Pure: the caller supplies every value (nothing is read here).
 *
 * - English is the artifact's text, word for word, except where a sentence would promise something the product does not do; each such
 *   change is listed in `TEMPLATE_DEVIATIONS` for the team (Dayane) to confirm. Portuguese subjects and bodies follow section 04 of the
 *   supplied Flight FloFi.html canvas. Technical access instructions remain truthful to Privy and persisted token lifetimes (Email 3: 72 hours; requested codes: 15 minutes).
 * - Version 1 is frozen in templates-v1.ts. Existing outbox rows retain that renderer, including retries with the same provider idempotency key.
 * - HTML is tables with inline styles, at most 600 px wide, images as PNG (Gmail shows no SVG), with a plain-text part. Every value that
 *   comes from a person (handle) or the database is escaped. No count of people anywhere: only the recipient's own seat number.
 * - Every email carries the risk footer, the privacy policy link and a one-click unsubscribe (List-Unsubscribe, RFC 8058).
 * - Dates come from the deployment's campaign calendar, in Brasília time (America/Sao_Paulo), never from a date written here.
 */
import type { FlightCalendar } from '../campaign.ts';

// Frozen v4 renderer (Email 6 v4): kept to inspect retired queued rows; delivery holds them (TEMPLATE_VERSION_REVIEW) and never sends this copy.
const FLIGHT_CREATOR_BRIEF_URL = 'https://cooked-goat-9ec.notion.site/Flight-FloFi-Brief-do-criador-4147b5d0a5fd81afb15ffdeb090a6450';

export type EmailTemplate = 'EARLY_LIST' | 'LIST_CONFIRMATION' | 'EVE' | 'GROUP_BOARDING' | 'ACCESS_REQUESTED' | 'CARD_FOUNDING' | 'CARD_PASSENGER' | 'NEXT_FLIGHT' | 'CREATOR_INVITE';
export type EmailLanguage = 'EN' | 'PT';
/** The version of each template. Bump it whenever its text or layout changes; every outbox row records the version it was enqueued with. */
export const TEMPLATE_VERSIONS: Readonly<Record<EmailTemplate, number>> = Object.freeze({
  EARLY_LIST: 1, LIST_CONFIRMATION: 2, EVE: 2, GROUP_BOARDING: 2, ACCESS_REQUESTED: 2, CARD_FOUNDING: 2, CARD_PASSENGER: 2, NEXT_FLIGHT: 2, CREATOR_INVITE: 4,
});
/** ESSENTIAL: an access email the person asked for themselves; sent even to an unsubscribed address and while campaign email is paused. */
export const TEMPLATE_CATEGORY: Readonly<Record<EmailTemplate, 'CAMPAIGN' | 'ESSENTIAL'>> = Object.freeze({
  EARLY_LIST: 'CAMPAIGN', LIST_CONFIRMATION: 'CAMPAIGN', EVE: 'CAMPAIGN', GROUP_BOARDING: 'CAMPAIGN', ACCESS_REQUESTED: 'ESSENTIAL', CARD_FOUNDING: 'CAMPAIGN',
  CARD_PASSENGER: 'CAMPAIGN', NEXT_FLIGHT: 'CAMPAIGN', CREATOR_INVITE: 'CAMPAIGN',
});
/** Which approved email each template is (the artifact's numbering). */
export const TEMPLATE_NUMBER: Readonly<Record<EmailTemplate, string>> = Object.freeze({
  EARLY_LIST: '0', LIST_CONFIRMATION: '1', EVE: '2', GROUP_BOARDING: '3', ACCESS_REQUESTED: '3 (requested again)', CARD_FOUNDING: '4a', CARD_PASSENGER: '4b',
  NEXT_FLIGHT: '5', CREATOR_INVITE: '6',
});
/** Where the English differs from the approved artifact, and why (each needs the team's confirmation). */
export const TEMPLATE_DEVIATIONS: readonly string[] = Object.freeze([
  'Email 2: "and routes have a small limit during the beta" is left out: FloFi has no per-route value limit, and this build adds none (no new barriers to execution).',
  'Email 3: "This button signs you in with this email" becomes "This button confirms your boarding with this email": the link proves the address and opens the campaign; signing in stays FloFi\'s own login.',
  'Email 3: the 6-digit code is printed in the email for another device (the artifact sent it on request only); the request path still exists at flofi.xyz/board.',
  'Email 3: a "Group" line is added when the person has a numbered boarding group.',
  'Email 6 v4 follows Dayane’s approved invited-guest copy (BUILD-FLOFI-FLIGHT-EMAIL6-CONSOLE-FIX-001); v1–v3 remain historical renderers.',
  'Emails 4a and 4b show the real card image (the 1200 × 630 card picture) in place of the drawn card block.',
  'Version 2 follows BUILD-FLOFI-FLIGHT-LAUNCH-ADMIN-001: linked-wallet return access in Email 3, @ in Email 4a, official card after the first route in Email 6, Portuguese interface labels and boarding-card footers. Portuguese copy follows section 04 of the supplied Flight FloFi.html; unsupported route-limit and automatic-sign-in promises remain omitted.',
]);

export type CardView = {
  readonly founding: boolean; readonly seat: string; readonly handle: string | null; readonly from: string; readonly to: string;
  readonly stepCount: number; readonly networkCount: number; readonly departedAt: string;
  readonly publicUrl: string; readonly imageUrl: string; readonly downloadUrl: string;
};
export type TemplateInput =
  | { readonly template: 'EARLY_LIST' }
  | { readonly template: 'LIST_CONFIRMATION' | 'EVE' | 'NEXT_FLIGHT' }
  | { readonly template: 'GROUP_BOARDING' | 'ACCESS_REQUESTED'; readonly accessUrl: string; readonly code: string; readonly codeMinutes: number;
      readonly linkHours: number; readonly foundingOpen: boolean; readonly group: number | null }
  | { readonly template: 'CARD_FOUNDING'; readonly card: CardView; readonly invites: readonly string[]; readonly invitesUrl: string }
  | { readonly template: 'CARD_PASSENGER'; readonly card: CardView }
  | { readonly template: 'CREATOR_INVITE'; readonly code: string; readonly briefUrl: string };
export type EmailContext = {
  readonly language: EmailLanguage; readonly recipient: string; readonly origin: string; readonly calendar: Required<FlightCalendar>;
  readonly unsubscribeUrl: string;
};
export type RenderedEmail = { readonly subject: string; readonly html: string; readonly text: string; readonly preheader: string };

// Approved palette (artifact design system "flofi"): navy, blue, periwinkle, ground.
const C = { navy: '#041B3D', blue: '#2343D9', peri: '#93A6FF', soft: '#C9D2F8', ground: '#E9EEF5', panel: '#F5F8FB', line: '#DCE3F0', body: '#3A4658',
  muted: '#7A8699', label: '#4B5B73', footSoft: '#8EA0C4', white: '#FFFFFF' } as const;
const SANS = "'Outfit',Helvetica,Arial,sans-serif", MONO = "'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const e = escapeHtml;

// Dates, in Brasília time.
const parts = (ms: number, locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'America/Sao_Paulo', ...options }).formatToParts(new Date(ms));
const part = (list: Intl.DateTimeFormatPart[], type: string) => list.find(p => p.type === type)?.value ?? '';
/** "9:00" (EN) or "9h" / "9h30" (PT). */
export function clock(ms: number, language: EmailLanguage): string {
  const list = parts(ms, 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const hour = Number(part(list, 'hour')), minute = part(list, 'minute');
  return language === 'PT' ? `${hour}h${minute === '00' ? '' : minute}` : `${hour}:${minute}`;
}
/** "Thursday, Nov 12" (EN) or "quinta-feira, 12/11" (PT). */
export function longDay(ms: number, language: EmailLanguage): string {
  if (language === 'PT') {
    const list = parts(ms, 'pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
    return `${part(list, 'weekday')}, ${part(list, 'day')}/${part(list, 'month')}`;
  }
  const list = parts(ms, 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return `${part(list, 'weekday')}, ${part(list, 'month')} ${part(list, 'day')}`;
}
/** "Thu, Nov 12" (EN) or "qui, 12/11" (PT). */
function shortDay(ms: number, language: EmailLanguage): string {
  if (language === 'PT') {
    const list = parts(ms, 'pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return `${part(list, 'weekday').replace('.', '')}, ${part(list, 'day')}/${part(list, 'month')}`;
  }
  const list = parts(ms, 'en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${part(list, 'weekday')}, ${part(list, 'month')} ${part(list, 'day')}`;
}
/** The flap board's "NOV 12 09:00". */
export function flapDay(ms: number, withTime = true, language: EmailLanguage = 'EN'): string {
  const list = parts(ms, language === 'PT' ? 'pt-BR' : 'en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${part(list, 'month').replace('.', '').toUpperCase()} ${part(list, 'day')}${withTime ? ` ${part(list, 'hour')}:${part(list, 'minute')}` : ''}`;
}
/** The card's "NOV 12". */
export const cardDay = (iso: string) => flapDay(Date.parse(iso), false);

// Building blocks.
const p = (html: string, size = 17) => `<p style="margin:0 0 18px;font-family:${SANS};font-size:${size}px;line-height:1.55;color:${C.body}">${html}</p>`;
const h1 = (first: string, accent = '') => `<h1 style="margin:0 0 18px;font-family:${SANS};font-weight:700;font-size:36px;line-height:1.05;letter-spacing:-1px;color:${C.navy}">${first}${accent ? `<span style="color:${C.blue}">${accent}</span>` : ''}</h1>`;
const label = (text: string) => `<div style="font-family:${MONO};font-weight:500;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${C.label};padding:0 0 5px">${e(text)}</div>`;
/** A flap row: one dark cell per character (tables render in every client, Outlook included). */
function flaps(text: string): string {
  const cells = [...text.toUpperCase()].map(ch => `<td style="width:20px;height:30px;background:${C.navy};border-radius:3px;text-align:center;font-family:${MONO};font-weight:500;font-size:17px;color:${C.white}">${ch.trim() ? e(ch) : '&nbsp;'}</td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="2" style="border-collapse:separate" aria-label="${e(text)}"><tr>${cells}</tr></table>`;
}
const panel = (rows: string[]) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:${C.panel};border:1.5px solid ${C.line};border-radius:16px"><tr><td style="padding:16px 18px">${rows.map((row, index) => `<div style="padding:${index ? '12px' : '0'} 0 0">${row}</div>`).join('')}</td></tr></table>`;
const button = (href: string, text: string, color: string = C.blue) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td style="background:${color};border-radius:999px"><a href="${e(href)}" style="display:inline-block;padding:14px 26px;font-family:${SANS};font-weight:600;font-size:17px;color:${C.white};text-decoration:none">${e(text)}</a></td></tr></table>`;
const small = (html: string) => `<p style="margin:0 0 18px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted}">${html}</p>`;
const mono = (text: string, color: string = C.blue) => `<p style="margin:0 0 18px;font-family:${MONO};font-weight:500;font-size:15px;color:${color}">${e(text)}</p>`;
const list = (items: string[]) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${items.map(item => `<tr><td style="vertical-align:top;padding:9px 10px 0 0"><div style="width:8px;height:8px;border-radius:8px;background:${C.blue}"></div></td><td style="font-family:${SANS};font-size:16px;line-height:1.5;color:${C.body};padding:0 0 6px">${item}</td></tr>`).join('')}</table>`;

type Pose = 'welcome' | 'captain' | 'safety' | 'wink';
const POSE_ALT: Record<Pose, string> = { welcome: 'Gota', captain: 'Gota', safety: 'Gota', wink: 'Gota' };
function layout(ctx: EmailContext, input: { subject: string; preheader: string; band: string; pose: Pose; body: string; reason: string }): string {
  const t = FOOTER[ctx.language], o = ctx.origin;
  return `<!doctype html><html lang="${ctx.language === 'PT' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${e(input.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.ground}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ground}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.white}">
<tr><td style="background:${C.blue};padding:0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:30px 0 24px 36px;vertical-align:top"><img src="${o}/brand/flight/email/flofi-logo-on-blue.png" width="76" height="28" alt="FloFi" style="display:block;border:0;height:28px;width:76px">
      <div style="padding-top:62px;font-family:${MONO};font-weight:500;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:${C.soft}">${e(input.band)}</div></td>
    <td align="right" style="padding:14px 20px 6px 0;vertical-align:top;width:170px"><img src="${o}/brand/flight/email/gota-${input.pose}.png" width="150" height="150" alt="${POSE_ALT[input.pose]}" style="display:block;border:0;width:150px;height:150px"></td>
  </tr></table></td></tr>
<tr><td style="padding:32px 36px 18px">${input.body}</td></tr>
<tr><td style="background:${C.navy};padding:24px 36px">
  <p style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.soft}">${e(t.risk)}</p>
  <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.footSoft}">${e(input.reason)} <a href="${e(ctx.unsubscribeUrl)}" style="color:${C.footSoft};text-decoration:underline">${e(t.unsubscribe)}</a> · <a href="${o}/privacy" style="color:${C.footSoft};text-decoration:underline">${e(t.privacy)}</a></p>
</td></tr></table></td></tr></table></body></html>`;
}
const FOOTER = {
  EN: { risk: 'DeFi involves risk. A simulation does not guarantee price or outcome. FloFi never holds your keys or your funds.', unsubscribe: 'Unsubscribe', privacy: 'Privacy Policy',
    list: 'You’re getting this because you joined the FloFi beta list at flofi.xyz/board.', invited: 'You’re getting this because the FloFi team invited you to the closed beta.',
    access: 'You’re getting this because you asked for a boarding link at flofi.xyz/board.', boarded: 'You’re getting this because you boarded Flight FloFi.' },
  PT: { risk: 'DeFi envolve risco. A simulação não garante preço nem resultado. A FloFi nunca guarda suas chaves nem seus fundos.', unsubscribe: 'Descadastrar', privacy: 'Política de Privacidade',
    list: 'Você recebeu este e-mail porque entrou na lista beta da FloFi em flofi.xyz/board.', invited: 'Você recebeu este e-mail porque o time da FloFi enviou um convite para você para o beta fechado.',
    access: 'Você recebeu este e-mail porque pediu um link de embarque em flofi.xyz/board.', boarded: 'Você recebeu este e-mail porque embarcou no Flight FloFi.' },
} as const;

/** Plain text: the same words, one paragraph per line. */
function plain(lines: (string | null | false | undefined)[], ctx: EmailContext, reason: string): string {
  const t = FOOTER[ctx.language];
  return [...lines.filter((line): line is string => typeof line === 'string'), '—', t.risk, `${reason} ${t.unsubscribe}: ${ctx.unsubscribeUrl}`, `${t.privacy}: ${ctx.origin}/privacy`].join('\n\n') + '\n';
}
const share = (card: CardView, language: EmailLanguage) => {
  const steps = `${card.stepCount} ${card.stepCount === 1 ? 'step' : 'steps'}`;
  // The approved post text (card handoff), in English on X for both languages: the card itself is English.
  const text = card.founding ? `I just boarded Flight FloFi ✈️ Founding Member ${card.seat}. ${card.from} → ${card.to} in ${steps}, and I approve every step. @FloFi_xyz`
    : `I just boarded Flight FloFi ✈️ ${card.from} → ${card.to} in ${steps}, and I approve every step. @FloFi_xyz`;
  void language;
  return `https://x.com/intent/post?${new URLSearchParams({ text, url: card.publicUrl })}`;
};
export const shareText = share;
function cardBlock(card: CardView, ctx: EmailContext, heading: string): string {
  const PT = ctx.language === 'PT';
  const meta = `${card.founding ? `FOUNDING ${card.seat}` : `${PT ? 'ASSENTO' : 'SEAT'} ${card.seat}`} · ${card.stepCount} ${PT ? (card.stepCount === 1 ? 'PASSO' : 'PASSOS') : (card.stepCount === 1 ? 'STEP' : 'STEPS')} · ${flapDay(Date.parse(card.departedAt), false, ctx.language)} · ${PT ? 'VOCÊ APROVA' : 'YOU APPROVE'}`;
  return `<div style="font-family:${MONO};font-weight:500;font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:${C.blue};padding:0 0 8px">${e(heading)}</div>
<a href="${e(card.publicUrl)}"><img src="${e(card.imageUrl)}" width="528" alt="${e(`${card.handle ? `@${card.handle} · ` : ''}${card.from} → ${card.to} · ${meta}`)}" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:14px;margin:0 0 10px"></a>
<p style="margin:0 0 18px;font-family:${MONO};font-weight:500;font-size:12px;letter-spacing:.6px;color:${C.label}">${card.handle ? `@${e(card.handle)} · ` : ''}${e(card.from)} → ${e(card.to)}<br>${e(meta)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr>
<td style="background:${C.navy};border-radius:999px"><a href="${e(share(card, ctx.language))}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-weight:600;font-size:16px;color:${C.white};text-decoration:none">${ctx.language === 'PT' ? 'Compartilhar no X' : 'Share on X'}</a></td><td style="width:10px"></td>
<td style="background:${C.blue};border-radius:999px"><a href="${e(card.downloadUrl)}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-weight:600;font-size:16px;color:${C.white};text-decoration:none">${ctx.language === 'PT' ? 'Baixar cartão' : 'Download card'}</a></td>
</tr></table>`;
}

/** Render one email. Throws on a template whose inputs are missing (the caller then holds the email, never sends a broken one). */
export function renderEmail(input: TemplateInput, ctx: EmailContext): RenderedEmail {
  const PT = ctx.language === 'PT', cal = ctx.calendar, o = ctx.origin;
  const boardsDay = longDay(cal.boardingOpensAt, ctx.language), boardsAt = clock(cal.boardingOpensAt, ctx.language);
  const reason = FOOTER[ctx.language];
  switch (input.template) {
    case 'EARLY_LIST': {
      const subject = PT ? 'Você chegou cedo. Seu lugar no Flight FloFi está guardado ✈️' : 'You were early. Your Flight FloFi seat is saved ✈️';
      const preheader = PT ? 'Você se inscreveu antes de todo mundo. Veja o que acontece na quinta.' : "You signed up before anyone else. Here's what happens Thursday.";
      const intro = PT ? 'Você se inscreveu no beta da FloFi antes de a lista ir para flofi.xyz/board. Não precisa fazer nada: você está na lista, na ordem em que se inscreveu.'
        : "You signed up for the FloFi beta before the list moved to flofi.xyz/board. You don't need to do anything: you're on the list, in the order you signed up.";
      const boards = PT ? `O embarque abre na <b>${e(boardsDay)}, às ${e(boardsAt)} (horário de Brasília)</b>, em grupos por ordem de inscrição. Avisamos por e-mail assim que o seu grupo embarcar.`
        : `Boarding opens <b>${e(boardsDay)}, at ${e(boardsAt)} BRT</b>, in groups by signup order. We’ll email you the moment your group boards.`;
      const ask = PT ? '<b>Para onde você iria primeiro?</b> Responda com a sua rota, do seu jeito.' : '<b>Where would you go first?</b> Reply with your route, in your own words.';
      const example = PT ? '“levar meu USDC da Ethereum para a Base e emprestar na Aave”' : '“move my USDC from Ethereum to Base and lend it on Aave”';
      const reasonEarly = PT ? 'Você recebeu este e-mail porque entrou na lista beta da FloFi pelo nosso formulário de inscrição.'
        : "You're getting this because you joined the FloFi beta list through our signup form.";
      const title = PT ? 'Você chegou cedo.<br>Seu lugar está guardado.' : 'You were early.<br>Your seat is saved.';
      const body = h1(title) + p(e(intro)) + panel([label(PT ? 'Passageiro' : 'Passenger') + `<div style="font-family:${MONO};font-weight:500;font-size:16px;color:${C.navy}">${e(ctx.recipient)}</div>`,
        label('Status') + flaps('ON THE LIST'), label(PT ? 'Embarque' : 'Boards') + flaps(flapDay(cal.boardingOpensAt))]) + p(boards) + p(ask) + mono(example);
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: 'Flight FloFi · Early list', pose: 'welcome', body, reason: reasonEarly }),
        text: plain([subject, intro, `${PT ? 'Passageiro' : 'Passenger'}: ${ctx.recipient}`, 'Status: ON THE LIST', strip(boards), strip(ask), example], ctx, reasonEarly) };
    }
    case 'LIST_CONFIRMATION': {
      const subject = PT ? 'Você está na lista beta da FloFi ✈️' : 'You’re on the FloFi beta list ✈️';
      const preheader = PT ? `Primeiro embarque: ${shortDay(cal.boardingOpensAt, 'PT')}, ${boardsAt}.` : `First boarding: ${shortDay(cal.boardingOpensAt, 'EN')}, ${boardsAt} BRT.`;
      const intro = PT ? `O Flight FloFi embarca na <b>${e(boardsDay)}, às ${e(boardsAt)} (horário de Brasília)</b>, abrindo em grupos. Avisamos por e-mail assim que o seu grupo embarcar.`
        : `Flight FloFi boards <b>${e(boardsDay)}, at ${e(boardsAt)} BRT</b>, opening in groups. We’ll email you the moment your group boards.`;
      const ask = PT ? '<b>Até lá: para onde você iria primeiro?</b> Responda este e-mail com a sua rota, do seu jeito. Algo como:' : '<b>Until then: where would you go first?</b> Reply to this email with your route, in your own words. Something like:';
      const example = PT ? '“levar meu USDC da Ethereum para a Base e emprestar na Aave”' : '“move my USDC from Ethereum to Base and lend it on Aave”';
      const read = PT ? 'Lemos todas as respostas, e as rotas mais pedidas definem os primeiros voos.' : 'We read every reply, and the most wanted routes shape the first flights.';
      const body = h1(PT ? 'Você está na lista.' : 'You’re on the list.') + p(intro)
        + panel([label(PT ? 'Passageiro' : 'Passenger') + `<div style="font-family:${MONO};font-weight:500;font-size:16px;color:${C.navy}">${e(ctx.recipient)}</div>`,
          label(PT ? 'Situação' : 'Status') + flaps(PT ? 'NA LISTA' : 'ON THE LIST'), label(PT ? 'Embarque' : 'Boards') + flaps(flapDay(cal.boardingOpensAt, true, ctx.language))])
        + p(ask) + mono(example) + p(read);
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Lista beta' : 'Flight FloFi · Beta list', pose: 'welcome', body, reason: reason.list }),
        text: plain([subject, PT ? 'Você está na lista.' : 'You’re on the list.', strip(intro), `${PT ? 'Passageiro' : 'Passenger'}: ${ctx.recipient}`, PT ? 'Situação: NA LISTA' : 'Status: ON THE LIST',
          `${PT ? 'Embarque' : 'Boards'}: ${flapDay(cal.boardingOpensAt, true, ctx.language)} BRT`, strip(ask), example, read], ctx, reason.list) };
    }
    case 'EVE': {
      const subject = PT ? `O embarque começa amanhã, às ${boardsAt} ✈️` : `Boarding starts tomorrow, ${boardsAt} BRT ✈️`;
      const preheader = PT ? 'Os grupos abrem por ordem de inscrição.' : 'Groups open in signup order.';
      const intro = PT ? `O primeiro grupo embarca na <b>${e(boardsDay)}, às ${e(boardsAt)} (horário de Brasília)</b>. Os grupos abrem por ordem de inscrição, e avisamos por e-mail assim que o seu abrir.`
        : `The first group boards <b>${e(boardsDay)}, at ${e(boardsAt)} BRT</b>. Groups open in signup order, and we’ll email you the moment yours does.`;
      const before = PT ? '<b>Antes de embarcar:</b> deixe a sua carteira pronta, com um pouco a mais para as taxas de rede. É mainnet, com dinheiro real. A FloFi monta a rota e simula, e nada se move até você revisar e assinar na sua carteira.'
        : '<b>Before you board:</b> have your wallet ready, with a little extra for network fees. This is mainnet, with real funds. FloFi builds the route and simulates it, and nothing moves until you review and sign in your own wallet.';
      const body = h1(PT ? 'O embarque começa ' : 'Boarding starts ', PT ? 'amanhã.' : 'tomorrow.') + p(intro)
        + panel([label(PT ? 'Portão abre' : 'Gate opens') + flaps(flapDay(cal.boardingOpensAt, true, ctx.language))]) + p(before);
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Última chamada' : 'Flight FloFi · Final call', pose: 'wink', body, reason: reason.list }),
        text: plain([subject, strip(intro), `${PT ? 'Portão abre' : 'Gate opens'}: ${flapDay(cal.boardingOpensAt, true, ctx.language)} BRT`, strip(before)], ctx, reason.list) };
    }
    case 'GROUP_BOARDING': case 'ACCESS_REQUESTED': {
      if (!/^\d{6}$/.test(input.code) || !/^\/board\/access(\?l=(en|pt))?#t=[A-Za-z0-9_-]{43}$/.test(input.accessUrl.slice(o.length)) || !input.accessUrl.startsWith(o))
        throw new Error('EMAIL_TEMPLATE_INPUT_INVALID');
      const subject = PT ? 'Seu grupo está embarcando ✈️' : 'Your group is boarding ✈️';
      const preheader = PT ? 'Diga para onde vai. Você aprova cada passo.' : 'Say where you’re going. You approve every step.';
      const intro = PT ? 'O seu portão abriu. Diga à FloFi para onde quer levar as suas criptos, veja cada passo simulado e assine só o que aprovar.'
        : 'Your gate is open. Tell FloFi where you want your crypto to go, see every step simulated, and sign only what you approve.';
      const hours = input.linkHours, minutes = input.codeMinutes;
      const codeLife = minutes >= 120 ? (PT ? `${Math.round(minutes / 60)} horas` : `${Math.round(minutes / 60)} hours`) : (PT ? `${minutes} minutos` : `${minutes} minutes`);
      const note = PT ? `Este botão confirma o seu embarque com este e-mail, sem senha, uma vez, e vale por ${hours} horas.`
        : `This button confirms your boarding with this email, no password, once, and works for ${hours} hours.`;
      const returning = PT ? 'Depois de vincular este acesso à sua conta FloFi, entre com a carteira já vinculada, comprovando que ela é sua pela Privy. Você não precisa informar o e-mail novamente, mesmo em outro aparelho.'
        : 'After linking this access to your FloFi account, sign in with your linked wallet, proving you control it through Privy. You won’t need to enter your email again, even on another device.';
      const other = PT ? `Em outro aparelho? Em flofi.xyz/board, digite este e-mail e o código acima. O código vale por ${codeLife}, uma vez. Precisa de outro? Digite seu e-mail em flofi.xyz/board e enviamos um código novo.`
        : `On another device? At flofi.xyz/board, enter this email and the code above. The code works for ${codeLife}, once. Need another? Enter your email at flofi.xyz/board and we’ll send you a new 6-digit code.`;
      const founding = PT ? 'As 100 primeiras pessoas a embarcar viram <b>Founding Members</b>: assento numerado, acesso antecipado à FloFi no Claude e no ChatGPT (em breve) e 3 convites.'
        : 'The first 100 to board become <b>Founding Members</b>: a numbered seat, first access to FloFi in Claude and ChatGPT (coming soon), and 3 invites.';
      const rows = [label(PT ? 'Portão' : 'Gate') + flaps(PT ? 'ABERTO' : 'OPEN'), ...input.group ? [label(PT ? 'Grupo' : 'Group') + flaps(PT ? `GRUPO ${input.group}` : `GROUP ${input.group}`)] : []];
      const body = h1(PT ? 'Seu grupo ' : 'Your group ', PT ? 'está embarcando.' : 'is boarding.') + p(intro) + panel(rows)
        + button(input.accessUrl, PT ? 'Embarcar agora →' : 'Board now →') + small(e(note))
        + panel([label(PT ? 'Código de 6 dígitos' : '6-digit code') + flaps(input.code)]) + small(e(other)) + small(e(returning))
        + (input.foundingOpen ? `<div style="border-top:1.5px solid #E2E7EE;padding-top:16px">${p(founding, 16)}</div>` : '');
      const why = input.template === 'ACCESS_REQUESTED' ? reason.access : reason.list;
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Embarcando' : 'Flight FloFi · Now boarding', pose: 'welcome', body, reason: why }),
        text: plain([subject, strip(intro), ...input.group ? [`${PT ? 'Grupo' : 'Group'}: ${input.group}`] : [], `${PT ? 'Embarcar agora' : 'Board now'}: ${input.accessUrl}`, note,
          `${PT ? 'Código de 6 dígitos' : '6-digit code'}: ${input.code}`, other, returning, input.foundingOpen && strip(founding)], ctx, why) };
    }
    case 'CARD_FOUNDING': {
      if (input.invites.length !== 0 && input.invites.length !== 3) throw new Error('EMAIL_TEMPLATE_INPUT_INVALID');
      const card = input.card;
      const subject = PT ? `Você é Founding Member ${card.seat} ✈️` : `You’re Founding Member ${card.seat} ✈️`;
      const preheader = input.invites.length ? (PT ? 'Seu cartão de embarque e 3 convites estão aqui.' : 'Your boarding card and 3 invites are inside.')
        : (PT ? 'Seu cartão de embarque está aqui.' : 'Your boarding card is inside.');
      const perks = PT ? ['Seu assento numerado e o seu @ no mural de Founding Members', 'Acesso antecipado à FloFi no Claude e no ChatGPT, em breve', 'O time da FloFi junto com você no Discord', '3 convites para trazer gente a bordo, sem lista']
        : ['Your numbered seat and your @ on the Founding Members wall', 'First access to FloFi in Claude and ChatGPT, coming soon', 'The FloFi team beside you on Discord', '3 invites to bring people on board, no list needed'];
      const shownPerks = input.invites.length ? perks : perks.slice(0, 3);
      const intro = PT ? 'Você está entre as 100 primeiras pessoas do Flight FloFi. O que vem com o seu assento:' : 'You’re one of the first 100 on Flight FloFi. Here’s what comes with your seat:';
      const tip = PT ? 'Poste o cartão como imagem para ter mais alcance, e marque @FloFi_xyz para a gente repostar.' : 'Post the card as an image for the best reach, and tag @FloFi_xyz so we can repost it.';
      const invites = input.invites.length ? `<div style="font-family:${MONO};font-weight:500;font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:${C.blue};padding:0 0 8px">${PT ? 'Seus 3 convites' : 'Your 3 invites'}</div>`
        + p(PT ? 'Traga três pessoas a bordo, sem precisar da lista. Cada código vale uma vez.' : 'Bring three people on board, no list needed. Each code works once.', 16)
        + input.invites.map(code => `<div style="padding:0 0 6px">${flaps(code)}</div>`).join('') + `<div style="height:12px"></div>` + button(input.invitesUrl, PT ? 'Enviar convite' : 'Send an invite', C.navy) : '';
      const body = h1(PT ? 'Boas-vindas a bordo,<br>' : 'Welcome aboard,<br>', `Founding Member ${e(card.seat)}.`) + p(intro) + list(shownPerks.map(e))
        + cardBlock(card, ctx, PT ? 'Seu cartão de embarque' : 'Your boarding card') + invites + small(e(tip));
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Founding Member' : 'Flight FloFi · Founding Member', pose: 'captain', body, reason: reason.boarded }),
        text: plain([subject, intro, ...shownPerks.map(perk => `· ${perk}`), `${PT ? 'Seu cartão' : 'Your card'}: ${card.publicUrl}`, `${PT ? 'Baixar cartão' : 'Download card'}: ${card.downloadUrl}`,
          ...input.invites.length ? [`${PT ? 'Seus 3 convites' : 'Your 3 invites'}: ${input.invites.join('  ')}`, `${PT ? 'Enviar convite' : 'Send an invite'}: ${input.invitesUrl}`] : [], tip], ctx, reason.boarded) };
    }
    case 'CARD_PASSENGER': {
      const card = input.card;
      const subject = PT ? 'Seu cartão de embarque do Flight FloFi ✈️' : 'Your Flight FloFi boarding card ✈️';
      const preheader = PT ? 'Você está a bordo. Seu cartão está aqui.' : 'You’re on board. Your card is inside.';
      const intro = PT ? 'Os assentos Founding acabaram, então você voa como passageiro. Mesmo voo, mesma regra: você aprova cada passo.'
        : 'Founding seats are taken, so you’re flying as a passenger. Same flight, same rule: you approve every step.';
      const tip = PT ? 'Poste o cartão como imagem para ter mais alcance, e marque @FloFi_xyz para a gente repostar.' : 'Post the card as an image for the best reach, and tag @FloFi_xyz so we can repost it.';
      const body = h1(PT ? 'Você está a bordo.' : 'You’re on board.') + p(intro) + cardBlock(card, ctx, PT ? 'Seu cartão de embarque' : 'Your boarding card') + small(e(tip));
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · A bordo' : 'Flight FloFi · On board', pose: 'welcome', body, reason: reason.boarded }),
        text: plain([subject, intro, `${PT ? 'Seu cartão' : 'Your card'}: ${card.publicUrl}`, `${PT ? 'Baixar cartão' : 'Download card'}: ${card.downloadUrl}`, tip], ctx, reason.boarded) };
    }
    case 'NEXT_FLIGHT': {
      const subject = PT ? 'Você está na lista do próximo voo ✈️' : 'You’re on the list for the next flight ✈️';
      const preheader = PT ? 'Avisamos quando o próximo grupo abrir.' : 'We’ll email you when the next group opens.';
      const intro = PT ? 'A lista do primeiro voo fechou, e você está na lista do próximo. Avisamos por e-mail assim que ele abrir.'
        : 'The list for the first flight is closed, and you’re on the list for the next one. We’ll email you the moment it opens.';
      const ask = PT ? 'Para onde você iria primeiro? Responda com a sua rota, do seu jeito. Algo como:' : 'Where would you go first? Reply with your route, in your own words. Something like:';
      const example = PT ? '“levar meu USDC da Ethereum para a Base e emprestar na Aave”' : '“move my USDC from Ethereum to Base and lend it on Aave”';
      const body = h1(PT ? 'Você está no<br>' : 'You’re on<br>', PT ? 'próximo voo.' : 'the next flight.') + p(intro)
        + panel([label(PT ? 'Passageiro' : 'Passenger') + `<div style="font-family:${MONO};font-weight:500;font-size:16px;color:${C.navy}">${e(ctx.recipient)}</div>`,
          label(PT ? 'Portão' : 'Gate') + flaps(PT ? 'PRÓXIMO VOO' : 'NEXT FLIGHT')]) + p(ask) + mono(example);
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Próximo voo' : 'Flight FloFi · Next flight', pose: 'safety', body, reason: reason.list }),
        text: plain([subject, intro, `${PT ? 'Passageiro' : 'Passenger'}: ${ctx.recipient}`, ask, example], ctx, reason.list) };
    }
    case 'CREATOR_INVITE': {
      if (!/^FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(input.code) || input.briefUrl !== FLIGHT_CREATOR_BRIEF_URL) throw new Error('EMAIL_TEMPLATE_INPUT_INVALID');
      const subject = PT ? 'Seu convite para o beta da FloFi ✈️' : 'Your invite to the FloFi beta ✈️';
      const preheader = PT ? 'Seu código e como embarcar na quinta.' : 'Your code, and how to board on Thursday.';
      const headline = PT ? 'Obrigada por embarcar com a gente.' : 'Thanks for coming aboard.';
      const intro = PT ? 'Você está entre as primeiras pessoas a usar a FloFi fora do nosso time. Ainda estamos no começo: é uma primeira versão, e queremos aprender com o seu uso. Comece com valores pequenos, porque é mainnet, com dinheiro de verdade.'
        : "You're one of the first people to use FloFi outside our team. It's still early: this is a first version, and we want to learn from how you use it. Please start with small amounts, since it runs on mainnet with real funds.";
      const steps = PT ? [
        'Quinta, a partir das 9h, entra em flofi.xyz/board, toca em "I have an invite code" e digita o seu código e o seu e-mail.',
        'Conecta a sua carteira, escreve o que quer fazer, confere a simulação e assina só o que fizer sentido pra você.',
        'Conta pra nós como foi: onde travou, o que demorou, o que te deixou em dúvida antes de assinar. Pode responder este e-mail ou mandar mensagem pra Dayane no WhatsApp ou no Telegram.']
        : ['Thursday from 9:00 BRT, go to flofi.xyz/board, tap "I have an invite code" and enter your code and email.',
          'Connect your wallet, write what you want to do, check the simulation and sign only what makes sense to you.',
          'Tell us how it went: where you got stuck, what was slow, what made you hesitate before signing. Reply to this email or message Dayane on WhatsApp or Telegram.'];
      const cta = PT ? 'Ler o brief do convidado' : 'Read the guest brief';
      const note = PT ? 'Depois da sua primeira rota, o seu cartão de embarque chega por e-mail. Se você curtir e quiser compartilhar, ajuda muito, mas fica totalmente a seu critério. O seu código é pessoal e funciona uma vez só.'
        : 'After your first route, your boarding card arrives by email. If you enjoy it and feel like sharing, it really helps us, but it is entirely up to you. Your code is personal and works once.';
      const why = PT ? reason.invited : "You're getting this because the FloFi team invited you to the closed beta.";
      const boarding = flapDay(cal.boardingOpensAt);
      const numbered = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${steps.map((step, index) => `<tr><td style="vertical-align:top;padding:0 12px 12px 0"><div style="width:26px;height:26px;border-radius:26px;background:${C.navy};color:${C.white};font-family:${MONO};font-weight:500;font-size:14px;line-height:26px;text-align:center">${index + 1}</div></td><td style="font-family:${SANS};font-size:16px;line-height:1.5;color:${C.body};padding:0 0 12px">${e(step)}</td></tr>`).join('')}</table>`;
      const body = h1(e(headline)) + p(e(intro))
        + panel([label(PT ? 'CÓDIGO DE CONVITE' : 'Invite code') + flaps(input.code), label(PT ? 'EMBARQUE' : 'Boarding') + flaps(boarding)])
        + numbered + button(input.briefUrl, cta, C.navy) + small(e(note));
      return { subject, preheader, html: layout(ctx, { subject, preheader, band: PT ? 'Flight FloFi · Convite' : 'Flight FloFi · Invited', pose: 'wink', body, reason: why }),
        text: plain([subject, preheader, headline, intro, `${PT ? 'CÓDIGO DE CONVITE' : 'Invite code'} = ${input.code}`, `${PT ? 'EMBARQUE' : 'Boarding'} = ${boarding}`,
          ...steps.map((step, index) => `${index + 1}. ${step}`), `${cta}: ${input.briefUrl}`, note], ctx, why) };
    }
  }
}
/** HTML fragments of the copy as plain text. */
function strip(html: string): string {
  return html.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

