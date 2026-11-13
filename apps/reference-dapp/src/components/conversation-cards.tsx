// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useId } from 'react';
import { translate, useLocale } from '../i18n/locale';
import { sumByAsset, type ConversationLanguage, type ConversationReview } from '../domain/conversation-lifecycle';
import { shortDecimal } from '../domain/review-block';
import { isIncludedNetworkFee } from '../domain/gas-payment';
import { networkChoiceOptions, networkOfOption } from '../domain/approved-ux';
import { useOptionalBuild009Wallet } from '../state/build009-wallet-store';
import { walletChainRef } from '../wallet/evm-networks';
import { NetworkBrandIcon } from './brand-icon';

export { networkChoiceOptions };
/**
 * The connected wallet's network, when it is one of the answers, is listed first and marked; every other answer keeps FloFi's order. Nothing is
 * chosen here: the person still picks one.
 */
export function orderNetworkChoices(options: readonly string[], walletChain: string | null | undefined): { readonly options: readonly string[]; readonly wallet: string | null } {
  const wallet = walletChain ? options.find(option => networkOfOption(option)?.chain === walletChain) ?? null : null;
  return { options: wallet ? [wallet, ...options.filter(option => option !== wallet)] : options, wallet };
}
/**
 * P0 approved UX (board 05): the answers to "Which network…?" as a vertical list of network buttons (icon and name). Each button sends exactly
 * the answer text FloFi offered, as a chip did before; the wallet's network is tagged "Your wallet" but never selected for the person. The
 * wallet's network is read (read-only) from the shell's EVM wallet where one is provided; `walletChain` (a CAIP-2 chain) overrides it.
 */
export function NetworkChoices({ options, walletChain, disabled, onPick }: { options: readonly string[]; walletChain?: string | null | undefined; disabled?: boolean | undefined;
  onPick(option: string): void }) {
  const { t: tr } = useLocale();
  const tag = useId();
  const wallet = useOptionalBuild009Wallet();
  const ordered = orderNetworkChoices(options, walletChain === undefined ? walletChainRef(wallet?.chainId) : walletChain);
  return <div className="conversation-network-choices" role="group" aria-label={tr('Choose a network')}>
    {ordered.options.map(option => {
      const walletNetwork = option === ordered.wallet;
      return <button key={option} type="button" className="conversation-network-choice" data-wallet={walletNetwork || undefined} disabled={disabled}
        aria-label={option} aria-describedby={walletNetwork ? tag : undefined} onClick={() => onPick(option)}>
        <span className="conversation-network-icon" aria-hidden="true"><NetworkBrandIcon network={networkOfOption(option)?.name ?? option}/></span>
        <span className="conversation-network-name">{option}</span>
        {walletNetwork && <span id={tag} className="conversation-network-wallet">{tr('Your wallet')}</span>}
      </button>;
    })}
  </div>;
}

const short = (value: string) => value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: a decimal amount written "<number> <symbol>", shortened to six significant digits (`shortDecimal`): `down` for what
 * is received or guaranteed (never overstated), `up` for what is sent or paid at most (never understated). Anything else is returned unchanged.
 */
export function shortAmount(value: string, mode: 'down' | 'up'): string {
  const match = /^(\d+)(?:\.(\d+))? (\S.*)$/.exec(value.trim());
  if (!match) return value;
  const fraction = match[2] ?? '';
  return `${shortDecimal(BigInt(match[1]! + fraction).toString(), fraction.length, mode)} ${match[3]}`;
}
const NETWORK_FEE = /network|gas|execution fee/i;
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the compact network fee — the estimate and the maximum, each summed per asset and shortened up. Review round 2:
 * `unreadable` says a network-fee amount could not be read (`sumByAsset`); the row then points to Technical details instead of showing a sum
 * that silently leaves that amount out (which would understate what is paid).
 */
