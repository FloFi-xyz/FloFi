// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { TokenUnitsText } from '../token-amount-text';
import { createContext, useContext, useEffect, useId, useState } from 'react';
import { positionsWalletKey, type PositionScan, type PositionWallet } from '../../domain/defi-positions';
import { liquidityPositionChoiceValid, type LiquidityPositionChoice, type LiquidityPositionView } from '../../domain/liquidity-positions';
import type { LiquidityPositionPoolInput } from '../../domain/commands';
import { DEFAULT_SLIPPAGE_BPS } from '../../domain/slippage-policy';
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

/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: how a position action reaches the Editor. It only PREPARES the workflow (the owner's choice committed as
 * MANAGE_LIQUIDITY_POSITION and staged for Simulate) and returns why it could not (a code), or null. Nothing is simulated, reviewed or signed:
 * the owner still simulates, reviews and confirms in their wallet. `fresh` starts a new workflow first, on the owner's explicit click.
 */
export type PreparePosition = (choice: LiquidityPositionChoice, pool: LiquidityPositionPoolInput, fresh?: boolean) => string | null;
const PrepareContext = createContext<PreparePosition | null>(null);

export function DefiPositions({ evm, solana, prepare }: { evm: string | null; solana: string | null; prepare?: PreparePosition | undefined }) {
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
      {opened && <PrepareContext.Provider value={prepare ?? null}><PositionsContent key={JSON.stringify([evm, solana, proofVersion])} evm={evm} solana={solana}/></PrepareContext.Provider>}
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

export function PositionResults({ scans, prepare }: { scans: readonly PositionScan[]; prepare?: PreparePosition | undefined }) {
  const { t, language } = useLocale();
  const prepareFromContext = useContext(PrepareContext), prepareAction = prepare ?? prepareFromContext;
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
              <span title={asset.address}>{asset.units === null ? t('{0}: amount unavailable', asset.symbol) : <TokenUnitsText units={asset.units} decimals={asset.decimals} symbol={asset.symbol}/>}</span>
              {asset.units !== null && asset.units !== '0' && <small title={valuation ? t('Price observed {0}', formatObservedAt(valuation.observedAt, language) ?? '—') : undefined}>
                {valuation ? t('≈ {0} (Chainlink)', formatUsdValue(valuation.usd, language)) : t('Valuation unavailable')}
              </small>}
              {asset.recordedOwedUnits && <small>{t('{0} {1} recorded unclaimed', formatTokenAmount(asset.recordedOwedUnits, asset.decimals, language), asset.symbol)}</small>}
            </li>;
          })}</ul>
          {position.type === 'LIQUIDITY' && position.liquidity && <LiquidityPositionFacts view={position.liquidity} prepare={prepareAction}/>}
        </li>)}</ul>}
      </section>;
    })}
  </div>;
}

/** The Dashboard's three position actions; each is offered only when the verified view lists its operation. */
export type LiquidityPositionAction = 'COLLECT' | 'REMOVE' | 'CLOSE';
const SHARES = [2_500, 5_000, 7_500] as const;
/** The actions a verified position offers now, only from `view.operations` (capability-driven; never inferred here). */
export function liquidityPositionActions(view: Pick<LiquidityPositionView, 'operations' | 'manageable'>): LiquidityPositionAction[] {
  if (!view.manageable.ok) return [];
  return [...view.operations.includes('COLLECT') ? ['COLLECT' as const] : [], ...view.operations.includes('DECREASE') ? ['REMOVE' as const] : [],
    ...view.operations.includes('EXIT') ? ['CLOSE' as const] : []];
}
/**
 * The owner's choice for one action. Remove liquidity: a share of the position (100% removes everything and keeps a Uniswap NFT); Close position:
 * a Uniswap exit that burns the emptied NFT only because the owner picked it, an Orca exit (which always closes the position). Null when the
 * view does not offer it.
 */
