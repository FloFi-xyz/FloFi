// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useRouter } from 'next/navigation';
import { useLocale } from '../../i18n/locale';
import styles from './flight.module.css';

/** The board's "EN · PT" switch: the product's one shared language preference (the same as the site, sign-in and /app). */
export function LanguageSwitch({ language, label }: { language: 'EN' | 'PT'; label: string }) {
  const { setLanguage } = useLocale(), router = useRouter();
  return <div className={styles.lang} role="group" aria-label={label}>
    {(['EN', 'PT'] as const).map(value => <button key={value} type="button" lang={value === 'PT' ? 'pt-BR' : 'en'} aria-pressed={language === value}
      onClick={() => { setLanguage(value); if (value !== language) router.refresh(); }}>{value}</button>)}
  </div>;
}
