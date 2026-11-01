// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { engineeringUiAllowed } from '../../server/engineering-ui';
import { networkScope } from '../../server/network-scope';
import { copilotConfig } from '../../server/copilot-service';
import { ProductWorkspace } from '../../components/product-workspace';
import { LocaleProvider } from '../../i18n/locale';
import { LANGUAGE_COOKIE, parseLanguage } from '../../i18n/language';
import { parseWalletHint, WALLET_HINT_COOKIE } from '../../wallet/wallet-hint';
import { FloFiPrivyProvider } from '../../accounts/privy-client';
import { privyBrowserConfig } from '../../accounts/privy-server';
import { SessionGuard } from '../../components/account/session-guard';
import '@xyflow/react/dist/style.css';
import '../globals.css';

/**
 * One persistent workspace for /app, its deep links, /approve and /connections.
 * BUILD-FLOFI-PRODUCT-UX-001: the server renders the screen the owner will keep seeing — their language, a neutral wallet slot while a remembered
 * session reconnects, and the Copilot mode this deployment is configured for (the live mode is still confirmed by the client) — so hydration
 * never swaps one interface for another.
 */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  await connection();
  const initialWorkflowId = `workflow-${randomUUID()}`;
  const jar = await cookies();
  const configured = copilotConfig(process.env).mode;
  const bootstrap = { walletHint: parseWalletHint(jar.get(WALLET_HINT_COOKIE)?.value), copilotMode: configured };
  // BUILD-FLOFI-PRIVY-UX-001: the person's Privy wallets sign here (with Privy's own confirmation), and Disconnect logs out of Privy. The page
  // runs under the proxy's nonce policy (account-csp.ts productPagePolicy): Next.js puts the nonce on its own scripts.
  return <LocaleProvider initialLanguage={parseLanguage(jar.get(LANGUAGE_COOKIE)?.value) ?? 'EN'}>
    <FloFiPrivyProvider config={privyBrowserConfig(process.env)} accounts={Boolean(process.env.DATABASE_URL)}><SessionGuard/>
      <ProductWorkspace initialWorkflowId={initialWorkflowId} engineeringEnabled={await engineeringUiAllowed()} networkScope={networkScope()} bootstrap={bootstrap}/>{children}
    </FloFiPrivyProvider>
  </LocaleProvider>;
}
