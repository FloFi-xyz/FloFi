// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the browser half of user-funded execution groups. The owner's own wallets produce every signature and
 * (for EIP-5792 batches) send every transaction; their accounts pay every fee. FloFi only hands the wallet what it prepared and relays the
 * answer to the server, which verifies it against the frozen artifact.
 *
 *   capabilities   EIP-5792 `wallet_getCapabilities(address, [chains])` → `atomic` per chain; `paymasterService` is asked only when FloFi
 *                  offers to sponsor a prepared batch's network fee (ADR-0009);
 *                  FloFi Wallet (Privy) is reported as such: it batches nothing and confirms each Solana transaction separately
 *   batch          `wallet_sendCalls` (version 2.0.0, atomicRequired) of exactly the prepared calls, after a chain switch and a check that the
 *                  wallet's selected account (`eth_accounts[0]`) is the run's account; the batch id is kept. With a sponsorship offer and a
 *                  wallet reporting `paymasterService` on that chain, the request carries the capability (FloFi's paymaster proxy URL and the
 *                  grant context): the wallet still signs, the paymaster pays the network fee
 *                  and the receipts' transaction hashes are read back with `wallet_getCallsStatus`
 *   user operation `eth_signTypedData_v4` of the owner's own ERC-4337 operation (MetaMask EIP7702StatelessDeleGator domain)
 *   Solana         one `solana:signTransaction` request for every transaction of the group
 *   Circle fee     ADR-0010: two `eth_signTypedData_v4` prompts — the USDC permit (spender = Circle's pinned paymaster, value = the reviewed cap),
 *                  then the operation that carries it — each re-derived here from the artifact's facts and FloFi's pins and compared with the
 *                  server's typed data before the wallet is asked. FloFi Wallet (owner requirement) signs them only bound to the workflow run
 *                  (`circleSigningContext`: its server gate re-derives each); on its first use, FloFi's own consent step comes first (the owner
 *                  must agree; declining signs nothing: CIRCLE_UPGRADE_DECLINED), then the EIP-7702 upgrade authorization (`flofi_signAuthorization`
 *                  of exactly the recorded tuple: this chain, the pinned Simple7702Account v0.8, the account's nonce) — three signatures, two after
 */
import { circlePaymaster, eip5792, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { circleFactsOf, circleOperationOf, circleOperationTypedData, circlePermitOf } from '../user-funded/circle-facts';
import { chosenEvmProvider, evmWalletIdentity, injected, isFloFiWalletKey, type EvmProvider } from '../wallet/evm-discovery';
import { bindFloFiSigning } from '../wallet/flofi-wallet-channel';
import { circleSigningContext } from '../wallet/flofi-signing';
import { connectSolanaWallet, signAllWithSolanaWallet } from '../wallet/solana-wallet';
import { walletPreference } from '../wallet/wallet-registry';
import type { WalletProfile } from '../workflow-runs/execution-groups';
import { signWorkflowGrant } from './delegation-browser';

const fail = (code: string): never => { throw new Error(code); };
const NOT_SENT_CODES: ReadonlySet<number> = new Set([5700, 5710, 5740, 5750, 5760, 4100, 4200, -32601, -32602]);
const evmProvider = (): EvmProvider => chosenEvmProvider() ?? injected() ?? fail('EVM_WALLET_NOT_FOUND');
const rejected = (cause: unknown) => (cause as { code?: unknown } | null)?.code === 4001 ? fail('WALLET_REQUEST_REJECTED') : Promise.reject(cause);
/** A wallet request that failed before anything was sent: the owner's own rejection keeps `rejected`'s code, anything else becomes `code`. */
const notSent = (code: string) => (cause: unknown): never => fail((cause as { code?: unknown } | null)?.code === 4001 ? 'WALLET_REQUEST_REJECTED' : code);

/**
 * The `atomic` status a wallet reported for one chain: its own entry, else a chain-agnostic `0x0` entry (EIP-5792); null when it reported nothing
 * for that chain. An entry without `atomic` means the wallet answered for the chain and offers no atomic batching there.
 */
function reportedAtomic(capabilities: unknown, chainId: number): 'supported' | 'ready' | 'unsupported' | null {
  const all = capabilities && typeof capabilities === 'object' ? capabilities as Record<string, unknown> : null;
  if (!all) return null;
  const key = Object.keys(all).find(k => /^0x[0-9a-fA-F]+$/.test(k) && BigInt(k) === BigInt(chainId)) ?? Object.keys(all).find(k => /^0x0+$/.test(k));
  if (!key || !all[key] || typeof all[key] !== 'object') return null;
  return eip5792.atomicCapability({ ['0x' + chainId.toString(16)]: all[key] }, chainId);
}
/** What the owner's wallets can do on these chains, asked once from the wallets themselves (only what they report; never assumed). */
/**
 * ADR-0010 review (C4): the EVM wallet this browser would sign with, as a group's preparation needs it (FloFi Wallet signs no USDC permit, so it is
 * never handed a Circle-paid group). Null without any EVM wallet: the server then treats the wallet as unknown and offers no Circle permit.
 */
export function evmWalletKind(): 'INJECTED' | 'FLOFI_WALLET' | null {
  const provider = chosenEvmProvider() ?? injected();
  return provider ? isFloFiWalletKey(evmWalletIdentity(provider)?.key) ? 'FLOFI_WALLET' : 'INJECTED' : null;
}
export async function walletProfile(evmAddress: string | null, chains: readonly string[], withSolana: boolean): Promise<WalletProfile> {
  let eip155: WalletProfile['eip155'] | null = null, solana: WalletProfile['solana'] | null = null;
  if (evmAddress) {
    const provider = chosenEvmProvider() ?? injected();
    const flofi = provider ? isFloFiWalletKey(evmWalletIdentity(provider)?.key) : false;
    const evmChains = chains.filter(c => c.startsWith('eip155:'));
    const atomic: Record<string, 'supported' | 'ready' | 'unsupported'> = {};
    if (provider && !flofi && evmChains.length) {
      // P0 universal execution: only what the wallet REPORTED counts. A chain it answers for without atomic support is 'unsupported'; a chain it
      // does not mention, or a failed request, stays unknown (absent) — the plan then says "not known", never "your wallet cannot batch".
      try {
        const caps = await provider.request({ method: 'wallet_getCapabilities', params: [evmAddress, evmChains.map(c => '0x' + BigInt(c.slice(7)).toString(16))] });
        for (const c of evmChains) { const status = reportedAtomic(caps, Number(c.slice(7))); if (status) atomic[c] = status; }
      } catch { /* unknown: nothing reported */ }
    }
    eip155 = { wallet: flofi ? 'FLOFI_WALLET' : 'INJECTED', atomic, typedData: true };
  }
  if (withSolana) {
    const chosen = walletPreference().solana;
    const flofi = chosen === 'FloFi Wallet';
    solana = { wallet: flofi ? 'FLOFI_WALLET' : 'WALLET_STANDARD', signMultiple: !flofi && Boolean(chosen), nonceAccounts: 0 };
  }
  return { ...eip155 ? { eip155 } : {}, ...solana ? { solana } : {} };
}

/**
 * ADR-0009: FloFi's offer to sponsor a prepared batch's network fee (`required`: the owner's balance cannot pay it, so it is never sent
 * unsponsored). `url` null: the artifact REQUIRES sponsorship but carries no offer this browser can use (BUILD-FLOFI-MAINNET-EXEC-002 review,
 * round 2) — `sendWalletBatch` then asks the wallet nothing (GAS_SPONSORSHIP_WALLET_UNSUPPORTED).
 */
export type BatchSponsorship = { readonly url: string | null; readonly context: Readonly<Record<string, unknown>> | null; readonly required: boolean };
/** Whether the wallet REPORTS EIP-5792 `paymasterService` for this chain (its own entry, else a chain-agnostic `0x0` one); never assumed. */
export function reportedPaymasterService(capabilities: unknown, chainId: bigint): boolean {
  const all = capabilities && typeof capabilities === 'object' ? capabilities as Record<string, unknown> : null;
  if (!all) return false;
  const key = Object.keys(all).find(k => /^0x[0-9a-fA-F]+$/.test(k) && BigInt(k) === chainId) ?? Object.keys(all).find(k => /^0x0+$/.test(k));
  const entry = key ? all[key] as { paymasterService?: { supported?: unknown } } | null : null;
  return entry?.paymasterService?.supported === true;
}
/**
 * Puts the wallet on `chainId` before anything is asked of it: the network is read, switched if needed, and READ AGAIN — a wallet whose switch
 * "succeeds" without moving would otherwise sign or send on the network it is on. Every failure is a closed "nothing was sent" code: the
 * network could not be read or switched, or is still another one (WALLET_WRONG_NETWORK; the owner's own rejection stays WALLET_REQUEST_REJECTED).
 */
async function onChainOrFail(provider: EvmProvider, chainId: bigint, hex: string): Promise<void> {
  const onChain = async () => {
    const c = await provider.request({ method: 'eth_chainId', params: [] }).catch(notSent('WALLET_WRONG_NETWORK'));
    try { return typeof c === 'string' && BigInt(c) === chainId; } catch { return false; }
  };
  if (await onChain()) return;
  // A pending request (-32002), an unknown chain (4902) or any other failure of the switch: nothing was asked to send.
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }).catch(notSent('WALLET_WRONG_NETWORK'));
  if (!await onChain()) fail('WALLET_WRONG_NETWORK');
}
/**
 * Sends the prepared atomic batch from the owner's own account; returns the wallet's batch id (the wallet signs, sends and pays). The request
 * carries the group's own EIP-5792 id: a wallet that already has that batch refuses it as a duplicate (5720), which means it was SENT before —
 * its id is returned so it is read back, never sent twice.
 *
 * Until `wallet_sendCalls` is requested nothing can have been sent, so every failure before it is a closed "nothing was sent" code, never a raw
 * wallet error a caller would have to treat as "may have been sent": the network could not be read or switched (WALLET_WRONG_NETWORK; the
 * owner's own rejection stays WALLET_REQUEST_REJECTED), or the wallet's selected account is not the run's account, or the wallet is locked
 * (WALLET_ACCOUNT_MISMATCH). `onSending` runs synchronously immediately before the `wallet_sendCalls` request, and only then: a caller keeps
 * its "may have been sent" marker there, so a request that was never made can never leave the group unsendable. If `onSending` throws, the
 * request is not made and its error is returned unchanged (never mapped to a "nothing was sent" or "may have been sent" code here).
 */
