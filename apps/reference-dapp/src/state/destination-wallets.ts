// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the owner's wallets a bridge can deliver to, read from what this page already knows — the wallets connected in
 * this session, the FloFi account's wallets (Privy embedded, and the account's linked wallets once the signed-in account is read) and the
 * public addresses saved in Credentials → Wallets — resolved by `resolveDestinationWallet`. Public addresses only; nothing here connects,
 * signs or sends, and nothing is written to the workflow by itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { useFloFiPrivy } from '../accounts/privy-context';
import { accountState } from '../app/account-action';
import { resolveDestinationWallet, type DestinationCandidate, type DestinationEcosystem, type DestinationInventory, type DestinationResolution } from '../domain/destination-wallet';
import { useCredentials } from './credentials-store';
import { useOptionalJupiter } from './jupiter-store';

type AccountWallets = readonly { readonly ecosystem: DestinationEcosystem; readonly address: string; readonly providerName: string }[];
/** The signed-in account's wallets are read once per page (public data; a failure or a signed-out visitor is simply "none"). */
let accountRead: Promise<AccountWallets> | null = null;
function readAccountWallets(): Promise<AccountWallets> {
  accountRead ??= accountState().then(state => state.account?.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address,
    providerName: wallet.provider === 'privy' || wallet.provider === 'turnkey' ? 'FloFi Wallet' : wallet.providerName })) ?? [], () => []);
  return accountRead;
}

/** The connected EVM wallet as the caller's wallet store reports it (callers already hold it). */
export type SessionEvmWallet = { readonly account: string | null; readonly provider?: { readonly name: string } | null } | null | undefined;
export function useDestinationInventory(evm: SessionEvmWallet): DestinationInventory {
  const solana = useOptionalJupiter(), privy = useFloFiPrivy(), credentials = useCredentials();
  const [account, setAccount] = useState<AccountWallets>([]);
  useEffect(() => { let live = true; void readAccountWallets().then(wallets => { if (live) setAccount(wallets); }); return () => { live = false; }; }, []);
  const solanaSession = solana?.session?.chain === 'solana:mainnet' ? solana.session : null;
  return useMemo(() => {
    const session: DestinationCandidate[] = [
      ...evm?.account ? [{ ecosystem: 'evm' as const, address: evm.account, providerName: evm.provider?.name ?? 'Browser wallet', source: 'SESSION' as const }] : [],
      ...solanaSession ? [{ ecosystem: 'solana' as const, address: solanaSession.account.address, providerName: solanaSession.wallet.name, source: 'SESSION' as const }] : []];
    const linked: DestinationCandidate[] = [
      ...(privy?.embedded ?? []).map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: 'FloFi Wallet', source: 'ACCOUNT' as const })),
      ...account.map(wallet => ({ ...wallet, source: 'ACCOUNT' as const }))];
    const saved = credentials.wallets.map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, providerName: wallet.providerName, source: 'SAVED' as const }));
    return { session, account: linked, saved };
  }, [evm?.account, evm?.provider?.name, solanaSession, privy?.embedded, account, credentials.wallets]);
}
/** The resolved destination wallet of each ecosystem (see `resolveDestinationWallet`). */
export function useDestinationWallets(evm: SessionEvmWallet): { readonly inventory: DestinationInventory; readonly evm: DestinationResolution; readonly solana: DestinationResolution } {
  const inventory = useDestinationInventory(evm);
  return useMemo(() => ({ inventory, evm: resolveDestinationWallet('evm', inventory), solana: resolveDestinationWallet('solana', inventory) }), [inventory]);
}
/** The address a resolution fills automatically (exactly one wallet at the first tier that has any), else null. */
export const resolvedAddress = (resolution: DestinationResolution): string | null => resolution.kind === 'RESOLVED' ? resolution.wallet.address : null;
