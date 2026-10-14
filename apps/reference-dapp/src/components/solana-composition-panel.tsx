// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
import { useJupiter } from '../state/jupiter-store';
import { useSolanaComposition } from '../state/solana-composition-store';
import { formatTokenAmount } from '../domain/jupiter-authoring';
import { solanaNotSubmittedReason } from '../domain/solana-refusal';

const sol = (raw: string | null | undefined) => raw == null ? '—' : `${formatTokenAmount(raw, 9)} SOL`;
const usdc = (raw: string | null | undefined) => raw == null ? '—' : `${formatTokenAmount(raw, 6)} devUSDC`;
const amountOf = (token: 0 | 1, raw: string | null | undefined) => token === 0 ? sol(raw) : usdc(raw);
const MESSAGES: Readonly<Record<string, string>> = {
  SOLANA_COMPOSITION_CONTINUE_EXISTING_RUN: 'An earlier composition swapped tokens and still owes its position. Continue it, or end it to keep the tokens, before starting another.',
  SOLANA_COMPOSITION_PREFLIGHT_POSITION_ALREADY_OPEN: 'You already have a Flofi position on this pool. Nothing was swapped; manage that position first.',
  SOLANA_COMPOSITION_PREFLIGHT_TICK_ARRAYS_INITIALIZED: 'This range needs tick arrays that are not initialized on the pool. Nothing was swapped; choose a range closer to the price.',
  SOLANA_COMPOSITION_PREFLIGHT_SOL_SUFFICIENT: 'After the swap there would not be enough SOL for the position and its refundable deposits. Nothing was swapped.',
  SOLANA_COMPOSITION_PREFLIGHT_DEVUSDC_SUFFICIENT: 'After the swap there would not be enough devUSDC for the position. Nothing was swapped.',
  SOLANA_COMPOSITION_PREFLIGHT_POSITION_NON_ZERO: 'This range and maxima would not open a position. Nothing was swapped.',
  SOLANA_COMPOSITION_SEMANTIC_REVISION_CHANGED: 'The workflow changed after authorization. The position uses exactly the authorized workflow: restore it, or end the run and keep the swapped tokens.',
  SOLANA_COMPOSITION_EXISTING_ATTEMPT_OBSERVE_ONLY: 'A transaction for this step already exists. Observe it; it is never sent again.',
  SOLANA_COMPOSITION_LIQUIDITY_ATTEMPTS_EXHAUSTED: 'The position was prepared the maximum number of times. End the run to keep the swapped tokens.',
  ORCA_LIQUIDITY_POSITION_KEY_UNAVAILABLE: 'This tab no longer holds the one-time position key (for example after a reload). Prepare the position again; nothing was sent.',
  SOLANA_COMPOSITION_EXECUTION_NOT_ENABLED: 'Execution is not enabled on this server. Simulation and Review remain available.',
};
const PREFLIGHT: Readonly<Record<string, string>> = { POOL_VERIFIED: 'Pool verified', TICK_ARRAYS_INITIALIZED: 'Tick arrays initialized', POSITION_NON_ZERO: 'Position would open',
  SWAP_OUTPUT_DEPOSITED: 'Swap output deposited', SOL_SUFFICIENT: 'Enough SOL after the swap', DEVUSDC_SUFFICIENT: 'Enough devUSDC after the swap' };
const stateText = (state: string, verdict?: string) => `${state.toLowerCase().replaceAll('_', ' ')}${verdict && verdict !== 'PENDING' ? ` · ${verdict.toLowerCase().replaceAll('_', ' ')}` : ''}`;
const phases: Readonly<Record<string, string>> = { SIMULATED: 'Simulated — accept the Review to authorize the plan', AUTHORIZED: 'Authorized — execute the swap',
  PRODUCING: 'Swap in progress', BOUND: 'Swap reconciled — prepare the position with the received amount', CONSUMING: 'Position step in progress',
  COMPLETED: 'Completed and reconciled', PARTIAL: 'Ended after the swap — the swapped tokens stayed in your wallet', NOT_EXECUTED: 'Not executed — nothing was swapped',
  FAILED: 'The swap did not execute — no position was attempted', ATTENTION: 'Needs attention — observing only; nothing is retried', EXPIRED: 'Review expired or replaced — simulate again' };

