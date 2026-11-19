// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: FloFi Wallet's pages (wallet origin only; the proxy serves them nowhere else). No product shell, no
 * workflow engine, no Copilot: only the language provider and the theme bootstrap. Every page renders per request so the proxy's nonce
 * policy (`walletPagePolicy`: no `'unsafe-eval'`, no inline script but this nonce'd one) applies to it and to Next.js's own scripts.
 */
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { LocaleProvider } from '../../i18n/locale';
import { requestLanguage } from '../../server/request-language';
import '../globals.css';

export default async function WalletLayout({ children }: { children: ReactNode }) {
  await connection();
  return <LocaleProvider initialLanguage={(await requestLanguage()).language}>
    {children}
  </LocaleProvider>;
}
