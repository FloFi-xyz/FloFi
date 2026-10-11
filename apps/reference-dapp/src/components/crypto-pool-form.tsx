// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useState, type FormEvent } from 'react';
import { cryptoInputOf, cryptoProfile, defaultPoolRange } from '../domain/crypto-action-picker';
import { useUniswapLiquidity } from '../state/uniswap-liquidity-store';
import { uniswapBandInput, uniswapLiquidityProfileFor } from '../domain/uniswap-liquidity-authoring';
import { useWorkflow } from '../state/workflow-store';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { TokenAmountInput } from './token-amount-input';
import { usePoolContributionInputs } from './canvas-card-inputs';
import { poolReviewFormId } from './composer-card';
import { usePoolPriceRange, poolPriceBounds } from './pool-price-range';
import { ROBINHOOD_NETWORK } from '../domain/asset-catalogs';
import { networkIdentity } from '../domain/network-registry';
import { robinhoodFullRange, ROBINHOOD_LIQUIDITY_DEFAULT_FEE, ROBINHOOD_LIQUIDITY_FEE_TIERS } from '../domain/robinhood-liquidity-authoring';

/** Picker drafts use the existing pool builders and range validators at Review. */
export function CryptoPoolForm({ nodeId }: { nodeId: string }) {
  const { t: tr } = useLocale();
  const { state, actionSetup, cryptoSelections, editPoolSetup, reviewCryptoPool, dismissProposal } = useWorkflow();
  const liquidity = useUniswapLiquidity();
  const wallet = useBuild009Wallet(), contributions = usePoolContributionInputs(nodeId), range = usePoolPriceRange(nodeId);
  const setup = actionSetup?.id === nodeId && actionSetup.action === 'pool' ? actionSetup : null;
  const node = state.workflow.nodes.find(node => node.nodeId === nodeId), existing = node ? cryptoInputOf(node) : null;
  const selection = setup?.cryptoSelection ?? cryptoSelections[nodeId] ?? existing?.selection;
  const sameNetwork = Boolean(existing && existing.selection.network === selection?.network), initial = defaultPoolRange(selection?.network ?? '');
  const [fields, setFields] = useState({ rangeUnit: existing?.rangeUnit ?? 'TICK', lower: sameNetwork ? existing!.lower ?? '-887270' : initial.lower,
    upper: sameNetwork ? existing!.upper ?? '887270' : initial.upper, slippage: existing?.slippage ?? '50' });
  // BUILD-RH-002: a catalog-network pool (Robinhood Chain, BUILD-BASE-001 Base) is the pair's pool at the chosen Uniswap v3 fee tier.
  const [fee, setFee] = useState(existing?.fee ?? ROBINHOOD_LIQUIDITY_DEFAULT_FEE);
  const [error, setError] = useState('');
  if (!selection || selection.action !== 'pool' || !contributions.values) return null;
  const input = setup?.input ?? fields;
  const set = (patch: Partial<typeof fields>) => {
    dismissProposal(); range.reset();
    if (setup) editPoolSetup(nodeId, { ...setup.input, ...patch }); else setFields(current => ({ ...current, ...patch }));
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selection) return;
    try {
      const bounds = range.edited ? poolPriceBounds(range.reference, range.percent, range.preset) : input;
      const failure = reviewCryptoPool(nodeId, { selection, amount: contributions.values![0]!.amount, secondAmount: contributions.values![1]!.amount,
        rangeUnit: bounds.rangeUnit, lower: bounds.lower, upper: bounds.upper, slippage: input.slippage, ...networkIdentity(selection.network)?.catalog ? { fee } : {},
        ...(setup?.cryptoBeneficiary ?? existing?.beneficiary ?? wallet.account ? { beneficiary: setup?.cryptoBeneficiary ?? existing?.beneficiary ?? wallet.account! } : {}) });
      if (failure) throw new Error(failure);
      if (range.edited) range.markReviewed();
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid pool settings'); }
  }
  async function aroundCurrent() {
    if (selection?.network !== 'Base Sepolia' && selection?.network !== 'Ethereum Sepolia') return;
    const price = await liquidity.fetchPrice(uniswapLiquidityProfileFor(selection.network).chain);
    if (price) { const bounds = uniswapBandInput(price.sqrtPriceX96, 1_000, selection.network); set({ rangeUnit: bounds.rangeUnit, lower: bounds.lower, upper: bounds.upper }); }
  }
  const profile = cryptoProfile(selection)!;
  const catalogNetwork = networkIdentity(selection.network), symbols = [selection.from, selection.to!], robinhood = catalogNetwork?.catalog === true;
  /** A new fee tier has its own tick spacing: the range restarts at that tier's full range. */
  const chooseFee = (value: number) => { const full = robinhoodFullRange(value, catalogNetwork?.chain); setFee(value); set({ rangeUnit: 'TICK', lower: String(full.tickLower), upper: String(full.tickUpper) }); };
  return <form id={poolReviewFormId(nodeId)} className="inspector-fields" aria-label={tr(`Edit ${selection.network} liquidity position`)} onSubmit={submit}>
    <p className="muted">{tr(profile.provider)} · {tr(selection.network)} · {tr(symbols.join(' / '))}</p>
    {symbols.map((symbol, index) => <label key={symbol}>{tr("Maximum ")}{symbol}<TokenAmountInput aria-label={tr(`Maximum ${symbol}`)} maxLength={40} value={contributions.values![index]!.amount} onValueChange={amount => contributions.edit(index, amount)}/></label>)}
    <label>{tr("Range unit")}<select aria-label={tr("Range unit")} value={input.rangeUnit} onChange={event => set({ rangeUnit: event.target.value as 'PRICE' | 'TICK' })}>
      <option value="TICK">{tr("Tick")}</option>{!robinhood && <option value="PRICE">{tr("Price")}</option>}
    </select></label>
    {robinhood && <label>{tr("Fee tier")}<select aria-label={tr("Liquidity fee tier")} value={fee} onChange={event => chooseFee(Number(event.target.value))}>
      {ROBINHOOD_LIQUIDITY_FEE_TIERS.map(tier => <option key={tier} value={tier}>{tr(`${tier / 10_000}%`)}</option>)}</select></label>}
    <label>{tr("Lower bound")}<input aria-label={tr("Lower bound")} value={input.lower} onChange={event => set({ lower: event.target.value })}/></label>
    <label>{tr("Upper bound")}<input aria-label={tr("Upper bound")} value={input.upper} onChange={event => set({ upper: event.target.value })}/></label>
    {robinhood ? <small>{selection.network === ROBINHOOD_NETWORK ? tr("Real funds on Robinhood Chain. Simulate checks both tokens against the official registry and the live pool.")
      : tr("Real funds on {0}. Simulate checks both tokens against the network's official catalog and the chain, and that the pool is live.", selection.network)}</small>
      : selection.network === 'Base Sepolia' || selection.network === 'Ethereum Sepolia' ? <button type="button" className="quiet" disabled={liquidity.busy || !liquidity.available} onClick={() => void aroundCurrent()}>{tr("Use ±10% around the current ")}{tr(selection.network)}{tr(" price")}</button> : <button type="button" className="quiet" onClick={() => void range.refresh()}>{tr("Refresh current pool price")}</button>}
    {<label>{tr("Slippage (bps)")}<input aria-label={tr("Liquidity slippage (bps)")} inputMode="numeric" value={input.slippage} onChange={event => set({ slippage: event.target.value })}/></label>}
    {error && <p role="alert">{tr(error)}</p>}
  </form>;
}
