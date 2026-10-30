// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { copilotMetricsEnabled, recordCopilotMetrics } from './copilot-metrics-store';

describe('copilot metrics delivery policy', () => {
  it('honors the telemetry switch and never silently mixes replay with live', () => {
    expect(copilotMetricsEnabled({}, 'live')).toBe(true);
    expect(copilotMetricsEnabled({}, 'replay')).toBe(false);
    expect(copilotMetricsEnabled({ FLOFI_COPILOT_TELEMETRY: 'off' }, 'live')).toBe(false);
    expect(copilotMetricsEnabled({ FLOFI_COPILOT_TELEMETRY: 'log' }, 'replay')).toBe(true);
  });
  it('waits for delivery and records only a closed failure signal on an outage', async () => {
    const lines: string[] = [];
    let delivered = false;
    await recordCopilotMetrics(async () => { await Promise.resolve(); delivered = true; }, line => lines.push(line));
    expect(delivered).toBe(true);
    expect(lines).toEqual([]);
    await recordCopilotMetrics(async () => { throw new Error('postgres://private:secret@private.invalid prompt=private'); }, line => lines.push(line));
    expect(lines.map(line => JSON.parse(line))).toEqual([{ event: 'flofi.copilot.metrics', outcome: 'FAILED', code: 'COPILOT_METRICS_UNAVAILABLE' }]);
    expect(lines.join()).not.toMatch(/private|secret/);
  });
});
