// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the transient pages a phone's browser shows between the conversation and the wallet app. A deeplink answer
 * must land on an https URL, so each hop passes here for a moment: it opens the wallet (or offers one tap to), or says in one line that the step is
 * done and the person can go back to their conversation. No Review, amount or decision lives on these pages (those are in the conversation and the
 * wallet); no external resource, no form, no frame. Only the start page runs a small fixed script (its hash is the only script the CSP allows).
 */
import { createHash } from 'node:crypto';
import { nativeReviewLines } from './review.ts';
import type { NativeReturn, NativeSession } from './session-store.ts';

export type PageLanguage = 'EN' | 'PT';
type Page = { readonly status: number; readonly html: string; readonly headers: Readonly<Record<string, string>> };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const STYLE = 'body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#fff;color:#14233a}main{max-width:520px;margin:12vh auto;padding:0 20px}'
  + 'h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#52627a}a.button{display:inline-block;background:#1d5fca;color:#fff;text-decoration:none;font-weight:700;'
  + 'padding:12px 18px;border-radius:10px}.review{border:1px solid #dce4ef;border-radius:10px;padding:10px 12px;margin:0 0 16px}.review p{margin:0 0 4px;color:inherit;overflow-wrap:anywhere}@media (prefers-color-scheme:dark){body{background:#0f141b;color:#e8edf4}p{color:#9aa8ba}}';
