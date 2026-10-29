// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';

/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the FloFi Assistant's avatar — the owner-approved FloFi symbol (`public/brand`, see
 * flofi-identity.source.md), its light or dark artwork chosen by the shell theme exactly as `FloFiLogo` does; never a redrawn mark.
 * Decorative: the message or heading beside it carries the name.
 */
export function FloFiAvatar({ size = 'message' }: { size?: 'message' | 'title' }) {
  return <span className={`flofi-avatar flofi-avatar-${size}`} aria-hidden="true">
    {(['light', 'dark'] as const).map(theme => <Image key={theme} className={`flofi-avatar-symbol flofi-logo-${theme}`} src={`/brand/flofi-symbol-${theme}.svg`} alt=""
      width={370} height={345} unoptimized/>)}
  </span>;
}
/** The person beside the owner's own messages: the product's stroke-icon style (24 px grid, currentColor), never an account photo or identity. */
export function UserAvatar() {
  return <span className="user-avatar" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>
    </svg>
  </span>;
}
