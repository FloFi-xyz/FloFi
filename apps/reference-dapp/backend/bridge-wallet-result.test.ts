// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { FLOWS } from './flows';
const hash = '0x' + 'a'.repeat(64);
it.each(['crosschain-router','crosschain-router-arbitrum-to-base','crosschain-universal'] as const)('%s accepts attempt-bound wallet reports while refusing malformed or extra fields', flow => {
  const run = (flow === 'crosschain-universal' ? 'xuni-' : 'xroute-') + '1'.repeat(32), attemptId = run + '.deposit.2';
  const validate = FLOWS[flow].methods.report!.validate;
  for (const result of [{ kind:'HASH',hash },{kind:'UNKNOWN'},{kind:'REJECTED',code:'WALLET_REJECTED'}]) {
    expect(validate([run,result])).toBe(true);
    expect(validate([run,{...result,attemptId}])).toBe(true);
    for(const bad of ['',42,'../attempt','xroute-other.approval.1']) expect(validate([run,{...result,attemptId:bad}])).toBe(false);
    expect(validate([run,{...result,attemptId,extra:'not allowed'}])).toBe(false);
  }
});
