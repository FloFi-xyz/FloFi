// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the browser half of user-funded execution groups. The owner's own wallets produce every signature and
 * (for EIP-5792 batches) send every transaction; their accounts pay every fee. FloFi only hands the wallet what it prepared and relays the
 * answer to the server, which verifies it against the frozen artifact.
 *
 *   capabilities   EIP-5792 `wallet_getCapabilities(address, [chains])` → `atomic` per chain (never requests a paymaster or any capability);
 *                  FloFi Wallet (Privy) is reported as such: it batches nothing and confirms each Solana transaction separately
 *   batch          `wallet_sendCalls` (version 2.0.0, atomicRequired) of exactly the prepared calls, after a chain switch; the batch id is kept
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
const evmProvider = (): EvmProvider => chosenEvmProvider() ?? injected() ?? fail('EVM_WALLET_NOT_FOUND');
const rejected = (cause: unknown) => (cause as { code?: unknown } | null)?.code === 4001 ? fail('WALLET_REQUEST_REJECTED') : Promise.reject(cause);

/** What the owner's wallets can do on these chains, asked once from the wallets themselves (errors mean "not supported", never assumed). */
export async function walletProfile(evmAddress: string | null, chains: readonly string[], withSolana: boolean): Promise<WalletProfile> {
  let eip155: WalletProfile['eip155'] | null = null, solana: WalletProfile['solana'] | null = null;
  if (evmAddress) {
    const provider = chosenEvmProvider() ?? injected();
    const flofi = provider ? isFloFiWalletKey(evmWalletIdentity(provider)?.key) : false;
    const evmChains = chains.filter(c => c.startsWith('eip155:'));
    const atomic: Record<string, 'supported' | 'ready' | 'unsupported'> = {};
    if (provider && !flofi && evmChains.length) {
      try {
        const caps = await provider.request({ method: 'wallet_getCapabilities', params: [evmAddress, evmChains.map(c => '0x' + BigInt(c.slice(7)).toString(16))] });
        for (const c of evmChains) atomic[c] = eip5792.atomicCapability(caps, Number(c.slice(7)));
      } catch { for (const c of evmChains) atomic[c] = 'unsupported'; }
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
 * Sends the prepared atomic batch from the owner's own account; returns the wallet's batch id (the wallet signs, sends and pays). The request
 * carries the group's own EIP-5792 id: a wallet that already has that batch refuses it as a duplicate (5720), which means it was SENT before —
 * its id is returned so it is read back, never sent twice.
 */
export async function sendWalletBatch(request: eip5792.SendCallsRequest): Promise<string> {
  const provider = evmProvider();
  const chainId = BigInt(request.chainId);
  const onChain = async () => { const c = await provider.request({ method: 'eth_chainId', params: [] }); return typeof c === 'string' && BigInt(c) === chainId; };
  if (!await onChain()) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: request.chainId }] }).catch(rejected);
    if (!await onChain()) fail('WALLET_WRONG_NETWORK');
  }
  // Exactly the prepared request: atomic required, no capabilities (FloFi never asks for a paymaster or sponsorship).
  const answer = await provider.request({ method: 'wallet_sendCalls', params: [{ ...request, calls: request.calls.map(c => ({ ...c })) }] })
    .catch(cause => request.id && (cause as { code?: unknown } | null)?.code === eip5792.DUPLICATE_ID ? request.id : rejected(cause));
  return eip5792.sendCallsId(answer);
}
/**
 * The transaction hashes of a batch once the wallet reports it final (null while pending). Only the hashes are used; the chain decides.
 * Throws when the wallet does not know the id (EIP-5792 5730): nothing was sent under it.
 */
export async function walletBatchHashes(batchId: string): Promise<{ readonly hashes: readonly string[]; readonly failed: boolean } | null> {
  const status = eip5792.callsStatus(await evmProvider().request({ method: 'wallet_getCallsStatus', params: [batchId] }));
  if (status.status === 'PENDING' || status.status === 'UNKNOWN') return null;
  return { hashes: status.receipts.map(r => r.transactionHash), failed: status.status !== 'CONFIRMED' };
}
/**
 * The owner revokes a user operation they signed that FloFi never relayed: their own wallet sends `EntryPoint.incrementNonce(key)` for that
 * group's nonce key (the owner confirms and pays). Afterwards the signed operation can never execute. Returns the transaction hash.
 */
export async function revokeUserOperation(owner: string, chainId: number, runId: string, groupIndex: number): Promise<string> {
  const provider = evmProvider(), chain = '0x' + chainId.toString(16);
  const current = await provider.request({ method: 'eth_chainId', params: [] });
  if (typeof current !== 'string' || BigInt(current) !== BigInt(chainId)) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain }] }).catch(rejected);
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
