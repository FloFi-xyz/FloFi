// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type CSSProperties } from 'react';
import { GLYPH_MARKS, assetIdentity, networkFallback, networkMark, type MonogramMark, type VisualMark } from '../domain/asset-identity';
/**
 * Local brand images keep their own fills, gradients and colors, independent of theme. BUILD-BASE-001: marks come from the generic
 * identity resolver (`domain/asset-identity.ts`): a reviewed local mark, a provider logo its rule accepted for the exact asset, else a
 * deterministic monogram generated locally. Every image, local or remote, is replaced by that same monogram if it cannot be loaded; both
 * fill the same box, so nothing moves.
 */
function Monogram({ mark }: { mark: MonogramMark }) {
  return <span className="brand-icon-fallback brand-mark-monogram" data-mark="monogram" style={{ '--mark-hue': String(mark.hue) } as CSSProperties} aria-hidden="true">{mark.text}</span>;
}
const UNKNOWN: MonogramMark = Object.freeze({ kind: 'monogram', text: '?', hue: 0 });
/**
 * A provider logo: always an `<img>` (an SVG is never inlined, so no third-party markup or script reaches the page), sent without a
 * referrer, and replaced by its deterministic monogram if it cannot be loaded (missing, broken or blocked).
 */
export function ProviderLogo({ mark }: { mark: Extract<VisualMark, { kind: 'logo' }> }) {
  const [failed, setFailed] = useState(false);
  return failed ? <Monogram mark={mark.fallback}/> : <img className="brand-icon" data-mark="logo" src={mark.src} alt="" aria-hidden="true" draggable={false}
    referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)}/>;
}
/** A reviewed local mark (never inlined), replaced by the identity's deterministic monogram if the file is missing or cannot be decoded. */
export function LocalMark({ src, fallback }: { src: string; fallback: MonogramMark }) {
  const [failed, setFailed] = useState(false);
  return failed ? <Monogram mark={fallback}/> : <img className="brand-icon" data-mark="image" data-shape={GLYPH_MARKS.has(src) ? 'glyph' : undefined} src={src} alt=""
    aria-hidden="true" draggable={false} decoding="async" onError={() => setFailed(true)}/>;
}
function BrandMark({ mark, fallback }: { mark: VisualMark; fallback: MonogramMark }) {
  return mark.kind === 'image' ? <LocalMark key={mark.src} src={mark.src} fallback={fallback}/>
    : mark.kind === 'logo' ? <ProviderLogo key={mark.src} mark={mark}/> : <Monogram mark={mark}/>;
}
/**
 * `network` (a CAIP-2 chain or display name) and `address` (the exact token address on that network, e.g. an Aave reserve's underlying)
 * let the resolver bind the exact asset; without them only the symbol is known. Both are optional.
 */
export function TokenBrandIcon({ symbol, network, address }: { symbol: string; network?: string | null | undefined; address?: string | null | undefined }) {
  if (symbol === '—') return <Monogram mark={UNKNOWN}/>;
  const identity = assetIdentity({ symbol, network, address });
  return <BrandMark mark={identity.mark} fallback={identity.fallback}/>;
}
export function NetworkBrandIcon({ network }: { network: string }) {
  return <BrandMark mark={networkMark(network)} fallback={networkFallback(network)}/>;
}
