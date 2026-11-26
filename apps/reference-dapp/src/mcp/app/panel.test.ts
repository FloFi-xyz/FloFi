// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: the in-chat panel's state-aware heading, badge and notice (incident 9: "Ready for review"
 * after completion), its EN/PT wording (incident 11), and the bounded signing-frame lifecycle (incident 1). The derivation is a pure function
 * serialized into the panel, so it is exercised here both directly and as the panel will run it (re-created from its own source text).
 */
import { describe, expect, it } from 'vitest';
import { panelHtml, panelPresentation, type PanelPresentation } from './panel.ts';

const ORIGIN = 'https://flofi.test';
type Input = Parameters<typeof panelPresentation>[0];
const of = (status: string, progress: Record<string, unknown> | null = null, language: 'EN' | 'PT' = 'EN', action: string | null = 'swap'): Input =>
  ({ status, progress, language, action });
const RECONCILED = { executionId: 'arb-1', flow: 'arbitrum-swap', status: 'RECONCILED', reconciled: true, terminal: true, errorCode: null };

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: panel presentation', () => {
  it('says "Review …" only while nothing reached the signing flow, and offers actions only then', () => {
    expect(panelPresentation(of('PENDING'))).toMatchObject({ phase: 'REVIEW', heading: 'Review swap', actionable: true, done: false });
    expect(panelPresentation(of('PENDING', null, 'PT'))).toMatchObject({ phase: 'REVIEW', heading: 'Revisar troca', badge: 'Aguardando você' });
    expect(panelPresentation(of('PENDING', null, 'EN', null)).heading).toBe('Review your operation');
    expect(panelPresentation(of('CLAIMED'))).toMatchObject({ phase: 'AWAITING_WALLET', actionable: true, done: false });
  });

  it('never shows a completed, ended, uncertain or unshared state as ready for review', () => {
    const states: [Input, PanelPresentation['phase'], boolean][] = [
      [of('APPLIED', { status: 'APPLIED', runs: [RECONCILED], runsVisible: true }), 'COMPLETED', true],
      [of('APPLIED', { status: 'APPLIED', runs: [{ ...RECONCILED, reconciled: false, terminal: false, status: 'SUBMITTED' }], runsVisible: true }), 'IN_PROGRESS', false],
      [of('APPLIED', { status: 'APPLIED', runs: [{ ...RECONCILED, reconciled: false, terminal: true, errorCode: 'REVERTED' }], runsVisible: true }), 'ATTENTION', true],
      // A failed attempt then a reconciled retry is a completed operation.
      [of('APPLIED', { status: 'APPLIED', runs: [{ ...RECONCILED, executionId: 'arb-0', reconciled: false, terminal: true, errorCode: 'REJECTED' }, RECONCILED],
        runsVisible: true }), 'COMPLETED', true],
      [of('APPLIED', { status: 'APPLIED', runs: [], runsVisible: false }), 'NOT_SHARED', true],
      [of('APPLIED', { status: 'APPLIED', runs: [], runsVisible: true, runsComplete: false }), 'UNKNOWN', false],
      [of('EXPIRED'), 'ENDED', true], [of('REVOKED'), 'ENDED', true], [of('SUPERSEDED'), 'ENDED', true], [of('STALE'), 'ENDED', true],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'COMPLETED', nextAction: 'NONE', steps: [] } }), 'COMPLETED', true],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION', steps: [] } }), 'IN_PROGRESS', false],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP', steps: [] } }), 'AWAITING_WALLET', false],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'HALTED', nextAction: 'OWNER_DECIDES', steps: [] } }), 'ATTENTION', false],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'FAILED', steps: [] } }), 'ENDED', true],
      [of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'CANCELLED', steps: [] } }), 'ENDED', true],
      [of('EXPIRED', { status: 'EXPIRED', workflowRun: { state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION', steps: [] } }), 'IN_PROGRESS', false],
    ];
    for (const [input, phase, done] of states) {
      const shown = panelPresentation(input);
      expect(shown.phase, JSON.stringify(input.progress ?? input.status)).toBe(phase);
      expect(shown.done, phase).toBe(done);
      expect(shown.heading, phase).not.toMatch(/^Review|^Revisar|ready for review/i);
      expect(shown.actionable && ['COMPLETED', 'ENDED', 'IN_PROGRESS', 'ATTENTION', 'UNKNOWN', 'NOT_SHARED'].includes(phase)).toBe(false);
    }
  });

  it('speaks one language at a time: the PT wording carries no EN heading or badge', () => {
    for (const input of [of('PENDING'), of('CLAIMED'), of('EXPIRED'), of('APPLIED', { status: 'APPLIED', runs: [RECONCILED], runsVisible: true }),
      of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'HALTED', steps: [] } })]) {
      const en = panelPresentation(input), pt = panelPresentation({ ...input, language: 'PT' });
      expect(pt.phase).toBe(en.phase);
      expect(pt.heading).not.toBe(en.heading);
      expect(pt.notice).not.toBe(en.notice);
    }
  });

  it('runs inside the panel exactly as here: its serialized source closes over nothing', () => {
    const revived = new Function(`return (${panelPresentation.toString()})`)() as typeof panelPresentation;
    for (const input of [of('PENDING', null, 'PT'), of('APPLIED', { status: 'APPLIED', runs: [RECONCILED], runsVisible: true }),
      of('CLAIMED', { status: 'CLAIMED', workflowRun: { state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION', steps: [] } })])
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
