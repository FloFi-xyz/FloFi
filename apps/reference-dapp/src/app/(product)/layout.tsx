// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { requireFlightAccess } from '../../server/flight-access';
import { flightGateOutcome, flightGateResponse, flightRequestKind, type FlightGateOutcome } from '../../server/flight-gate';
import { FlightGateScreen } from '../../components/flight/flight-transition';
import { engineeringUiAllowed } from '../../server/engineering-ui';
import { networkScope } from '../../server/network-scope';
import { copilotConfig } from '../../server/copilot-service';
import { ProductWorkspace } from '../../components/product-workspace';
import { LocaleProvider } from '../../i18n/locale';
import { requestLanguage } from '../../server/request-language';
import { parseWalletHint, WALLET_HINT_COOKIE } from '../../wallet/wallet-hint';
import { parsePrivacyNotice, PRIVACY_NOTICE_COOKIE } from '../../domain/privacy-notice';
import { FloFiPrivyProvider } from '../../accounts/privy-client';
import { privyBrowserConfig } from '../../accounts/privy-server';
import { SessionGuard } from '../../components/account/session-guard';
import { learningConfig, sessionAdaptation } from '../../learning/config';
import '@xyflow/react/dist/style.css';
import '../globals.css';
// BUILD-FLOFI-BUILDER-UX-002: the Editor (stepper, workflow header, rail, cards, FloFi summary, footer), after the shared product styles.
import '../editor.css';
// P0 approved UX (boards 03–16): shell, lifecycle and Review styles, then the Editor and secondary-page workstreams.
import '../approved-ux.css';
import '../approved-ux-editor.css';
import '../approved-ux-pages.css';

/**
 * One persistent workspace for /app, its deep links, /approve and /connections.
 * BUILD-FLOFI-PRODUCT-UX-001: the server renders the screen the owner will keep seeing — their language, a neutral wallet slot while a remembered
 * session reconnects, and the Copilot mode this deployment is configured for (the live mode is still confirmed by the client) — so hydration
 * never swaps one interface for another.
 */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  await connection();
  // P0 hotfix (Flight transition, src/server/flight-gate.ts): a refusal leaves for /board (an HTTP redirect for a document, else a full-page
  // hand-off, never a client navigation that would draw /board inside this product document); a failure to check access shows "Try again",
  // never /board. Either way nothing of the workspace renders and none of its data is read.
  let refused: FlightGateOutcome | null = null;
  try { await requireFlightAccess(); } catch (error) { refused = flightGateOutcome(error); }
  if (refused) {
    const response = flightGateResponse(refused, flightRequestKind(await headers()));
    if (response === 'REDIRECT') redirect('/board');
    return <FlightGateScreen response={response}/>;
  }
  const initialWorkflowId = `workflow-${randomUUID()}`;
  const jar = await cookies();
  const configured = copilotConfig(process.env).mode;
  const bootstrap = { walletHint: parseWalletHint(jar.get(WALLET_HINT_COOKIE)?.value), copilotMode: configured,
    privacyNotice: parsePrivacyNotice(jar.get(PRIVACY_NOTICE_COOKIE)?.value) ?? 'UNANSWERED' as const,
    // BUILD-FLOFI-UX-FIX-003: what `learningAvailability()` returns, known with the page instead of asked when Settings first opens.
    learningTier: learningConfig(process.env).enabled ? 'ENABLED' as const : sessionAdaptation(process.env) ? 'SESSION' as const : 'OFF' as const };
  // BUILD-FLOFI-PRIVY-UX-001: the person's Privy wallets sign here (with Privy's own confirmation), and Disconnect logs out of Privy. The page
  // runs under the proxy's nonce policy (account-csp.ts productPagePolicy): Next.js puts the nonce on its own scripts.
  return <LocaleProvider initialLanguage={(await requestLanguage()).language}>
    <FloFiPrivyProvider config={privyBrowserConfig(process.env)} accounts={Boolean(process.env.DATABASE_URL)}><SessionGuard/>
      <ProductWorkspace initialWorkflowId={initialWorkflowId} engineeringEnabled={await engineeringUiAllowed()} networkScope={networkScope()} bootstrap={bootstrap}/>{children}
    </FloFiPrivyProvider>
  </LocaleProvider>;
}
