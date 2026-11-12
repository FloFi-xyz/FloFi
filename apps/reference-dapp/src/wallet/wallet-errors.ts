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
const declined = (cause: Cause) => codeOf(cause) === 4001 || /reject|declin|denied|cancel/i.test(textOf(cause) + String((cause as { name?: unknown } | null)?.name ?? ''));

/**
 * P0 hotfix (locale contract): a wallet notice is a catalog message and its values (`[template, ...values]`), rendered with explicit `{0}`
 * parameters in the interface's current language (`tr(...notice)`); the wallet's own name is the only value. A notice for an unnamed wallet is a
 * whole sentence of its own (never "your wallet" spliced into another language). `walletNoticeText` is the English sentence.
 */
export type WalletNotice = readonly [string, ...string[]];
export const walletNoticeText = ([template, ...values]: WalletNotice): string => template.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? '');
/** The sentence for an unnamed wallet, or the template naming it (`{0}`). */
const named = (name: string | null, unnamed: string, template: string): WalletNotice => name ? [template, name] : [unnamed];

/** An EVM wallet (EIP-1193) failure while connecting or switching networks. */
export function evmWalletNotice(cause: Cause, walletName: string | null, request: 'connect' | 'switch'): WalletNotice {
  const name = walletName || null, code = codeOf(cause);
  if (declined(cause)) return request === 'connect'
    ? named(name, 'You declined the connection in your wallet. Choose Connect Wallet to try again.', 'You declined the connection in {0}. Choose Connect Wallet to try again.')
    : named(name, 'You declined the network switch in your wallet. Nothing changed.', 'You declined the network switch in {0}. Nothing changed.');
  if (code === -32002) return named(name, 'Your wallet already has a request waiting. Open your wallet to approve or reject it, then try again.',
    '{0} already has a request waiting. Open {0} to approve or reject it, then try again.');
  if (code === 4100) return named(name, 'Your wallet has not authorized FloFi for this account. Unlock your wallet, then connect again.',
    '{0} has not authorized FloFi for this account. Unlock {0}, then connect again.');
  if (code === 4900 || code === 4901) return named(name, 'Your wallet is not connected to the network right now. Check your wallet, then try again.',
    '{0} is not connected to the network right now. Check {0}, then try again.');
  if (request === 'switch' && (code === 4902 || textOf(cause) === 'WALLET_DID_NOT_SWITCH'))
    return named(name, 'Your wallet stayed on another network. Choose the network in your wallet, then try again.', '{0} stayed on another network. Choose the network in {0}, then try again.');
  return request === 'connect' ? named(name, 'Could not connect your wallet. Unlock it, make sure it is enabled for this site, and try again.',
    'Could not connect {0}. Unlock it, make sure it is enabled for this site, and try again.')
    : named(name, 'Could not switch networks in your wallet. Check your wallet and try again.', 'Could not switch networks in {0}. Check {0} and try again.');
}
/** The English sentence of `evmWalletNotice` (unchanged wording). */
export const evmWalletErrorMessage = (cause: Cause, walletName: string | null, request: 'connect' | 'switch'): string => walletNoticeText(evmWalletNotice(cause, walletName, request));

/** A Solana wallet (Wallet Standard) failure while connecting, switching cluster or proving ownership; `failure` may be FloFi's closed code. */
export function solanaWalletNotice(failure: Cause, walletName: string | null, cluster: string | null = null): WalletNotice {
  const name = walletName || null, text = textOf(failure), network = cluster === 'solana:devnet' ? 'Solana Devnet' : 'Solana';
  if (declined(failure)) return named(name, 'You declined the request in your Solana wallet. Choose it again when you are ready.', 'You declined the request in {0}. Choose it again when you are ready.');
  if (/_BUSY$/.test(text)) return ['Another wallet request is still in progress. Finish it in your wallet, then try again.'];
  if (/_SOLANA_WALLET_AMBIGUOUS$/.test(text)) return named(name, 'Two installed wallets have the same name. Disable one of them for this site, then try again.',
    'Two installed wallets are both named {0}. Disable one of them for this site, then try again.');
  if (/_WALLET_CHANGED$/.test(text)) return named(name, 'Your Solana wallet switched accounts during the request. Check the account in your Solana wallet, then try again.',
    '{0} switched accounts during the request. Check the account in {0}, then try again.');
  if (/_SOLANA_WALLET_NOT_AUTHORIZED$/.test(text)) return named(name, 'Your Solana wallet needs your approval to reconnect. Choose Connect Wallet and approve it in your Solana wallet.',
    '{0} needs your approval to reconnect. Choose Connect Wallet and approve it in {0}.');
  if (/_SOLANA_WALLET_REQUIRED$/.test(text)) return name ? ['{0} cannot connect and sign on {1}. Unlock it, or choose another Solana wallet.', name, network]
    : [`Your Solana wallet cannot connect and sign on ${network}. Unlock it, or choose another Solana wallet.`];
  if (/_SOLANA_SIGN_MESSAGE_UNSUPPORTED$/.test(text)) return named(name, 'Your Solana wallet cannot sign FloFi\'s sign-in message. Choose another Solana wallet.',
    '{0} cannot sign FloFi\'s sign-in message. Choose another Solana wallet.');
  return named(name, 'Could not connect your Solana wallet. Unlock it, make sure it is enabled for this site, and try again.', 'Could not connect {0}. Unlock it, make sure it is enabled for this site, and try again.');
}
/** The English sentence of `solanaWalletNotice` (unchanged wording). */
export const solanaWalletErrorMessage = (failure: Cause, walletName: string | null, cluster: string | null = null): string => walletNoticeText(solanaWalletNotice(failure, walletName, cluster));
