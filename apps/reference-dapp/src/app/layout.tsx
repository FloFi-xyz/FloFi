// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { product } from '../config/product';
import { LocaleProvider } from '../i18n/locale';
import { documentLanguage, englishPinnedPath, languageMigrationScript } from '../i18n/language';
import { requestLanguage } from '../server/request-language';
import './base.css';
import './fonts.css';

export const metadata: Metadata = { title: `${product.name} · Build, Simulate, Execute`, description: 'Compose multichain DeFi workflows, simulate and review the Strategy Manifest, then authorize with your own wallet and follow execution, reconciliation and evidence.' };
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every HTML document on this origin gets a fresh nonce policy, including public and error pages. Reading the request headers
  // makes their render dynamic so Next.js can attach this request's nonce to its bootstrap and hydration scripts.
  const request = await headers(), pathname = request.get('x-flofi-pathname'), nonce = request.get('x-nonce') ?? undefined;
  // P0 hotfix (locale contract, i18n/language.ts): the visitor's saved language (the cookie), else the product default (English), from the
  // first paint: the site, sign-in and /app agree, and nothing in the browser flips it after load.
  const { language, chosen } = await requestLanguage();
  // Only without a cookie (and off the English-pinned surfaces): a legacy preference kept in storage alone is migrated once, before the first
  // paint (the script writes the cookie and reloads hidden only when storage holds the other language). The proxy's nonce allows it.
  const migrate = !chosen && !englishPinnedPath(pathname);
  return <html lang={documentLanguage(language)} className="flofi-fonts"><head>
    {migrate && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: languageMigrationScript(language) }}/>}
    <link rel="preload" href="/fonts/outfit-92684e4acde79ef0.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
    <link rel="preload" href="/fonts/ibm-plex-mono-c36f509c0a8f9f85.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
    <link rel="preload" href="/fonts/ibm-plex-mono-a76f53ca6612e7b3.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
  </head><body><LocaleProvider initialLanguage={language}>{children}</LocaleProvider></body></html>;
}
