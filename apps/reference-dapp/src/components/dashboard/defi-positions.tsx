// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useId, useState } from 'react';
import { positionsWalletKey, type PositionScan, type PositionWallet } from '../../domain/defi-positions';
import { WALLET_PROOF_CHANGED } from '../../domain/wallet-proof-events';
import { formatObservedAt, formatTokenAmount, formatUsdValue, shortAddress } from '../../domain/wallet-portfolio';
import { useLocale } from '../../i18n/locale';
import styles from './defi-positions.module.css';

async function read<T>(signal: AbortSignal, wallet?: PositionWallet): Promise<T> {
  const response = await fetch('/api/dashboard/positions', { cache: 'no-store', credentials: 'same-origin', signal,
    ...wallet && { headers: { 'x-flofi-account': wallet.address } } });
  const body = await response.json() as { readonly ok: boolean; readonly value: T };
  if (!response.ok || !body.ok) throw new Error('POSITION_SCAN_UNAVAILABLE');
  return body.value;
}

export function DefiPositions({ evm, solana }: { evm: string | null; solana: string | null }) {
  const { t } = useLocale();
  const heading = useId(), content = useId();
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState(false);
  const [proofVersion, setProofVersion] = useState(0);
  useEffect(() => {
    setReady(true);
    const invalidate = () => setProofVersion(version => version + 1);
    window.addEventListener(WALLET_PROOF_CHANGED, invalidate);
    return () => window.removeEventListener(WALLET_PROOF_CHANGED, invalidate);
  }, []);
  return <section className="ux-panel" aria-labelledby={heading}>
    <h2 id={heading}><button type="button" className={styles.disclosure} disabled={!ready} aria-busy={!ready} aria-expanded={opened} aria-controls={content}
      onClick={() => setOpened(value => !value)}>{t('My DeFi Positions')}</button></h2>
    <div id={content} hidden={!opened}>
      {opened && <PositionsContent key={JSON.stringify([evm, solana, proofVersion])} evm={evm} solana={solana}/>}
    </div>
  </section>;
}

function PositionsContent({ evm, solana }: { evm: string | null; solana: string | null }) {
  const { t } = useLocale();
  const [generation, setGeneration] = useState(0);
  const [directory, setDirectory] = useState<{ readonly generation: number; readonly wallets: readonly PositionWallet[] | null }>();
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read<readonly PositionWallet[]>(controller.signal).then(
      wallets => { if (!controller.signal.aborted) setDirectory({ generation, wallets }); },
      () => { if (!controller.signal.aborted) setDirectory({ generation, wallets: null }); });
    return () => controller.abort();
  }, [generation]);

  if (!directory || directory.generation !== generation) return <p role="status">{t('Checking wallets for DeFi positions…')}</p>;
  const { wallets } = directory;
  if (!wallets) return <div role="alert"><p>{t('Wallets are temporarily unavailable.')}</p>
    <button type="button" className="ux-button ux-button-small" onClick={() => setGeneration(value => value + 1)}>{t('Retry')}</button></div>;
  if (!wallets.length) return <p role="status">{evm || solana ? t('Verify or link this wallet to scan its DeFi positions.')
    : t('Connect or link a wallet to view its DeFi positions.')}</p>;
  const selected = wallets.find(wallet => positionsWalletKey(wallet) === chosen) ??
    wallets.find(wallet => wallet.address === evm?.toLowerCase() || wallet.address === solana) ?? (wallets.length === 1 ? wallets[0] : undefined);
  const key = selected ? positionsWalletKey(selected) : '';
  return <div className={styles.content}>
    <p className="ux-panel-text">{t('DeFi positions are separate from liquid wallet balances. Supplied assets, liquidity and debt are shown individually.')}</p>
    <label className={styles.wallet}>{t('Wallet to scan')}
      <select value={key} onChange={event => setChosen(event.target.value)}>
        {!selected && <option value="">{t('Select a wallet')}</option>}
        {wallets.map(wallet => <option key={positionsWalletKey(wallet)} value={positionsWalletKey(wallet)} title={wallet.address}>
          {wallet.namespace === 'solana' ? 'Solana' : 'EVM'} · {shortAddress(wallet.address)}
        </option>)}
      </select>
    </label>
    {selected && <WalletPositions key={key} wallet={selected}/>}
    <details className="ux-details">
      <summary>{t('Position scan coverage')}</summary>
      <ul>
        <li>{t('Aave V3 on Ethereum, Base and Arbitrum One covers registered reserves and variable debt.')}</li>
        <li>{t('Uniswap V3 covers up to 20 directly held position NFTs per network on Ethereum, Base, Arbitrum One and Robinhood Chain.')}</li>
        <li>{t('Orca covers standalone positions on the registered SOL/USDC Whirlpool on Solana, with up to 40 candidate tokens checked. Bundles and other pools are outside this scan.')}</li>
        <li>{t('Recorded unclaimed amounts can include withdrawn principal. Newly accrued fees and rewards are outside this scan.')}</li>
      </ul>
    </details>
  </div>;
}

