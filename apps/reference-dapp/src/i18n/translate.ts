// SPDX-License-Identifier: AGPL-3.0-only
import { portuguese } from './pt';
import type { Language } from './language';

/**
 * The catalog lookup shared by the interface (`useLocale().t`), the chat's deterministic copy and domain presentation code. Kept free of
 * `'use client'` (P0 hotfix, locale contract) so a domain or server module calls exactly the function the components call. Moved unchanged
 * from `locale.tsx`, which re-exports it.
 */
const templates = Object.entries(portuguese).filter(([key]) => key.includes('{0}')).map(([key, value]) => ({
  pattern: new RegExp('^' + key.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$'), value,
}));
/** Translate only catalog messages. Unlisted symbols, addresses, hashes, IDs and user names pass through unchanged. */
export function translate<T>(language: Language, input: T, ...parameters: readonly (string | number)[]): T {
  if (typeof input !== 'string') return input;
  const text = input.trim();
  let value = language === 'PT' && Object.hasOwn(portuguese, text) ? portuguese[text] : undefined;
  if (parameters.length) {
    const message = (value ?? text).replace(/\{(\d+)\}/g, (placeholder, i: string) => String(parameters[Number(i)] ?? placeholder));
    return input.replace(text, () => message) as T;
  }
  if (language !== 'PT') return input;
  if (!value) for (const template of templates) { const match = template.pattern.exec(text); if (match) { value = template.value.replace(/\{(\d+)\}/g, (_, i: string) => match[Number(i) + 1] ?? ''); break; } }
  return (value === undefined ? input : input.replace(text, () => value!)) as T;
}
