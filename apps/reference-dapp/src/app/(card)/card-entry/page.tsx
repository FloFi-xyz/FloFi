// SPDX-License-Identifier: AGPL-3.0-only
import { connection } from 'next/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cardOrigin } from '../../../server/card-origin';
import { cardProviderStatus } from '../../../server/card-provider';
import { CardEntryFrame, CardEntryUnavailable } from '../../../components/card-entry-frame';
import { LocaleProvider } from '../../../i18n/locale';
import '../../globals.css';

/**
 * BUILD-FLOFI-PRIVY-UX-001: Add card's secure entry, on the card origin only (the proxy serves this page nowhere else; card-origin.ts).
 * No Privy, no workspace, no FloFi session: only the provider's Secure Fields and the fields the provider needs besides the card.
 */
export default async function CardEntryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const params = await searchParams, card = cardOrigin(process.env), status = cardProviderStatus(process.env);
  // Only on the card origin, whatever path alias reached this page (the proxy routes the card host; this is the page's own check).
  if (!card || ((await headers()).get('host') ?? '').toLowerCase() !== card.host.toLowerCase()) notFound();
  const language = params.lang === 'PT' ? 'PT' : 'EN', theme = params.theme === 'dark' ? 'dark' : 'light';
  return <LocaleProvider initialLanguage={language}>
    {status.available ? <CardEntryFrame cardOrigin={card.origin} appOrigin={card.appOrigin} client={status.client} providerName={status.provider.name} theme={theme}/>
      : <CardEntryUnavailable appOrigin={card.appOrigin}/>}
  </LocaleProvider>;
}
