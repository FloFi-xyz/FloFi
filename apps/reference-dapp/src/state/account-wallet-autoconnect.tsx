// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P1-02, P1-06): the signed-in account's own FloFi wallets (Privy embedded wallets) are ready in the
 * app without a second "Connect Wallet".
 *
 * Before: FloFi wallets were registered for explicit selection only, so a person who created EVM and Solana wallets during onboarding still
 * saw "Wallet not connected" in /app and had to pick "FloFi Wallet" in the selector (and again after every reload).
 *
 * Now, per ecosystem, when nothing is connected and the person has not disconnected in FloFi, the account's FloFi wallet is connected:
 *  - only a wallet the server lists for this signed-in account (flofi-wallet-sync.ts registers exactly those);
 *  - never in place of an external wallet: if the person's last explicit choice was an external wallet (MetaMask, Phantom, …), the stores
 *    restore that one, and a wallet this browser already authorized silently (`eth_accounts`) wins;
 *  - only when the choice is unambiguous: the remembered FloFi wallet, or the account's single FloFi wallet of that ecosystem;
 *  - once per page load per ecosystem, never after an explicit Disconnect (until the next sign-in), never inside an embedding frame.
 *
 * Connecting a FloFi wallet shares its public address with this page only: no prompt, no signature, no authority. Every transaction still
 * needs a fresh simulation, the Strategy Manifest review and the person's confirmation in Privy's own screen.
 */
import { useEffect, useReducer, useRef } from 'react';
import { evmWalletEntries, injected, isFloFiWalletKey, subscribeEvmDiscovery } from '../wallet/evm-discovery';
import { solanaWalletChoices, subscribeSolanaDiscovery } from '../wallet/solana-wallet';
import { isFloFiWalletChoice } from '../wallet/flofi-wallet-sync';
import { walletPreference, type WalletChoice } from '../wallet/wallet-registry';
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

export function AccountWalletAutoConnect({ disabled = false }: { disabled?: boolean }) {
  const evm = useBuild009Wallet(), solana = useJupiter();
  const tried = useRef({ evm: false, solana: false });
  // FloFi wallets register after the account read (syncFloFiWallets); each registration re-runs the checks below.
  const [registrations, registered] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stopEvm = subscribeEvmDiscovery(registered), stopSolana = subscribeSolanaDiscovery(registered);
    return () => { stopEvm(); stopSolana(); };
  }, []);

  useEffect(() => {
    if (disabled || tried.current.evm || evm.account || evm.restoring || evm.busy) return;
    const preference = walletPreference();
    if (preference.evmDisconnected || prefersExternalWallet(preference.evm, isFloFiWalletKey)) return;
    const choice = accountWalletChoice(evmWalletEntries().map(entry => entry.choice), entry => isFloFiWalletKey(entry.key), preference.evm);
    if (!choice) return;
    tried.current.evm = true;
    void (async () => {
      // A wallet this browser already authorized for FloFi (read silently, never a prompt) is kept, never replaced.
      if (injected() && await evm.session()) return;
      if (walletPreference().evmDisconnected) return;
      await evm.connectWith(choice.id);
    })();
  }, [disabled, evm, registrations]);

  useEffect(() => {
    // Engineering certification keeps its own explicit cluster choice; the public product signs Solana on mainnet-beta only.
    if (disabled || activeNetworkScope() === 'ENGINEERING' || tried.current.solana || solana.session || solana.restoring || solana.busy) return;
    const preference = walletPreference();
    const choices = solanaWalletChoices('solana:mainnet');
    const floFi = (choice: WalletChoice) => isFloFiWalletChoice(choice);
    if (preference.solanaDisconnected || preference.solana !== null && !choices.some(choice => choice.key === preference.solana && floFi(choice))) return;
    const choice = accountWalletChoice(choices, floFi, preference.solana);
    if (!choice) return;
    tried.current.solana = true;
    void solana.connectWithResult(choice.key, 'solana:mainnet');
  }, [disabled, solana, registrations]);
  return null;
}
