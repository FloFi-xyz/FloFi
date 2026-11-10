// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { flightAdminFilters, flightCsv, type FlightAdminEntry } from './flight';

describe('Flight administrative filters and CSV', () => {
  it('bounds paging and validates UTC dates, groups and closed enums', () => {
    expect(flightAdminFilters({ search: ' Person@Example.Com ', group: 4, from: '2026-11-01', to: '2026-11-10', page: 2, pageSize: 100 }))
      .toMatchObject({ search: 'person@example.com', group: 4, page: 2, pageSize: 100, sort: 'desc' });
    for (const input of [null, [], { page: 0 }, { page: 1.2 }, { page: 100001 }, { pageSize: 101 }, { pageSize: -1 }, { group: '1' }, { group: 1000 },
      { from: '2026-02-30' }, { from: '2026-11-10', to: '2026-11-09' }, { status: 'SENT' }, { sort: 'desc;DROP TABLE' }, { search: '\n' }, { tenantId: 'other' }]) {
      expect(() => flightAdminFilters(input)).toThrow('ADMIN_FLIGHT_FILTER_INVALID');
    }
  });
  it('quotes CSV cells and neutralizes formulas including whitespace prefixes', () => {
    const row: FlightAdminEntry = { entryId: 'entry', email: 'ordinary@example.com', joinedAt: '2026-11-10T00:00:00.000Z', flight: 'FIRST', language: 'PT',
      group: null, boarding: 'WAITING', access: 'UNPROVEN', lastEmail: null, card: null };
    const csv = flightCsv(['=cmd@example.com', '+cmd@example.com', '-cmd@example.com', '@cmd@example.com', ' \t=cmd@example.com', 'a"b@example.com', row.email]
      .map(email => ({ ...row, email })));
    expect(csv).toContain('"\'=cmd@example.com"');
    expect(csv).toContain('"\' \t=cmd@example.com"');
    expect(csv).toContain('"a""b@example.com"');
    expect(csv).toContain('"ordinary@example.com"');
    expect(csv).toMatch(/^\uFEFF/);
    expect(csv).not.toContain(row.entryId);
  });
});
