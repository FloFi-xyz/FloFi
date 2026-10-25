// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001 (wallet F): what a failed wallet request means for the owner, in words they can act on. EIP-1193 and Wallet
 * Standard failures are classified by their standard codes (and the closed codes FloFi's own wallet helpers throw); a raw code, stack or wallet
 * message is never shown. Display copy only: nothing here changes a session, a Review or an authorization.
 */
type Cause = unknown;
const codeOf = (cause: Cause): number | null => {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
};
const textOf = (cause: Cause) => cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
/** A sentence that starts with the wallet's name starts with a capital ("Your wallet …", "MetaMask …"). */
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const declined = (cause: Cause) => codeOf(cause) === 4001 || /reject|declin|denied|cancel/i.test(textOf(cause) + String((cause as { name?: unknown } | null)?.name ?? ''));

/** An EVM wallet (EIP-1193) failure while connecting or switching networks. */
export function evmWalletErrorMessage(cause: Cause, walletName: string | null, request: 'connect' | 'switch'): string {
  const wallet = walletName || 'your wallet', code = codeOf(cause);
  if (declined(cause)) return request === 'connect' ? `You declined the connection in ${wallet}. Choose Connect Wallet to try again.`
    : `You declined the network switch in ${wallet}. Nothing changed.`;
  if (code === -32002) return `${cap(wallet)} already has a request waiting. Open ${wallet} to approve or reject it, then try again.`;
  if (code === 4100) return `${cap(wallet)} has not authorized FloFi for this account. Unlock ${wallet}, then connect again.`;
  if (code === 4900 || code === 4901) return `${cap(wallet)} is not connected to the network right now. Check ${wallet}, then try again.`;
  if (request === 'switch' && (code === 4902 || textOf(cause) === 'WALLET_DID_NOT_SWITCH'))
    return `${cap(wallet)} stayed on another network. Choose the network in ${wallet}, then try again.`;
  return request === 'connect' ? `Could not connect ${wallet}. Unlock it, make sure it is enabled for this site, and try again.`
    : `Could not switch networks in ${wallet}. Check ${wallet} and try again.`;
}

/** A Solana wallet (Wallet Standard) failure while connecting, switching cluster or proving ownership; `failure` may be FloFi's closed code. */
export function solanaWalletErrorMessage(failure: Cause, walletName: string | null, cluster: string | null = null): string {
  const wallet = walletName || 'your Solana wallet', text = textOf(failure), network = cluster === 'solana:devnet' ? 'Solana Devnet' : 'Solana';
  if (declined(failure)) return `You declined the request in ${wallet}. Choose it again when you are ready.`;
  if (/_BUSY$/.test(text)) return 'Another wallet request is still in progress. Finish it in your wallet, then try again.';
  if (/_SOLANA_WALLET_AMBIGUOUS$/.test(text)) return `Two installed wallets are both named ${wallet}. Disable one of them for this site, then try again.`;
  if (/_WALLET_CHANGED$/.test(text)) return `${cap(wallet)} switched accounts during the request. Check the account in ${wallet}, then try again.`;
  if (/_SOLANA_WALLET_NOT_AUTHORIZED$/.test(text)) return `${cap(wallet)} needs your approval to reconnect. Choose Connect Wallet and approve it in ${wallet}.`;
  if (/_SOLANA_WALLET_REQUIRED$/.test(text)) return `${cap(wallet)} cannot connect and sign on ${network}. Unlock it, or choose another Solana wallet.`;
  if (/_SOLANA_SIGN_MESSAGE_UNSUPPORTED$/.test(text)) return `${cap(wallet)} cannot sign FloFi's sign-in message. Choose another Solana wallet.`;
  return `Could not connect ${wallet}. Unlock it, make sure it is enabled for this site, and try again.`;
}