export function compactNetworkFee(fees: readonly ConversationReview['fees'][number][]): { readonly estimate: string | null; readonly maximum: string | null; readonly unreadable: boolean;
  /** BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: a network fee taken out of the swap itself (0x Gasless), shown visibly instead of dropped. */
  readonly included?: string } {
  const network = fees.filter(line => NETWORK_FEE.test(line.label));
  let unreadable = false;
  const sum = (treatment: string, lines = network) => { const values = lines.filter(line => line.treatment === treatment).map(line => line.value);
    const summed = sumByAsset(values); if (summed.unreadable) unreadable = true;
    return summed.sums.length ? summed.sums.map(value => shortAmount(value, 'up')).join(' + ') : null; };
  const estimate = sum('ADDITIONAL'), maximum = sum('CEILING'), included = sum('INCLUDED', network.filter(isIncludedNetworkFee));
  return { estimate, maximum, unreadable, ...included ? { included } : {} };
}
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2: the step details that stay visible in the compact block (they change what the owner authorizes:
 * the Aave health factor after the step, a step already completed, how a step is funded and its bound amount, a Solana token's mint). Every
 * other detail line stays under Technical details. The labels are the simulation projection's own (`simulation-presentation.ts`).
 */
export const MATERIAL_STEP_DETAILS: readonly string[] = ['Health factor after', 'Step status', 'Funded by', 'Bound amount', 'Token mint',
  // BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: how many wallet prompts a 0x Gasless swap needs, when more than one.
  'Signatures'];
const materialDetail = (line: { readonly label: string }) => MATERIAL_STEP_DETAILS.includes(line.label);
/**
 * A step of the compact Review. `destinationOwned` (optional, review round 2): the step's producer says whether the destination is one of the
 * owner's own wallets; absent, the card compares it with the wallet it knows (`review.account`), and otherwise shows the address alone.
 */
export type CompactReviewStep = ConversationReview['steps'][number] & { readonly destinationOwned?: boolean };
const sameWallet = (a: string, b: string) => /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Whether a token permission's value already names its token ("Exactly 2 USDC"), so the symbol is not written twice. */
const namesSymbol = (value: string, symbol: string) => ` ${value.replace(/\s+/g, ' ')} `.includes(` ${symbol} `);
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the Review the chat presents, in the language FloFi answered in. Every value is the existing simulation and Review
 * projection's own (no quote, price, fee or result is computed here); a value the simulation does not provide is labelled as not provided.
 * BUILD-FLOFI-MAINNET-EXEC-002 (owner request: "the Review in the chat is too long"): the visible part is one short block per step — network and
 * provider, Sends, Receives ≈, Minimum, Network fee, Destination (in full), material step details — plus the costs paid on top, FloFi's recorded
 * fee, token permissions and every warning that is not an evidence caveat. Exact values, every fee line and its treatment, the quote expiry,
 * limits, approvals and evidence caveats are under Technical details, closed by default. Nothing material is dropped: amounts are shortened in
 * the safe direction and their full values stay one click away.
 */
export function ConversationReviewCard({ review, language }: { review: ConversationReview; language: ConversationLanguage }) {
  const t = (value: string, ...parameters: (string | number)[]) => translate(language, value, ...parameters);
  const sequence = review.sequence, simulated = review.steps[0];
  const fee = compactNetworkFee(review.fees), unknownNetwork = review.unknown.some(name => NETWORK_FEE.test(name));
  // Review round 2: an unreadable network-fee amount is never dropped from a sum: the row points to the exact lines under Technical details.
  const paidOnTop = fee.unreadable ? t('See Technical details') : fee.estimate && fee.maximum ? t('≈ {0} · at most {1}', fee.estimate, fee.maximum) : fee.estimate ? t('≈ {0}', fee.estimate)
    : fee.maximum ? t('at most {0}', fee.maximum) : unknownNetwork && !fee.included ? t('Not provided by this simulation') : null;
  // ADR-0010: a fee 0x takes out of the swap is shown as such (included, in the swap's token), never hidden and never added on top.
  const networkFee = [paidOnTop, fee.included ? t('{0}, included in the swap', fee.included) : null].filter(Boolean).join(' · ') || null;
  // Review round 2: the fee lines are the whole Review's, so a multi-step Review (not a step-by-step sequence) says its network fee once, after
  // the steps, instead of repeating the same total under every step. A single step (or a sequence's current step) keeps it in its block.
  const sharedFee = !sequence && review.steps.length > 1 ? networkFee : null, stepFee = sharedFee ? null : networkFee;
  // Costs paid on top of the amount sent that are not the network fee (an account deposit, a provider charge billed separately).
  const onTop = review.fees.filter(line => (line.treatment === 'ADDITIONAL' || line.treatment === 'CEILING') && !NETWORK_FEE.test(line.label));
  // Review round 2: the full destination (a shortened address invites look-alike mistakes), tagged when it is one of the owner's own wallets.
  const owned = (step: CompactReviewStep) => step.destinationOwned ?? Boolean(step.destination && review.account && sameWallet(step.destination, review.account));
  const compact = (step: CompactReviewStep) => <dl className="conversation-review-compact">
    {step.input !== '—' && <div><dt>{t('Sends')}</dt><dd title={step.input}>{shortAmount(t(step.input), 'up')}</dd></div>}
    {step.result && <div><dt>{t('Receives')}</dt><dd title={step.result}>{/^\d/.test(step.result) ? t('≈ {0}', shortAmount(step.result, 'down')) : t(step.result)}</dd></div>}
    {step.minimum && <div><dt>{t('Minimum')}</dt><dd title={step.minimum}>{shortAmount(step.minimum, 'down')}</dd></div>}
    {stepFee && <div><dt>{t('Network fee')}</dt><dd>{stepFee}</dd></div>}
    {step.destination && <div data-wrap="true" data-destination-owned={owned(step) || undefined}><dt>{t('Destination')}</dt>
      <dd><code>{step.destination}</code>{owned(step) ? <span className="conversation-review-owned"> · {t('Your wallet')}</span> : null}</dd></div>}
    {step.details.filter(materialDetail).map(line => <div key={`${line.label}:${line.value}`} data-wrap="true" data-detail={line.label}><dt>{t(line.label)}</dt>
      <dd>{line.label === 'Token mint' ? <code>{line.value}</code> : t(line.value)}</dd></div>)}
  </dl>;
  // The full figures, as before, for Technical details.
  const details = (step: ConversationReview['steps'][number]) => <dl className="conversation-review-figures">
    {step.input !== '—' && <div><dt>{t('Sending')}</dt><dd>{t(step.input)}</dd></div>}
    <div><dt>{t('Expected receipt')}</dt><dd>{step.result ?? t('Not provided by this simulation')}{step.result ? <small>{t(step.resultLabel)}</small> : null}</dd></div>
    {step.minimum && <div><dt>{t('Minimum receipt')}</dt><dd>{step.minimum}</dd></div>}
    {step.provider && <div><dt>{t('Provider')}</dt><dd>{t(step.provider)}</dd></div>}
    {step.slippage && <div><dt>{t('Max slippage')}</dt><dd>{step.slippage}</dd></div>}
    {step.priceImpact && <div><dt>{t('Price impact')}</dt><dd>{step.priceImpact}</dd></div>}
    {step.destination && <div><dt>{t('Destination')}</dt><dd><code>{step.destination}</code></dd></div>}
    {step.details.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}</dd></div>)}
  </dl>;
  const heading = (step: { readonly number: number; readonly action: string }, networks: string | null | undefined, provider: string | null | undefined) =>
    <strong>{step.number}. {[t(step.action), networks, provider && provider !== '—' ? t(provider) : null].filter(Boolean).join(' · ')}</strong>;
  const treatment = { INCLUDED: 'Already included in the quoted output', CEILING: 'Maximum, separate from the output', ADDITIONAL: 'Estimated, paid on top' } as const;
  const costs = review.fees.filter(line => line.treatment !== 'COMPONENT' && line.treatment !== 'OBLIGATION'), parts = review.fees.filter(line => line.treatment === 'COMPONENT');
  const total = review.totals.additional.length ? review.totals.additional.join(' + ') + (review.totals.ceilings.length ? ` · ${t('network fee up to {0}', review.totals.ceilings.join(' + '))}` : '')
    : review.totals.ceilings.length ? t('Up to {0}', review.totals.ceilings.join(' + ')) : review.unknown.length ? t('Not available from this simulation') : t('None beyond the amount sent');
  // Review round 2: only an evidence-limit caveat (`technical`) moves under Technical details; every other warning, of any severity, stays visible.
  const visibleWarnings = review.warnings.filter(warning => warning.technical !== true);
  const technicalWarnings = review.warnings.filter(warning => warning.technical === true);
  return <section className="conversation-review" aria-label={t('Workflow review')}>
    {/* BUILD-FLOFI-CHAT-E2E-FIX-002: a sequence lists every canonical action in order; only the current step is simulated now. */}
    {sequence ? <ol className="conversation-review-steps" aria-label={t('Workflow actions')}>{sequence.steps.map(step => <li key={step.number} data-sequence-state={step.state}>
      {heading(step, step.network, step.state === 'CURRENT' ? simulated?.provider : null)}
      {step.state === 'COMPLETED' ? <span className="conversation-review-state">{step.delivered ? t('Completed and reconciled · delivered {0}', step.delivered) : t('Completed and reconciled')}</span>
        : step.state === 'NEXT' ? <span className="conversation-review-state">{step.amount ? `${t(step.amount)} · ` : ''}{t('Reviewed after step {0}', step.number - 1)}</span> : null}
      {step.funding && <span className="conversation-review-funding">{step.funding.bound ? t('Funded by step {0}: spends {1} (what step {0} delivered, at most {2})', step.funding.from, step.funding.bound, step.funding.cap)
        : t('Funded by step {0}: spends the smaller of {1} and what step {0} actually delivers', step.funding.from, step.funding.cap)}</span>}
      {step.state === 'CURRENT' && simulated && compact(simulated)}
    </li>)}</ol>
    : <ol className="conversation-review-steps">{review.steps.map(step => <li key={step.number}>
      {heading(step, step.networks, step.provider)}
      {compact(step)}
    </li>)}</ol>}
    {(sharedFee || review.flofiFee.recorded || onTop.length > 0 || review.approvals.length > 0) && <dl className="conversation-review-compact conversation-review-extra">
      {sharedFee && <div data-shared-fee="true"><dt>{t('Network fee')}</dt><dd>{sharedFee}</dd></div>}
      {onTop.map(line => <div key={`${line.label}:${line.value}`}><dt>{t(line.label)}</dt><dd title={line.value}>{line.treatment === 'CEILING' ? t('at most {0}', shortAmount(line.value, 'up')) : t('≈ {0}', shortAmount(line.value, 'up'))}</dd></div>)}
      {/* Review round 2: FloFi's own fee, when this route records it, is a visible line; its note and the whole breakdown stay under Technical details. */}
      {review.flofiFee.recorded && <div data-flofi-fee="obligation"><dt>{t('FloFi fee')}</dt><dd title={review.flofiFee.value}>{t(shortAmount(review.flofiFee.value, 'up'))}</dd></div>}
      {/* A token permission is material: always visible, exact amount and spender. Its value already names the token ("Exactly 2 USDC"); the symbol
          is added only to a value that does not ("Unlimited approval"). */}
      {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.spender}`} data-permission="true"><dt>{t('Permission')}</dt>
        <dd>{t(approval.value)}{namesSymbol(approval.value, approval.symbol) ? '' : ` ${approval.symbol}`} → {t(approval.spender)}</dd></div>)}
    </dl>}
    {(visibleWarnings.length > 0 || sequence) && <ul className="conversation-review-warnings" aria-label={t('Risks and warnings')}>
      {sequence && <li data-severity="attention">{t('This workflow runs as {0} separate wallet transactions, one step at a time. If a later step fails or you stop, the earlier steps stay executed and their assets stay in your wallet.', sequence.total)}</li>}
      {visibleWarnings.map((warning, index) => <li key={index} data-severity={warning.severity}>{t(warning.message)}</li>)}</ul>}
    <details className="conversation-review-technical review-block-technical"><summary>{t('Technical details')}</summary>
      {review.steps.map(step => <div key={step.number} className="conversation-review-technical-step">{sequence ? null : <span className="conversation-review-route">{step.pair ? t(step.pair) : null}</span>}{details(step)}</div>)}
      <dl className="conversation-review-lines" aria-label={t('Costs')}>
        {costs.map(line => <div key={`${line.label}:${line.value}`} data-treatment={line.treatment ?? 'UNCLASSIFIED'}><dt>{t(line.label)}</dt>
          <dd>{line.value}<small>{line.treatment && line.treatment in treatment ? t(treatment[line.treatment as keyof typeof treatment]) : null}{line.note ? `${line.treatment && line.treatment in treatment ? ' · ' : ''}${t(line.note)}` : ''}</small></dd></div>)}
        {review.unknown.map(name => <div key={name} data-unknown="true"><dt>{t(name)}</dt><dd>{t('Not provided by this simulation')}</dd></div>)}
        <div data-treatment="OBLIGATION" data-flofi-fee={review.flofiFee.recorded ? 'obligation' : 'not-charged'}><dt>{t('FloFi fee')}</dt><dd>{t(review.flofiFee.value)}<small>{t(review.flofiFee.note)}</small></dd></div>
        {review.expiresAt !== null && <div><dt>{t('Quote expiry')}</dt><dd><time dateTime={new Date(review.expiresAt).toISOString()}>{new Date(review.expiresAt).toLocaleTimeString(language === 'PT' ? 'pt-BR' : 'en-US')}</time></dd></div>}
        <div className="conversation-review-total"><dt>{t('Total additional payable costs')}</dt><dd>{total}</dd></div>
      </dl>
      {review.totals.excludes.length > 0 && <p className="conversation-review-excludes">{t('Excludes: {0}', review.totals.excludes.map(item => t(item.text, ...item.parameters)).join('; '))}</p>}
      {parts.length > 0 && <dl className="conversation-review-lines" aria-label={t('Fee breakdown')}>
        {parts.map(line => <div key={`${line.label}:${line.value}`} data-treatment="COMPONENT"><dt>{t(line.label)}</dt><dd>{line.value}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
      </dl>}
      <dl className="conversation-review-lines conversation-review-context" aria-label={t('Wallet and quote')}>
        {review.account && <div><dt>{t('Wallet')}</dt><dd title={review.account}>{short(review.account)}</dd></div>}
        {review.network && <div><dt>{t('Network')}</dt><dd>{review.network}</dd></div>}
      </dl>
      {technicalWarnings.length > 0 && <ul className="conversation-review-warnings">{technicalWarnings.map((warning, index) => <li key={index} data-severity={warning.severity}>{t(warning.message)}</li>)}</ul>}
      {(review.limits.length > 0 || review.approvals.length > 0) && <dl className="conversation-review-lines" aria-label={t('Approvals and limits')}>
        {review.limits.map(line => <div key={`${line.label}:${line.value}:${line.note ?? ''}`}><dt>{t(line.label)}</dt><dd>{t(line.value)}{line.note ? <small>{t(line.note)}</small> : null}</dd></div>)}
        {review.approvals.map(approval => <div key={`${approval.symbol}:${approval.spender}`}><dt>{t('Token approval')}</dt><dd>{t(approval.value)} · {approval.symbol} · {t(approval.spender)} · {approval.network}</dd></div>)}
      </dl>}
      <p className="conversation-review-note">{t('Estimates from this simulation, not executed results. Your wallet shows every request before you sign it.')}</p>
    </details>
  </section>;
}
