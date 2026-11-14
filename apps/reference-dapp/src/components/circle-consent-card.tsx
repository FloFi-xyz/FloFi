// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): FloFi's own consent card on `/approve`, shown before FloFi
 * Wallet is asked anything for a group whose network fee would be paid in USDC through Circle. On the address's first use it is the owner's
 * explicit confirmation of the EIP-7702 upgrade (Privy shows no confirmation screen for an EIP-7702 authorization, and FloFi Wallet's signing gate
 * refuses it until this consent was recorded); once the address is upgraded it asks about the USDC fee alone.
 *
 * It sits inside the approval notice in the workflow panel's own visual language (`workflow-run-choice`, `approval-actions`), never a banner. A
 * labelled, described dialog (non-modal: the page stays readable) that takes focus when it opens and gives it back when it closes. It records,
 * signs and sends nothing itself: `onAnswer` does, after the owner's click.
 */
import { useEffect, useId, useRef } from 'react';
import { CIRCLE_CONSENT_DECLINE, CIRCLE_FEE_CONSENT, CIRCLE_UPGRADE_CONSENT, feeAmountText } from '../domain/token-fee';
import { useLocale } from '../i18n/locale';
import type { CircleConsentOffer } from './flofi-wallet-circle-flow';

export function CircleConsentCard({ offer, network, onAnswer }: { offer: CircleConsentOffer; network: string; onAnswer: (agreed: boolean) => void }) {
  const { t: tr } = useLocale();
  const id = useId(), card = useRef<HTMLDivElement>(null);
  // Focus moves into the card as it opens (its title and description are read first), and back to where it was once the owner answered.
  useEffect(() => {
    const previous = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const fee = feeAmountText(offer.maxFee, 'token', { symbol: 'USDC', decimals: 6 }, 'up');
  const words = offer.upgrade ? CIRCLE_UPGRADE_CONSENT : CIRCLE_FEE_CONSENT;
  const described = offer.upgrade ? `${id}-what ${id}-unchanged ${id}-stays ${id}-signatures` : `${id}-what ${id}-signatures`;
  return <div ref={card} className="workflow-run-choice circle-consent" role="dialog" aria-labelledby={`${id}-title`} aria-describedby={described} tabIndex={-1}
    data-circle-consent={offer.upgrade ? 'upgrade' : 'fee'}>
    <p id={`${id}-title`}><strong>{tr(words.TITLE)}</strong></p>
    <p id={`${id}-what`}>{tr(words.WHAT, tr(network))}</p>
    {offer.upgrade && <p id={`${id}-unchanged`}>{tr(CIRCLE_UPGRADE_CONSENT.UNCHANGED)}</p>}
    {offer.upgrade && <p id={`${id}-stays`}>{tr(CIRCLE_UPGRADE_CONSENT.STAYS)}</p>}
    <p id={`${id}-signatures`}>{tr(words.SIGNATURES)}</p>
    <p className="muted">{tr('Network fee, at most {0} — paid from your USDC through Circle', fee)}</p>
    <div className="approval-actions">
      <button type="button" onClick={() => onAnswer(true)}>{tr(words.AGREE)}</button>
      <button type="button" className="secondary" aria-describedby={`${id}-not-now`} onClick={() => onAnswer(false)}>{tr(CIRCLE_CONSENT_DECLINE.ACTION)}</button>
    </div>
    <p className="muted" id={`${id}-not-now`}>{tr(CIRCLE_CONSENT_DECLINE.NOTE)}</p>
  </div>;
}
