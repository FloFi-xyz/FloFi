// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { HandoffRecord } from '../../platform/handoff-store';
import { channelCopy, type RunLine } from './copy';
import { plannedNotifications, statusReplies } from './status';

const handoff = { handoffId: 'apr_test', shareStatus: true } as HandoffRecord;
const run = { executionId: 'rhx_test', flow: 'robinhood-transfer', status: 'SIMULATED', reconciled: false, terminal: false, errorCode: null,
  evidenceEnvironment: null, evidenceOutcome: null, evidenceBundleHash: null, receiptUrl: null, updatedAt: '2026-10-19T10:00:00.000Z' };
const progress = { status: 'APPLIED', expiresAt: '2026-10-19T10:15:00.000Z', runsVisible: true, runs: [run] } as unknown as Parameters<typeof plannedNotifications>[2];

describe.each(['EN', 'PT'] as const)('truthful channel lifecycle (%s)', language => {
  it('reports automatic preparation as read-only simulation in STATUS and notifications', () => {
    const { due, done } = plannedNotifications(language, handoff, progress);
    const status = statusReplies(language, { handoff, progress })[0]!.text;
    for (const text of [due.at(-1)!.text, status]) {
      expect(text).toContain(language === 'EN' ? 'Simulation complete (read-only)' : 'Simulação concluída (somente leitura)');
      expect(text).not.toMatch(/Execution in progress|Execução em andamento|Receipt:|Recibo:|✅/);
    }
    expect(done).toBe(false);
  });

  it('does not consume subsequent lifecycle notices when simulation is announced', () => {
    const states = ['SIMULATED', 'AUTHORIZED', 'PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'HASH', 'PENDING', 'CONFIRMED', 'RECONCILED'];
    const notices = states.map(status => plannedNotifications(language, handoff, { ...progress, runs: [{ ...run, status }] }).due.at(-1)!);
    expect(new Set(notices.map(n => n.key)).size).toBe(states.length);
    expect(new Set(notices.map(n => n.text)).size).toBe(states.length);
    expect(plannedNotifications(language, handoff, progress).due.at(-1)).toEqual(notices[0]);
    for (const n of notices) {
      expect(n.text).not.toMatch(/Receipt:|Recibo:|✅/);
      // The durable outbox rejects uppercase keys and rolls back the entire notification batch.
      expect(n.key).toMatch(/^[a-z][a-z0-9_.:-]{2,159}$/);
    }
  });

  it('uses conservative wording for failed or unfamiliar states without inventing a receipt', () => {
    for (const facts of [{ status: 'UNRECOGNIZED' }, { status: 'FAILED', terminal: true, errorCode: 'WALLET_REJECTED' }]) {
      const text = channelCopy(language).run({ ...run, ...facts, receiptUrl: 'https://flofi.test/unverified' });
      expect(text).not.toMatch(/Receipt:|Recibo:|✅|https:/);
    }
  });

  it('reports reconciled evidence without upgrading MOCKED to public execution', () => {
    const result: RunLine = { ...run, status: 'RECONCILED', reconciled: true, terminal: true, evidenceEnvironment: 'MOCKED',
      evidenceOutcome: 'RECONCILED', evidenceBundleHash: 'sha256:' + 'a'.repeat(64), receiptUrl: 'https://flofi.test/app/dashboard/runs/rhx_test' };
    const text = channelCopy(language).run(result);
    expect(text).toContain('MOCKED'); expect(text).toContain(result.receiptUrl);
    expect(text).not.toMatch(/TESTNET_EXECUTED|MAINNET_EXECUTED/);
    // A scheduled sweep may first deliver the loaded notice after execution has already finished.
    expect(channelCopy(language).loaded).not.toMatch(/Nothing is signed yet|Nada foi assinado ainda/);
  });

  it('sends no notices without the owner sharing status', () => {
    expect(plannedNotifications(language, { ...handoff, shareStatus: false }, progress).due).toEqual([]);
  });
});

describe('BUILD-FLOFI-E2E-RELIABILITY-001 channel status follows the run evidence', () => {
  it('an incomplete run read is said as unknown (never "no record") and keeps notifications open', () => {
    for (const language of ['EN', 'PT'] as const) {
      const unknown = { ...progress, runs: [], runsComplete: false } as unknown as Parameters<typeof plannedNotifications>[2];
      const text = statusReplies(language, { handoff, progress: unknown })[0]!.text;
      expect(text, language).toMatch(language === 'EN' ? /not evidence that nothing was sent/ : /não é prova de que nada foi enviado/);
      expect(text, language).not.toMatch(/No simulation or execution record|Ainda não há registro/);
      const partial = { ...progress, runs: [{ ...run, terminal: true, status: 'REJECTED', errorCode: 'X' }], runsComplete: false } as unknown as Parameters<typeof plannedNotifications>[2];
      expect(plannedNotifications(language, handoff, partial).done, language).toBe(false);
    }
  });
  it('a run whose only landed request is its token approval is never read as "nothing submitted" or as the action', () => {
    const landed = { ...progress, runs: [{ ...run, status: 'AUTHORIZED', terminal: false, reconciled: false, landed: 'Approval confirmed · main action not sent' }] } as unknown as Parameters<typeof plannedNotifications>[2];
    const en = statusReplies('EN', { handoff, progress: landed })[0]!.text, pt = statusReplies('PT', { handoff, progress: landed })[0]!.text;
    expect(en).toContain('Approval confirmed · main action not sent. The token approval is confirmed onchain, but it moves no funds by itself');
    expect(en).not.toContain('Wallet authorization is still required before submission');
    expect(pt).toContain('Aprovação confirmada');
    expect(plannedNotifications('EN', handoff, landed).due.at(-1)!.key).toMatch(/:approval-landed$/);
  });
});
