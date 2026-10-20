// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useState, type FormEvent } from 'react';
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';
import { createAuthoredTransfer, formatEth, isSolanaTransferNetwork, SOLANA_TRANSFER_NETWORKS, transferDetails, transferProfileFor, TRANSFER_NETWORKS, type RobinhoodTransferInput,
  type TransferNetwork } from '../domain/robinhood-transfer-authoring';
import { solanaTransferSymbols } from '../domain/solana-transfer-authoring';
import { BASE_CHAIN, featuredNetworkSymbols, featuredStockSymbols, resolveNetworkAsset } from '../domain/asset-catalogs';
import { networkIdentity } from '../domain/network-registry';
import { useWorkflow } from '../state/workflow-store';
import { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import { useBuild009Wallet } from '../state/build009-wallet-store';

/** Copy is written for Robinhood Testnet; another transfer network's name is substituted. Display text only. */
const short = (network: TransferNetwork) => network === 'Robinhood Chain Testnet' ? 'Robinhood' : network;
function transferCopy(text: string, network: TransferNetwork): string {
  return network === 'Robinhood Chain Testnet' ? text : text.replaceAll('Robinhood Chain Testnet', network).replaceAll('Robinhood Testnet', network).replaceAll('Robinhood', network);
}

export function RobinhoodTransferAuthoringForm({ nodeId, onDone, direct = false }: { nodeId?: string; onDone?: () => void; direct?: boolean }) {
  const { t: tr } = useLocale();
  const { state, propose, dispatch } = useWorkflow(), node = state.workflow.nodes.find(n => n.nodeId === nodeId);
  const existing = node ? transferDetails(node as Parameters<typeof transferDetails>[0]) : null;
  const [amount, setAmount] = useState(existing?.amount ?? '0.000001'), [error, setError] = useState('');
  const [network, setNetwork] = useState<TransferNetwork>(existing?.network ?? 'Robinhood Chain Testnet');
  // BUILD-RH-002: Robinhood Chain mainnet moves native ETH or a catalog asset, to the owner or an explicit recipient (BUILD-BASE-001: so does Base).
  // BUILD-SOLANA-TRANSFER-UX-001: Solana (SOL, USDC, USDT) and Solana Devnet (SOL, devUSDC) always name an explicit recipient wallet.
  const solana = isSolanaTransferNetwork(network), mainnet = solana || networkIdentity(network)?.catalog === true;
  const [asset, setAsset] = useState(existing?.asset ?? (solana ? 'SOL' : 'ETH'));
  const [customToken, setCustomToken] = useState(Boolean(existing?.decimals !== undefined));
  const [mint, setMint] = useState(existing?.decimals !== undefined ? existing.asset : '');
  const [decimals, setDecimals] = useState(existing?.decimals ?? '6');
  const [program, setProgram] = useState<'spl-token' | 'token-2022'>(existing?.program ?? 'spl-token');
  const [recipient, setRecipient] = useState(existing && existing.recipient !== 'CONNECTED_OWNER' ? existing.recipient : '');
  const assets = solana ? [...new Set([...solanaTransferSymbols(network), asset])] : network === 'Base' ? [...new Set(['ETH', ...featuredNetworkSymbols(BASE_CHAIN), asset])]
    : mainnet ? [...new Set(['ETH', 'USDG', 'WETH', ...featuredStockSymbols(), asset])] : ['ETH'];
  function submit(event: FormEvent) { event.preventDefault(); try {
    const input: RobinhoodTransferInput = solana ? { network, asset: customToken ? mint.trim() : asset, amount, recipient: recipient.trim(),
      ...customToken ? { decimals, program } : {} }
      : { network, asset: mainnet ? asset : 'ETH', amount, recipient: mainnet && recipient.trim() ? recipient.trim() : 'CONNECTED_OWNER' };
    createAuthoredTransfer(nodeId ?? 'node-preview', input);
    const command = nodeId ? { type: 'SET_RH_TRANSFER' as const, nodeId, input, source: 'CANVAS' as const, baseRevision: state.workflow.revision }
      : { type: 'ADD_RH_TRANSFER' as const, input, source: 'CANVAS' as const, baseRevision: state.workflow.revision };
    if (direct) dispatch(command); else propose(command); onDone?.();
  } catch (cause) { setError(cause instanceof Error && cause.message === 'ASSET_CATALOG_UNAVAILABLE' ? network === 'Robinhood Chain'
      ? 'Robinhood assets are unavailable right now. Try again in a moment.' : `${network} tokens are unavailable right now. Try again in a moment.`
    : solana ? 'Enter an exact positive amount and the recipient\'s Solana wallet address.'
    : mainnet ? 'Enter an exact positive amount for the selected asset and, optionally, a valid recipient address.' : 'Enter an exact positive test-ETH amount up to 0.001 with at most 18 decimal places.'); } }
  return <form className="inspector-fields" aria-label={tr(nodeId ? 'Edit Robinhood transfer' : 'Create Robinhood transfer')} onSubmit={submit}>
    <strong>{tr(mainnet ? `${network} transfer` : transferCopy('Robinhood Testnet test-ETH self-transfer', network))}</strong>
    <label>{tr("Transfer network")}<select aria-label={tr("Transfer network")} value={network} onChange={e => { const next = e.target.value as TransferNetwork; setNetwork(next);
      if (isSolanaTransferNetwork(next) !== solana) setAsset(isSolanaTransferNetwork(next) ? 'SOL' : 'ETH'); }}>
      {([...Object.keys(TRANSFER_NETWORKS), ...SOLANA_TRANSFER_NETWORKS] as TransferNetwork[]).map(name => <option key={name}>{name}</option>)}</select></label>
    {mainnet && <label>{tr("Asset")}<select aria-label={tr("Transfer asset")} value={solana && customToken ? 'CUSTOM_SPL' : asset} onChange={e => {
      setCustomToken(e.target.value === 'CUSTOM_SPL'); if (e.target.value !== 'CUSTOM_SPL') setAsset(e.target.value);
    }}>
      {assets.map(symbol => <option key={symbol}>{symbol}</option>)}{solana && <option value="CUSTOM_SPL">{tr('Other SPL token')}</option>}</select></label>}
    {solana && customToken && <>
      <label>{tr('Token mint')}<input aria-label={tr('Token mint')} required value={mint} maxLength={44} spellCheck={false} autoComplete="off" onChange={event => setMint(event.target.value)}/></label>
      <label>{tr('Token decimals')}<input aria-label={tr('Token decimals')} required type="number" min={0} max={18} step={1} value={decimals} onChange={event => setDecimals(event.target.value)}/></label>
      <label>{tr('Token program')}<select aria-label={tr('Token program')} value={program} onChange={event => setProgram(event.target.value as typeof program)}><option value="spl-token">SPL Token</option><option value="token-2022">Token-2022</option></select></label>
      <p>{tr('FloFi verifies the mint, decimals, token program and supported extensions on chain before signing.')}</p>
    </>}
    <label>{tr(mainnet ? 'Transfer amount' : 'Transfer amount (test ETH)')}<input aria-label={tr(mainnet ? 'Transfer amount' : 'Transfer amount (test ETH)')} inputMode="decimal" value={amount} maxLength={40} onChange={e => setAmount(e.target.value)}/></label>
    {solana ? <label>{tr("Recipient")}<input aria-label={tr("Transfer recipient")} placeholder={tr("Solana address")} autoComplete="off" spellCheck={false} required value={recipient} maxLength={44} onChange={e => setRecipient(e.target.value)}/></label>
      : mainnet ? <label>{tr("Recipient (optional)")}<input aria-label={tr("Transfer recipient")} placeholder={tr("Your connected wallet")} autoComplete="off" spellCheck={false} value={recipient} maxLength={42} onChange={e => setRecipient(e.target.value)}/></label>
      : <p>{tr("Recipient: your connected owner wallet (a self-transfer), bound at Review. Only the network fee is spent. A chain execution proof, not a DeFi action.")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button type="submit">{tr(nodeId ? 'Review transfer change' : direct ? 'Add transfer' : 'Review transfer proposal')}</button>
    {onDone && <button type="button" className="quiet" onClick={onDone}>{tr("Cancel")}</button>}
  </form>;
}
const messages: Record<string, string> = {
  TRANSFER_PUBLIC_TESTNET_NOT_ENABLED: 'Robinhood Testnet execution is not enabled on this app instance.',
  ROBINHOOD_MAINNET_NOT_ENABLED: 'Robinhood Chain is not enabled on this app instance.',
  BASE_MAINNET_NOT_ENABLED: 'Base mainnet is not enabled on this app instance.',
  ETHEREUM_MAINNET_NOT_ENABLED: 'Ethereum Mainnet is not enabled on this app instance.',
  ETHEREUM_STORAGE_NOT_CONFIGURED: 'Ethereum Mainnet execution storage is not configured on this app instance.',
  ETHEREUM_TOKEN_LIST_UNAVAILABLE: 'The Ethereum token list is unavailable. Try again later.',
  OWNER_EXECUTION_NOT_ENABLED: 'Real-funds execution is not enabled on this app instance. Review is available; nothing was sent.',
  TRANSFER_INSUFFICIENT_ETH: 'The owner wallet needs ETH on this network for the network fee.', TRANSFER_INSUFFICIENT_TOKEN_BALANCE: 'The owner wallet does not hold enough of this asset.',
  TRANSFER_RECIPIENT_NOT_EOA: 'ETH can only be sent to a regular wallet address here, not to a contract.',
  TRANSFER_ASSET_IDENTITY_CHANGED: 'The official asset registry no longer matches this asset. Build the transfer again.',
  TRANSFER_STOCK_MULTIPLIER_MISMATCH: 'The Robinhood registry and the chain disagree on the shares per token. Nothing was prepared.',
  TRANSFER_STOCK_MULTIPLIER_CHANGE_PENDING: 'A corporate action will change the shares per token before this Review could be used. Try again after it takes effect.',
  TRANSFER_STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED: 'A corporate action changed the shares per token. Simulate and review again.',
  STOCK_REGISTRY_UNAVAILABLE: 'The official Robinhood asset registry is unavailable. Try again later.',
  TRANSFER_WRONG_CHAIN: 'Switch your wallet to Robinhood Chain Testnet.', TRANSFER_WRONG_ACCOUNT: 'Select the owner wallet shown in Review.',
  TRANSFER_INSUFFICIENT_TEST_ETH: 'The owner wallet needs Robinhood Testnet ETH from the faucet.', TRANSFER_OWNER_NOT_EOA: 'The owner account has code (for example a smart-account delegation). Use a plain EOA account.',
  TRANSFER_PENDING_TRANSACTION: 'The wallet has a pending transaction. Wait for it to settle, then simulate again.',
  TRANSFER_REVIEW_EXPIRED: 'Review expired. Simulate and review again.', TRANSFER_AUTHORIZATION_STALE: 'Wallet state changed since Review. Simulate and review again.',
  TRANSFER_WALLET_NONCE_MISMATCH: 'The wallet would use a different nonce than the Review. Simulate and review again.',
  TRANSFER_REJECTED: 'The transfer request was declined in the wallet. Nothing was submitted.', AWAITING_CONFIRMATIONS: 'Waiting for network confirmations.',
  TRANSFER_TRANSACTION_NOT_OBSERVED: 'No transaction for the reviewed nonce is visible yet. Flofi will not submit again; observe later.',
  TRANSFER_SUBMISSION_UNKNOWN_OBSERVE_EXISTING: 'The wallet result is uncertain. Flofi will not submit again; observe the existing request.',
  TRANSFER_SUBMISSION_UNKNOWN: 'The wallet result is uncertain. Flofi will not submit again; observe the existing request.',
  TRANSFER_RPC_RATE_LIMITED: 'The public Robinhood Testnet provider is busy. Try again.',
};
export function RobinhoodTransferPanel({ view }: { view: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const { state } = useWorkflow(), run = useRobinhoodTransfer(), wallet = useBuild009Wallet(), record = run.record, review = record?.review;
  const node = state.workflow.nodes.find(n => n.actionType === 'asset.transfer'), fields = node ? transferDetails(node as Parameters<typeof transferDetails>[0]) : null;
  // The reviewed chain (else the authored one) names the network; Robinhood Testnet before anything is authored, as before.
  const network: TransferNetwork = (Object.keys(TRANSFER_NETWORKS) as TransferNetwork[]).find(name => TRANSFER_NETWORKS[name]?.chain === (review?.chain ?? node?.chainId)) ?? 'Robinhood Chain Testnet';
  const profile = transferProfileFor(network);
  const attempt = record?.attempt, info = run.error ?? record?.error, observation = record?.observations.at(-1);
  const observing = Boolean(attempt && !attempt.reconciled && !record?.notSubmitted && record?.verdict === 'PENDING');
  const evidenceLevel = record?.evidence ? `${record.evidence.bundle.environment} / RECONCILED` : record?.verdict === 'DIVERGENT' ? 'DIVERGENT' : record?.authorization ? 'READY_FOR_OWNER_EXECUTION' : null;
  // BUILD-RH-002: token transfers show the asset in its own decimals; the native self-transfer copy stays as it was.
  const token = review?.asset ? resolveNetworkAsset(review.chain, { address: review.asset.token }) : null;
  const symbol = review?.asset ? token?.symbol ?? 'Token' : fields?.asset ?? 'ETH';
  const amountText = review?.asset ? formatAssetAmount(review.value, review.asset.decimals) : fields?.amount ?? (review ? formatEth(review.value) : '');
  const selfTransfer = !review || review.recipient === review.account;
  return <section className="panel" aria-label={tr(transferCopy('Robinhood Testnet transfer', network))}><h2>{tr(view === 'simulate' ? `Simulate ${short(network)} transfer` : record?.evidence ? `${short(network)} transfer result` : `Review ${short(network)} transfer`)}</h2>
    {networkIdentity(network)?.catalog ? <p>{tr("Transfer ")}{tr(amountText)} {tr(symbol)}{tr(" on ")}{network}{tr(selfTransfer ? ' to your connected wallet.' : '.')}
      {' '}{tr("Real funds: your wallet signs and sends this transaction; Flofi never signs for you.")}</p>
      : <p>{tr("Self-transfer ")}{tr(fields?.amount ?? (review ? formatEth(review.value) : ''))}{tr(" test ETH on ")}{network}{tr(". A chain execution proof, not a DeFi action.")}</p>}
    {run.retired && record && <p role="alert">{tr("The workflow changed. Authorization is invalid. Observe any existing transaction before starting again.")}</p>}
    {review && <dl className="step-facts">
      <div><dt>{tr("Network")}</dt><dd>{network}{tr(" · chain ID ")}{tr(review.chainId)} ({tr(review.chain)})</dd></div>
      <div><dt>{tr("Owner")}</dt><dd className="numeric">{review.account}</dd></div><div><dt>{tr("Recipient")}</dt><dd className="numeric">{tr(review.recipient)}{tr(selfTransfer ? ' (owner, self-transfer)' : '')}</dd></div>
      {review.asset ? <>
        <div><dt>{tr("Asset")}</dt><dd>{tr(symbol)} · <span className="numeric">{tr(review.asset.token)}</span></dd></div>
        <div><dt>{tr("Exact amount")}</dt><dd className="numeric">{tr(amountText)} {tr(symbol)}{tr(" (")}{tr(review.value)}{tr(" units)")}</dd></div>
        {review.asset.multiplierWad && <div><dt>{tr("Shares per token")}</dt><dd className="numeric">{tr(formatAssetAmount(review.asset.multiplierWad, 18))}</dd></div>}
        <div><dt>{tr("Asset balance")}</dt><dd className="numeric">{tr(formatAssetAmount(review.asset.balanceBefore, review.asset.decimals))} → {tr(formatAssetAmount(review.asset.expectedBalanceAfter, review.asset.decimals))} {tr(symbol)}</dd></div>
        <div><dt>{tr("Calldata")}</dt><dd><code>{tr(review.transaction.data)}</code>{tr(" (token transfer)")}</dd></div>
      </> : <>
        <div><dt>{tr("Exact value")}</dt><dd className="numeric">{tr(formatEth(review.value))}{tr(" ETH (")}{tr(review.value)}{tr(" wei)")}</dd></div>
        <div><dt>{tr("Calldata")}</dt><dd><code>{tr(review.transaction.data)}</code>{tr(" (none: native transfer)")}</dd></div>
      </>}
      <div><dt>{tr("Current balance")}</dt><dd className="numeric">{tr(formatEth(review.balanceBefore))}{tr(" ETH")}</dd></div>
      <div><dt>{tr("Expected balance after")}</dt><dd className="numeric">{tr(formatEth(review.expectedBalanceAfter))}{tr(selfTransfer && !review.asset ? ' ETH (value returns to the owner; only the fee is spent)' : ' ETH')}</dd></div>
      <div><dt>{tr("Gas estimate")}</dt><dd className="numeric">{tr(review.gasEstimate)}{tr(" gas (limit ")}{tr(review.gasLimit)})</dd></div>
      <div><dt>{tr("Expected network cost")}</dt><dd className="numeric">{tr(formatEth(review.expectedFee))}{tr(" ETH")}</dd></div>
      <div><dt>{tr("Maximum fee budget")}</dt><dd className="numeric">{tr(formatEth(review.feeBudget))}{tr(" ETH (")}{tr(review.gasLimit)}{tr(" gas × ")}{tr(review.maxFeePerGas)}{tr(" wei)")}</dd></div>
      <div><dt>{tr("Worst-case balance after")}</dt><dd className="numeric">{tr(formatEth(review.minimumBalanceAfter))}{tr(" ETH")}</dd></div>
      <div><dt>{tr("Nonce")}</dt><dd className="numeric">{tr(review.nonce)}</dd></div>
      <div><dt>{tr("Reviewed state")}</dt><dd className="numeric">{tr("block ")}{tr(review.state.block)} · {tr(review.state.blockHash)}</dd></div>
      <div><dt>{tr("Review expires")}</dt><dd>{tr(review.expiresAt)}</dd></div>
      <div><dt>{tr("Exact transaction")}</dt><dd className="numeric">{JSON.stringify(review.transaction)}</dd></div>
    </dl>}
    {review?.asset?.officialId && <p className="muted">{tr("Stock Tokens are issued by Robinhood Assets (Jersey) Limited and are not offered to US persons or in restricted jurisdictions.")}</p>}
    {evidenceLevel && <p role="status">{tr("Evidence state: ")}{tr(evidenceLevel)}</p>}
    {view === 'simulate' ? <button type="button" disabled={run.busy || observing} onClick={() => void run.simulate()}>{tr("Simulate transfer")}</button> : <>
      {record && wallet.account && wallet.chainId !== profile.chainHex && !record.evidence && <div><p role="status">{tr("Switch your wallet to ")}{network}{tr(" to continue.")}</p>
        <button type="button" disabled={run.busy} onClick={() => void run.switchNetwork()}>{tr("Switch to ")}{network}</button></div>}
      {record && !record.authorization && !attempt && !run.retired && record.verdict === 'PENDING' && <button type="button" disabled={run.busy} onClick={() => void run.review()}>{tr("Accept transfer review")}</button>}
      {record?.authorization && !run.retired && !attempt && record.verdict === 'PENDING' && <button type="button" className="primary" disabled={run.busy} onClick={() => void run.execute()}>{tr("Execute")}</button>}
      {attempt && <p>{tr("Transfer: ")}{tr(attempt.reconciled ? 'Reconciled from public chain state' : record?.notSubmitted ? 'not submitted' : attempt.state.toLowerCase().replaceAll('_', ' '))}
        {attempt.transactionHash && <> <a href={`${profile.explorer}/tx/${attempt.transactionHash}`} target="_blank" rel="noreferrer">{tr("View transaction")}</a></>}</p>}
      {observing && <button type="button" disabled={run.busy} onClick={() => void run.observe()}>{tr("Observe existing transaction")}</button>}
      {record?.notSubmitted && record.verdict === 'PENDING' && !run.retired && <><p>{tr("The wallet request was not submitted. Prepare a fresh explicit owner Review.")}</p>
        <button type="button" disabled={run.busy} onClick={() => void run.recoverReview()}>{tr("Prepare fresh review")}</button></>}
      {attempt && !record?.evidence && <a download="flofi-rh-demo-001-execution-record.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(record, null, 2))}>{tr("Download execution record")}</a>}
      {record?.evidence && observation?.facts && <><p>{tr("Transfer reconciled. Exactly one owner-signed transaction, nonce ")}{tr(observation.facts.nonceBefore)} → {tr(observation.facts.nonceAfter)}{tr(", block ")}{tr(observation.facts.blockNumber)}{tr("; network cost ")}{tr(formatEth(observation.facts.fee))}{tr(" ETH; balance ")}{tr(formatEth(observation.facts.balanceBefore))} → {tr(formatEth(observation.facts.balanceAfter))}{tr(" ETH.")}</p>
        <a download="flofi-rh-demo-001-evidence.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(record.evidence, null, 2))}>{tr("Download Evidence Bundle")}</a></>}
    </>}
    {info && <p role="status">{tr(transferCopy(messages[info] ?? 'The transfer needs attention. Inspect technical details and observe any existing transaction.', network))}</p>}
    <details><summary>{tr("Show technical details")}</summary><pre>{JSON.stringify({ error: info, attempt, observations: record?.observations, walletDiagnostic: record?.walletDiagnostic,
      environment: record?.evidence?.bundle.environment, journal: record?.journal.entries.filter(e => e.level === 'attempt').map(e => e.toState) }, null, 2)}</pre></details>
  </section>;
}
