// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: the boarding card as an image, rendered on the server from the card's own record ("Gerar no servidor"):
 * - 1200 × 630, the approved "Cartão · imagem de link" board, for the link preview on X (og:image, twitter:image) and the emails;
 * - 1600 × 900, the same card with its steps (VIA), for "Download card" (`flofi-boarding-card-042.png`).
 * Real data only: the handle the person typed (or none), the route the server simulated, the seat issued, the departure day. Never a wallet,
 * an amount, a hash, an address or a count of people.
 */
import { ImageResponse } from 'next/og';
import { visibleSteps } from './campaign';
import { gotaCaptainSvg, outfit500Woff, outfit700Woff, plexMono500Woff } from './card-assets';
import type { PublicCard } from './store';

const C = { navy: '#041B3D', blue: '#2343D9', soft: '#C9D2F8', label: '#4B5B73', white: '#FFFFFF' } as const;
const font = (base64: string) => { const bytes = Buffer.from(base64, 'base64'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };
let fonts: { name: string; data: ArrayBuffer; weight: 500 | 700; style: 'normal' }[] | null = null;
const loadFonts = () => fonts ??= [
  { name: 'Outfit', data: font(outfit500Woff), weight: 500, style: 'normal' }, { name: 'Outfit', data: font(outfit700Woff), weight: 700, style: 'normal' },
  { name: 'Plex', data: font(plexMono500Woff), weight: 500, style: 'normal' }];

/** "12 NOV" (the board's departure day, Brasília calendar). */
export function cardDayShort(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short' }).formatToParts(new Date(iso));
  return `${parts.find(p => p.type === 'day')?.value ?? ''} ${(parts.find(p => p.type === 'month')?.value ?? '').toUpperCase()}`;
}
/** The card's meta line: "FOUNDING #042 · 2 STEPS · 2 NETWORKS · 12 NOV" or "SEAT 214E · …". */
export function cardMeta(card: Pick<PublicCard, 'founding' | 'seat' | 'route' | 'departedAt'>): string {
  const { stepCount: s, networkCount: n } = card.route;
  return `${card.founding ? `FOUNDING ${card.seat}` : `SEAT ${card.seat}`} · ${s} ${s === 1 ? 'STEP' : 'STEPS'} · ${n} ${n === 1 ? 'NETWORK' : 'NETWORKS'} · ${cardDayShort(card.departedAt)}`;
}
export type CardImageSize = 'link' | 'download';
export const CARD_IMAGE_SIZES = { link: { width: 1200, height: 630 }, download: { width: 1600, height: 900 } } as const;

export function cardImage(card: PublicCard, size: CardImageSize, headers: Record<string, string> = {}): ImageResponse {
  const { width, height } = CARD_IMAGE_SIZES[size], big = size === 'download', k = big ? 1.12 : 1;
  const steps = big ? visibleSteps(card.route) : null;
  const px = (value: number) => Math.round(value * k);
  const sparkle = (left: number, top: number, side: number) => <svg key={`${left}-${top}`} viewBox="0 0 40 40" width={px(side)} height={px(side)}
    style={{ position: 'absolute', left: px(left), top: px(top) }}><path fill={C.white} d="M20 0 C22 14 26 18 40 20 C26 22 22 26 20 40 C18 26 14 22 0 20 C14 18 18 14 20 0 Z"/></svg>;
  return new ImageResponse(
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', background: C.blue, fontFamily: 'Outfit', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: px(70), top: big ? 60 : px(100), width: px(780), display: 'flex', flexDirection: 'column', background: C.white,
        borderRadius: px(36), border: `${px(9)}px solid ${C.navy}`, color: C.navy, overflow: 'hidden' }}>
        <div style={{ height: px(78), background: C.navy, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `0 ${px(36)}px` }}>
          <span style={{ fontWeight: 700, fontSize: px(34), color: C.white }}>Flight FloFi</span>
          <span style={{ fontFamily: 'Plex', fontSize: px(20), letterSpacing: px(2.4), color: C.soft }}>BOARDING PASS</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: `${px(27)}px ${px(36)}px ${px(32)}px`, position: 'relative' }}>
          <span style={{ fontFamily: 'Plex', fontSize: px(18), letterSpacing: px(2.2), color: C.label }}>PASSENGER</span>
          <span style={{ fontWeight: 700, fontSize: px(41), marginTop: px(6) }}>{card.handle ? `@${card.handle}` : 'PASSENGER'}</span>
          <span style={{ fontFamily: 'Plex', fontSize: px(card.route.from.length + card.route.to.length > 8 ? 84 : 100), lineHeight: 1, color: C.blue, marginTop: px(10) }}>
            {`${card.route.from} → ${card.route.to}`}</span>
          {steps && <div style={{ display: 'flex', flexDirection: 'column', marginTop: px(18) }}>
            <span style={{ fontFamily: 'Plex', fontSize: px(16), letterSpacing: px(2), color: C.label }}>VIA</span>
            {steps.shown.map((step, index) => <div key={index} style={{ display: 'flex', alignItems: 'center', marginTop: px(6) }}>
              <span style={{ fontFamily: 'Plex', fontSize: px(18), color: C.white, background: C.navy, borderRadius: px(14), width: px(28), height: px(28), display: 'flex',
                alignItems: 'center', justifyContent: 'center', marginRight: px(12) }}>{String(index + 1)}</span>
              <span style={{ fontWeight: 700, fontSize: px(22), marginRight: px(12) }}>{step.action}</span>
              <span style={{ fontFamily: 'Plex', fontSize: px(18), color: C.label }}>{step.detail}</span>
            </div>)}
            {steps.more > 0 && <span style={{ fontFamily: 'Plex', fontSize: px(18), color: C.label, marginTop: px(6) }}>{`+${steps.more} steps`}</span>}
          </div>}
          <span style={{ fontFamily: 'Plex', fontSize: px(20), letterSpacing: px(1), color: C.label, marginTop: px(18) }}>{cardMeta(card)}</span>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: px(8) }}>
            <span style={{ fontWeight: 700, fontSize: px(27), color: C.blue }}>You approve</span>
            <span style={{ transform: 'rotate(-8deg)', border: `${px(5)}px solid ${C.blue}`, color: C.blue, borderRadius: px(16), padding: `${px(2)}px ${px(16)}px`,
              fontFamily: 'Plex', fontSize: px(24), letterSpacing: px(2.4) }}>CHECKED</span>
          </div>
        </div>
      </div>
      <img src={gotaCaptainSvg} width={px(330)} height={px(330)} alt="" style={{ position: 'absolute', left: big ? 1190 : px(870), top: big ? 470 : px(250) }}/>
      {sparkle(big ? 1150 : 900, 90, 40)}{sparkle(big ? 1300 : 1120, 190, 26)}
    </div>,
    { width, height, fonts: loadFonts(), headers: { 'cache-control': 'public, max-age=300, s-maxage=3600', 'x-content-type-options': 'nosniff', ...headers } },
  );
}