export async function sendWalletBatch(request: eip5792.SendCallsRequest, onSending?: () => void, sponsorship: BatchSponsorship | null = null): Promise<string> {
  // Review round 2: a REQUIRED sponsorship without a usable offer (`batchSponsorshipOf`): the owner's balance cannot pay the fee and there is no
  // paymaster to hand the wallet, so nothing at all is asked of it (a closed "nothing was sent" code).
  if (sponsorship?.required && !sponsorship.url) fail('GAS_SPONSORSHIP_WALLET_UNSUPPORTED');
  const provider = evmProvider();
  await onChainOrFail(provider, BigInt(request.chainId), request.chainId);
  // A wallet that ignores `from` sends the batch from its SELECTED account (`eth_accounts[0]`), so that account must be the run's own
  // (compared case-insensitively); being merely connected is not enough. A locked wallet (no account) or an unreadable answer: not asked.
  // Read last, right before sending (after any network switch).
  // ADR-0009: the sponsorship capability only for a wallet that reports it on this chain. A REQUIRED offer the wallet cannot take: nothing is sent
  // (the owner's balance cannot pay the fee, and FloFi never sends the batch hoping it can). Asked before the account check, which stays last.
  const sponsored = sponsorship?.url && sponsorship.context ? await provider.request({ method: 'wallet_getCapabilities', params: [request.from, [request.chainId]] })
    .then(caps => reportedPaymasterService(caps, BigInt(request.chainId)), () => false) : false;
  if (sponsorship?.required && !sponsored) fail('GAS_SPONSORSHIP_WALLET_UNSUPPORTED');
  const accounts = await provider.request({ method: 'eth_accounts', params: [] }).catch(notSent('WALLET_ACCOUNT_MISMATCH'));
  const selected = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
  if (selected !== request.from.toLowerCase()) fail('WALLET_ACCOUNT_MISMATCH');
  // A throw from `onSending` (e.g. another tab already handed this group to the wallet) propagates as is: `wallet_sendCalls` is never requested.
  onSending?.();
  // Exactly the prepared request: atomic required; the only capability ever added is FloFi's own paymaster service (an optional one unless required).
  const send = (withSponsor: boolean) => provider.request({ method: 'wallet_sendCalls', params: [{ ...request, calls: request.calls.map(c => ({ ...c })),
    ...withSponsor && sponsorship?.url ? { capabilities: { paymasterService: { url: sponsorship.url, context: sponsorship.context, ...sponsorship.required ? {} : { optional: true } } } } : {} }] });
  const codeOf = (cause: unknown) => (cause as { code?: unknown } | null)?.code;
  const answer = await send(sponsored).catch(cause => {
    // A wallet that refuses the sponsorship capability itself (5700) sent nothing: an optional offer falls back to the owner-paid batch once.
    if (sponsored && !sponsorship?.required && codeOf(cause) === 5700) return send(false);
    throw cause;
  }).catch(cause => {
      const code = codeOf(cause);
      if (request.id && code === eip5792.DUPLICATE_ID) return request.id;
      // Refusals the wallet returns BEFORE sending anything (EIP-5792 5700 unsupported capability, 5710 unsupported chain, 5740 batch too large,
      // 5750 atomic batching unsupported, 5760 upgrade rejected; EIP-1193 4100 unauthorized, 4200 unsupported method; JSON-RPC -32601/-32602): nothing
      // was sent, so the group can be offered again. Any other error stays "may have been sent" (fail closed).
      if (typeof code === 'number' && NOT_SENT_CODES.has(code)) return fail('WALLET_BATCH_NOT_SENT');
      return rejected(cause);
    });
  return eip5792.sendCallsId(answer);
}
/**
 * The sponsorship offer a prepared wallet batch carries (ADR-0009), or null. Review round 2: a batch whose artifact REQUIRES sponsorship
 * (`sponsorship.required`, or `fee.sponsorship` = REQUIRED) but carries no usable offer is never treated as "no offer" (it would be sent
 * owner-paid by a wallet whose balance cannot pay the fee): it reads as `{ url: null, required: true }`, which `sendWalletBatch` refuses before
 * asking the wallet anything.
 */
