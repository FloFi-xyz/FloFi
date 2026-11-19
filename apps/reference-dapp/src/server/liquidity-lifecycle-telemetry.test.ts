// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
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
});
