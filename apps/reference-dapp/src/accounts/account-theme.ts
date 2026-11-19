// SPDX-License-Identifier: AGPL-3.0-only
export const THEME_KEY = 'flofi.theme';
type Theme = 'light' | 'dark';
const THEME_CHANGED = 'flofi:theme-changed';

export function defaultTheme(pathname: string | null): Theme | undefined {
  if (/^\/admin(?:\/|$)/.test(pathname ?? '')) return undefined;
  return pathname === '/login' || /^\/(?:onboarding|wallet|account)(?:\/|$)/.test(pathname ?? '') ? 'dark' : 'light';
}

/** The document already carries its route default. Apply an explicit choice before the page paints. */
export const THEME_BOOTSTRAP = `try{const t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}`;

export function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export const lightTheme = (): Theme => 'light';
export const darkTheme = (): Theme => 'dark';

function paintTheme(theme: Theme) {
  if (readTheme() === theme) return;
  document.documentElement.dataset.theme = theme;
  // Resolve style changes now and finish palette transitions before the browser paints.
  // Transform, opacity and keyframe animations keep their existing interaction behavior.
  for (const animation of document.getAnimations?.() ?? []) {
    if ('transitionProperty' in animation && /(?:color$|^background|^box-shadow$|^fill$|^stroke$)/.test(String(animation.transitionProperty))) {
      animation.cancel();
    }
  }
}

export function selectTheme(theme: Theme) {
  paintTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* The document retains the choice for this visit. */ }
  window.dispatchEvent(new Event(THEME_CHANGED));
}

export function subscribeTheme(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== THEME_KEY || (event.newValue !== 'light' && event.newValue !== 'dark')) return;
    paintTheme(event.newValue);
    onChange();
  }
  window.addEventListener(THEME_CHANGED, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGED, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
