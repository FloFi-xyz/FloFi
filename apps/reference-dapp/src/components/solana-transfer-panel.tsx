// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import { useWorkflow } from '../state/workflow-store';
import { useSolanaTransfer } from '../state/solana-transfer-store';
import { formatTokenAmount } from '../domain/jupiter-authoring';
import { shortSolanaAddress, solanaTransferDetails } from '../domain/solana-transfer-authoring';
import { PendingExecutionNote, SolanaWalletGuardNote } from './execution-concurrency-notes';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: the Solana transfer's own details (technical details on Execute, the engineering Simulate view). The shared
 * "Authorize in wallet" action owns Review acceptance and the wallet request; this panel only simulates (engineering), observes an existing
 * transaction and shows the receipt and Evidence Bundle.
 */
export function SolanaTransferPanel({ view }: { view: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const { state } = useWorkflow(), transfer = useSolanaTransfer();
  const node = state.workflow.nodes.find(n => solanaTransferDetails(n)), fields = node ? solanaTransferDetails(node) : null;
  const record = transfer.record, review = record?.review, attempt = record?.attempt, observation = record?.observations.at(-1);
  const devnet = transfer.network === 'Solana Devnet', sol = (lamports: string | null | undefined) => lamports ? `${formatTokenAmount(lamports, 9)} ${devnet ? 'Devnet SOL' : 'SOL'}` : '--';
  const amount = review ? `${formatTokenAmount(review.amount, review.asset.decimals)} ${review.asset.symbol}` : fields ? `${fields.amount} ${fields.symbol}` : '--';
  const pending = Boolean(attempt && record?.verdict === 'PENDING' && ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(attempt.state));
  return <section className="panel" aria-label={tr(devnet ? 'Solana Devnet transfer' : 'Solana transfer')}><h2>{tr(view === 'simulate' ? 'Simulate transfer' : 'Transfer')}</h2>
    {fields && <p>{tr('Send {0} to {1} on {2}.', `${fields.amount} ${fields.symbol}`, shortSolanaAddress(fields.recipient), tr(transfer.network))}</p>}
    {devnet && <p role="note">{tr("Solana Devnet test tokens only. They have no value, and no real funds are used.")}</p>}
    {!transfer.owner && <button type="button" disabled={transfer.busy} onClick={() => void transfer.connect()}>{tr("Connect Solana wallet")}</button>}
    {view === 'simulate' && <button type="button" disabled={transfer.busy || !transfer.owner} onClick={() => void transfer.simulate()}>{tr("Simulate transfer")}</button>}
    {review && !transfer.retired && <dl className="swap-summary" aria-label={tr("Transfer details")}>
      <dt>{tr("Send")}</dt><dd>{amount}</dd><dt>{tr("To")}</dt><dd><code>{review.recipient}</code></dd>
      <dt>{tr("From")}</dt><dd><code>{review.owner}</code></dd><dt>{tr("Network")}</dt><dd>{tr(review.network)}</dd>
      {review.asset.mint && <><dt>{tr("Token mint")}</dt><dd><code>{review.asset.mint}</code> · {tr(review.asset.program === 'token-2022' ? 'Token-2022' : 'SPL Token')}</dd></>}
      <dt>{tr("Estimated network fee")}</dt><dd>{sol(review.estimatedFeeLamports)}</dd>
      {review.accountCreationLamports !== '0' && <><dt>{tr("Recipient token account deposit")}</dt><dd>{sol(review.accountCreationLamports)}</dd></>}
      {review.token && review.accountCreationLamports === '0' && <><dt>{tr('Maximum token account deposit')}</dt><dd>{sol(review.maximumAccountCreationLamports)}<small>{tr('Only paid if the recipient token account must be recreated before this transfer lands.')}</small></dd></>}
    </dl>}
    {attempt && !record?.evidence && <p>{tr("Transfer: ")}{tr(record?.notSubmitted ? 'not submitted' : attempt.state.toLowerCase().replaceAll('_', ' '))} {observation?.explorer && <a href={observation.explorer} target="_blank" rel="noreferrer">{tr("View transaction")}</a>}</p>}
    {pending && <button type="button" disabled={transfer.busy} onClick={() => void transfer.observe()}>{tr("Observe existing transaction")}</button>}<PendingExecutionNote pending={pending}/><SolanaWalletGuardNote guard={attempt?.walletGuard}/>
    {record?.evidence && observation && <section aria-label={tr("Transfer result")} className="swap-result">
      <h3>{tr("Success")}</h3>
      <p>{tr("Transfer independently reconciled. Sent {0}; the recipient received {1}; fee {2}.", amount, review ? `${formatTokenAmount(observation.amountReceived ?? '0', review.asset.decimals)} ${review.asset.symbol}` : '--', sol(observation.feeLamports))}</p>
      <dl className="swap-summary"><dt>{tr("Transaction")}</dt><dd><code>{observation.signature}</code></dd>
        {observation.explorer && <><dt>{tr("Explorer")}</dt><dd><a href={observation.explorer} target="_blank" rel="noreferrer">{tr("View transaction")}</a></dd></>}
        <dt>{tr("Slot")}</dt><dd>{observation.slot ?? '--'}</dd></dl>
      <p>{tr("Evidence: ")}{record.evidenceClass}</p>
      <a download="flofi-solana-transfer-evidence.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(record.evidence, null, 2))}>{tr("Download Evidence Bundle")}</a></section>}
    <details><summary>{tr("Show technical details")}</summary><pre>{JSON.stringify({ error: transfer.error ?? record?.error, evidenceClass: record?.evidenceClass, submissionError: record?.submissionError,
      walletDiagnostic: record?.walletDiagnostic, cluster: review?.cluster, token: review?.token, messageHash: review?.messageHash, blockhash: review?.blockhash,
      lastValidBlockHeight: review?.lastValidBlockHeight, simulation: review?.simulationResult, attempt, observations: record?.observations, verdict: record?.verdict }, null, 2)}</pre></details>
  </section>;
}
