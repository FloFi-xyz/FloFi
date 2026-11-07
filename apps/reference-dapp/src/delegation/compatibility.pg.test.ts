// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002 compatibility with what FloFi already reconciles:
 *
 * the delegated executor's redemptions are exactly the canonical shape the existing public-flow verifier (`verifyOwnerSubmission`, shared by
 * the Base Sepolia swap, Uniswap liquidity and Router flows) accepts as a DELEGATED_SINGLE submission of the owner (the real-chain codec
 * vector is `erc7710-vector.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { erc7710 } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { verifyOwnerSubmission } from '../server/public-testnet-service.ts';
import { delegationHarness } from './delegation.test-harness.ts';

const D = erc7710;
describe('BUILD-AUTOMATION-002 executor redemptions are what FloFi\'s public flows already reconcile (PostgreSQL, MOCKED chain)', () => {
  // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (intentional safety change): the executor no longer produces a redemption — its session key would pay
  // the gas (S1). What remains to reconcile from it is nothing: no submission, no transaction. verifyOwnerSubmission's DELEGATED_SINGLE branch
  // for relayed public-flow submissions is unchanged and covered by its own suites.
  it('an executor redemption never exists any more: the step holds no submission and the chain saw no executor transaction', async () => {
    const t = await createTestDatabase();
    try {
      const h = await delegationHarness(t.db);
      const passkeyId = await h.registerPasskey();
      await h.enrollEvm(passkeyId);
      const { created } = await h.authorize(h.multichainInput({}, false));
      await h.trigger(created.ruleId); await h.drain();
      const [execution] = await h.store.executions(h.owner, { limit: 1 });
      expect(execution).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      const [step] = await h.store.steps(execution!.executionId);
      expect(step).toMatchObject({ state: 'BLOCKED', submission: null });
      expect(h.evm.control.sends()).toBe(0);
      expect(typeof verifyOwnerSubmission).toBe('function');
      expect(D.DELEGATION_FRAMEWORK_V1_3.delegationManager).toMatch(/^0x[0-9a-f]{40}$/);
    } finally { await t.drop(); }
  });
});
