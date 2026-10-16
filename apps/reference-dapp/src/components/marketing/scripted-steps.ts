// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export const SCRIPT_STEP_MS = 900;

/**
 * `static`: the complete final frame (server HTML, reduced motion, no IntersectionObserver). `waiting`: not yet meaningfully visible,
 * scrolled away or the tab is hidden. `paused`: the visitor paused it. `done`: the final frame, held until a replay.
 */
export type TimelineState = 'static' | 'waiting' | 'playing' | 'paused' | 'done';
export type Timeline = { readonly index: number; readonly state: TimelineState; toggle(): void; replay(): void };

/** Meaningfully visible: a third of the element, or almost half the viewport for elements taller than the screen. */
const meaningful = (entry: IntersectionObserverEntry) => entry.isIntersecting && (entry.intersectionRatio >= .35 || entry.intersectionRect.height >= window.innerHeight * .45);

/**
 * One deterministic clock for a scripted illustration. `ticks` are the fixed times (ms, ascending, starting at 0) at which the frame
 * changes; the returned `index` is the last tick reached, so everything a section draws is a pure function of it. A single timer is
 * armed at a time. The clock starts when the element is meaningfully in view, holds while it is out of view or the tab is hidden,
 * follows the visitor's pause, and stops on its final frame (no loop). Server HTML, reduced motion and browsers without
 * IntersectionObserver get the final frame at once. Changing `run` restarts it. Nothing is fetched, stored or measured.
 */
export function useTimeline(ref: RefObject<HTMLElement | null>, ticks: readonly number[], run: string | number = 0): Timeline {
  const last = ticks.length - 1;
  const [index, setIndex] = useState(last);
  const [state, setState] = useState<TimelineState>('static');
  const control = useRef({ toggle: () => {}, replay: () => {} });
  useEffect(() => {
    const element = ref.current;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || media.matches || !('IntersectionObserver' in window)) { setIndex(last); setState('static'); return; }
    let timer: ReturnType<typeof setTimeout> | undefined, at = 0, running = false, held = false, inView = false, stopped = false;
    const arm = () => { timer = setTimeout(advance, ticks[at + 1]! - ticks[at]!); };
    const advance = () => {
      at += 1; setIndex(at);
      if (at >= last) { running = false; setState('done'); } else arm();
    };
    const resume = () => {
      if (stopped || running || held || at >= last || !inView || document.hidden) return;
      running = true; setState('playing'); arm();
    };
    const hold = (next: TimelineState) => { clearTimeout(timer); running = false; if (at < last) setState(next); };
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1]!;
      // Once started, it keeps playing while any part is on screen; it starts or resumes only when meaningfully visible.
      if (meaningful(entry)) { inView = true; resume(); } else if (!entry.isIntersecting) { inView = false; if (running) hold('waiting'); }
    }, { threshold: [0, .1, .2, .35, .5, .75, 1] });
    const visibility = () => { if (document.hidden) { if (running) hold('waiting'); } else resume(); };
    const preference = () => { if (!media.matches) return; stopped = true; clearTimeout(timer); running = false; at = last; setIndex(last); setState('static'); };
    control.current = {
      toggle: () => {
        if (stopped) return;
        if (at >= last) { control.current.replay(); return; }
        if (held) { held = false; setState('waiting'); resume(); } else { held = true; hold('paused'); }
      },
      replay: () => {
        if (stopped) return;
        clearTimeout(timer); running = false; held = false; at = 0; setIndex(0); setState('waiting'); resume();
      },
    };
    setIndex(0); setState('waiting');
    observer.observe(element);
    document.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', preference);
    return () => {
      clearTimeout(timer); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      media.removeEventListener('change', preference);
      control.current = { toggle: () => {}, replay: () => {} };
    };
  }, [ref, ticks, last, run]);
  const toggle = useCallback(() => control.current.toggle(), []);
  const replay = useCallback(() => control.current.replay(), []);
  return { index, state, toggle, replay };
}

const stepTicks = new Map<number, readonly number[]>();

/**
 * A short, finite sequence of `last` steps of SCRIPT_STEP_MS each (under five seconds) on the shared timeline, left on its complete final
 * state. `run` restarts it (a visitor's choice).
 */
export function useScriptedSteps(ref: RefObject<HTMLElement | null>, last: number, run: string | number) {
  let ticks = stepTicks.get(last);
  if (!ticks) { ticks = Array.from({ length: last + 1 }, (_, step) => step * SCRIPT_STEP_MS); stepTicks.set(last, ticks); }
  return useTimeline(ref, ticks, run).index;
}
