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

export type ProductBootstrap = { readonly walletHint: readonly WalletHintEcosystem[]; readonly copilotMode: CopilotMode | null };
const NONE: ProductBootstrap = Object.freeze({ walletHint: Object.freeze([]), copilotMode: null });
const Context = createContext<ProductBootstrap>(NONE);
export function ProductBootstrapProvider({ value, children }: { value: ProductBootstrap; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useProductBootstrap = () => useContext(Context);
