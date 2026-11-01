// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-02, P1-06): the signed-in account's own FloFi wallets (Privy embedded wallets) are ready in the
 * app without a second "Connect Wallet".
 *
 * Before: FloFi wallets were registered for explicit selection only, so a person who created EVM and Solana wallets during onboarding still
 * saw "Wallet not connected" in /app and had to pick "FloFi Wallet" in the selector (and again after every reload).
 *
 * Now, per ecosystem and once per page load, when NO wallet has been connected on this page yet, the account's FloFi wallet is connected:
 *  - only a wallet the server lists for this signed-in account (flofi-wallet-sync.ts registers exactly those);
 *  - only when the choice is unambiguous: the remembered FloFi wallet, or the account's single FloFi wallet of that ecosystem;
 *  - never in place of an external wallet: not when the person's last explicit choice was an external wallet (its store restores it), not
 *    when a wallet this browser already authorized answers silently (`eth_accounts`), and never after any wallet was seen on this page (a
 *    MetaMask that locks mid-session is not replaced);
 *  - never after an explicit Disconnect, unless the person has signed in since (sign-in-wallet.ts: own FloFi wallets only);
 *  - never on an approval page (`/approve`, `/mcp/approve`), inside an embedding frame, or in engineering certification;
 *  - the automatic connection is not remembered as the person's choice: the remembered wallet stays what the person last picked.
 * Connecting a FloFi wallet shares its public address with this page only: no prompt, no signature, no authority. Every transaction still
 * needs a fresh simulation, the Strategy Manifest review and the person's confirmation in Privy's own screen.
 */
import { useEffect, useReducer, useRef } from 'react';
import { chosenEvmProvider, evmWalletEntries, injected, isFloFiWalletKey, subscribeEvmDiscovery } from '../wallet/evm-discovery';
import { solanaWalletChoices, subscribeSolanaDiscovery } from '../wallet/solana-wallet';
import { isFloFiWalletChoice } from '../wallet/flofi-wallet-sync';
import { accountWalletReconnectAllowed } from '../wallet/sign-in-wallet';
import { updateWalletPreference, walletPreference, type WalletChoice, type WalletEcosystem, type WalletPreference } from '../wallet/wallet-registry';
import { activeNetworkScope } from '../domain/network-scope';
import { useBuild009Wallet } from './build009-wallet-store';
import { useJupiter } from './jupiter-store';

/** The FloFi wallet to connect: the remembered one, else the only one; null when there is none or the choice is ambiguous. */
export function accountWalletChoice(choices: readonly WalletChoice[], isFloFi: (choice: WalletChoice) => boolean, remembered: string | null): WalletChoice | null {
  const own = choices.filter(isFloFi);
  return own.find(choice => choice.key === remembered) ?? (own.length === 1 ? own[0]! : null);
}
/** Whether the person's last explicit choice in this ecosystem was another (external) wallet, which its store restores instead. */
export const prefersExternalWallet = (remembered: string | null, isFloFiKey: (key: string) => boolean) => remembered !== null && !isFloFiKey(remembered);
/** Whether this ecosystem is still disconnected by the person (no sign-in since that Disconnect re-allowed their own FloFi wallet). */
export function accountWalletBlocked(ecosystem: WalletEcosystem, preference: WalletPreference, reconnectAllowed: boolean): boolean {
  return (ecosystem === 'evm' ? preference.evmDisconnected : preference.solanaDisconnected) && !reconnectAllowed;
}

export function AccountWalletAutoConnect({ disabled = false }: { disabled?: boolean }) {
  const evm = useBuild009Wallet(), solana = useJupiter();
  const tried = useRef({ evm: false, solana: false });
  // Latched: once any wallet was connected on this page, its absence later (locked, switched, disconnected) is never filled automatically.
  if (evm.account) tried.current.evm = true;
  if (solana.session) tried.current.solana = true;
  const live = useRef(evm); live.current = evm;
  // FloFi wallets register after the account read (syncFloFiWallets); each registration re-runs the checks below.
  const [registrations, registered] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stopEvm = subscribeEvmDiscovery(registered), stopSolana = subscribeSolanaDiscovery(registered);
    return () => { stopEvm(); stopSolana(); };
  }, []);
  const off = disabled || activeNetworkScope() === 'ENGINEERING';

  useEffect(() => {
    if (off || tried.current.evm || evm.account || evm.restoring || evm.busy) return;
    const preference = walletPreference();
    if (accountWalletBlocked('evm', preference, accountWalletReconnectAllowed('evm')) || prefersExternalWallet(preference.evm, isFloFiWalletKey)) return;
    const choice = accountWalletChoice(evmWalletEntries().map(entry => entry.choice), entry => isFloFiWalletKey(entry.key), preference.evm);
    if (!choice) return;
    tried.current.evm = true;
    void (async () => {
      // A wallet this browser already authorized for FloFi (read silently, never a prompt) is kept, never replaced.
      if (injected() && await evm.session()) return;
      // Anything the person did meanwhile wins: a selector choice, a new remembered wallet, a connection or a request in flight.
      const now = walletPreference(), current = live.current;
      if (chosenEvmProvider() || current.account || current.busy || now.evm !== preference.evm ||
          accountWalletBlocked('evm', now, accountWalletReconnectAllowed('evm'))) return;
      const session = await evm.connectWith(choice.id);
      // Automatic, not the person's choice: keep the remembered wallet AND the Disconnect mark exactly as they were (a disconnected external
      // wallet must not come back on the next load because this page connected the account's own FloFi wallet).
      if (session) updateWalletPreference({ evm: preference.evm, evmDisconnected: preference.evmDisconnected });
    })();
  }, [off, evm, registrations]);

  useEffect(() => {
    if (off || tried.current.solana || solana.session || solana.restoring || solana.busy) return;
    const preference = walletPreference();
    const choices = solanaWalletChoices('solana:mainnet');
    const floFi = (choice: WalletChoice) => isFloFiWalletChoice(choice);
    if (accountWalletBlocked('solana', preference, accountWalletReconnectAllowed('solana')) ||
      preference.solana !== null && !choices.some(choice => choice.key === preference.solana && floFi(choice))) return;
    const choice = accountWalletChoice(choices, floFi, preference.solana);
    if (!choice) return;
    tried.current.solana = true;
    void solana.connectWithResult(choice.key, 'solana:mainnet').then(result => {
      if (result.ok) updateWalletPreference({ solana: preference.solana, solanaDisconnected: preference.solanaDisconnected }); });
  }, [off, solana, registrations]);
  return null;
}
