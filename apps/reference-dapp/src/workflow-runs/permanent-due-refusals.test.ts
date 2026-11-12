// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round 4 F5: a DUE group refused for an asset no batch may ever move (a Stock Token, a token outside the network's catalog, another scale of
 * decimals) is a PERMANENT refusal: the group is blocked and the run halted at once, and Resume runs its steps through their own owner-signed
 * flows — instead of the run staying RUNNING until its expiry while every preparation is refused again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PERMANENT_DUE_REFUSALS } from './service.ts';

describe('round 4 F5: an asset no batch may move is a permanent due-time refusal', () => {
  it('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED and USER_FUNDED_SWAP_ASSET_UNSUPPORTED halt and resume step by step', () => {
    for (const code of ['USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED', 'USER_FUNDED_SWAP_ASSET_UNSUPPORTED']) {
      expect(PERMANENT_DUE_REFUSALS.has(code), code).toBe(true);
      // The batch builder still raises exactly this closed code (a renamed code would silently stop being permanent).
      expect(readFileSync(new URL('../user-funded/evm-calls.ts', import.meta.url), 'utf8')).toContain(`'${code}'`);
    }
    // A transient refusal is never permanent: it is retried while the run is open.
    for (const code of ['USER_FUNDED_RPC_UNAVAILABLE', 'USER_FUNDED_PREPARED_STILL_VALID', 'WORKFLOW_RUN_EXPIRED']) expect(PERMANENT_DUE_REFUSALS.has(code), code).toBe(false);
  });
});