export function SolanaCompositionPanel({ view }: { view: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const jupiter = useJupiter(), c = useSolanaComposition();
  const v = c.record, q = v?.record.review, lp = q?.liquidity, binding = v?.record.binding, position = v?.liquidity;
  const info = c.error ?? v?.record.error ?? null;
  // A step refused before broadcast says why (for example, the wallet changed the reviewed transaction).
  const refused = [v?.swap, position].find(run => run?.notSubmitted && run.attempt && !run.attempt.signature && run.error === info);
  const refusal = info && !MESSAGES[info] && refused ? solanaNotSubmittedReason(info, refused.walletDiagnostic?.change) : null;
  const preparable = Boolean(v && !c.retired && (v.phase === 'BOUND' || v.phase === 'CONSUMING' && !position?.attempt));
  const reviewable = Boolean(v && !c.retired && !c.authorized && (v.phase === 'SIMULATED' || v.phase === 'CONSUMING' && position && !position.attempt));
  const executable = Boolean(v && !c.retired && c.authorized && c.executionEnabled);
  const pending = Boolean(v && ['PRODUCING', 'CONSUMING', 'ATTENTION'].includes(v.phase) && (v.swap.attempt?.signature || position?.attempt?.signature));
  return <section className="panel" aria-label={tr('Solana Devnet swap and liquidity')}>
    <h2>{tr(view === 'simulate' ? 'Simulate swap and liquidity' : 'Swap and liquidity')}</h2>
    <p role="note">{tr('Solana Devnet test tokens only. They have no value, and no real funds are used.')}</p>
    <p>{tr('Two separate transactions, each reviewed and signed in your wallet: the swap, then a position funded by the swap’s actual reconciled output. If the position is not opened, the swapped tokens stay in your wallet; the swap is never repeated.')}</p>
    {!c.owner && <button type="button" disabled={jupiter.busy} onClick={() => void jupiter.connect('solana:devnet')}>{tr('Connect Solana wallet')}</button>}
    {c.owner && <p>{tr('Wallet connected · Solana Devnet: ')}<span>{c.owner}</span></p>}
    {c.retired && v && <p role="alert">{tr(['SIMULATED', 'AUTHORIZED', 'EXPIRED'].includes(v.phase) ? 'The workflow changed. Simulate the current workflow again.'
      : 'The workflow changed after authorization. The position uses exactly the authorized workflow: restore it, or end the run and keep the swapped tokens.')}</p>}
    {v && q && lp && <dl className="swap-summary" aria-label={tr('Composition plan')}>
      <dt>{tr('Status')}</dt><dd data-composition-phase={v.phase}>{tr(phases[v.phase] ?? v.phase)}</dd>
      <dt>{tr('1. Swap')}</dt><dd>{tr('{0} → expected {1}, at least {2} ({3} bps)', amountOf(q.swap.input.symbol === 'SOL' ? 0 : 1, q.swap.amount), amountOf(lp.boundToken, q.swap.expectedOutput), amountOf(lp.boundToken, q.swap.minimumOutput), q.swap.slippageBps)}</dd>
      <dt>{tr('2. Position')}</dt><dd>{tr('{0} at most, plus {1} · range {2}–{3} devUSDC per SOL (ticks {4} to {5}) · {6} bps', lp.boundToken === 1 ? sol(lp.otherMaximum) : usdc(lp.otherMaximum),
        lp.capIsFullOutput ? tr('100% of the swap’s reconciled output') : tr('the swap’s reconciled output up to {0}', amountOf(lp.boundToken, lp.cap)), lp.lowerPrice, lp.upperPrice, lp.tickLower, lp.tickUpper, lp.slippageBps)}</dd>
      <dt>{tr('Projected position')}</dt><dd>{tr('{0} + {1} with the expected swap output; {2} + {3} with the minimum. Projection only: the position is simulated and reviewed again after the swap.',
        sol(lp.expected.amount0), usdc(lp.expected.amount1), sol(lp.adverse.amount0), usdc(lp.adverse.amount1))}</dd>
      <dt>{tr('Pool price')}</dt><dd>{tr('{0} devUSDC per SOL now; {1} after the simulated swap (slot {2})', lp.pool.price, lp.pool.postSwapPrice, lp.pool.slot)}</dd>
      <dt>{tr('Preflight')}</dt><dd><ul>{lp.preflight.map(check => <li key={check.code}>{check.ok ? '✓' : check.blocking ? '✗' : '⚠'} {tr(PREFLIGHT[check.code] ?? check.code)}</li>)}</ul>
        {tr('Risk reduction only: it does not guarantee that the position transaction succeeds.')}</dd>
      <dt>{tr('Swap transaction')}</dt><dd>{v.swap.attempt ? tr(stateText(v.swap.attempt.state, v.swap.verdict)) : tr('not started')}</dd>
      {binding && <><dt>{tr('Received and bound')}</dt><dd data-composition-binding={binding.bound}>{tr('{0} received (reconciled); the position may use {1}', amountOf(binding.token, binding.received), amountOf(binding.token, binding.bound))}</dd></>}
      {position && <><dt>{tr('Position transaction')}</dt><dd>{position.attempt ? tr(stateText(position.attempt.state, position.verdict)) : tr(position.authorization ? 'review accepted' : 'review prepared')} · {tr('preparation {0}', v.record.consumerRunIds.length)}</dd></>}
    </dl>}
    {position && v?.phase === 'CONSUMING' && !position.attempt && <dl className="swap-summary" aria-label={tr('Position review')}>
      <dt>{tr('Deposit at most')}</dt><dd>{sol(position.review.operationPlan.tokenA)} + {usdc(position.review.operationPlan.tokenB)}</dd>
      <dt>{tr('Expected deposit')}</dt><dd>{sol(position.review.expected.amountA)} + {usdc(position.review.expected.amountB)} {tr('(fresh simulation)')}</dd>
      <dt>{tr('Range state')}</dt><dd>{tr(stateText(position.review.range.state))}</dd>
      <dt>{tr('Signers')}</dt><dd>{tr('your wallet, then a one-time position-mint key created in this browser')}</dd>
    </dl>}
    <div className="panel-actions">
      {(!v || ['NOT_EXECUTED', 'FAILED', 'EXPIRED', 'COMPLETED', 'PARTIAL'].includes(v.phase) || c.retired && ['SIMULATED', 'AUTHORIZED'].includes(v.phase) || preparable) &&
        <button type="button" disabled={c.busy || !c.owner} onClick={() => void c.simulate()}>{tr(preparable ? 'Prepare position with the received amount' : 'Simulate swap and liquidity')}</button>}
      {reviewable && <button type="button" disabled={c.busy} onClick={() => void c.review()}>{tr(v?.phase === 'CONSUMING' ? 'Accept position review' : 'Accept composed review')}</button>}
      {executable && <button type="button" className="primary" disabled={c.busy} onClick={() => void c.execute()}>{tr(v?.phase === 'AUTHORIZED' ? 'Execute swap' : 'Execute position')}</button>}
      {pending && <button type="button" disabled={c.busy} onClick={() => void c.observe()}>{tr('Observe existing transaction')}</button>}
      {v && !c.busy && (v.phase === 'BOUND' || v.phase === 'CONSUMING' && !position?.attempt) &&
        <button type="button" className="quiet" onClick={() => void c.end()}>{tr('End and keep the swapped tokens')}</button>}
    </div>
    {v?.record.evidence && <p>{tr('Evidence: ')}{tr(v.record.evidence.evidenceClass)} · <a download="flofi-solana-devnet-composition-evidence.json"
      href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(v.record.evidence, null, 2))}>{tr('Download Evidence Bundle')}</a></p>}
    {info && <p role="status">{refusal ? tr(refusal.text, ...refusal.args) : tr(MESSAGES[info] ?? info)}</p>}
    <details><summary>{tr('Show technical details')}</summary><pre>{JSON.stringify({ phase: v?.phase, error: info, record: v?.record.id, swapRun: v?.swap.id,
      liquidityRuns: v?.record.consumerRunIds, binding, manifest: q?.manifest, plan: q?.plan, journal: v?.record.journal.entries.length }, null, 2)}</pre></details>
  </section>;
}
