// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from 'react';
import { useLocale } from '../i18n/locale';
import { assetIdentity, networkMark, type VisualMark } from '../domain/asset-identity';
/**
 * Local brand images keep their own fills, gradients and colors, independent of theme. BUILD-BASE-001: marks come from the generic
 * identity resolver (`domain/asset-identity.ts`): a local mark FloFi can vouch for, else a deterministic monogram generated locally.
 */
function BrandMark({ mark }: { mark: VisualMark }) {
  const { t: tr } = useLocale();
  return mark.kind === 'image' ? <img className="brand-icon" src={mark.src} alt={tr("")} aria-hidden="true" draggable={false}/>
    : <span className="brand-icon-fallback brand-mark-monogram" data-mark="monogram" style={{ '--mark-hue': String(mark.hue) } as CSSProperties} aria-hidden="true">{mark.text}</span>;
}
/** `network` (a CAIP-2 chain or display name) and `address` let the resolver bind the exact asset; without them only the symbol is known. */
export function TokenBrandIcon({ symbol, network, address }: { symbol: string; network?: string | undefined; address?: string | undefined }) {
  return <BrandMark mark={symbol === '—' ? { kind: 'monogram', text: '?', hue: 0 } : assetIdentity({ symbol, network, address }).mark}/>;
}
export function NetworkBrandIcon({ network }: { network: string }) {
  return <BrandMark mark={networkMark(network)}/>;
}