export function batchSponsorshipOf(prepared: Readonly<Record<string, unknown>>): BatchSponsorship | null {
  const s = prepared.sponsorship as { url?: unknown; context?: unknown; required?: unknown } | undefined;
  const fee = prepared.fee as { sponsorship?: unknown } | undefined;
  const required = s?.required === true || fee?.sponsorship === 'REQUIRED', unusable = required ? { url: null, context: null, required: true } : null;
  if (!s || typeof s.url !== 'string') return unusable;
  // FloFi's own paymaster proxy only: HTTPS (a loopback origin in local acceptance), never a URL with credentials.
  let url: URL;
  try { url = new URL(s.url); } catch { return unusable; }
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') || url.username || url.password) return unusable;
  const context = s.context && typeof s.context === 'object' && !Array.isArray(s.context) ? s.context as Record<string, unknown> : null;
  return { url: s.url, context, required };
}
/**
 * The transaction hashes of a batch once the wallet reports it final (null while pending). Only the hashes are used; the chain decides.
 * Throws when the wallet does not know the id (EIP-5792 5730): nothing was sent under it.
 */
export async function walletBatchHashes(batchId: string): Promise<{ readonly hashes: readonly string[]; readonly failed: boolean } | null> {
  return batchOutcome(eip5792.callsStatus(await evmProvider().request({ method: 'wallet_getCallsStatus', params: [batchId] })));
}
/**
 * What a wallet's batch status means for the run. `failed` (reported as "not sent") ONLY for EIP-5792 status 400, the one status that says the
 * batch was not included on chain. A batch that failed by the chain's rules (500) or landed partially (600) DID reach the chain and the owner
 * paid for it: its transactions are reported (reconciliation decides what happened), and until the wallet lists them it stays pending —
 * never reported as not sent.
 */
