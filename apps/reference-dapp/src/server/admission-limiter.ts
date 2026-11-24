// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-process admission: bounded concurrency and a sliding window. Not a global quota. A plain utility with no imports, so read-only modules
 * (wallet positions, which the MCP route may load) can bound their work without depending on the Copilot service. BUILD-FLOFI-UNIVERSAL-CHANNELS-001
 * moved it here unchanged from `copilot-service.ts`, which re-exports it as `createCopilotLimiter`.
 */
export type AdmissionLimits = { readonly windowMs: number; readonly maxConcurrent: number; readonly maxPerWindow: number };
export function createAdmissionLimiter(limits: AdmissionLimits, now: () => number = Date.now) {
  let active = 0;
  const starts: number[] = [];
  return {
    acquire(): (() => void) | null {
      const time = now();
      while (starts.length && time - starts[0]! >= limits.windowMs) starts.shift();
      if (active >= limits.maxConcurrent || starts.length >= limits.maxPerWindow) return null;
      active += 1; starts.push(time);
      let released = false;
      return () => { if (!released) { released = true; active -= 1; } };
    },
  };
}
export type AdmissionLimiter = ReturnType<typeof createAdmissionLimiter>;
