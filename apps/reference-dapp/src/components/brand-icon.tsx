// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type CSSProperties } from 'react';
import { useLocale } from '../i18n/locale';
import { assetIdentity, networkMark, type MonogramMark, type VisualMark } from '../domain/asset-identity';
/**
 * Local brand images keep their own fills, gradients and colors, independent of theme. BUILD-BASE-001: marks come from the generic
 * identity resolver (`domain/asset-identity.ts`): a reviewed local mark, a provider logo its rule accepted for the exact asset, else a
 * deterministic monogram generated locally.
 */
function Monogram({ mark }: { mark: MonogramMark }) {
  return <span className="brand-icon-fallback brand-mark-monogram" data-mark="monogram" style={{ '--mark-hue': String(mark.hue) } as CSSProperties} aria-hidden="true">{mark.text}</span>;
}
/**
 * A provider logo: always an `<img>` (an SVG is never inlined, so no third-party markup or script reaches the page), sent without a
 * referrer, and replaced by its deterministic monogram if it cannot be loaded (missing, broken or blocked).
 */
export function ProviderLogo({ mark }: { mark: Extract<VisualMark, { kind: 'logo' }> }) {
  const [failed, setFailed] = useState(false);
  return failed ? <Monogram mark={mark.fallback}/> : <img className="brand-icon" data-mark="logo" src={mark.src} alt="" aria-hidden="true" draggable={false}
    referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)}/>;
}
function BrandMark({ mark }: { mark: VisualMark }) {
  const { t: tr } = useLocale();
  return mark.kind === 'image' ? <img className="brand-icon" src={mark.src} alt={tr("")} aria-hidden="true" draggable={false}/>
    : mark.kind === 'logo' ? <ProviderLogo key={mark.src} mark={mark}/> : <Monogram mark={mark}/>;
}
/** `network` (a CAIP-2 chain or display name) and `address` let the resolver bind the exact asset; without them only the symbol is known. */
export function TokenBrandIcon({ symbol, network, address }: { symbol: string; network?: string | undefined; address?: string | undefined }) {
  return <BrandMark mark={symbol === '—' ? { kind: 'monogram', text: '?', hue: 0 } : assetIdentity({ symbol, network, address }).mark}/>;
}
export function NetworkBrandIcon({ network }: { network: string }) {
  return <BrandMark mark={networkMark(network)}/>;
}