export function batchOutcome(status: eip5792.CallsStatus): { readonly hashes: readonly string[]; readonly failed: boolean } | null {
  if (status.status === 'PENDING' || status.status === 'UNKNOWN') return null;
  const hashes = status.receipts.map(r => r.transactionHash);
  if (hashes.length) return { hashes, failed: false };
  return status.status === 'OFFCHAIN_FAILURE' ? { hashes: [], failed: true } : null;
}
/**
 * The owner revokes a user operation they signed that FloFi never relayed: their own wallet sends `EntryPoint.incrementNonce(key)` for that
 * group's nonce key (the owner confirms and pays). Afterwards the signed operation can never execute. Returns the transaction hash.
 * The network is checked exactly as for a batch (`onChainOrFail`, read again after a switch): on another network the nonce key would be
 * spent on the wrong chain's EntryPoint and the signed operation would stay valid, so nothing is sent there (WALLET_WRONG_NETWORK).
 */
export async function revokeUserOperation(owner: string, chainId: number, runId: string, groupIndex: number, entryPoint: string = erc4337.ENTRY_POINT_V0_7): Promise<string> {
  if (entryPoint !== erc4337.ENTRY_POINT_V0_7 && entryPoint !== erc4337.ENTRY_POINT_V0_8) fail('ERC4337_ENTRY_POINT_UNSUPPORTED');
  const provider = evmProvider();
  await onChainOrFail(provider, BigInt(chainId), '0x' + chainId.toString(16));
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: entryPoint,
    data: erc4337.incrementNonceCall(erc4337.nonceKeyOf(`${runId}:g${groupIndex}`)) }] }).catch(rejected);
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : fail('WALLET_RESPONSE_INVALID');
}
/** The owner signs their own user operation's EIP-712 typed data on its chain (no transaction is sent by the wallet). */
export async function signUserOperation(address: string, chainId: number, typedData: unknown): Promise<string> {
  return signWorkflowGrant(address, chainId, typedData);
}

// ── BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a group whose network fee the owner pays in USDC through Circle ───────────────────
/** Whether a prepared group's fee is paid in the owner's USDC through Circle (two typed-data signatures: the permit, then the operation). */
export const isCirclePaid = (prepared: Readonly<Record<string, unknown>>) => prepared.kind === 'EVM_USER_OPERATION' && circleFactsOf(prepared) !== null;
/**
 * Owner requirement (FloFi Wallet + Circle): FloFi Wallet signs a Circle-paid group's signatures only bound to its workflow run (its server gate
 * re-derives each one from the prepared group); without the run it is never asked (CIRCLE_WALLET_UNSUPPORTED, nothing sent). Any other wallet: as
 * before. Returns whether the wallet is FloFi Wallet (and binds the next request to the run when it is).
 */
function bindFloFiWallet(binding: CircleBinding | undefined, chainId: number): boolean {
  const provider = chosenEvmProvider() ?? injected();
  if (!provider || !isFloFiWalletKey(evmWalletIdentity(provider)?.key)) return false;
  const context = binding ? circleSigningContext(binding.runId, chainId) : null;
  if (!context) fail('CIRCLE_WALLET_UNSUPPORTED');
  bindFloFiSigning(provider, context);
  return true;
}
/** The workflow run a Circle-paid group belongs to (`RunView.workflowRunId`): FloFi Wallet's signing binding. */
export type CircleBinding = { readonly runId: string };
/**
 * The owner's USDC permit for a Circle-paid group. Before the wallet is asked, the page re-derives the permit from the artifact's facts and FloFi's
 * own pins alone — USDC's domain on this chain (`USD Coin`/`2`), spender = Circle's paymaster pinned for this chain and the account's EntryPoint,
 * value = the reviewed cap (the fee shown), the owner, the never-expiring deadline — and requires the server's typed data to be exactly it
 * (CIRCLE_PERMIT_MISMATCH otherwise: nothing is signed). The wallet then shows exactly these fields.
 */
export async function signCirclePermit(address: string, prepared: Readonly<Record<string, unknown>>, binding?: CircleBinding): Promise<string> {
  const facts = circleFactsOf(prepared), chainId = Number(prepared.chainId), pins = circlePaymaster.circlePinsOf(chainId);
  if (!facts || facts.stage !== 'PERMIT' || !pins || facts.usdc !== pins.usdc || circlePaymaster.circlePaymasterOf(chainId, facts.entryPoint) !== facts.paymaster
    || String(prepared.owner).toLowerCase() !== address.toLowerCase()) fail('CIRCLE_PERMIT_MISMATCH');
  const expected = circlePaymaster.permitTypedData(circlePermitOf(facts!, chainId, address.toLowerCase()));
  const shown = prepared.gasPayment as { permitCap?: unknown; paymaster?: unknown; maxFee?: { amount?: unknown } } | undefined;
  if (JSON.stringify((prepared.permit as { typedData?: unknown } | undefined)?.typedData) !== JSON.stringify(expected) || shown?.permitCap !== facts!.permitCap
    || shown?.maxFee?.amount !== facts!.permitCap || shown?.paymaster !== facts!.paymaster) fail('CIRCLE_PERMIT_MISMATCH');
  bindFloFiWallet(binding, chainId);
  return signWorkflowGrant(address, chainId, expected);
}
/**
 * The owner's signature of a Circle-paid operation, once its permit was verified (stage OPERATION): the operation is rebuilt here from the facts
 * (the exact calls, gas words, the pinned paymaster with the signed permit and the reviewed cap) and its typed data must be exactly the server's.
 */
