// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Ledger, LiveVerification } from './certification-matrix';
import { mainnetProductMatrix } from './mainnet-product-matrix';
import { codeCapabilities } from './capability-catalog';
import { networkIdentity } from '../domain/network-registry';

const docs = (name: string) => new URL(`../../../../docs/builds/${name}`, import.meta.url);
const ledger = JSON.parse(readFileSync(docs('BUILD-FLOFI-UNIVERSAL-E2E-001-EXECUTION-LEDGER.json'), 'utf8')) as Ledger;
const verification = JSON.parse(readFileSync(docs('BUILD-FLOFI-UNIVERSAL-E2E-001-LIVE-VERIFICATION.json'), 'utf8')) as LiveVerification;
const MATRIX = 'BUILD-FLOFI-MAINNET-PRODUCT-001-CAPABILITY-MATRIX.json';

describe('BUILD-FLOFI-MAINNET-PRODUCT-001 public capability matrix', () => {
  const matrix = mainnetProductMatrix(ledger, verification);
  it('offers exactly the mainnet capabilities discovery reports for the public product, all real funds', () => {
    const publicIds = codeCapabilities('PUBLIC_MAINNET').map(row => row.example);
    expect(matrix.rows.filter(row => row.status !== 'NOT_IMPLEMENTED').length).toBeGreaterThanOrEqual(publicIds.length);
    for (const row of matrix.rows) {
      expect([row.id, row.funds]).toEqual([row.id, 'REAL_FUNDS']);
      // A named network is a mainnet; a row may also name a class of mainnets ("any EVM network" for the not-implemented EVM → Solana bridge).
      for (const name of [row.network, row.destinationNetwork].filter((n): n is string => n !== null)) {
        expect(networkIdentity(name)?.environment ?? 'MAINNET', row.id).toBe('MAINNET');
        expect(name, row.id).not.toMatch(/sepolia|devnet|testnet/i);
      }
    }
  });
  it('retires every test-network row as read-only history, and certifies no mainnet row from test-network evidence', () => {
    expect(matrix.retired.length).toBeGreaterThan(20);
    for (const row of matrix.retired) expect([row.availability, row.history]).toEqual(['TEST_NETWORK_NOT_AVAILABLE', 'READ_ONLY']);
    for (const row of matrix.rows.filter(row => row.status === 'LIVE_CERTIFIED')) expect(row.liveEvidence.map(id => ledger.entries.find(e => e.id === id)?.recordedClass)).toContain('MAINNET_EXECUTED');
  });
  it('matches the committed matrix (regenerate with FLOFI_WRITE_MAINNET_MATRIX=1)', () => {
    const generated = `${JSON.stringify({ format: 'flofi.mainnet-product-matrix.v1', build: 'BUILD-FLOFI-MAINNET-PRODUCT-001',
      source: 'apps/reference-dapp/src/engine/mainnet-product-matrix.ts', verifiedAt: verification.checkedAt,
      note: 'Code support and certification status only. Whether a deployment runs a row is its own enablement and policy (MCP get_capabilities).', ...matrix }, null, 2)}\n`;
    if (process.env.FLOFI_WRITE_MAINNET_MATRIX === '1') writeFileSync(docs(MATRIX), generated);
    expect(readFileSync(docs(MATRIX), 'utf8')).toBe(generated);
  });
});
