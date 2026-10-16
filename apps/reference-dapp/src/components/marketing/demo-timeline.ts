// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BUILD-FLOFI-UX-UI-002 (owner revision): the "How it works" story on one deterministic timeline. Every visible state of the chat and
 * the Canvas is a pure function of the time reached on it, so they can never drift apart. The cue times are milliseconds from the moment
 * the section becomes meaningfully visible. Nothing here fetches, stores, connects or computes a financial value.
 */
export const DEMO_CUES = {
  typing: 600, // the visitor's request is typed into the composer
  sent: 2900, // the message is sent and appears as a bubble; the mascot looks at it
  thinking: 3300, // FloFi is thinking
  reply: 4700, // "I'll build your Aave workflow."
  supplyGhost: 5500, // "Adding the supply step…" and the Supply card's outline is placed
  supplyCard: 6000, // the Supply card materializes
  borrowGhost: 7000, // the supply step is in place; "Connecting your borrow step…" and the Borrow outline
  borrowCard: 7500, // the Borrow card materializes
  connector: 7900, // the connector is drawn Supply → Borrow
  ready: 9000, // "Your workflow is ready to simulate."; Simulate workflow appears; the mascot jumps
  press: 10000, // Simulate workflow is pressed
  simulate: 10400, // stage 2: checking the workflow (both cards)
  collateral: 11200, // checking collateral and borrowing requirements (the Borrow card)
  costs: 12000, // reviewing network costs
  manifest: 12800, // preparing the Strategy Manifest
  execute: 13800, // stage 3: strategy review; "Your wallet has the final say."
  wallet: 14700, // wallet authorization; the mascot looks
  run: 15700, // execution, step by step (Supply)
  runBorrow: 16200, // execution reaches the Borrow step
  status: 16800, // status and reconciliation
  done: 17800, // the lifecycle is illustrated end to end; the closing call to action
} as const;
export type DemoCue = 'idle' | keyof typeof DEMO_CUES;
const order = Object.entries(DEMO_CUES) as [keyof typeof DEMO_CUES, number][];

export const DEMO_TYPING_MS = 50;
/** Every time at which the frame changes: the cues, plus one tick per typed character slot. */
export const DEMO_TICKS: readonly number[] = [...new Set([0, ...order.map(([, at]) => at),
  ...Array.from({ length: Math.floor((DEMO_CUES.sent - DEMO_CUES.typing - 200) / DEMO_TYPING_MS) + 1 }, (_, i) => DEMO_CUES.typing + i * DEMO_TYPING_MS)])]
  .sort((a, b) => a - b);
export const DEMO_END = DEMO_CUES.done;

export type Status = 'pending' | 'active' | 'visited';
export type CardState = 'hidden' | 'ghost' | 'shown';
export type Stage = 'build' | 'simulate' | 'execute';
export type DemoFrame = ReturnType<typeof demoFrame>;

export function demoCue(time: number): DemoCue {
  let cue: DemoCue = 'idle';
  for (const [name, at] of order) if (time >= at) cue = name;
  return cue;
}

/** The complete picture at `time`. The final frame (DEMO_END) is also the static version for reduced motion and server HTML. */
export function demoFrame(time: number) {
  const at = (cue: keyof typeof DEMO_CUES) => time >= DEMO_CUES[cue];
  const span = (from: keyof typeof DEMO_CUES, to: keyof typeof DEMO_CUES): Status => !at(from) ? 'pending' : at(to) ? 'visited' : 'active';
  const card = (ghost: keyof typeof DEMO_CUES, shown: keyof typeof DEMO_CUES): CardState => !at(ghost) ? 'hidden' : at(shown) ? 'shown' : 'ghost';
  const stage: Stage = at('execute') ? 'execute' : at('simulate') ? 'simulate' : 'build';
  const typingEnd = DEMO_CUES.sent - 200;
  return {
    cue: demoCue(time),
    stage,
    // Chat
    composing: at('typing') && !at('sent'),
    typed: Math.min(1, Math.max(0, (time - DEMO_CUES.typing + DEMO_TYPING_MS) / (typingEnd - DEMO_CUES.typing))),
    sending: at('sent') && !at('thinking'),
    sent: at('sent'),
    thinking: at('thinking') && !at('reply'),
    reply: at('reply'),
    supplyLine: span('supplyGhost', 'borrowGhost'),
    borrowLine: span('borrowGhost', 'ready'),
    ready: at('ready'),
    simulateLine: span('simulate', 'execute'),
    handoff: at('execute'),
    // Canvas
    stages: { build: at('simulate') ? 'visited' as const : 'active' as const, simulate: span('simulate', 'execute'), execute: at('execute') ? 'active' as const : 'pending' as const },
    empty: !at('supplyGhost'),
    supply: card('supplyGhost', 'supplyCard'),
    borrow: card('borrowGhost', 'borrowCard'),
    connector: at('connector'),
    simulateButton: !at('ready') ? 'hidden' as const : at('press') ? 'pressed' as const : 'shown' as const,
    checks: [span('simulate', 'collateral'), span('collateral', 'costs'), span('costs', 'manifest'), span('manifest', 'execute')] as const,
    steps: [span('execute', 'wallet'), span('wallet', 'run'), span('run', 'status'), span('status', 'done')] as const,
    // The card(s) the current check or execution step is about; nothing is marked as a result.
    focus: {
      supply: (at('simulate') && !at('collateral')) || (at('run') && !at('runBorrow')),
      borrow: (at('simulate') && !at('costs')) || (at('runBorrow') && !at('status')),
    },
    done: at('done'),
  };
}

/** Mascot reactions requested from the existing journey controller at meaningful moments only. */
export const DEMO_REACTIONS: Partial<Record<DemoCue, 'look' | 'jump'>> = { sent: 'look', ready: 'jump', wallet: 'look' };
