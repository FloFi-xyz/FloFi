// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (incident 9): the /approve proposal notice follows the shown execution and the workflow run,
 * never "Ready for your review." after anything was requested from the wallet; each phase is translated (incident 11).
 */
import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/locale';
import { APPROVAL_NOTICE, approvalNoticePhase, type ApprovalNoticePhase } from './approval-notice';

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: approval notice phase', () => {
  it('reads "Ready for your review." only while nothing was requested from the wallet', () => {
    expect(approvalNoticePhase(null, null)).toBe('review');
    expect(approvalNoticePhase(undefined, { state: 'PENDING', nextAction: 'OWNER_CHOOSES_MODE' })).toBe('review');
    expect(approvalNoticePhase(null, { state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP' })).toBe('review');
    expect(APPROVAL_NOTICE.review[0]).toBe('Ready for your review.');
  });
  it('follows the execution and the run\'s durable state, the run first', () => {
    const cases: [Parameters<typeof approvalNoticePhase>, ApprovalNoticePhase][] = [
      [['active', null], 'active'], [['complete', null], 'complete'], [['attention', null], 'attention'],
      [[null, { state: 'RUNNING', nextAction: 'WAITING_FOR_RECONCILIATION' }], 'active'],
      [[null, { state: 'COMPLETED', nextAction: 'NONE' }], 'complete'],
      [['active', { state: 'COMPLETED', nextAction: 'NONE' }], 'complete'],
      [[null, { state: 'HALTED', nextAction: 'OWNER_DECIDES' }], 'attention'], [[null, { state: 'ATTENTION' }], 'attention'],
      [[null, { state: 'FAILED' }], 'ended'], [[null, { state: 'CANCELLED' }], 'ended'], [[null, { state: 'EXPIRED' }], 'ended'],
      [['complete', { state: 'RUNNING', nextAction: 'OWNER_SIGNS_GROUP' }], 'complete'],
      [[null, { state: 'CANCELLED', steps: [{ code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] }], 'attention'],
      [[null, { state: 'EXPIRED', groups: [{ code: 'WALLET_BATCH_OUTCOME_UNKNOWN' }] }], 'attention'],
    ];
    for (const [args, phase] of cases) expect(approvalNoticePhase(...args), JSON.stringify(args)).toBe(phase);
  });
  it('every phase is worded in Portuguese too (no English lead or sentence on a Portuguese page)', () => {
    for (const [phase, [lead, sentence]] of Object.entries(APPROVAL_NOTICE)) {
      expect(translate('PT', lead), phase).not.toBe(lead);
      expect(translate('PT', sentence), phase).not.toBe(sentence);
    }
  });
});