export function liquidityPositionChoiceFor(view: LiquidityPositionView, action: LiquidityPositionAction, shareBps = 5_000): LiquidityPositionChoice | null {
  if (!liquidityPositionActions(view).includes(action)) return null;
  const orca = view.ref.protocol === 'ORCA', position = view.ref;
  let choice: LiquidityPositionChoice | null;
  if (action === 'COLLECT') choice = { position, operation: 'COLLECT', partBps: null, close: false };
  else if (action === 'CLOSE') choice = { position, operation: 'EXIT', partBps: null, close: true };
  // 100%: every unit of liquidity, the Uniswap NFT kept (an Orca exit always closes its position, so it is "Close position" only).
  else if (shareBps >= 10_000) choice = !orca && view.operations.includes('EXIT') ? { position, operation: 'EXIT', partBps: null, close: false } : null;
  else choice = { position, operation: 'DECREASE', partBps: shareBps, close: false };
  return choice && liquidityPositionChoiceValid(choice) ? choice : null;
}
/** The pool node a position operation is prepared on: the verified pool, its exact range and the principal it held (never deposited). */
export function liquidityPositionPoolOf(view: LiquidityPositionView): LiquidityPositionPoolInput {
  return { token0: view.token0, token1: view.token1, feeTier: view.feeTier, tickLower: view.tickLower, tickUpper: view.tickUpper,
    amount0: view.principal[0] ?? '0', amount1: view.principal[1] ?? '0', slippageBps: DEFAULT_SLIPPAGE_BPS };
}
const rangeLabel = { IN_RANGE: 'In range', BELOW_RANGE: 'Out of range (below)', ABOVE_RANGE: 'Out of range (above)' } as const;
const unmanageable: Readonly<Record<string, string>> = {
  POOL_NOT_VERIFIED: 'FloFi cannot verify this pool, so it cannot prepare actions for this position.',
  LEGACY_POSITION_TOKEN: 'This position token type is not managed by FloFi.',
  DELEGATED_POSITION_TOKEN: 'This position token is delegated, so FloFi does not manage it.',
  REWARDS_UNSUPPORTED: 'This pool emits rewards FloFi does not model yet, so it cannot prepare actions for this position.',
};

/**
 * A verified liquidity position's facts (range and state, current price, liquidity status, principal, recorded owed tokens and fees, what a
 * collection would pay now, last verification) and its capability-driven actions. The actions PREPARE the workflow and open the Editor; they
 * never simulate, sign or send anything.
 */
