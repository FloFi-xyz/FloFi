// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRIVY-UX-001: the FloFi import screen for one ecosystem — Wallet name, Private key, Import wallet.
 *
 * The private key is read once from its field when the person presses Import wallet, handed to Privy's `importWallet` (which encrypts it
 * into Privy's isolated wallet frame on `auth.privy.io`), and the field is cleared at once, whatever happens. It is never kept in React
 * state, never put in a URL, form submission, server action, log, analytics event or storage, and never sent to FloFi's server: FloFi
 * receives only the resulting public address and the name, and saves them after Privy's API confirms the wallet belongs to this person.
 * The page runs under the account pages' strict Content Security Policy, outside the workflow application.
 */
import { useId, useRef, useState } from 'react';
import { useLocale } from '../../i18n/locale';
import { savePrivyWallet, type AccountState } from '../../app/account-action';
import { WALLET_LABEL_MAX, walletLabel } from '../../accounts/account-model';
import { useFloFiPrivy } from '../../accounts/privy-client';
import type { WalletEcosystem } from '../../wallet/wallet-registry';
import { AccountIcon } from './account-icons';
import { accountMessage } from './account-messages';
import { AccountShell, accountStyles as styles } from './account-shell';

const NAME: Readonly<Record<WalletEcosystem, string>> = { evm: 'EVM', solana: 'Solana' };
/** Shape only (no key material is logged or returned): a 32-byte hex key for EVM, a base58 secret key for Solana. */
export function privateKeyShapeValid(ecosystem: WalletEcosystem, value: string): boolean {
  return ecosystem === 'evm' ? /^(?:0x)?[0-9a-fA-F]{64}$/.test(value) : /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(value);
}

export function ImportWallet({ state, ecosystem }: { state: AccountState; ecosystem: WalletEcosystem }) {
  const { t } = useLocale();
  const privy = useFloFiPrivy();
  const keyField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(`Imported ${NAME[ecosystem]} wallet`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId(), keyId = useId(), noteId = useId();
  const ready = Boolean(state.account?.privy && state.availability.managedWallets && privy?.ready && privy.authenticated);

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!privy || busy) return;
    const field = keyField.current, label = walletLabel(name);
    // Read once, then clear the field immediately: from here the key exists only inside this call to Privy.
    const key = (field?.value ?? '').trim();
    if (field) field.value = '';
    setError(null);
    if (!label) { setError('ACCOUNT_WALLET_LABEL_INVALID'); return; }
    if (!privateKeyShapeValid(ecosystem, key)) { setError('PRIVY_PRIVATE_KEY_INVALID'); return; }
    setBusy(true);
    let address: string;
    try { address = (await privy.importWallet(ecosystem, ecosystem === 'evm' && !key.startsWith('0x') ? `0x${key}` : key)).address; }
    catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : 'PRIVY_WALLET_IMPORT_FAILED'); return; }
    const token = await privy.getAccessToken();
    const saved = token ? await savePrivyWallet(token, ecosystem, address, label).catch(() => ({ ok: false as const, code: 'ACCOUNT_WALLET_SAVE_FAILED' }))
      : { ok: false as const, code: 'PRIVY_SESSION_REQUIRED' };
    // Back to onboarding, where the new address shows in its card. A save that did not finish is completed there (wallet recovery).
    if (saved.ok) { window.location.replace('/onboarding/wallets'); return; }
    setBusy(false); setError(saved.code);
  }

  return <AccountShell showcase="wallets" start>
    <p className={styles.crumbs}><a href="/onboarding/wallets">{t('Add wallets')}</a> / <span aria-current="page">{t('Import {0} wallet', NAME[ecosystem])}</span></p>
    <h1 className={styles.heading} style={{ marginTop: 28 }}>{t('Import your {0} wallet', NAME[ecosystem])}</h1>
    <p className={styles.lead}>{t('Your private key goes straight to our wallet provider, Privy, in its own secure frame. FloFi never receives, stores or logs it.')}</p>
    {!ready && <div className={styles.banner} role="status"><strong>{t('Importing isn’t available right now.')}</strong>
      <p>{t('Go back to Add wallets and sign in again if it asks you to.')}</p><a className={styles.primary} href="/onboarding/wallets">{t('Back to Add wallets')}</a></div>}
    <form className={styles.form} onSubmit={event => void submit(event)} aria-label={t('Import {0} wallet', NAME[ecosystem])} autoComplete="off" data-import-ecosystem={ecosystem}>
      <label htmlFor={nameId}>{t('Wallet name')}</label>
      <input id={nameId} className={styles.input} type="text" required maxLength={WALLET_LABEL_MAX} value={name} disabled={!ready || busy}
        onChange={event => setName(event.currentTarget.value)}/>
      <label htmlFor={keyId}>{t('Private key')}</label>
      <input id={keyId} ref={keyField} className={styles.input} type="password" required autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        inputMode="text" data-1p-ignore="true" data-lpignore="true" aria-describedby={noteId} disabled={!ready || busy}
        placeholder={ecosystem === 'evm' ? '0x…' : t('Base58 private key')}/>
      <p id={noteId} className={styles.small} style={{ textAlign: 'left', margin: 0 }}>
        <AccountIcon name="shield" size={14}/> {t(ecosystem === 'evm' ? 'Paste the 64-character hexadecimal private key of the EVM wallet.' : 'Paste the base58 private key of the Solana wallet.')}
        {' '}{t('Never share it with anyone else.')}</p>
      <button type="submit" className={styles.primary} disabled={!ready || busy}>{t(busy ? 'Importing…' : 'Import wallet')}</button>
      <a className={styles.textLink} href="/onboarding/wallets">{t('Cancel')}</a>
    </form>
    {error && <p className={styles.error} role="alert">{t(accountMessage(error))}</p>}
    <p className={styles.small}>{t('Importing a wallet authorizes nothing. Every transaction is still simulated, reviewed and signed by you.')}</p>
  </AccountShell>;
}
