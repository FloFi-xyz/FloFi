// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState } from 'react';

/**
 * BUILD-FLOFI-LAUNCH-001: the approved landing's typing hero. Each of the five phrases owns one 3.93 s slot of the board's 19.67 s loop:
 * a verb types at 95 ms a character, holds and backspaces at 45 ms a character so it is empty 0.5 s before the next slot; a sentence types at
 * 32 ms a character and clears at 80% of its slot. The text is decorative: callers hide it from assistive technology and name the control or
 * heading with the full sentence. Without JavaScript, and when the visitor prefers reduced motion, the first phrase stays still (as the board's
 * `prefers-reduced-motion` rule does).
 */
export const SLOT_MS = 19_670 / 5;
/** Where the clock starts: every first phrase (verb and sentence, in both languages) is fully typed by then, so the phrase the server rendered
 * stays on screen through hydration instead of blanking and retyping. */
export const START_MS = 1_300;
const WORD_TYPE_MS = 95, WORD_DELETE_MS = 45, WORD_GAP_MS = 500, SENTENCE_TYPE_MS = 32, SENTENCE_SHOWN = 0.8;

/** The visible text of `kind` at `elapsed` milliseconds into the loop (pure, so the timeline is unit-tested). */
export function typedAt(kind: 'word' | 'sentence', phrases: readonly string[], elapsed: number): string {
  const loop = SLOT_MS * phrases.length, at = ((elapsed % loop) + loop) % loop;
  const index = Math.min(phrases.length - 1, Math.floor(at / SLOT_MS)), phrase = phrases[index] ?? '', t = at - index * SLOT_MS;
  if (kind === 'sentence') return t < SLOT_MS * SENTENCE_SHOWN ? phrase.slice(0, Math.floor(t / SENTENCE_TYPE_MS)) : '';
  const erase = SLOT_MS - WORD_GAP_MS - phrase.length * WORD_DELETE_MS;
  if (t >= erase) return phrase.slice(0, Math.max(0, phrase.length - Math.ceil((t - erase) / WORD_DELETE_MS)));
  return phrase.slice(0, Math.floor(t / WORD_TYPE_MS));
}

export function TypingText({ kind, phrases }: { kind: 'word' | 'sentence'; phrases: readonly string[] }) {
  const [text, setText] = useState(phrases[0] ?? '');
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      if (still?.matches) { setText(phrases[0] ?? ''); return; }
      const origin = performance.now() - START_MS;
      setText(typedAt(kind, phrases, START_MS));
      timer = setInterval(() => setText(typedAt(kind, phrases, performance.now() - origin)), 1000 / 30);
    };
    start();
    still?.addEventListener?.('change', start);
    return () => { clearInterval(timer); still?.removeEventListener?.('change', start); };
  }, [kind, phrases]);
  return <>{text}</>;
}