function LiquidityPositionFacts({ view, prepare }: { view: LiquidityPositionView; prepare: PreparePosition | null }) {
  const { t, language } = useLocale();
  const [removing, setRemoving] = useState(false), [share, setShare] = useState(5_000);
  const [refusal, setRefusal] = useState<{ readonly code: string; readonly choice: LiquidityPositionChoice } | null>(null);
  const pair = (units: readonly (string | null)[]) => units.every(unit => unit !== null)
    ? `${formatTokenAmount(units[0]!, view.token0.decimals, language)} ${view.token0.symbol} + ${formatTokenAmount(units[1]!, view.token1.decimals, language)} ${view.token1.symbol}` : null;
  // The price unit is the catalog's own phrase ("WETH per USDC" / "WETH por USDC"), never an English word inside a Portuguese line.
  const priced = (value: string) => t('{0} {1} per {2}', value, view.price.quote, view.price.base);
  const verified = formatObservedAt(view.observedAt, language);
  const actions = prepare ? liquidityPositionActions(view) : [];
  const orca = view.ref.protocol === 'ORCA';
  const run = (choice: LiquidityPositionChoice | null, fresh = false) => {
    if (!choice || !prepare) return;
    const code = prepare(choice, liquidityPositionPoolOf(view), fresh);
    setRefusal(code ? { code, choice } : null);
  };
  return <div className={styles.liquidity} data-liquidity-position={view.ref.positionId}>
    <dl className={styles.facts}>
      <div><dt>{t('Range')}</dt><dd>{priced(`${view.lowerPrice}–${view.upperPrice}`)} · {t(view.rangeState ? rangeLabel[view.rangeState] : 'Range state unavailable')}</dd></div>
      <div><dt>{t('Current price')}</dt><dd>{view.currentPrice === null ? t('Unavailable') : priced(view.currentPrice)}</dd></div>
      {/* The position's status (an adjective, "Aberta"), never the catalog's verb "Open" → "Abrir" of the buttons. */}
      <div><dt>{t('Liquidity')}</dt><dd>{t(view.status === 'OPEN' ? 'Open (has liquidity)' : 'Empty (no liquidity)')}</dd></div>
      <div><dt>{t('Principal')}</dt><dd>{pair(view.principal) ?? t('Unavailable')}</dd></div>
      <div><dt>{t('Owed tokens and fees (recorded)')}</dt><dd>{pair(view.recordedOwed) ?? t('Unavailable')}</dd></div>
      <div><dt>{t('Collectable now')}</dt><dd>{view.collectable ? pair(view.collectable) : t('Unavailable')}</dd></div>
      {verified && <div><dt>{t('Last verified')}</dt><dd>{verified}</dd></div>}
    </dl>
    {!view.manageable.ok && <p className={styles.note}>{t(unmanageable[view.manageable.reason] ?? 'FloFi cannot prepare actions for this position.')}</p>}
    {actions.length > 0 && <>
      <div className={styles.actions} role="group" aria-label={t('Position actions')}>
        {actions.includes('COLLECT') && <button type="button" className="ux-button ux-button-small" onClick={() => run(liquidityPositionChoiceFor(view, 'COLLECT'))}>{t('Collect fees')}</button>}
        {actions.includes('REMOVE') && <button type="button" className="ux-button ux-button-small" aria-expanded={removing} onClick={() => setRemoving(value => !value)}>{t('Remove liquidity')}</button>}
        {actions.includes('CLOSE') && <button type="button" className="ux-button ux-button-small" onClick={() => run(liquidityPositionChoiceFor(view, 'CLOSE'))}>{t('Close position')}</button>}
      </div>
      {removing && <div className={styles.actions} role="group" aria-label={t('Share of liquidity to remove')}>
        <label>{t('Share to remove')}
          <select value={share} onChange={event => setShare(Number(event.target.value))}>
            {SHARES.map(value => <option key={value} value={value}>{value / 100}%</option>)}
            {!orca && actions.includes('CLOSE') && <option value={10_000}>{t('100% (keep the position NFT)')}</option>}
          </select>
        </label>
        <button type="button" className="ux-button ux-button-small" onClick={() => run(liquidityPositionChoiceFor(view, 'REMOVE', share))}>{t('Prepare removal')}</button>
      </div>}
      <p className={styles.note}>{t(orca && actions.includes('CLOSE') ? 'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here. Closing an Orca position refunds its account rent.'
        : 'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here.')}</p>
    </>}
    {refusal && <PreparationRefusal code={refusal.code} startNew={() => run(refusal.choice, true)}/>}
  </div>;
}

/**
 * Why the Editor did not take a position action (nothing was prepared, simulated or sent): the open workflow has other steps (the owner may start a
 * new workflow for the position — an explicit click), it is still being executed or checked (it is never changed under its run), or the
 * preparation failed.
 */
export function PreparationRefusal({ code, startNew }: { code: string; startNew: () => void }) {
  const { t } = useLocale();
  if (code === 'POSITION_WORKFLOW_HAS_OTHER_STEPS') return <div role="alert" className={styles.actions} data-position-refusal={code}>
    <p>{t('Your current workflow has other steps. Start a new workflow for this position; the current one stays in your history if you saved it.')}</p>
    <button type="button" className="ux-button ux-button-small" onClick={startNew}>{t('Start a new workflow')}</button>
  </div>;
  return <p role="alert" data-position-refusal={code}>{t(code === 'POSITION_WORKFLOW_EXECUTING'
    ? 'Your current workflow is still being executed or checked. Follow it in Operate; prepare this position once it has finished. Nothing was changed.'
    : 'This position could not be prepared. Nothing was simulated or sent. Refresh the positions and try again.')}</p>;
}
