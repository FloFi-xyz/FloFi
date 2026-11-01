// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRIVY-UX-001: Add card's secure entry, served only on the card origin (src/server/card-origin.ts) inside the product's
 * Add card dialog. Mercado Pago's Secure Fields SDK runs here and nowhere else: the card number, expiry and security code are typed into
 * its own iframes; this page sends the product only the provider's one-time token and the email the provider saves the card under, by
 * `postMessage` to the product origin, and takes from the product only the result of saving it. Opened on its own (not framed by the
 * product), it loads nothing.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { loadMercadoPago, type MercadoPagoInstance, type MercadoPagoSecureField, type SecureFieldType } from './card-secure-fields';
import { CARD_EMAIL, parseCardParentMessage, type CardFrameMessage } from './card-frame-protocol';
import type { CardProviderClient } from '../server/card-provider';

const CARD_FIELDS: readonly { readonly type: SecureFieldType; readonly label: string; readonly placeholder: string }[] = [
  { type: 'cardNumber', label: 'Card number', placeholder: '1234 1234 1234 1234' },
  { type: 'expirationDate', label: 'Expiry', placeholder: 'MM/YY' },
  { type: 'securityCode', label: 'Security code', placeholder: 'CVC' },
];

export function CardEntryFrame({ cardOrigin, appOrigin, client, providerName, theme }: { cardOrigin: string; appOrigin: string; client: CardProviderClient; providerName: string;
  theme: 'light' | 'dark' }) {
  const { t: tr } = useLocale();
  const baseId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const sdk = useRef<MercadoPagoInstance | null>(null);
  const [framed, setFramed] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'unavailable'>('loading');
  const [documents, setDocuments] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const post = (message: CardFrameMessage) => window.parent.postMessage(message, appOrigin);
  // The provider's SDK loads only on the card origin and only when the product frames this page.
  useEffect(() => { document.documentElement.dataset.theme = theme; setFramed(window.parent !== window && location.origin === cardOrigin); }, [theme, cardOrigin]);
  // Escape cancels Add card as it did when the form lived in the product's dialog (key events in this frame never reach the dialog).
  useEffect(() => {
    if (!framed) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') post({ type: 'flofi-card-cancel' }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [framed, appOrigin]);
  // The product's answer to a token: only from the product origin and the window that framed this page.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== appOrigin || event.source !== window.parent) return;
      const message = parseCardParentMessage(event.data);
      if (!message) return;
      if (message.ok) return; // The product closes the dialog.
      setPhase('ready'); setError(message.error ?? 'The card could not be added. Nothing was saved.');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appOrigin]);
  useEffect(() => {
    if (!framed) return;
    let current = true;
    const mounted: MercadoPagoSecureField[] = [];
    void (async () => {
      try {
        const MercadoPago = await loadMercadoPago(client.sdkUrl);
        if (!current) return;
        const instance = new MercadoPago(client.publicKey, { locale: client.locale });
        const tokens = getComputedStyle(document.documentElement);
        const style = { fontSize: '14px', color: tokens.getPropertyValue('--ink').trim() || '#10233f', placeholderColor: tokens.getPropertyValue('--muted').trim() || '#6b778c' };
        for (const field of CARD_FIELDS) mounted.push(instance.fields.create(field.type, { placeholder: field.placeholder, style }).mount(`${baseId}-${field.type}`));
        const types = (await instance.getIdentificationTypes()).map(type => type.id).filter((id): id is string => typeof id === 'string' && /^[A-Z]{2,10}$/.test(id));
        if (!current) return;
        if (!types.length) throw new Error('CARD_SDK_UNAVAILABLE');
        sdk.current = instance; setDocuments(types); setPhase('ready'); post({ type: 'flofi-card-ready' });
      } catch { if (current) { setPhase('unavailable'); post({ type: 'flofi-card-unavailable' }); } }
    })();
    return () => { current = false; sdk.current = null; for (const field of mounted) try { field.unmount(); } catch { /* already gone */ } };
    // `post` only closes over appOrigin.
  }, [baseId, client, framed, appOrigin]);
  async function submit(form: HTMLFormElement) {
    const data = new FormData(form), text = (name: string) => String(data.get(name) ?? '').trim();
    const holder = text('cardholderName'), documentType = text('identificationType'), documentNumber = text('identificationNumber').replace(/\D/g, ''), email = text('email');
    if (!sdk.current || phase !== 'ready') return;
    if (!holder || !documentType || !documentNumber || !email) { setError('Fill in every field.'); return; }
    // Checked before the provider mints a token: the product accepts no other email shape (card-frame-protocol.ts).
    if (email.length > 254 || !CARD_EMAIL.test(email)) { setError('Enter a valid email address.'); return; }
    setError(''); setPhase('saving');
    let token: unknown;
    try { token = (await sdk.current.fields.createCardToken({ cardholderName: holder, identificationType: documentType, identificationNumber: documentNumber })).id; }
    catch { setPhase('ready'); setError('Check the card details and try again.'); return; }
    if (typeof token !== 'string') { setPhase('ready'); setError('Check the card details and try again.'); return; }
    post({ type: 'flofi-card-token', token, email });
  }
  if (framed === false) return <main className="card-entry-standalone"><p>{tr('Open Add card from Credentials in FloFi.')}</p></main>;
  if (phase === 'unavailable') return <main className="card-entry-body" role="status"><p>{tr('Secure card entry could not be loaded. Nothing was collected. Try again later.')}</p></main>;
  return <main className="card-entry-frame-page"><form className="card-entry-form" aria-label={tr('Add a card')} aria-busy={phase !== 'ready'} noValidate
    onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
    <p className="card-entry-note">{tr("Card details are entered in {0}'s secure fields. FloFi receives only a token, the brand, the last four digits and the expiry date.", providerName)}</p>
    {CARD_FIELDS.map(field => <div key={field.type} className={`card-entry-field card-entry-${field.type}`} role="group" aria-labelledby={`${baseId}-${field.type}-label`}>
      <span id={`${baseId}-${field.type}-label`}>{tr(field.label)}</span><div id={`${baseId}-${field.type}`} className="card-entry-secure" data-secure-field={field.type}/>
    </div>)}
    <label className="card-entry-field card-entry-holder">{tr('Name on card')}<input name="cardholderName" autoComplete="cc-name" maxLength={60} required/></label>
    <label className="card-entry-field card-entry-document-type">{tr('Document')}<select name="identificationType" required>{documents.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
    <label className="card-entry-field card-entry-document">{tr('Number')}<input name="identificationNumber" inputMode="numeric" autoComplete="off" maxLength={18} required/></label>
    <label className="card-entry-field card-entry-email">{tr('Email')}<input name="email" type="email" autoComplete="email" maxLength={254} required/></label>
    {error && <p className="workspace-inline-error card-entry-error" role="alert">{tr(error)}</p>}
    <div className="wallet-selector-footer card-entry-actions"><button type="button" className="workspace-action" onClick={() => post({ type: 'flofi-card-cancel' })}>{tr('Cancel')}</button>
      <button type="submit" className="workspace-action" disabled={phase !== 'ready'}>{tr(phase === 'saving' ? 'Adding…' : 'Add card')}</button></div>
  </form></main>;
}

/** The card page when this deployment cannot offer card entry: it says so, and tells the product so Add card shows the same. */
export function CardEntryUnavailable({ appOrigin }: { appOrigin: string | null }) {
  const { t: tr } = useLocale();
  useEffect(() => { if (appOrigin && window.parent !== window) window.parent.postMessage({ type: 'flofi-card-unavailable' } satisfies CardFrameMessage, appOrigin); }, [appOrigin]);
  return <main className="card-entry-body" role="status"><p>{tr('Secure card entry could not be loaded. Nothing was collected. Try again later.')}</p></main>;
}
