// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { certificationMatrix, type Ledger, type LiveVerification } from './certification-matrix';
import { STRATEGY_EXAMPLES } from './strategy-examples';

const docs = (name: string) => new URL(`../../../../docs/builds/${name}`, import.meta.url);
const ledger = JSON.parse(readFileSync(docs('BUILD-FLOFI-UNIVERSAL-E2E-001-EXECUTION-LEDGER.json'), 'utf8')) as Ledger;
const verification = JSON.parse(readFileSync(docs('BUILD-FLOFI-UNIVERSAL-E2E-001-LIVE-VERIFICATION.json'), 'utf8')) as LiveVerification;
const MATRIX = 'BUILD-FLOFI-UNIVERSAL-E2E-001-CERTIFICATION-MATRIX.json';

describe('BUILD-FLOFI-UNIVERSAL-E2E-001 certification matrix', () => {
  const rows = certificationMatrix(ledger, verification);
  it('omits no implemented capability: one row per canonical example, each classified', () => {
    for (const example of STRATEGY_EXAMPLES) expect(rows.filter(row => row.id === example.id)).toHaveLength(1);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const row of rows) expect(['LIVE_CERTIFIED', 'IMPLEMENTED_UNCERTIFIED', 'BROKEN', 'NOT_IMPLEMENTED']).toContain(row.status);
  });
  it('has no implemented, handed-off path without a web runtime', () => {
    expect(rows.filter(row => row.status === 'BROKEN').map(row => row.id)).toEqual([]);
  });
  it('certifies live only from verified public executions, never a mainnet row without mainnet evidence', () => {
    const verified = new Set(verification.results.filter(result => result.status === 'VERIFIED').map(result => result.id));
    for (const row of rows.filter(row => row.status === 'LIVE_CERTIFIED')) {
      expect(row.liveEvidence.length).toBeGreaterThan(0);
      for (const id of row.liveEvidence) expect(verified.has(id)).toBe(true);
      const classes = row.liveEvidence.map(id => ledger.entries.find(entry => entry.id === id)!.recordedClass);
      if (row.funds === 'REAL_FUNDS') expect(classes).toContain('MAINNET_EXECUTED');
    }
    // Every recorded execution supports at least one row: no evidence is left unattributed.
    for (const entry of ledger.entries) expect([entry.id, rows.some(row => row.liveEvidence.includes(entry.id))]).toEqual([entry.id, true]);
  });
  it('keeps agent surfaces inside the rollout policy and the Developer API on test funds', () => {
    for (const row of rows) {
      if (row.agentRollout) expect([row.id, row.channels.mcp, row.channels.copilot, row.channels.telegram]).toEqual([row.id, false, false, false]);
      if (row.funds === 'REAL_FUNDS') expect([row.id, row.channels.developerApi]).toEqual([row.id, false]);
    }
  });
  it('matches the committed matrix (regenerate with FLOFI_WRITE_CERTIFICATION_MATRIX=1)', () => {
    const generated = `${JSON.stringify({ format: 'flofi.certification-matrix.v1', build: 'BUILD-FLOFI-UNIVERSAL-E2E-001',
      source: 'apps/reference-dapp/src/engine/certification-matrix.ts', verifiedAt: verification.checkedAt, rows }, null, 2)}\n`;
    if (process.env.FLOFI_WRITE_CERTIFICATION_MATRIX === '1') writeFileSync(docs(MATRIX), generated);
    expect(readFileSync(docs(MATRIX), 'utf8')).toBe(generated);
  });
});
