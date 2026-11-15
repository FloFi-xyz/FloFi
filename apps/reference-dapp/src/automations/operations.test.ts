// SPDX-License-Identifier: AGPL-3.0-only
/** The closed operation contract (`operations.ts`): `replace` takes exactly a rule id, a version and `{ schedule: { frequency, weekday, time } }`. */
import { describe, expect, it, vi } from 'vitest';
import { AUTOMATION_OPERATIONS, IDEMPOTENT_OPERATIONS, isAutomationOperation, runAutomationOperation, type AutomationService } from './operations';
import type { Owner } from './store';

const OWNER: Owner = { namespace: 'eip155', address: '0x' + 'a1'.repeat(20) };
const RULE = 'aut_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const service = () => {
  const replace = vi.fn(async () => ({ created: {}, archived: {} }));
  return { replace, service: { replace } as unknown as AutomationService };
};

describe('automation operations: replace', () => {
  it('is a closed, idempotency-keyed operation', () => {
    expect(AUTOMATION_OPERATIONS).toContain('replace');
    expect(isAutomationOperation('replace')).toBe(true);
    expect(isAutomationOperation('update')).toBe(false);
    expect([...IDEMPOTENT_OPERATIONS].sort()).toEqual(['create', 'replace']);
  });

  it('passes exactly the verified owner, the id, the version and the schedule patch', async () => {
    const s = service();
    await runAutomationOperation(s.service, OWNER, 'replace', [RULE, 3, { schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30' } }]);
    await runAutomationOperation(s.service, OWNER, 'replace', [RULE, 1, { schedule: { time: '07:00', weekday: null, frequency: 'DAILY' } }]);
    expect(s.replace.mock.calls).toEqual([[OWNER, RULE, 3, { schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30' } }],
      [OWNER, RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' } }]]);
  });

  it.each<[string, readonly unknown[]]>([
    ['no patch', [RULE, 1]],
    ['an extra argument', [RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' } }, 'x']],
    ['a long id', ['a'.repeat(65), 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' } }]],
    ['version 0', [RULE, 0, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' } }]],
    ['a string version', [RULE, '1', { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' } }]],
    ['a null patch', [RULE, 1, null]],
    ['a patch with another field', [RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00' }, limits: {} }]],
    ['a patch without schedule', [RULE, 1, {}]],
    ['a schedule with a time zone', [RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:00', timezone: 'UTC' } }]],
    ['a schedule without weekday', [RULE, 1, { schedule: { frequency: 'DAILY', time: '07:00' } }]],
    ['a monthly frequency', [RULE, 1, { schedule: { frequency: 'MONTHLY', weekday: null, time: '07:00' } }]],
    ['weekday 0', [RULE, 1, { schedule: { frequency: 'WEEKLY', weekday: 0, time: '07:00' } }]],
    ['weekday 8', [RULE, 1, { schedule: { frequency: 'WEEKLY', weekday: 8, time: '07:00' } }]],
    ['a fractional weekday', [RULE, 1, { schedule: { frequency: 'WEEKLY', weekday: 1.5, time: '07:00' } }]],
    ['an unpadded time', [RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '7:00' } }]],
    ['24:00', [RULE, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '24:00' } }]],
    ['an array schedule', [RULE, 1, { schedule: ['DAILY', null, '07:00'] }]],
  ])('refuses %s with AUTOMATION_INPUT_INVALID before the service sees it', async (_, args) => {
    const s = service();
    await expect(runAutomationOperation(s.service, OWNER, 'replace', args)).rejects.toThrow('AUTOMATION_INPUT_INVALID');
    expect(s.replace).not.toHaveBeenCalled();
  });
});
