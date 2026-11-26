// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: the in-chat panel's state-aware heading, badge and notice (incident 9: "Ready for review"
 * after completion), its EN/PT wording (incident 11), and the bounded signing-frame lifecycle (incident 1). The derivation is a pure function
 * serialized into the panel, so it is exercised here both directly and as the panel will run it (re-created from its own source text).
 */
import { describe, expect, it } from 'vitest';
import { panelHtml, panelPresentation, type PanelPresentation } from './panel.ts';
import { approvalState } from '../../platform/conversation-state.ts';

const ORIGIN = 'https://flofi.test';
type Input = Parameters<typeof panelPresentation>[0];
const of = (status: string, progress: Record<string, unknown> | null = null, language: 'EN' | 'PT' = 'EN', action: string | null = 'swap'): Input =>
  ({ status, progress, language, action });
const RECONCILED = { executionId: 'arb-1', flow: 'arbitrum-swap', status: 'RECONCILED', reconciled: true, terminal: true, errorCode: null };

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: panel presentation follows the server\'s canonical lifecycle', () => {
  // The panel receives `get_execution_progress`, which carries `conversationState: approvalState(progress)`: build it exactly that way.
  const read = (progress: Record<string, unknown>, language: 'EN' | 'PT' = 'EN', action: string | null = 'swap') =>
    panelPresentation({ status: String(progress.status), progress: { ...progress, conversationState: approvalState(progress as Parameters<typeof approvalState>[0]) }, language, action });
  const run = (extra: Record<string, unknown>) => ({ status: 'CLAIMED', executionPlan: 'SEQUENTIAL', claimed: true, runs: [],
    workflowRun: { state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP', steps: [{ index: 0, action: 'swap', state: 'READY', code: null }], groups: [], halted: null, resumable: false, ...extra } });

  it('says "Review …" only while nothing reached the signing flow, and offers actions only while the approval is open', () => {
    expect(panelPresentation(of('PENDING'))).toMatchObject({ phase: 'REVIEW', heading: 'Review swap', actionable: true, done: false });
    expect(read({ status: 'PENDING' })).toMatchObject({ phase: 'REVIEW', heading: 'Review swap', actionable: true });
    expect(read({ status: 'PENDING' }, 'PT')).toMatchObject({ heading: 'Revisar troca', badge: 'Aguardando você' });
    expect(read({ status: 'PENDING' }, 'EN', null).heading).toBe('Review your operation');
    expect(read({ status: 'CLAIMED' })).toMatchObject({ phase: 'AWAITING_WALLET', actionable: true, done: false });
  });

  it('agrees with approvalState on every run shape, never "Review" after the signing flow, and stops polling only when the server says final', () => {
    const cases: [Record<string, unknown>, PanelPresentation['phase'], boolean][] = [
      [{ status: 'APPLIED', runs: [RECONCILED], runsVisible: true }, 'COMPLETED', true],
      [{ status: 'APPLIED', runs: [], runsVisible: false }, 'NOT_SHARED', false],
      [{ status: 'APPLIED', statusHidden: true, executionPlan: 'SEQUENTIAL', runs: [], runsVisible: false }, 'NOT_SHARED', false],
      [{ status: 'APPLIED', runs: [], runsVisible: true, runsComplete: false }, 'UNKNOWN', false],
      [{ status: 'EXPIRED' }, 'ENDED', true], [{ status: 'REVOKED' }, 'ENDED', true], [{ status: 'SUPERSEDED' }, 'ENDED', true], [{ status: 'STALE' }, 'ENDED', true],
      [run({ state: 'COMPLETED', nextAction: 'NONE', steps: [{ index: 0, action: 'swap', state: 'RECONCILED', code: null }] }), 'COMPLETED', true],
      [run({ nextAction: 'OWNER_CONFIRMS_BATCH' }), 'IN_PROGRESS', false],
      [run({ state: 'HALTED', nextAction: 'OWNER_DECIDES', halted: 'STOPPED' }), 'ATTENTION', false],
      // An ended run whose batch was handed to the wallet and never answered may have executed: attention, never "Ended" (flofi-mcp/security).
      [run({ state: 'CANCELLED', nextAction: 'NONE', steps: [{ index: 0, action: 'swap', state: 'SKIPPED', code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] }), 'ATTENTION', false],
      [run({ state: 'FAILED', nextAction: 'NONE', steps: [{ index: 0, action: 'swap', state: 'FAILED', code: 'REVERTED' }] }), 'ENDED', true],
      [run({ state: 'CANCELLED', nextAction: 'NONE', steps: [{ index: 0, action: 'swap', state: 'SKIPPED', code: null }] }), 'ENDED', true],
    ];
    for (const [progress, phase, done] of cases) {
      const shown = read(progress), canonical = approvalState(progress as Parameters<typeof approvalState>[0]);
      expect(shown.phase, JSON.stringify(progress)).toBe(phase);
      expect(shown.done, `${phase} done`).toBe(done);
      expect(shown.done && !canonical.final, `${phase}: done only when the server says final`).toBe(false);
      expect(shown.heading, phase).not.toMatch(/^Review|^Revisar|ready for review/i);
    }
  });

  it('speaks one language at a time: the PT wording carries no EN heading or notice', () => {
    for (const progress of [{ status: 'CLAIMED' }, { status: 'EXPIRED' }, { status: 'APPLIED', runs: [RECONCILED], runsVisible: true },
      run({ state: 'HALTED', nextAction: 'OWNER_DECIDES', halted: 'STOPPED' })]) {
      const en = read(progress), pt = read(progress, 'PT');
      expect(pt.phase).toBe(en.phase);
      expect(pt.heading).not.toBe(en.heading);
      expect(pt.notice).not.toBe(en.notice);
    }
  });

  it('runs inside the panel exactly as here: its serialized source closes over nothing', () => {
    const revived = new Function(`return (${panelPresentation.toString()})`)() as typeof panelPresentation;
    for (const input of [of('PENDING', null, 'PT'), of('APPLIED', { status: 'APPLIED', runs: [RECONCILED], runsVisible: true, conversationState: { state: 'CONFIRMED', final: true } })])
      expect(revived(input)).toEqual(panelPresentation(input));
  });
});

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: panel document', () => {
  const html = panelHtml({ origin: ORIGIN, inFrameProbeHosts: [], frameAncestors: ['https://chatgpt.com', 'https://web-sandbox.oaiusercontent.com'] });
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  it('is one self-contained script that also carries the allowed signing-frame ancestors (public origins only)', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('"frameAncestors":["https://chatgpt.com","https://web-sandbox.oaiusercontent.com"]');
    expect(script).not.toMatch(/__name\(|require\(|import\(|\bimport\s|innerHTML|eval\(/);
    expect(script).not.toMatch(/eth_requestAccounts|eth_sendTransaction|signTransaction|signMessage|personal_sign|wallet_sendCalls/);
  });
  it('bounds the signing frame: a load without the frame\'s answer, a disallowed chain and no answer at all each end in a stated failure', () => {
    for (const code of ['HOST_FRAME_BLOCKED', 'HOST_FRAME_ORIGIN_NOT_ALLOWED', 'HOST_FRAME_TIMEOUT']) expect(script).toContain(code);
    // A masked ("null") ancestor is unknown, never a reason to tear the frame down early (flofi-security review).
    expect(script).toMatch(/origin !== ["']null["'] && !allowed\.includes\(origin\)/);
    // A step that never ran is never called done.
    expect(script).toContain('Not run'); expect(script).not.toContain('Already done');
    expect(script).toContain('ancestorOrigins');
    // The "opening" notice is re-rendered away as soon as the frame answers (the stuck notice of the incident).
    expect(script).toMatch(/signingFrame\.hidden = false;\s*view\.frame = ["']shown["'];[\s\S]{0,400}if \(first\) render\(\)/);
  });
  it('describes a wallet deep link as opening FloFi in the wallet, never as a signature request', () => {
    expect(script).toContain('Open FloFi in MetaMask');
    expect(script).toContain('Abrir a FloFi no MetaMask');
    expect(script).not.toMatch(/["']Open in MetaMask["']/);
  });
});
