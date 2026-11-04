// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { product } from '../config/product';
import { LocaleProvider } from '../i18n/locale';
import { LANGUAGE_COOKIE, defaultLanguageFor, documentLanguage, parseLanguage } from '../i18n/language';
import './base.css';
import './fonts.css';

export const metadata: Metadata = { title: `${product.name} · Build, Simulate, Execute`, description: 'Compose multichain DeFi workflows, simulate and review the Strategy Manifest, then authorize with your own wallet and follow execution, reconciliation and evidence.' };
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every HTML document on this origin gets a fresh nonce policy, including public and error pages. Reading the request headers
  // makes their render dynamic so Next.js can attach this request's nonce to its bootstrap and hydration scripts.
  const pathname = (await headers()).get('x-flofi-pathname');
  // The visitor's saved language, else the product default (Portuguese), from the first paint: the site, sign-in and /app agree.
  const language = parseLanguage((await cookies()).get(LANGUAGE_COOKIE)?.value) ?? defaultLanguageFor(pathname);
  return <html lang={documentLanguage(language)} className="flofi-fonts"><head>
    <link rel="preload" href="/fonts/outfit-92684e4acde79ef0.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
    <link rel="preload" href="/fonts/ibm-plex-mono-c36f509c0a8f9f85.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
    <link rel="preload" href="/fonts/ibm-plex-mono-a76f53ca6612e7b3.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>
  </head><body><LocaleProvider initialLanguage={language}>{children}</LocaleProvider></body></html>;
}