export async function signCircleOperation(address: string, prepared: Readonly<Record<string, unknown>>, binding?: CircleBinding): Promise<string> {
  const facts = circleFactsOf(prepared), chainId = Number(prepared.chainId);
  if (!facts || facts.stage !== 'OPERATION' || circlePaymaster.circlePaymasterOf(chainId, facts.entryPoint) !== facts.paymaster
    || String(prepared.owner).toLowerCase() !== address.toLowerCase()) fail('CIRCLE_PERMIT_MISMATCH');
  let expected: unknown;
  try { expected = circleOperationTypedData(facts!, chainId, circleOperationOf(facts!, address.toLowerCase())); } catch { return fail('CIRCLE_PERMIT_MISMATCH'); }
  if (JSON.stringify(prepared.typedData) !== JSON.stringify(expected)) fail('CIRCLE_PERMIT_MISMATCH');
  bindFloFiWallet(binding, chainId);
  return signWorkflowGrant(address, chainId, expected);
}
/**
 * Owner requirement (FloFi Wallet + Circle): what the first use of a FloFi Wallet address asks before its permit. `consent` is FloFi's own consent
 * (on /approve, the answer the owner gave on FloFi's consent card, `circle-consent-card.tsx`, just before) and resolves true only when the owner
 * agreed; `recordConsent` records it on the server
 * (the signing gate refuses the authorization without it); `upgrade` hands the signed authorization to the server, which verifies it.
 */
export type CircleUpgradeSteps = {
  readonly consent: (upgrade: { readonly chainId: number; readonly delegate: string }) => Promise<boolean>;
  readonly recordConsent: () => Promise<{ ok: true; value: { prepared: unknown } } | { ok: false; code: string }>;
  readonly upgrade: (signature: string) => Promise<{ ok: true; value: { prepared: unknown } } | { ok: false; code: string }>;
};
/**
 * The owner's EIP-7702 authorization of a Circle-paid group's upgrade, through FloFi Wallet only (`flofi_signAuthorization`, bound to the run): the
 * tuple is re-derived here from the artifact's facts and FloFi's pins alone — this chain (never 0), the pinned Simple7702Account v0.8, the recorded
 * nonce — and must match what the server shows; the signature must recover to the owner for exactly it.
 */
export async function signCircleAuthorization(address: string, prepared: Readonly<Record<string, unknown>>, binding: CircleBinding): Promise<string> {
  const facts = circleFactsOf(prepared), chainId = Number(prepared.chainId), upgrade = facts?.upgrade;
  const shown = (prepared.gasPayment as { upgrade?: { delegate?: unknown; chainId?: unknown } } | undefined)?.upgrade;
  if (!facts || facts.stage !== 'AUTHORIZATION' || !upgrade?.consentedAt || upgrade.chainId !== chainId || upgrade.delegate !== erc4337.SIMPLE_7702_ACCOUNT_V0_8
    || shown?.delegate !== upgrade.delegate || shown?.chainId !== chainId || String(prepared.owner).toLowerCase() !== address.toLowerCase()) fail('CIRCLE_PERMIT_MISMATCH');
  if (!bindFloFiWallet(binding, chainId)) fail('CIRCLE_PERMIT_MISMATCH');
  const provider = evmProvider();
  await onChainOrFail(provider, BigInt(chainId), '0x' + chainId.toString(16));
  bindFloFiWallet(binding, chainId);
  const tuple = { chainId, address: upgrade!.delegate, nonce: BigInt(upgrade!.nonce) };
  const signature = await provider.request({ method: 'flofi_signAuthorization', params: [address, { chainId: '0x' + chainId.toString(16), contractAddress: tuple.address,
    nonce: '0x' + tuple.nonce.toString(16) }] }).catch(rejected);
  if (typeof signature !== 'string') return fail('WALLET_SIGNATURE_INVALID');
  try { erc4337.signedEip7702Authorization(tuple, signature, address); } catch { return fail('WALLET_SIGNATURE_INVALID'); }
  return signature.toLowerCase();
}
/**
 * The whole Circle sequence for one prepared group: the permit (when not signed yet) handed to the server's permit step, then the operation's
 * signature — two wallet prompts, both typed data, nothing sent by the wallet. Returns the operation signature to authorize the group with.
 */
