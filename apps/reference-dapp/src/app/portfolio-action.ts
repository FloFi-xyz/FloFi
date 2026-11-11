// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { withFlightAccess } from '../server/flight-access';
import { cachedWalletPortfolio, readWalletPortfolio } from '../server/wallet-portfolio';
import type { WalletPortfolioResult } from '../domain/wallet-portfolio';
import { createCopilotLimiter, type CopilotLimiter } from '../server/copilot-service';

const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
/**
 * The Dashboard wallet portfolio: public balances of the given wallet addresses on the mainnets this deployment enables, valued only by
 * the verified price source. Read-only (no session, signature or submission) and never throws to the browser: any failure is a closed code.
 */
export async function walletPortfolio(input: { readonly evm: string | null; readonly solana: string | null }): Promise<WalletPortfolioResult> {
  return withFlightAccess(async () => {
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: anyone may ask for public balances, so a per-process admission window bounds the RPC reads a caller
  // can cause (cached answers are cheap; uncached ones are paced public reads). A refusal is a closed code the widget offers to retry.
  const cached = cachedWalletPortfolio(input);
  if (cached) return cached.then(portfolio => ({ ok: true as const, portfolio }), () => ({ ok: false as const, code: 'PORTFOLIO_UNAVAILABLE' }));
  const release = portfolioLimiter().acquire();
  if (!release) return { ok: false, code: 'PORTFOLIO_BUSY' };
  try { return { ok: true, portfolio: await readWalletPortfolio(input) }; }
  catch (cause) {
    const code = cause instanceof Error && CODE.test(cause.message) && cause.message.startsWith('PORTFOLIO_') ? cause.message : 'PORTFOLIO_UNAVAILABLE';
    return { ok: false, code };
  } finally { release(); }

  });
}
function portfolioLimiter(): CopilotLimiter {
  const key = Symbol.for('flofi.portfolio.limiter'), holder = globalThis as unknown as Record<symbol, CopilotLimiter | undefined>;
  holder[key] ??= createCopilotLimiter({ windowMs: 60_000, maxConcurrent: 2, maxPerWindow: 60 });
  return holder[key];
}
