// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, withSpan } from '@defi-workflow-engine/cloud-runtime';
import { liquidityOutcomeFields, recordLiquidityOutcome, setLiquidityOutcomeSink } from './liquidity-lifecycle-telemetry';

afterEach(() => setLiquidityOutcomeSink(null));

describe('BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 liquidity lifecycle outcomes (content-free)', () => {
  it('admits only the closed schema: no address, position id, amount or hash can be logged', () => {
    const fields = liquidityOutcomeFields({ outcome: 'WITHDRAWAL_PREPARED', protocol: 'UNISWAP_V3', network: 'Base', operation: 'DECREASE', provenance: 'MOCKED' }, {});
    expect(fields).toEqual({ schema: 'flofi.liquidity-lifecycle.v1', evidence: 'OPERATIONAL_SIGNAL', deployment: 'local', outcome: 'WITHDRAWAL_PREPARED',
      protocol: 'UNISWAP_V3', network: 'Base', operation: 'DECREASE', code: null, positions: null, provenance: 'MOCKED' });
    // Anything outside the schema (a free-text code, an unknown network, a testnet, a fractional count) is dropped whole, never partially logged.
    for (const bad of [{ code: '0x' + '1'.repeat(40) }, { network: 'Solana Devnet' }, { network: 'Base Sepolia' }, { count: 1.5 }, { outcome: 'TOKEN_ID_42' }])
      expect(liquidityOutcomeFields({ outcome: 'RECONCILED', protocol: 'ORCA', network: 'Solana', provenance: 'PUBLIC_MAINNET', ...bad } as never, {})).toBeNull();
  });
  it('buckets discovered position counts so a line never states a wallet\'s exact holdings', () => {
    const at = (count: number) => liquidityOutcomeFields({ outcome: 'POSITIONS_DISCOVERED', protocol: 'ORCA', network: 'Solana', count, provenance: 'PUBLIC_MAINNET' }, {})!.positions;
    expect([0, 1, 2, 5, 6, 20, 21, 400].map(at)).toEqual(['0', '1', '2-5', '2-5', '6-20', '6-20', '21+', '21+']);
  });
  it('is off by default: nothing is logged unless the deployment switched the existing telemetry flag on', () => {
    const lines: unknown[] = [];
    recordLiquidityOutcome({ outcome: 'RECONCILED', protocol: 'ORCA', network: 'Solana', provenance: 'MOCKED' }, {});
    recordLiquidityOutcome({ outcome: 'RECONCILED', protocol: 'ORCA', network: 'Solana', provenance: 'MOCKED' }, { FLOFI_JOURNEY_TELEMETRY: 'true' });
    expect(lines).toEqual([]);
    setLiquidityOutcomeSink(fields => lines.push(fields));
    recordLiquidityOutcome({ outcome: 'RECONCILED', protocol: 'ORCA', network: 'Solana', provenance: 'MOCKED' }, {});
    expect(lines).toHaveLength(1);
  });
  it('admits only FloFi\'s own refusal codes: a token id, mint, address or amount can never be smuggled in a code (flofi-data-privacy #2)', () => {
    const code = (value: string) => liquidityOutcomeFields({ outcome: 'SIMULATION_REJECTED', protocol: 'UNISWAP_V3', network: 'Base', code: value, provenance: 'MOCKED' }, {});
    for (const ok of ['UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED', 'POSITION_SCAN_PARTIAL', 'UNISWAP_WALLET_NOT_SUBMITTED', 'ORCA_LIQUIDITY_WALLET_NOT_SUBMITTED'])
      expect(code(ok)?.code, ok).toBe(ok);
    for (const bad of ['UNISWAP_9001', 'UNISWAP_TOKEN_123456', 'UNISWAP_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0', 'ORCA_' + 'D'.repeat(30), 'UNISWAP__X', 'uniswap_x'])
      expect(code(bad), bad).toBeNull();
  });
  it('writes the line outside the trace context: no trace or span id can join it to a run\'s other log lines (flofi-data-privacy #1)', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { written.push(String(chunk)); return true; }) as never);
    try {
      await withSpan(createLogger({ service: 'test', sink: () => undefined }), 'position.begin', { run_id: 'balp-x' }, async () => {
        recordLiquidityOutcome({ outcome: 'WITHDRAWAL_PREPARED', protocol: 'UNISWAP_V3', network: 'Base', operation: 'DECREASE', provenance: 'MOCKED' },
          { FLOFI_JOURNEY_TELEMETRY: 'on' });
      });
    } finally { spy.mockRestore(); }
    const lines = written.filter(line => line.includes('liquidity.lifecycle')).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'liquidity.lifecycle', outcome: 'WITHDRAWAL_PREPARED', service: 'flofi-liquidity' });
    for (const key of ['trace_id', 'span_id', 'parent_span_id', 'run_id']) expect(lines[0], key).not.toHaveProperty(key);
  });
});
