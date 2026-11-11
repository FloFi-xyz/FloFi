// SPDX-License-Identifier: AGPL-3.0-only
// Test process preload only. Never imported by application code. No production clock override exists.
import { readFileSync } from 'node:fs';
if (process.env.FLOFI_FLIGHT_TEAM_E2E !== 'MOCKED_LOOPBACK_ONLY' || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID || process.env.FLOFI_DEPLOYMENT === 'hosted'
  || !/^\/tmp\/flofi-flight-team-[a-zA-Z0-9-]+\/clock$/.test(process.env.FLOFI_FLIGHT_TEAM_CLOCK ?? '')) throw Error('TEAM_CLOCK_REQUIRES_ISOLATED_LOOPBACK_TEST');
const RealDate = Date;
const instant = () => {
  const value = Number(readFileSync(process.env.FLOFI_FLIGHT_TEAM_CLOCK, 'utf8'));
  if (!Number.isSafeInteger(value) || value <= 0) throw Error('INVALID_TEST_SERVER_TIME');
  return value;
};
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(instant()); }
  static now() { return instant(); }
  // Next wraps Date and copies its own properties; preserve the standard static API explicitly.
  static parse(value) { return RealDate.parse(value); }
  static UTC(...args) { return RealDate.UTC(...args); }
};