const headers = (script: string | null): Record<string, string> => ({
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; ${script ? `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; ` : ''}`
    + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
function page(language: PageLanguage, title: string, body: string, options: { readonly refresh?: string; readonly script?: string; readonly status?: number } = {}): Page {
  const html = `<!doctype html><html lang="${language === 'PT' ? 'pt-BR' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex">${options.refresh ? `<meta http-equiv="refresh" content="0;url=${escape(options.refresh)}">` : ''}`
    + `<title>${escape(title)}</title><link rel="icon" href="/icon.svg"><style>${STYLE}</style></head><body><main>${body}</main>`
    + `${options.script ? `<script>${options.script}</script>` : ''}</body></html>`;
  return { status: options.status ?? 200, html, headers: headers(options.script ?? null) };
}
const RETURN_LINKS: Readonly<Record<Exclude<NativeReturn, 'NONE' | 'TELEGRAM'>, { readonly url: string; readonly name: string }>> = Object.freeze({
  CHATGPT: { url: 'https://chatgpt.com/', name: 'ChatGPT' }, CLAUDE: { url: 'https://claude.ai/', name: 'Claude' } });
function returnTo(target: NativeReturn | null, language: PageLanguage, telegramBot: string | null): string {
  const pt = language === 'PT';
  if (target === 'TELEGRAM') return telegramBot ? `<p><a class="button" href="tg://resolve?domain=${escape(telegramBot)}">${pt ? 'Voltar ao Telegram' : 'Back to Telegram'}</a></p>`
    : `<p>${pt ? 'Volte ao Telegram.' : 'Go back to Telegram.'}</p>`;
  if (target === 'CHATGPT' || target === 'CLAUDE') { const link = RETURN_LINKS[target];
    return `<p><a class="button" href="${link.url}">${pt ? `Voltar ao ${link.name}` : `Back to ${link.name}`}</a></p>`; }
  return `<p>${pt ? 'Volte à sua conversa.' : 'Go back to your conversation.'}</p>`;
}

/** Hands the browser to the wallet app: an immediate redirect and one tap as the fallback (some in-app browsers open apps only on a tap). */
export function walletPage(url: string, walletName: string, language: PageLanguage): Page {
  const pt = language === 'PT';
  return page(language, `FloFi · ${walletName}`, `<h1>${pt ? `Abrindo o ${escape(walletName)}…` : `Opening ${escape(walletName)}…`}</h1>`
    + `<p>${pt ? 'Se o app não abrir sozinho, toque no botão.' : 'If the app does not open by itself, tap the button.'}</p>`
    + `<p><a class="button" href="${escape(url)}">${pt ? `Abrir o ${escape(walletName)}` : `Open ${escape(walletName)}`}</a></p>`, { refresh: url });
}
const SOURCES: Readonly<Record<NativeReturn, readonly [string, string]>> = Object.freeze({ CHATGPT: ['a ChatGPT conversation', 'uma conversa no ChatGPT'],
  CLAUDE: ['a Claude conversation', 'uma conversa no Claude'], TELEGRAM: ['a Telegram conversation', 'uma conversa no Telegram'],
  NONE: ['an assistant connected to FloFi', 'um assistente conectado à FloFi'] });
/** Where a wallet's answer lands: the signer's Review, done (back to the conversation), already handled, ended, or the wallet reading this link. */
export function statusPage(kind: 'METADATA' | 'REVIEW' | 'RETURN' | 'IGNORED' | 'ENDED' | 'REFRESHED', session: NativeSession | null, language: PageLanguage,
  options: { readonly telegramBot?: string | null; readonly ended?: string | null } = {}): Page {
  const pt = language === 'PT', back = returnTo(session?.returnTo ?? null, language, options.telegramBot ?? null);
  // After the wallet proved the account: the signer sees FloFi's own Review here, and where the request came from, before any transaction is asked
  // of their wallet (whoever confirms it in the conversation). Text only; the confirmation stays in the conversation.
  if (kind === 'REVIEW' && session?.review) {
    const source = SOURCES[session.returnTo] ?? SOURCES.NONE, lines = nativeReviewLines(session.review, language);
    return page(language, 'FloFi', `<h1>${pt ? 'Carteira verificada' : 'Wallet verified'}</h1><p>${pt ? `Este pedido veio de ${source[1]}. Confirme por lá; depois a sua carteira mostra exatamente isto:`
      : `This request came from ${source[0]}. Confirm it there; your wallet then shows exactly this:`}</p>`
      + `<div class="review">${lines.map(line => `<p>${escape(line)}</p>`).join('')}</div>`
      + `<p>${pt ? 'Se não foi você quem pediu isto na sua própria conversa, não confirme e recuse na carteira.' : 'If you did not ask for this in your own conversation, do not confirm it, and reject it in your wallet.'}</p>${back}`);
  }
  if (kind === 'METADATA') return page(language, 'FloFi', `<h1>FloFi</h1><p>${pt ? 'Assinatura pela sua carteira, revisada na sua conversa.' : 'Signing with your wallet, reviewed in your conversation.'}</p>`);
  if (kind === 'IGNORED') return page(language, 'FloFi', `<h1>${pt ? 'Nada mudou' : 'Nothing changed'}</h1><p>${pt
    ? 'Este passo já foi tratado ou o link não vale mais. Nada foi assinado nem enviado por ele.' : 'This step was already handled or the link is no longer valid. Nothing was signed or sent by it.'}</p>${back}`, { status: 409 });
  if (kind === 'REFRESHED') return page(language, 'FloFi', `<h1>${pt ? 'Nova Revisão na conversa' : 'New Review in your conversation'}</h1><p>${pt
    ? 'Os termos mudaram desde a sua Revisão, então a carteira não foi chamada. A FloFi mostrou uma nova Revisão na conversa.'
    : 'The terms changed since your Review, so your wallet was not asked. FloFi showed a new Review in your conversation.'}</p>${back}`);
  if (kind === 'ENDED') return page(language, 'FloFi', `<h1>${pt ? 'Encerrado' : 'Ended'}</h1><p>${escape(options.ended ?? (pt ? 'Este pedido foi encerrado.' : 'This request ended.'))}</p>${back}`);
  const state = session?.state;
  const line = state === 'REVIEW_READY' ? (pt ? 'Carteira verificada. A Revisão está na sua conversa: confira e confirme por lá.' : 'Wallet verified. Your Review is in your conversation: check it and confirm there.')
    : state === 'SUBMITTED' ? (pt ? 'Assinado e entregue à rede uma única vez. A FloFi publica o resultado verificado na sua conversa.' : 'Signed and handed to the network once. FloFi posts the verified result in your conversation.')
      : state === 'SUBMITTING' ? (pt ? 'Assinado. A FloFi está confirmando o envio, que nunca acontece duas vezes; o status segue na sua conversa.'
        : 'Signed. FloFi is confirming the sending, which never happens twice; the status follows in your conversation.')
        : (pt ? 'Feito. Continue na sua conversa.' : 'Done. Continue in your conversation.');
  return page(language, 'FloFi', `<h1>${pt ? 'Pronto' : 'Done'}</h1><p>${line}</p>${back}`);
}
/**
 * A conversation's "Sign with …" button: its token is in the URL fragment (never sent in a request line), so this fixed script posts it once and
 * opens the wallet's connect request it receives.
 */
export const START_SCRIPT = "(function(){var t=location.hash.slice(1);history.replaceState(null,'',location.pathname);var a=document.getElementById('go'),m=document.getElementById('msg');"
  + "if(!t){m.textContent=m.dataset.missing;return;}fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t}),credentials:'omit'})"
  + ".then(function(r){return r.json();}).then(function(j){if(!j||!j.url){m.textContent=j&&j.message||m.dataset.failed;return;}a.href=j.url;a.textContent=j.label;a.hidden=false;location.href=j.url;})"
  + ".catch(function(){m.textContent=m.dataset.failed;});})();";
export function startPage(language: PageLanguage): Page {
  const pt = language === 'PT';
  return page(language, 'FloFi', `<h1>${pt ? 'Abrindo a sua carteira…' : 'Opening your wallet…'}</h1><p id="msg" data-missing="${pt ? 'Este link está incompleto. Volte à conversa.' : 'This link is incomplete. Go back to your conversation.'}"`
    + ` data-failed="${pt ? 'Não foi possível iniciar agora. Nada foi assinado. Volte à conversa e tente de novo.' : 'Could not start right now. Nothing was signed. Go back to your conversation and try again.'}">`
    + `${pt ? 'Se o app não abrir sozinho, toque no botão.' : 'If the app does not open by itself, tap the button.'}</p><p><a class="button" id="go" hidden href="#"></a></p>`, { script: START_SCRIPT });
}
