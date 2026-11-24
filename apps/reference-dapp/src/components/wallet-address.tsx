// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS02): one public wallet address, wherever the person sees one of their wallets (header, Credentials,
 * Dashboard, the Editor's wallet chips). The text may be shortened; the full canonical address is in its tooltip, is read to screen readers,
 * and is exactly what Copy puts on the clipboard (never the shortened text). Its ecosystem (EVM / Solana) and network, when known, are named
 * beside it so an EVM and a Solana address are never confused. Public data only: it never shows or copies a key, phrase or credential.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';

export type AddressEcosystem = 'evm' | 'solana';
const ECOSYSTEM_NAME: Readonly<Record<AddressEcosystem, string>> = { evm: 'EVM', solana: 'Solana' };
/** The displayed form: first 6 and last 4 characters (the whole address when it is already short). */
export const shortWalletAddress = (address: string) => address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
/** The ecosystem a public address belongs to, by its canonical shape (EVM hex; else Solana base58); null when it is neither. */
export function addressEcosystem(address: string): AddressEcosystem | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm';
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? 'solana' : null;
}
const COPIED_MS = 2_000;

export function WalletAddress({ address, ecosystem, network, label, showEcosystem = true, className }: { address: string; ecosystem?: AddressEcosystem | null;
  /** Shown after the ecosystem when the wallet is on a known network ("Base"). Already translated by the caller or a catalog name. */ network?: string | null;
  /** What the address is ("Your wallet", a wallet's name): names the copy button. */ label?: string; showEcosystem?: boolean; className?: string }) {
  const { t } = useLocale();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const kind = ecosystem ?? addressEcosystem(address);
  const name = label ? t(label) : kind ? t('{0} address', ECOSYSTEM_NAME[kind]) : t('Wallet address');
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(address); setState('copied'); } catch { setState('failed'); }
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  }
  return <span className={`wallet-address-value${className ? ` ${className}` : ''}`} data-wallet-address={address} data-ecosystem={kind ?? undefined}>
    {showEcosystem && kind && <span className="wallet-address-ecosystem">{ECOSYSTEM_NAME[kind]}{network ? ` · ${network}` : ''}</span>}
    <code className="numeric wallet-address" title={address}><span aria-hidden="true">{shortWalletAddress(address)}</span><span className="sr-only">{address}</span></code>
    <button type="button" className="wallet-address-copy" aria-label={t('Copy {0}', name)} title={t(state === 'copied' ? 'Copied' : 'Copy address')} data-copy-state={state}
      onClick={() => void copy()}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {state === 'copied' ? <path d="M5 12.5l4.5 4.5L19 7.5"/> : <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>}
      </svg>
    </button>
    <span className="sr-only" role="status" aria-live="polite">{state === 'copied' ? t('{0} copied.', name) : state === 'failed' ? `${t('Copy unavailable.')} ${address}` : ''}</span>
    {state === 'failed' && <span className="wallet-address-copy-failed" aria-hidden="true">{t('Copy unavailable.')} <span className="numeric">{address}</span></span>}
  </span>;
}
