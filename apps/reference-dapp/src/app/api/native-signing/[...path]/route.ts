// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: `/api/native-signing/…` — where a conversation's native signing buttons and the owner's wallet app (Phantom,
 * Solflare) hand over to FloFi (`src/server/native-signing`):
 *
 *   GET  start                         a conversation's "Sign with …" button (its token in the URL fragment): the start page
 *   POST start                         { token } → the wallet's connect request
 *   GET  <approval>/<session>/<tag>    a wallet's answer (connect, sign-in proof, signed transaction) → the next wallet request, the signer's Review after
 *                                      the proof, or "back to your conversation"
 *   GET  <approval>/<session>/confirm/<ref>   the conversation's single-use confirmation of its Review → the wallet's signing request (the same request
 *                                      again for the same confirmation)
 *
 * Off unless `FLOFI_NATIVE_SIGNING` is unset, empty or `enabled`. Nothing here signs: the wallet signs, and the flow verifies and broadcasts the exact reviewed bytes.
 */
import { after, NextResponse, type NextRequest } from 'next/server';
import { nativeSigningEnabled, nativeSigningService, startFromChannelToken } from '../../../../server/native-signing/runtime';
import { nativeMessage, nativeRefusalText } from '../../../../server/native-signing/messages';
import { startPage, statusPage, walletPage, type PageLanguage } from '../../../../server/native-signing/pages';
import { DEEPLINK_WALLETS } from '../../../../server/native-signing/deeplink/protocol';
import { publicOrigin } from '../../../../server/deployment';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const codeOf = (error: unknown) => error instanceof Error && CODE.test(error.message) ? error.message : 'NATIVE_SIGNING_UNAVAILABLE';
const languageOf = (request: NextRequest): PageLanguage => /^pt\b/i.test(request.headers.get('accept-language') ?? '') ? 'PT' : 'EN';
const html = (p: { status: number; html: string; headers: Readonly<Record<string, string>> }) => new NextResponse(p.html, { status: p.status, headers: p.headers });
const telegramBot = () => /^[A-Za-z0-9_]{5,32}$/.test(process.env.FLOFI_TELEGRAM_BOT_USERNAME ?? '') ? process.env.FLOFI_TELEGRAM_BOT_USERNAME! : null;
const endedLine = (session: Parameters<typeof nativeMessage>[1] | null, language: PageLanguage) => {
  const origin = publicOrigin(process.env);
  if (!session || !origin) return null;
  return nativeMessage(origin, session, 'ENDED')?.text[language] ?? null;
};
type Params = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const language = languageOf(request), path = (await params).path ?? [];
  if (!nativeSigningEnabled(process.env)) return html(statusPage('ENDED', null, language, { ended: language === 'PT' ? 'Indisponível nesta implantação.' : 'Not available on this deployment.' }));
  if (path.length === 1 && path[0] === 'start') return html(startPage(language));
  const [handoffId, sessionId, step, confirmTag] = path;
  if (!handoffId || !sessionId || !step || path.length > 4) return html(statusPage('IGNORED', null, language));
  try {
    const service = await nativeSigningService(process.env);
    if (step === 'confirm' && path.length === 4) {
      const confirmed = await service.confirm({ handoffId, sessionId, confirmRef: confirmTag ?? '' });
      if (confirmed.kind === 'REFRESHED') return html(statusPage('REFRESHED', confirmed.session, language, { telegramBot: telegramBot() }));
      const session = await service.latestById(handoffId, sessionId);
      return html(walletPage(confirmed.url, session ? DEEPLINK_WALLETS[session.wallet].name : 'wallet', language));
    }
    if (path.length !== 3) return html(statusPage('IGNORED', null, language));
    const outcome = await service.callback(handoffId, sessionId, step, request.nextUrl.searchParams);
    // Just sent: a bounded follow-up after this response observes the run and posts its verified receipt to the conversation.
    // Only the answer that made the broadcast schedules it (a replayed or forged callback never does).
    if (outcome.kind === 'PAGE' && outcome.submitted === true)
      after(() => service.follow(handoffId, sessionId, { attempts: 7, intervalMs: 5_000 }).then(() => undefined).catch(() => undefined));
    if (outcome.kind === 'WALLET') { const session = await service.latestById(handoffId, sessionId);
      return html(walletPage(outcome.url, session ? DEEPLINK_WALLETS[session.wallet].name : 'wallet', language)); }
    return html(statusPage(outcome.page, outcome.session, language, { telegramBot: telegramBot(), ended: endedLine(outcome.session, language) }));
  } catch (error) {
    const session = await nativeSigningService(process.env).then(s => s.latestById(handoffId, sessionId)).catch(() => null);
    // After the signed bytes arrived, never "nothing changed": the page says it was signed and the status follows in the conversation.
    if (session && (session.state === 'SUBMITTING' || session.state === 'SUBMITTED')) return html(statusPage('RETURN', session, language, { telegramBot: telegramBot() }));
    // A wallet request is still out (it may yet be signed): say why this step did not go on, never "nothing was signed or sent".
    if (session && session.state === 'AWAITING_SIGNATURE') return html(statusPage('NOTICE', session, language, { telegramBot: telegramBot(),
      ended: codeOf(error) === 'NATIVE_CONFIRMATION_LAPSED' ? nativeRefusalText('NATIVE_CONFIRMATION_LAPSED', DEEPLINK_WALLETS[session.wallet].name)[language] : null }));
    return html(statusPage(session?.state === 'ENDED' ? 'ENDED' : 'IGNORED', session, language, { telegramBot: telegramBot(),
      ended: session?.state === 'ENDED' ? endedLine(session, language) : codeOf(error) }));
  }
}

/** `POST start` with `{ token }` from the start page's own script: the wallet's connect request, or a plain refusal. */
export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const path = (await params).path ?? [], language = languageOf(request);
  if (path.length !== 1 || path[0] !== 'start' || !nativeSigningEnabled(process.env)) return NextResponse.json({ ok: false }, { status: 404 });
  const origin = publicOrigin(process.env), sameOrigin = request.headers.get('origin');
  if (!origin || (sameOrigin !== null && sameOrigin !== origin)) return NextResponse.json({ ok: false }, { status: 403 });
  let token: unknown;
  try { token = ((await request.json()) as { token?: unknown })?.token; } catch { token = null; }
  try {
    const started = await startFromChannelToken(process.env, token);
    return NextResponse.json({ ok: true, url: started.connectUrl, label: language === 'PT' ? `Abrir o ${started.wallet}` : `Open ${started.wallet}` },
      { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const code = codeOf(error);
    // A known refusal in plain words (already sent, a request still open, status not shared, the approval ended); anything else: try again later.
    const known = code !== 'NATIVE_SIGNING_UNAVAILABLE' && code !== 'CLOUD_RUNTIME_UNAVAILABLE' && code !== 'NATIVE_SIGNING_BUSY' ? nativeRefusalText(code, language === 'PT' ? 'carteira' : 'wallet')[language] : null;
    const message = code === 'NATIVE_START_INVALID' ? (language === 'PT' ? 'Este botão não vale mais. Peça uma nova proposta na conversa.' : 'This button is no longer valid. Ask for a new proposal in your conversation.')
      : known ?? (language === 'PT' ? 'Não foi possível iniciar a assinatura agora. Nada foi assinado. Tente de novo pela conversa.' : 'Could not start signing right now. Nothing was signed. Try again from your conversation.');
    return NextResponse.json({ ok: false, code, message }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
}
