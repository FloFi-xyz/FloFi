// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import { useId } from 'react';
import type { LandingCopy } from './landing-copy';
import styles from './landing.module.css';

/** FloFi's own community accounts (owner-supplied). Marks are the owners' unmodified official artwork: `public/brand/social/sources.md`. */
export const SOCIAL_LINKS = [
  { id: 'x', href: 'https://x.com/FloFi_xyz', mark: '/brand/social/x.svg', width: 1200, height: 1227, name: 'X', label: 'socialX' },
  { id: 'discord', href: 'https://discord.gg/36rEhdUa', mark: '/brand/social/discord.svg', width: 127, height: 96, name: 'Discord', label: 'socialDiscord' },
  { id: 'linkedin', href: 'https://www.linkedin.com/company/flofixyz/home/', mark: '/brand/social/linkedin.png', width: 635, height: 540, name: 'LinkedIn', label: 'socialLinkedIn' },
  { id: 'telegram', href: 'https://t.me/FloFiAppBot', mark: '/brand/channels/telegram.svg', width: 1000, height: 1000, name: 'Telegram', label: 'socialTelegram' },
] as const;
export type SocialId = typeof SOCIAL_LINKS[number]['id'];

/**
 * Small round community links, deliberately unlike the product CTAs: a mono label, no button styling, each with a descriptive name,
 * a 44 px target and a new tab without opener or referrer.
 */
export function SocialLinks({ t, variant }: { t: LandingCopy; variant: 'hero' | 'footer' }) {
  const id = useId();
  return <div className={`${styles.socialLinks} ${variant === 'footer' ? styles.footerSocial : ''}`} data-social-links={variant}>
    <p id={id}>{t.socialLabel}</p>
    <ul aria-labelledby={id}>
      {SOCIAL_LINKS.map(link => <li key={link.id}>
        <a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={t[link.label]} title={link.name} data-social={link.id}>
          <span className={styles.socialMark} data-social-mark={link.id} aria-hidden="true">
            <Image src={link.mark} alt="" width={link.width} height={link.height} unoptimized draggable={false}/>
          </span>
        </a>
      </li>)}
    </ul>
  </div>;
}
