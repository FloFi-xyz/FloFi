// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: the account-scoped reads an external conversation needs so the person never has to open the FloFi
 * Dashboard to answer "which wallets?", "what do I hold?" or "what did I run?":
 *
 *   get_account     who this connection acts for: the client, its scopes and the wallets the account linked on FloFi (each proven by the
 *                   wallet's own sign-in message on `/connections`), and where to link another one
 *   get_portfolio   balances (the Dashboard's read-only wallet portfolio) and protocol positions of linked wallets only
 *   list_executions the linked wallets' recent runs across every flow (the Dashboard history read), with the canonical lifecycle
 *
 * The wallets come only from the authenticated principal (`principalOwners`): never an address a request names that the account did not
 * link. Every read is read-only public chain state or the owner's own durable records; nothing here can sign, submit, authorize or link.
 * An account is identified by its linked wallets, never by an e-mail, a username or client metadata.
 */
import { canonicalRunLifecycle } from '../domain/canonical-execution-status.ts';
import type { PositionScan } from '../domain/defi-positions.ts';
import { shortAddress, type WalletPortfolio } from '../domain/wallet-portfolio.ts';
import { conversationState, executionState } from '../platform/conversation-state.ts';
import { principalOwners, principalScopes, type McpPrincipal, type McpWalletOwner } from './config.ts';
import { createAdmissionLimiter, type AdmissionLimiter } from '../server/admission-limiter.ts';
import type { McpRuntime } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** At most this many linked wallets are read per call (each read touches several public networks). */
export const MAX_ACCOUNT_WALLETS = 4;
export const MAX_PORTFOLIO_HOLDINGS = 40;

/** The read-only portfolio port (the gateway injects the deployment's; tests inject a double). */
export type PortfolioReadPort = {
  readonly balances: (wallet: McpWalletOwner) => Promise<WalletPortfolio>;
  readonly positions?: (wallet: McpWalletOwner) => Promise<readonly PositionScan[]>;
};
/** The deployment's portfolio reads: the same modules as the Dashboard's widgets (loaded only when a portfolio is asked for). */
/** The Dashboard's per-process portfolio limiter (`app/portfolio-action.ts`, same global key and limits): MCP and the Dashboard share it. */
function sharedPortfolioLimiter(): AdmissionLimiter {
  const key = Symbol.for('flofi.portfolio.limiter'), holder = globalThis as unknown as Record<symbol, AdmissionLimiter | undefined>;
  holder[key] ??= createAdmissionLimiter({ windowMs: 60_000, maxConcurrent: 2, maxPerWindow: 60 });
  return holder[key];
}
export function deploymentPortfolioPort(env: Env = process.env): PortfolioReadPort {
  return {
    // A recent snapshot of the same wallet is served from the shared cache; an uncached read takes a slot of the shared limiter (busy: UNKNOWN).
    balances: async wallet => {
      const reader = await import('../server/wallet-portfolio.ts');
      const input = wallet.namespace === 'eip155' ? { evm: wallet.address, solana: null } : { evm: null, solana: wallet.address };
      const cached = reader.cachedWalletPortfolio(input);
      if (cached) return cached;
      const release = sharedPortfolioLimiter().acquire();
      if (!release) throw new Error('PORTFOLIO_BUSY');
      try { return await (env === process.env ? reader.readWalletPortfolio(input) : reader.readWalletPortfolio(input, env)); } finally { release(); }
    },
    positions: async wallet => (await import('../server/defi-positions.ts')).readWalletPositions(wallet),
  };
}

const label = (wallet: McpWalletOwner) => { try { return shortAddress(wallet.address); } catch { return `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`; } };
/** The linked wallets a call reads: the account's own links only (never an address a request names), at most MAX_ACCOUNT_WALLETS. */
export const linkedOwners = (principal: McpPrincipal): readonly McpWalletOwner[] => principalOwners(principal).slice(0, MAX_ACCOUNT_WALLETS);
/** The linked wallets whose balances and positions may be read (links made after `/connections` disclosed those reads); OAuth accounts only. */
export const portfolioOwners = (principal: McpPrincipal): readonly McpWalletOwner[] => principal.kind === 'mcp-oauth' ? principal.portfolioOwners ?? [] : [];
const sameWallet = (a: McpWalletOwner, b: McpWalletOwner) => a.namespace === b.namespace && a.address === b.address;
/** How many linked wallets a call did not read (beyond MAX_ACCOUNT_WALLETS): a call that skipped any is never complete. */
export const omittedOwners = (principal: McpPrincipal): number => Math.max(0, principalOwners(principal).length - MAX_ACCOUNT_WALLETS);

export function accountView(principal: McpPrincipal, origin: string) {
  const owners = principalOwners(principal), linkUrl = `${origin}/connections`;
  return {
    authenticated: true, kind: principal.kind === 'mcp-oauth' ? 'FLOFI_ACCOUNT_VIA_OAUTH' : 'DEVELOPER_CREDENTIAL',
    ...principal.kind === 'mcp-oauth' ? { client: principal.clientName } : {}, scopes: [...principalScopes(principal)],
    wallets: owners.map(o => ({ namespace: o.namespace, network: o.namespace === 'eip155' ? 'EVM' : 'SOLANA', address: o.address, label: label(o),
      // Balances and positions are read only for a link made after the Connections page asked for that; re-linking there renews consent.
      balancesReadable: portfolioOwners(principal).some(p => sameWallet(p, o)) })),
    walletCount: owners.length,
    identity: 'The account is identified by the wallets linked to it on FloFi, each proven by that wallet\'s own sign-in message — never by an e-mail, ' +
      'username or app metadata. Runs, evidence and execution history follow these wallets across the FloFi web app, ChatGPT and Claude. Approval requests ' +
      'belong to the conversation or connection that made them (list_approvals: this connection\'s), and are claimed only by the wallet proven on FloFi.',
    ...principal.kind === 'mcp-oauth' ? { linkWallet: { url: linkUrl, how: 'Open this FloFi page, sign in with the same FloFi connection, connect the wallet and confirm ' +
      'its sign-in message. That message moves no funds and grants no spending authority. The same page removes a link or withdraws an open approval request.' } } : {},
    nextSteps: owners.length ? ['get_portfolio for balances and positions of these wallets', 'list_executions for their recent runs']
      : principal.kind === 'mcp-oauth' ? ['No wallet is linked yet: share linkWallet.url with the person. Composing, reviewing, simulating and requesting approval work without a linked wallet.']
        : ['This developer credential has no granted wallets.'],
  };
}

/** A portfolio snapshot reduced to what a conversation shows: per-network read status and the listed holdings (largest priced first). */
export function portfolioView(wallet: McpWalletOwner, portfolio: WalletPortfolio) {
  const holdings = [...portfolio.holdings].sort((a, b) => Number(b.valueUsd ?? -1) - Number(a.valueUsd ?? -1)).slice(0, MAX_PORTFOLIO_HOLDINGS);
  // A network that could not be read, or whose listed tokens were only partly checked, leaves the snapshot incomplete (never zero, never a total).
  const unread = portfolio.networks.filter(n => n.status === 'UNAVAILABLE' || (n.status === 'READ' && n.tokens !== 'ALL')).map(n => n.id);
  const holdingsOmitted = Math.max(0, portfolio.holdings.length - holdings.length);
  return { wallet: { namespace: wallet.namespace, address: wallet.address, label: label(wallet) }, observedAt: portfolio.observedAt,
    complete: unread.length === 0 && holdingsOmitted === 0, ...unread.length ? { incompleteNetworks: unread } : {},
    pricedTotalUsd: portfolio.pricedTotalUsd, pricedTotalCovers: 'Priced holdings of the networks that were read only; unpriced and unread assets are not included.',
    unpricedCount: portfolio.unpricedCount, unlistedTokens: portfolio.unlisted, priceSource: portfolio.priceSource,
    networks: portfolio.networks.map(n => ({ id: n.id, name: n.name, status: n.status, provenance: n.provenance, observedAt: n.observedAt, tokens: n.tokens,
      uncheckedTokens: n.uncheckedTokens, code: n.code })),
    // `displayUnits` (at `decimals`) is what to show: a Stock Token's underlying shares or a Token-2022 balance by its own on-chain rules. `rawUnits`
    // is the on-chain base amount, withheld when the balance cannot be interpreted safely (`unavailableCode`).
    holdings: holdings.map(h => ({ network: h.networkId, symbol: h.symbol, name: h.name, tokenAddress: h.address, decimals: h.decimals,
      displayUnits: h.displayUnits, displayBasis: h.displayBasis, rawUnits: h.displayUnits === null ? null : h.units, unavailableCode: h.unavailableCode,
      valueUsd: h.valueUsd, priceObservedAt: h.price?.observedAt ?? null, provenance: h.provenance, native: h.native })),
    holdingsOmitted };
}
/** An 18-decimal fixed-point value (Aave's health factor) as a decimal string with 4 places, truncated; the raw value is kept beside it. */
function wad(value: string): string | null {
  if (!/^\d{1,78}$/.test(value)) return null;
  const raw = BigInt(value), whole = raw / 10n ** 18n, fraction = (raw % 10n ** 18n) / 10n ** 14n;
  return `${whole}.${fraction.toString().padStart(4, '0')}`;
}
export function positionsView(scans: readonly PositionScan[]) {
  return scans.map(scan => ({ protocol: scan.protocol, network: scan.network, status: scan.status, observedAt: scan.observedAt, provenance: scan.provenance,
    ...scan.risk ? { risk: { healthFactor: wad(scan.risk.healthFactor), healthFactorWad: scan.risk.healthFactor, liquidationThresholdBps: scan.risk.liquidationThresholdBps } } : {},
    count: scan.positions.length,
    // An explicit allowlist of public facts: what the position holds and its range state; never prepared operations or position internals.
    positions: scan.positions.slice(0, 20).map(p => ({ type: p.type, ...p.collateralEnabled != null ? { collateralEnabled: p.collateralEnabled } : {},
      assets: p.assets.map(a => ({ symbol: a.symbol, tokenAddress: a.address, decimals: a.decimals, units: a.units, valueUsd: a.valuation?.usd ?? null })),
      ...p.liquidity ? { liquidity: { feeTier: p.liquidity.feeTier, rangeState: p.liquidity.rangeState, status: p.liquidity.status, lowerPrice: p.liquidity.lowerPrice,
        upperPrice: p.liquidity.upperPrice, currentPrice: p.liquidity.currentPrice, priceUnit: `${p.liquidity.price.quote}/${p.liquidity.price.base}` } } : {} })) }));
}

/** Recent runs of the linked wallets, newest first, with each run's canonical lifecycle and conversational state. A failed read is INCOMPLETE. */
export async function historyView(runtime: McpRuntime, owners: readonly McpWalletOwner[]) {
  if (!runtime.history) return { available: false as const, reason: 'HISTORY_NOT_AVAILABLE_IN_THIS_DEPLOYMENT', items: [], complete: false };
  const pages = await Promise.all(owners.map(async owner => ({ owner, page: await runtime.history!(owner.address, null) })));
  const failed = pages.filter(p => !p.page.ok);
  const items = pages.flatMap(p => p.page.ok ? p.page.value.items.map(run => ({ wallet: label(p.owner), run })) : [])
    .sort((a, b) => String(b.run.updatedAt).localeCompare(String(a.run.updatedAt))).slice(0, 25)
    .map(({ wallet, run }) => {
      const lifecycle = canonicalRunLifecycle({ status: run.status, hasEvidence: run.hasEvidence, errorCode: run.errorCode ?? null,
        needsObservation: run.needsObservation === true, attentionRequired: run.attentionRequired === true });
      // A summary carries no attempts: "not started / waiting for the wallet" cannot be told apart from an in-flight request here.
      const state = lifecycle.status === 'NOT_STARTED' || lifecycle.status === 'AUTHORIZATION_PENDING'
        ? conversationState('STATUS_UNKNOWN', 'READ_GET_EXECUTION_STATUS') : executionState(lifecycle);
      return { executionId: run.runId, flow: run.flow, status: run.status, wallet, updatedAt: run.updatedAt, hasEvidence: run.hasEvidence, lifecycle,
        conversationState: state };
    });
  const more = pages.some(p => p.page.ok && p.page.value.next !== null);
  return { available: true as const, items, complete: failed.length === 0, ...failed.length ? { unreadWallets: failed.map(p => label(p.owner)),
    note: 'Some wallets could not be read now; their history is UNKNOWN (not empty). Try again.' } : {},
    ...more ? { olderRuns: 'Only the most recent runs are listed here; get_execution_status reads any listed or known execution id.' } : {} };
}
