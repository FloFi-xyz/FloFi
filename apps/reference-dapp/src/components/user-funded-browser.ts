// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the browser half of user-funded execution groups. The owner's own wallets produce every signature and
 * (for EIP-5792 batches) send every transaction; their accounts pay every fee. FloFi only hands the wallet what it prepared and relays the
 * answer to the server, which verifies it against the frozen artifact.
 *
 *   capabilities   EIP-5792 `wallet_getCapabilities(address, [chains])` → `atomic` per chain (never requests a paymaster or any capability);
 *                  FloFi Wallet (Privy) is reported as such: it batches nothing and confirms each Solana transaction separately
 *   batch          `wallet_sendCalls` (version 2.0.0, atomicRequired) of exactly the prepared calls, after a chain switch and a check that the
 *                  wallet's selected account (`eth_accounts[0]`) is the run's account; the batch id is kept
 *                  and the receipts' transaction hashes are read back with `wallet_getCallsStatus`
 *   user operation `eth_signTypedData_v4` of the owner's own ERC-4337 operation (MetaMask EIP7702StatelessDeleGator domain)
 *   Solana         one `solana:signTransaction` request for every transaction of the group
 */
import { eip5792, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { chosenEvmProvider, evmWalletIdentity, injected, isFloFiWalletKey, type EvmProvider } from '../wallet/evm-discovery';
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
export async function sendWalletBatch(request: eip5792.SendCallsRequest, onSending?: () => void): Promise<string> {
  const provider = evmProvider();
  await onChainOrFail(provider, BigInt(request.chainId), request.chainId);
  // A wallet that ignores `from` sends the batch from its SELECTED account (`eth_accounts[0]`), so that account must be the run's own
  // (compared case-insensitively); being merely connected is not enough. A locked wallet (no account) or an unreadable answer: not asked.
  // Read last, right before sending (after any network switch).
  const accounts = await provider.request({ method: 'eth_accounts', params: [] }).catch(notSent('WALLET_ACCOUNT_MISMATCH'));
  const selected = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
  if (selected !== request.from.toLowerCase()) fail('WALLET_ACCOUNT_MISMATCH');
  // A throw from `onSending` (e.g. another tab already handed this group to the wallet) propagates as is: `wallet_sendCalls` is never requested.
  onSending?.();
  // Exactly the prepared request: atomic required, no capabilities (FloFi never asks for a paymaster or sponsorship).
  const answer = await provider.request({ method: 'wallet_sendCalls', params: [{ ...request, calls: request.calls.map(c => ({ ...c })) }] })
    .catch(cause => {
      const code = (cause as { code?: unknown } | null)?.code;
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
export async function revokeUserOperation(owner: string, chainId: number, runId: string, groupIndex: number): Promise<string> {
  const provider = evmProvider();
  await onChainOrFail(provider, BigInt(chainId), '0x' + chainId.toString(16));
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: erc4337.ENTRY_POINT_V0_7,
    data: erc4337.incrementNonceCall(erc4337.nonceKeyOf(`${runId}:g${groupIndex}`)) }] }).catch(rejected);
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : fail('WALLET_RESPONSE_INVALID');
}
/** The owner signs their own user operation's EIP-712 typed data on its chain (no transaction is sent by the wallet). */
export async function signUserOperation(address: string, chainId: number, typedData: unknown): Promise<string> {
  return signWorkflowGrant(address, chainId, typedData);
}
/** The owner signs every transaction of a Solana group in one wallet request. */
export async function signSolanaGroup(address: string, unsignedTransactions: readonly string[]): Promise<string[]> {
  const chosen = walletPreference().solana ?? fail('SOLANA_WALLET_SESSION_REQUIRED');
  const session = await connectSolanaWallet(chosen, 'solana:mainnet', 'USER_FUNDED');
  if (session.account.address !== address) fail('SOLANA_WALLET_SESSION_REQUIRED');
  return signAllWithSolanaWallet(session, unsignedTransactions, 'USER_FUNDED');
}
