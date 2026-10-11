// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { usePublicTestnet } from '../state/public-testnet-store';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { useWorkflow } from '../state/workflow-store';
import { BASE_SEPOLIA, quoteDecimals, swapProfile } from '../domain/public-testnet-swap';
import type { PublicQuote } from '../server/public-testnet-service';

function units(value: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return '--';
  const padded = value.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
const amount = (value: string, symbol: string, decimals: number) => `${units(value, decimals)} ${symbol}`;
const pay = (q: PublicQuote, value: string) => amount(value, q.inputSymbol, quoteDecimals(q, 'input'));
const get = (q: PublicQuote, value: string) => amount(value, q.outputSymbol, quoteDecimals(q, 'output'));
/** BUILD-RH-002: shares per token as an exact decimal (1e18 = 1.0), never rounded through a float. */
const multiplier = (wad: string) => units(wad, 18);
/** Stock Token facts bound into a Robinhood Chain Review: multiplier, scheduled change and the issuer's eligibility notice. */
function StockFacts({ quote }: { quote: PublicQuote }) {
  const { t: tr } = useLocale();
  if (!quote.stocks?.length) return null;
  return <div className="step-card" aria-label={tr("Stock Token details")}>
    <dl className="step-facts">{quote.stocks.map(stock => <div key={stock.officialId}><dt>{tr("{0} shares per token", stock.symbol)}</dt>
      <dd className="numeric">{multiplier(stock.multiplierWad)}</dd></div>)}</dl>
    {quote.stocks.some(stock => stock.scheduledEffectiveAt > 0 && stock.scheduledMultiplierWad !== stock.multiplierWad) &&
      <p role="status">{tr("A corporate action will change the shares per token after this Review expires.")}</p>}
    {quote.stocks.some(stock => stock.fractionalRestricted) && <p role="status">{tr("Fractional trading of the underlying share is restricted.")}</p>}
    <p className="muted">{tr("Stock Tokens are issued by Robinhood Assets (Jersey) Limited and are not offered to US persons or in restricted jurisdictions.")}</p>
  </div>;
}
export function PublicTestnetPanel({ view }: { view: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const flow = usePublicTestnet();
  const wallet = useBuild009Wallet();
  const { run, busy, error } = flow;
  const quote = run?.quote;
  // The quoted chain (else the authored swap's chain) names the network; Base Sepolia before anything is authored, as before.
  const authored = useWorkflow().state.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')?.chainId;
  const profile = swapProfile(quote?.chainId ?? authored) ?? BASE_SEPOLIA, network = profile.network, mainnet = profile.environment === 'MAINNET';
  const last = run?.attempts.at(-1);
  const receipt = last?.receipt;
  const needReview = quote && run?.reviewedManifestHash !== quote.manifestHash;
  const expired = quote ? Date.now() >= Date.parse(quote.expiresAt) : false;
  if (view === 'simulate') return <section className="simulate-panel panel" aria-label={tr(`${network} swap simulation`)}>
    <div className="simulate-head"><div><p className="eyebrow">{tr("SIMULATE")}</p><h2>{tr("Uniswap swap · ")}{network}</h2>
      <p className="muted">{tr("Get a current quote from the public pool before reviewing the swap.")}</p></div>
      <button type="button" onClick={flow.simulate} disabled={Boolean(busy) || !flow.available || Boolean(last && ['PREPARED','HASH','PENDING','UNKNOWN'].includes(last.state))}>{tr("Simulate")}</button></div>
    {!flow.available && <p role="status">{tr(mainnet ? '{0} is not enabled on this app instance.' : 'Public testnet recording is not enabled on this app instance.', network)}</p>}
    {busy && <p role="status">{tr(busy)}…</p>}{error && <p role="alert">{tr(error)}</p>}
    {quote && !flow.retired && <div className="step-card" aria-label={tr("Live swap quote")}><h3>{tr("Current quote")}</h3>
      <dl className="step-facts"><div><dt>{tr("You pay")}</dt><dd className="numeric">{tr(pay(quote, quote.amountIn))}</dd></div>
        <div><dt>{tr("Expected")}</dt><dd className="numeric">{tr(get(quote, quote.expectedOut))}</dd></div>
        <div><dt>{tr("Minimum received")}</dt><dd className="numeric">{tr(get(quote, quote.minimumOut))}</dd></div>
        <div><dt>{tr("Slippage")}</dt><dd className="numeric">{tr(quote.slippageBps / 100)}%</dd></div>
        <div><dt>{tr("Network")}</dt><dd>{network}</dd></div></dl>
      {expired && <p role="status">{tr("Quote expired. Simulate again.")}</p>}
    </div>}
    {quote && !flow.retired && <StockFacts quote={quote}/>}
    {flow.retired && <p role="status">{tr("The swap changed. Simulate again to review the new amount.")}</p>}
  </section>;
  if (!quote || !run) return <section className="panel" aria-label={tr("Swap review")}><h2>{tr("Simulate your swap first")}</h2>
    <p>{tr("Get a current ")}{network}{tr(" quote before reviewing a transaction.")}</p></section>;
  if (run.outcome) return <section className="execution-panel panel" aria-label={tr("Swap result")}>
    <p className="eyebrow">{tr("RESULT")}</p><h2>{tr("Executed ✓")}</h2><p>{network}</p>
    <dl className="step-facts"><div><dt>{tr("Swapped")}</dt><dd className="numeric">{tr(pay(quote, run.outcome.inputSpent))}</dd></div>
      <div><dt>{tr("Received")}</dt><dd className="numeric">{tr(get(quote, run.outcome.outputReceived))}</dd></div>
      <div><dt>{tr(last?.receipt?.gasPayer !== last?.account ? 'Sponsored network fee' : 'Network fee')}</dt>
        <dd className="numeric">{tr(units(run.outcome.gasCostWei, 18))}{tr(" ETH")}</dd></div>
      <div><dt>{tr("Transaction")}</dt><dd className="numeric">{last?.txHash}</dd></div></dl>
    <a href={run.outcome.explorer} target="_blank" rel="noopener noreferrer">{tr("View transaction")}</a>
    <details><summary>{tr("Technical evidence")}</summary><pre>{JSON.stringify({ evidenceBundleHash: run.outcome.evidenceBundleHash,
      bundle: run.outcome.evidence, receipt, attempts: run.attempts }, null, 2)}</pre></details>
  </section>;
  return <section className="execution-panel panel" aria-label={tr("Swap review and execution")}>
    <p className="eyebrow">{tr("REVIEW")}</p><h2>{tr("Swap on ")}{network}</h2>
    <dl className="step-facts"><div><dt>{tr("You pay")}</dt><dd className="numeric">{tr(pay(quote, quote.amountIn))}</dd></div>
      <div><dt>{tr("Expected")}</dt><dd className="numeric">{tr(get(quote, quote.expectedOut))}</dd></div>
      <div><dt>{tr("Minimum received")}</dt><dd className="numeric">{tr(get(quote, quote.minimumOut))}</dd></div>
      <div><dt>{tr("Slippage")}</dt><dd className="numeric">{tr(quote.slippageBps / 100)}%</dd></div>
      <div><dt>{tr("Network")}</dt><dd>{network}</dd></div>
      <div><dt>{tr("Network cost")}</dt><dd>{tr("Shown in your wallet before confirmation")}</dd></div>
      <div><dt>{tr("Token approval")}</dt><dd>{tr("Requested only if your current allowance is insufficient")}</dd></div></dl>
    <StockFacts quote={quote}/>
    {mainnet && <p role="note">{tr("Real funds: your wallet signs and sends this transaction on {0}. Flofi never signs for you.", network)}</p>}
    {flow.retired && <p role="alert">{tr("This swap changed. Simulate it again.")}</p>}
    {expired && <p role="status">{tr("Quote expired. Simulate again.")}</p>}
    {error && <p role="alert">{tr(error)}</p>}{busy && <p role="status">{tr(busy)}…</p>}
    {wallet.account && wallet.chainId !== profile.chainHex && <div><p role="status">{tr("Switch your wallet to ")}{network}{tr(" to continue.")}</p>
      <button type="button" onClick={flow.switchNetwork} disabled={Boolean(busy)}>{tr("Switch to ")}{network}</button></div>}
    {last?.state === 'REVERTED' && <p role="alert">{tr(last.step === 'approval' ? 'Token approval reverted.' : 'The swap reverted.')} <a href={`${profile.explorer}${last.txHash}`} target="_blank" rel="noopener noreferrer">{tr("View transaction")}</a></p>}
    {last?.state === 'REJECTED' && <p role="status">{tr("Wallet authorization was rejected. You can try again.")}</p>}
    {last?.state === 'UNKNOWN' && <p role="alert">{tr("The wallet result is uncertain. Flofi will not submit this transaction again.")}</p>}
    {last && ['HASH','PENDING','CONFIRMED'].includes(last.state) && !run.outcome && <div><p role="status">{tr(last.step === 'approval' && last.state === 'CONFIRMED' ? 'Token approval confirmed. Continue to the swap.' :
      last.state === 'CONFIRMED' ? 'Transaction confirmed. Checking token balances.' : 'Transaction submitted. Waiting for a public receipt.')}</p>
      {last.txHash && <a href={`${profile.explorer}${last.txHash}`} target="_blank" rel="noopener noreferrer">{tr("View transaction")}</a>}
      {last.state !== 'CONFIRMED' || last.step === 'swap' ? <button type="button" onClick={flow.observe} disabled={Boolean(busy)}>{tr("Check result")}</button> : null}</div>}
    <div className="simulate-controls">
      {needReview && !flow.retired && !expired && last?.step !== 'swap' && last?.state !== 'UNKNOWN' &&
        <button type="button" onClick={flow.review} disabled={Boolean(busy)}>{tr("Confirm review")}</button>}
      {!needReview && !flow.retired && !expired && last?.state !== 'UNKNOWN' &&
        !['PREPARED','HASH','PENDING'].includes(last?.state ?? '') && last?.step !== 'swap' &&
        <button type="button" className="primary" onClick={flow.execute} disabled={Boolean(busy) || (wallet.account !== null && wallet.chainId !== profile.chainHex)}>
          {tr(last?.step === 'approval' ? 'Continue to swap' : 'Execute')}</button>}
    </div>
    <details><summary>{tr("Transaction details")}</summary><p>{tr("Uniswap v3 pool ")}{tr(quote.pool)}{tr(" · fee tier ")}{tr(quote.fee)}{tr(" · quote block ")}{tr(quote.blockNumber)}.</p>
      <p>{tr("Reviewed manifest: ")}<code>{quote.manifestHash}</code>.</p></details>
  </section>;
}
