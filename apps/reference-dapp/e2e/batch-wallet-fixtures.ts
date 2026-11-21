// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The owner's EIP-5792 wallet double of the Editor's whole-workflow browser specs on the MOCKED Base chain double (https://127.0.0.1:8567,
 * e2e/user-funded-chain-serve.ts), and the wallet-request recorder they assert with (P0 universal execution, case D;
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001).
 *
 * The recorder counts what the page ACTUALLY asks the wallet: every EIP-1193 request through `window.ethereum` (the provider the page
 * discovers, also through EIP-6963) is logged in the test process, in order, before it is answered — so the log survives reloads and a
 * request the wallet refuses is still counted. Nothing reaches a public network; nothing is signed with a real key; none of this is evidence
 * of a mainnet execution.
 */
import { request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { createDatabase } from '@defi-workflow-engine/cloud-runtime';
import type { TestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { createAccountStore } from '../src/accounts/account-store';
import { ACCOUNT_SESSION_COOKIE, sealAccountSession } from '../src/accounts/account-session';
import { sessionCookieName } from '../src/server/session-cookie';
import { challengeMessage, issueWalletChallenge, verifyWalletSignIn, WALLET_SESSION_COOKIE } from '../src/server/wallet-session';
import { APP_ORIGIN } from './app-origin';
import { expect } from './fixtures';

export const BASE = '0x2105';
export const CHAIN_HARNESS = 'https://127.0.0.1:8567';
export type SentBatch = { version: string; id?: string; chainId: string; from: string; atomicRequired: boolean; calls: { to: string; data: string; value: string }[]; capabilities?: unknown };
/** Wallet methods that would ask the owner for anything (a signature, a transaction, a network or permission change). */
export const ASKING = /^(personal_sign|eth_sign|eth_signTypedData.*|eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|wallet_switchEthereumChain|wallet_addEthereumChain|wallet_requestPermissions)$/;

let api: APIRequestContext | null = null;
/** Releases the chain double's control client (call from `test.afterAll`). */
export async function disposeChainControl(): Promise<void> { await api?.dispose(); api = null; }
/** The chain double's test-only control (loopback only); its per-run certificate is self-signed, as for the other loopback harnesses. */
export async function chainControl<T>(method: string, params: unknown[] = []): Promise<T> {
  api ??= await apiRequest.newContext({ ignoreHTTPSErrors: true });
  const response = await api.post(`${CHAIN_HARNESS}/control`, { data: { jsonrpc: '2.0', id: 1, method, params } });
  expect(response.ok()).toBe(true);
  const value = await response.json() as { result?: T; error?: { message: string } };
  if (value.error) throw new Error(value.error.message);
  return value.result as T;
}

/** A FloFi account holding the test wallet, signed in through the account store as an email sign-in leaves it. */
export async function signedIn(page: Page, wallet: string, subject = 'wallet-batch') {
  const db = createDatabase({ connectionString: process.env.FLOFI_E2E_DATABASE_URL!, maxConnections: 1 });
  try {
    const store = createAccountStore(db, 'default');
    const session = await store.signIn({ kind: 'email', subject: `${subject}-${Date.now()}@flofi-e2e.test`, label: null });
    await store.setOnboarding(session.accountId, 'completed');
    await store.saveWallet(session.accountId, { ecosystem: 'evm', address: wallet, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
    await page.context().addCookies([{ name: ACCOUNT_SESSION_COOKIE, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax',
      value: sealAccountSession({ FLOFI_SESSION_SECRET: process.env.FLOFI_E2E_SESSION_SECRET! }, session, new URL(APP_ORIGIN).host, new Date()) }]);
  } finally { await db.close(); }
}

/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: a valid wallet sign-in session of `wallet` in this browser BEFORE the owner authorizes, as the
 * product's own EIP-4361 sign-in leaves it (`app/wallet-session-action.ts`): FloFi's challenge for this origin, the wallet's `personal_sign` of
 * exactly FloFi's message (the test wallet's in-memory key, in the test process), FloFi's own verification, and the HttpOnly session cookie
 * sealed with the server's per-run session secret. The wallet double is not asked, so the recorder's window starts with no sign-in pending.
 */
export async function walletSignedIn(page: Page, wallet: TestWallet, chainId = 8453) {
  const env = { FLOFI_SESSION_SECRET: process.env.FLOFI_E2E_SESSION_SECRET! }, origin = new URL(APP_ORIGIN), now = new Date();
  const domain = origin.host, uri = origin.origin, address = wallet.address.toLowerCase();
  const challenge = issueWalletChallenge(env, { domain, uri, now });
  const message = challengeMessage(env, { challengeToken: challenge.token, domain, uri, address, chainId, now });
  const { token, session } = verifyWalletSignIn(env, { challengeToken: challenge.token, domain, uri, address, chainId, signature: wallet.signMessage(message), now });
  expect(session.account).toBe(address);
  await page.context().addCookies([{ name: sessionCookieName(WALLET_SESSION_COOKIE, origin.protocol === 'https:'), value: token, url: APP_ORIGIN, httpOnly: true,
    sameSite: 'Strict' }]);
}

export type BatchWalletOptions = {
  /** What `wallet_getCapabilities` answers (default: atomic batching supported on Base). */
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** `reject`: the owner declines every `wallet_sendCalls` in the wallet (EIP-1193 4001) — nothing reaches the chain. Default `execute`. */
  readonly sendCalls?: 'execute' | 'reject';
};
export type WalletRecorder = {
  /** Every EIP-1193 method the page asked the wallet, in order, across reloads. */
  readonly methods: string[];
  /** Every `wallet_sendCalls` request the wallet received (also declined or refused ones), in order. */
  readonly sent: SentBatch[];
  /** A position in the log: `count`/`counts`/`asking` from it cover only what was asked afterwards. */
  mark(): number;
  count(method: string, from?: number): number;
  counts(from?: number): Record<string, number>;
  /** The prompt-raising requests (`ASKING`), in order. */
  asking(from?: number): string[];
};

/**
 * The owner's EIP-5792 wallet: it reports atomic batching on Base (unless `capabilities` says otherwise), and for `wallet_sendCalls` it does what
 * MetaMask does with an EIP-7702 account — executes exactly the requested calls as ONE transaction from the owner's own account (here on the
 * MOCKED chain) and answers the batch id; it honours the app-provided id (a second request with it is refused 5720) and reports the receipts
 * through `wallet_getCallsStatus`. Every request is logged in the test process, across reloads. Installed after `installJourneyWallet`, whose
 * accounts, chain and `personal_sign` answer everything else.
 */
export async function installBatchWallet(page: Page, owner: string, options: BatchWalletOptions = {}): Promise<WalletRecorder> {
  const methods: string[] = [], sent: SentBatch[] = [];
  const batches = new Map<string, { hash: string }>();
  const capabilities = options.capabilities ?? { [BASE]: { atomic: { status: 'supported' } } };
  await page.exposeFunction('flofiBatchWallet', async (method: string, params: unknown[]) => {
    methods.push(method);
    if (method === 'wallet_getCapabilities') return { result: capabilities };
    if (method === 'wallet_sendCalls') {
      const request = params[0] as SentBatch;
      sent.push(request);
      if (options.sendCalls === 'reject') return { error: { code: 4001, message: 'User rejected the request.' } };
      if (request.id && batches.has(request.id)) return { error: { code: 5720, message: 'Duplicate id' } };
      if (request.chainId !== BASE || request.from.toLowerCase() !== owner || request.atomicRequired !== true) return { error: { code: 5700, message: 'Unsupported request' } };
      const hash = await chainControl<string>('MOCK_walletBatch', [owner, request.calls]);
      const id = request.id ?? `0x${'b'.repeat(64)}`;
      batches.set(id, { hash });
      return { result: { id } };
    }
    if (method === 'wallet_getCallsStatus') {
      const batch = batches.get(String(params[0]));
      if (!batch) return { error: { code: 5730, message: 'Unknown bundle id' } };
      const receipt = await chainControl<{ status: number; blockNumber: number }>('MOCK_receipt', [batch.hash]);
      return { result: { version: '2.0.0', id: params[0], chainId: BASE, atomic: true, status: 200,
        receipts: [{ transactionHash: batch.hash, status: receipt.status === 1 ? '0x1' : '0x0', blockNumber: '0x' + receipt.blockNumber.toString(16), gasUsed: '0x30d40', logs: [] }] } };
    }
    return { passthrough: true };
  });
  await page.addInitScript(() => {
    type Answer = { result?: unknown; error?: { code: number; message: string }; passthrough?: boolean };
    const w = window as unknown as { ethereum: { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> };
      flofiBatchWallet: (method: string, params: unknown[]) => Promise<Answer> };
    const request = w.ethereum.request;
    w.ethereum.request = async input => {
      const answer = await w.flofiBatchWallet(input.method, input.params ?? []);
      if (answer.passthrough) return request(input);
      if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.result;
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider: w.ethereum, info: { rdns: 'io.metamask', name: 'MetaMask', uuid: 'wallet-batch-metamask' } } })));
  });
  const after = (from = 0) => methods.slice(from);
  return {
    methods, sent,
    mark: () => methods.length,
    count: (method, from) => after(from).filter(m => m === method).length,
    counts: from => after(from).reduce<Record<string, number>>((all, m) => ({ ...all, [m]: (all[m] ?? 0) + 1 }), {}),
    asking: from => after(from).filter(m => ASKING.test(m)),
  };
}