export async function signCirclePaidGroup(address: string, prepared: Readonly<Record<string, unknown>>,
  permit: (signature: string) => Promise<{ ok: true; value: { prepared: unknown } } | { ok: false; code: string }>,
  firstUse?: CircleUpgradeSteps & CircleBinding, binding?: CircleBinding): Promise<string> {
  let current = prepared;
  const next = (answered: { ok: true; value: { prepared: unknown } } | { ok: false; code: string }) => {
    if (!answered.ok) fail(answered.code);
    current = (answered as { value: { prepared: Readonly<Record<string, unknown>> } }).value.prepared;
  };
  const run = binding ?? (firstUse ? { runId: firstUse.runId } : undefined);
  // Owner requirement: a FloFi Wallet's first use — FloFi's own consent first (declined: nothing is signed or sent), then the authorization.
  const upgrade = circleFactsOf(current)?.upgrade;
  if (circleFactsOf(current)?.stage === 'AUTHORIZATION' && upgrade) {
    if (!firstUse) fail('CIRCLE_PERMIT_MISMATCH');
    if (!upgrade.consentedAt) {
      if (!await firstUse!.consent({ chainId: upgrade.chainId, delegate: upgrade.delegate })) fail('CIRCLE_UPGRADE_DECLINED');
      next(await firstUse!.recordConsent());
    }
    next(await firstUse!.upgrade(await signCircleAuthorization(address, current, { runId: firstUse!.runId })));
  }
  if (circleFactsOf(current)?.stage === 'PERMIT') next(await permit(await signCirclePermit(address, current, run)));
  return signCircleOperation(address, current, run);
}
/**
 * The owner revokes a signed operation of a Circle-paid group exactly as an owner-paid one, on the EntryPoint its account uses (v0.7 or v0.8).
 */
export const entryPointOfGroup = (gasPayment: { readonly entryPoint?: string } | null | undefined): string => gasPayment?.entryPoint ?? erc4337.ENTRY_POINT_V0_7;
/** The owner signs every transaction of a Solana group in one wallet request. */
export async function signSolanaGroup(address: string, unsignedTransactions: readonly string[]): Promise<string[]> {
  const chosen = walletPreference().solana ?? fail('SOLANA_WALLET_SESSION_REQUIRED');
  const session = await connectSolanaWallet(chosen, 'solana:mainnet', 'USER_FUNDED');
  if (session.account.address !== address) fail('SOLANA_WALLET_SESSION_REQUIRED');
  return signAllWithSolanaWallet(session, unsignedTransactions, 'USER_FUNDED');
}

/**
 * Final review (P1): the hand-out token of each wallet batch this browser received (workflow-runs/service.ts `handedTo`), per approval and group.
 * The server hands a prepared batch again — or prepares it again once it can no longer execute — only to the browser that presents it, so a
 * second device or wallet instance never receives (and executes) the same group. The Editor and /approve share it (same origin, same storage).
 * Storage that cannot be written only means this browser cannot ask again for the same batch; it never sends anything by itself.
 */
const HANDOUTS_KEY = 'flofi.batch-handouts.v1';
const HANDOUTS_LIMIT = 64;
const read = (): Record<string, string> => {
  try { const v = JSON.parse(localStorage.getItem(HANDOUTS_KEY) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {}; }
  catch { return {}; }
};
export function batchHandout(approvalId: string, group: number): string | undefined {
  const token = read()[`${approvalId}:${group}`];
  return typeof token === 'string' ? token : undefined;
}
export function keepBatchHandout(approvalId: string, group: number, token: string | null | undefined): void {
  if (typeof token !== 'string' || !token) return;
  try {
    const all = read(), key = `${approvalId}:${group}`;
    delete all[key];
    const kept = Object.entries({ ...all, [key]: token }).slice(-HANDOUTS_LIMIT);
    localStorage.setItem(HANDOUTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* storage unavailable: this browser cannot ask for the same batch again */ }
}