function WalletPositions({ wallet }: { wallet: PositionWallet }) {
  const { t } = useLocale();
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ readonly generation: number; readonly scans: readonly PositionScan[] | null }>();
  // Keep the selected wallet's dependent fetch out of the server-action queue and discard answers for a previous wallet.
  useEffect(() => {
    const controller = new AbortController();
    void read<readonly PositionScan[]>(controller.signal, wallet).then(
      scans => { if (!controller.signal.aborted) setResult({ generation, scans }); },
      () => { if (!controller.signal.aborted) setResult({ generation, scans: null }); });
    return () => controller.abort();
  }, [wallet, generation]);
  const current = result?.generation === generation ? result : null;
  return <div aria-busy={!current} className={styles.content}>
    {!current ? <p role="status">{t('Scanning DeFi positions…')}</p> : <>
      {current.scans ? <PositionResults scans={current.scans}/> : <p role="alert">{t('DeFi positions are temporarily unavailable.')}</p>}
      <div><button type="button" className="ux-button ux-button-small" onClick={() => setGeneration(value => value + 1)}>
        {t(current.scans ? 'Refresh' : 'Retry')}</button></div>
    </>}
  </div>;
}

const stateLabel: Readonly<Record<Exclude<PositionScan['status'], 'COMPLETE'>, string>> = {
  PARTIAL: 'Partial scan. Some positions or amounts could not be read.',
  UNAVAILABLE: 'Position data temporarily unavailable.',
  UNSUPPORTED: 'Protocol unsupported on this network.',
  NETWORK_UNAVAILABLE: 'Network is unavailable for position reads on this deployment.',
};
const typeLabel = { SUPPLIED: 'Supplied', VARIABLE_DEBT: 'Variable debt', LIQUIDITY: 'Liquidity position' } as const;

export function PositionResults({ scans }: { scans: readonly PositionScan[] }) {
  const { t, language } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const future = scans.flatMap(scan => scan.positions.flatMap(position => position.assets.map(asset =>
      asset.valuation ? Date.parse(asset.valuation.expiresAt) : 0))).filter(expiry => expiry > now);
    if (!future.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...future) - Date.now()));
    return () => clearTimeout(timer);
  }, [scans, now]);

  return <div className={styles.scans} aria-live="polite">
    {scans.map(scan => {
      const observedAt = formatObservedAt(scan.observedAt, language);
      return <section className="ux-panel" key={`${scan.chain}:${scan.protocol}`} aria-label={`${scan.protocol} · ${scan.network}`}>
        <div className="ux-panel-head"><h3>{scan.protocol} · {scan.network}</h3></div>
        {scan.provenance === 'MOCKED' && <p>{t('Test data (MOCKED)')}</p>}
        {scan.status === 'COMPLETE' ? !scan.positions.length && <p>{t('No positions found in this scan.')}</p>
          : <p>{t(stateLabel[scan.status])}</p>}
        {observedAt && <p className="ux-panel-text">{t('Last scanned {0}', observedAt)}</p>}
        {scan.risk && <p className="ux-panel-text">
          {t('Health factor: {0}', formatTokenAmount(scan.risk.healthFactor, 18, language))} · {' '}
          {t('Liquidation threshold: {0}%', formatTokenAmount(scan.risk.liquidationThresholdBps, 2, language))}
        </p>}
        {!!scan.positions.length && <ul className="ux-list">{scan.positions.map(position => <li key={position.id} className={styles.row}>
          <strong>{t(typeLabel[position.type])}{position.type === 'LIQUIDITY' && <small> · {shortAddress(position.id)}</small>}</strong>
          {position.collateralEnabled === true && <small>{t('Enabled as collateral')}</small>}
          <ul>{position.assets.map(asset => {
            const valuation = asset.valuation && Date.parse(asset.valuation.expiresAt) > now ? asset.valuation : null;
            return <li key={asset.address}>
              <span title={asset.address}>{asset.units === null ? t('{0}: amount unavailable', asset.symbol) : `${formatTokenAmount(asset.units, asset.decimals, language)} ${asset.symbol}`}</span>
              {asset.units !== null && asset.units !== '0' && <small title={valuation ? t('Price observed {0}', formatObservedAt(valuation.observedAt, language) ?? '—') : undefined}>
                {valuation ? t('≈ {0} (Chainlink)', formatUsdValue(valuation.usd, language)) : t('Valuation unavailable')}
              </small>}
              {asset.recordedOwedUnits && <small>{t('{0} {1} recorded unclaimed', formatTokenAmount(asset.recordedOwedUnits, asset.decimals, language), asset.symbol)}</small>}
            </li>;
          })}</ul>
        </li>)}</ul>}
      </section>;
    })}
  </div>;
}
