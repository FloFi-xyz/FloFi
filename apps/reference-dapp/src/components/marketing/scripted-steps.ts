// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState, type RefObject } from 'react';

export const SCRIPT_STEP_MS = 900;

/**
 * A short, finite illustration sequence: `last` steps of SCRIPT_STEP_MS each (under five seconds), started when the section is in view
 * and the tab is visible, then left on its complete final state. Server HTML, reduced motion and browsers without IntersectionObserver
 * show the final state at once. `run` restarts it (a visitor's choice); nothing is fetched, stored or measured.
 */
export function useScriptedSteps(ref: RefObject<HTMLElement | null>, last: number, run: string | number) {
  const [step, setStep] = useState(last);
  useEffect(() => {
    const element = ref.current;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || media.matches || !('IntersectionObserver' in window)) { setStep(last); return; }
    let timer: ReturnType<typeof setTimeout> | undefined, started = false, inView = false;
    const advance = (next: number) => {
      setStep(next);
      if (next < last) timer = setTimeout(() => advance(next + 1), SCRIPT_STEP_MS);
    };
    const start = () => { if (started || !inView || document.hidden) return; started = true; advance(1); };
    const finish = () => { clearTimeout(timer); started = true; setStep(last); };
    setStep(0);
    const observer = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); start(); }, { threshold: .3 });
    observer.observe(element);
    const visibility = () => start();
    const preference = () => { if (media.matches) finish(); };
    document.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', preference);
    return () => {
      clearTimeout(timer); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      media.removeEventListener('change', preference);
    };
  }, [ref, last, run]);
  return step;
}
