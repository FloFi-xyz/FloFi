// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRODUCT-UX-001: what the server already knows when it renders /app, so the server HTML and the first client render are the same
 * screen and nothing flips during hydration — the remembered wallet ecosystems (a hint, `wallet/wallet-hint.ts`) and the Copilot mode the
 * deployment is configured for (confirmed by the client afterwards). Presentation only: none of it is authority.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { CopilotMode } from '../domain/copilot-mode';
import type { WalletHintEcosystem } from '../wallet/wallet-hint';
import type { PrivacyNoticeChoice } from '../domain/privacy-notice';
import type { PublishedStudioIntegration } from '../platform/studio-catalog';

export type ProductBootstrap = { readonly walletHint: readonly WalletHintEcosystem[]; readonly copilotMode: CopilotMode | null;
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: this browser's answer to the Privacy & Memory notice, as the server read it (absent: unknown, not shown). */
  readonly privacyNotice?: PrivacyNoticeChoice | 'UNANSWERED' | undefined;
  /** BUILD-FLOFI-UX-FIX-003: the deployment's learning tier (configuration, no database read), so Settings knows its rows at first paint. */
  readonly learningTier?: 'OFF' | 'SESSION' | 'ENABLED' | undefined;
  /** BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): whether this deployment charges the FloFi fee (configuration only, no secret). */
  readonly platformFeeCollection?: boolean | undefined;
  /**
   * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: an opaque digest of the tenant and the signed-in FloFi account (`server/conversation-scope.ts`)
   * under which this tab keeps the FloFi chat; null or absent: no account session, the chat stays in memory only. Not authority for anything.
   */
  readonly conversationScope?: string | null | undefined;
  /**
   * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: whether this deployment offers accounts and this browser holds a valid FloFi session, from the
   * same server-verified session read (`currentAccountBootstrap`); null or absent: not known, read by the Settings menu itself. Presentation
   * only — it opens no page and authorizes nothing (every account page and action verifies the session again).
   */
  readonly accountPresence?: { readonly accounts: boolean; readonly signedIn: boolean } | null | undefined;
  readonly publishedIntegrations?: readonly PublishedStudioIntegration[] | undefined;
};
const NONE: ProductBootstrap = Object.freeze({ walletHint: Object.freeze([]), copilotMode: null });
const Context = createContext<ProductBootstrap>(NONE);
export function ProductBootstrapProvider({ value, children }: { value: ProductBootstrap; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useProductBootstrap = () => useContext(Context);
