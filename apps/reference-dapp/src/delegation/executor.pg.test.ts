// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: delegated execution end to end on PostgreSQL with the MOCKED loopback chain doubles (evidence MOCKED).
 *
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 — INTENTIONAL SAFETY CHANGE (owner review): every executor submission is signed by the grant's session
 * key, the address that pays its gas. Invariant S1 (FloFi never funds user gas) retires that path, so the scenarios that used to SETTLE now
 * prove the refusal instead: the authority chain is still verified first (revocation, expiry, rebind keep their own codes), then every
 * step stops with EXECUTOR_GAS_PAYER_REFUSED before it is simulated or signed — no executor nonce is read, no byte is sent, no owner
 * funds move, and the reservation is released.
 */
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { delegationHarness } from './delegation.test-harness.ts';

describe('BUILD-AUTOMATION-002 delegated execution (PostgreSQL, MOCKED chains)', () => {
  it('a passkey-signed EVM + Solana authorization never makes FloFi pay gas: both domains stop before simulation, nothing is signed or sent', async () => {
    const t = await createTestDatabase();
    try {
      const h = await delegationHarness(t.db);
      const passkeyId = await h.registerPasskey();
      const evmGrant = await h.enrollEvm(passkeyId), solGrant = await h.enrollSolana(passkeyId);
      expect([evmGrant.state, solGrant.state]).toEqual(['ACTIVE', 'ACTIVE']);
      const { created, signed } = await h.authorize(h.multichainInput());
      expect(signed.state).toBe('ACTIVE');
      const usdcBefore = h.evm.control.balance('USDC', h.evmOwner.address), lamportsBefore = h.sol.control.lamports(h.solOwner.address);
      const seen: string[] = [];
      h.intercept.evm = method => { seen.push(method); return undefined; };
      const evaluated = await h.trigger(created.ruleId);
      expect(evaluated).toMatchObject({ kind: 'COMMITTED', occurrence: { state: 'DELEGATED' } });
      expect(await h.drain()).toBeGreaterThan(0);
      const [execution] = await h.store.executions(h.owner, { limit: 5 });
      expect(execution).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      const steps = await h.store.steps(execution!.executionId);
      expect(steps[0]).toMatchObject({ stepIndex: 0, state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED', submission: null, plan: null });
      // Nothing about signing ever started: no executor nonce, no fee data, no estimate, no send — on any chain.
      expect(seen.filter(m => ['eth_getTransactionCount', 'eth_maxPriorityFeePerGas', 'eth_gasPrice', 'eth_estimateGas', 'eth_sendRawTransaction'].includes(m))).toEqual([]);
      expect(h.evm.control.sends()).toBe(0);
      expect(h.evm.control.balance('USDC', h.evmOwner.address)).toBe(usdcBefore);
      expect(h.sol.control.lamports(h.solOwner.address)).toBe(lamportsBefore);
      expect((await h.store.budget(created.authorizationId)).every(b => b.state === 'RELEASED')).toBe(true);
      expect(h.lines.some(l => l.includes('delegation.executor_gas_refused'))).toBe(true);
    } finally { await t.drop(); }
  });
});

describe('BUILD-AUTOMATION-002 delegated execution: limits, revocation, recovery (PostgreSQL, MOCKED chains)', () => {
  const setup = async (db: Parameters<typeof delegationHarness>[0], input?: (h: Awaited<ReturnType<typeof delegationHarness>>) => unknown, solana = false) => {
    const h = await delegationHarness(db);
    const passkeyId = await h.registerPasskey();
    const evmGrant = await h.enrollEvm(passkeyId), solGrant = solana ? await h.enrollSolana(passkeyId) : null;
    const auth = await h.authorize(input ? input(h) : h.multichainInput({}, solana));
    return { h, passkeyId, evmGrant, solGrant, ...auth };
  };
  const daily = (h: Awaited<ReturnType<typeof delegationHarness>>, budget = '100') => h.multichainInput({ trigger: { kind: 'SCHEDULE', schedule: { frequency: 'DAILY', weekday: null, time: '09:00',
    timezone: 'Europe/Lisbon' } }, limits: { assets: [{ asset: h.USDC_KEY, maxPerExecution: '50', budgets: [{ period: 'WEEK', amount: budget }] }], maxExecutionsPerPeriod: null,
    cooldownMinutes: 0, maxSlippageBps: 50 } }, false);
  const last = async (h: Awaited<ReturnType<typeof delegationHarness>>) => (await h.store.executions(h.owner, { limit: 1 }))[0]!;

  it('every daily execution stops before anything is signed and spends nothing: the budget is never consumed by a refused step', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db, h => daily(h));
      for (let day = 0; day < 3; day++) { await h.trigger(created.ruleId); await h.drain(); expect(await last(h)).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' }); }
      expect(h.evm.control.sends()).toBe(0);
      expect((await h.store.budget(created.authorizationId)).filter(b => b.state === 'SPENT')).toEqual([]);
    } finally { await t.drop(); }
  });

  it('revoking the authorization pauses the rule and a queued stale occurrence never executes', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      await h.trigger(created.ruleId);
      await h.service.authorizationRevoke(h.owner, created.authorizationId);
      await h.drain();
      expect(await last(h)).toMatchObject({ state: 'BLOCKED', code: 'AUTHORIZATION_NOT_ACTIVE' });
      expect(h.evm.control.sends()).toBe(0);
      expect((await h.automations.ruleById(created.ruleId))!.state).toBe('PAUSED');
      // A later trigger cannot even evaluate; resuming the rule by hand is refused without an active authorization.
      h.advance(7 * 86_400_000);
      expect(await h.trigger(created.ruleId)).toMatchObject({ kind: 'SKIPPED' });
      expect(await h.service.resumeGuard((await h.automations.ruleById(created.ruleId))!)).toBe('DELEGATED_AUTHORIZATION_REQUIRED');
    } finally { await t.drop(); }
  });

  it('no executor transaction is ever prepared: the signing nonce is never read, the step holds no submission, the budget is released', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      await h.trigger(created.ruleId);
      let nonceRead = false;
      h.intercept.evm = (method) => { if (method === 'eth_getTransactionCount') nonceRead = true; return undefined; };
      await h.drain();
      const e = await last(h);
      expect(e).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect(nonceRead).toBe(false);
      expect(h.evm.control.sends()).toBe(0);
      expect((await h.store.steps(e.executionId))[0]).toMatchObject({ state: 'BLOCKED', submission: null });
      expect((await h.store.budget(created.authorizationId)).map(b => b.state)).toEqual(['RELEASED']);
    } finally { await t.drop(); }
  });

  it('an on-chain revocation made outside FloFi is detected before reservation (grant REVOKED)', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created, evmGrant } = await setup(t.db);
      const grant = (await h.store.grantById(evmGrant.grantId))!;
      const { delegationOf } = await import('./adapters.ts'), { erc7710 } = await import('@defi-workflow-engine/reference-compiler');
      h.evm.control.ownerSend(h.evmOwner.address, h.evmOwner.address, erc7710.disableDelegationCalldata(delegationOf(grant.grantPayload!.delegation)));
      await h.trigger(created.ruleId); await h.drain();
      expect(await last(h)).toMatchObject({ state: 'BLOCKED', code: 'CREDENTIAL_REVOKED' });
      expect((await h.store.grantById(evmGrant.grantId))!.state).toBe('REVOKED');
      expect(h.evm.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });

  it('the executor transport cannot broadcast at all, so a retried delivery can never send executor-paid bytes', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      await h.trigger(created.ruleId);
      const sendAttempts: string[] = [];
      h.intercept.evm = (method) => { if (method === 'eth_sendRawTransaction') sendAttempts.push(method); return undefined; };
      await h.drain();
      let e = await last(h);
      const { executeOccurrence } = await import('./executor.ts');
      // Retried and duplicated deliveries change nothing: still BLOCKED, still nothing sent.
      await executeOccurrence(h.deps, e.occurrenceId!, e.authorizationId);
      await executeOccurrence(h.deps, e.occurrenceId!, e.authorizationId);
      e = await last(h);
      expect(e).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect(sendAttempts).toEqual([]);
      expect(h.evm.control.sends()).toBe(0);
      await expect(h.deps.transport('eip155:84532')!.rpc('eth_sendRawTransaction', ['0x02'])).rejects.toThrow('DELEGATION_RPC_METHOD_FORBIDDEN');
      expect(h.evm.control.balance('USDC', h.evmOwner.address)).toBe(1_000_000_000n);
    } finally { await t.drop(); }
  });

  it('a price move cannot make a refused step spend anything: nothing is simulated, the owner keeps every unit, the budget is released', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      await h.trigger(created.ruleId);
      h.evm.control.setPrice(390_000_000_000_000n);
      await h.drain();
      expect(await last(h)).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect(h.evm.control.balance('USDC', h.evmOwner.address)).toBe(1_000_000_000n);
      expect((await h.store.budget(created.authorizationId)).map(b => b.state)).toEqual(['RELEASED']);
    } finally { await t.drop(); }
  });

  it('a changed workflow (rebind) invalidates eligibility until a new revision is signed', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      const rule = (await h.automations.ruleById(created.ruleId))!;
      const { bindStrategy } = await import('../automations/binding.ts');
      const bound = bindStrategy({ action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '40', slippageBps: 50 });
      if (!bound.ok) throw new Error(bound.code);
      await h.automations.rebind(h.owner, created.ruleId, rule.version, bound.binding, h.now());
      await h.trigger(created.ruleId); await h.drain();
      expect(await last(h)).toMatchObject({ state: 'BLOCKED', code: 'AUTHORIZATION_WORKFLOW_MISMATCH' });
      // Re-authorization: a new revision for the new workflow, signed once more; it narrows (40 ≤ 50) and widens nothing.
      const review = await h.service.authorizationReauthorize(h.owner, created.authorizationId);
      expect(review.revision).toBe(2);
      expect(review.widening).toEqual(['WORKFLOW_CHANGED']);
      expect((await h.automations.ruleById(created.ruleId))!.state).toBe('PAUSED');
      await h.service.authorizationSign(h.owner, created.authorizationId, 2, h.passkey.assert((await import('../passkeys/webauthn.ts')).fromB64url(review.challenge), 'http://localhost:3999', 'localhost'));
      h.advance(7 * 86_400_000);
      await h.trigger(created.ruleId); await h.drain();
      // The new revision verifies (authority first), then S1 stops the executor-paid step itself.
      expect(await last(h)).toMatchObject({ state: 'BLOCKED', revision: 2, code: 'EXECUTOR_GAS_PAYER_REFUSED' });
    } finally { await t.drop(); }
  });

  it('two workers delivering the same occurrence produce one execution and no spend', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db);
      const evaluated = await h.trigger(created.ruleId);
      const occurrenceId = (evaluated as { occurrence: { occurrenceId: string } }).occurrence.occurrenceId;
      const { executeOccurrence } = await import('./executor.ts');
      const other = { ...h.deps, store: (await import('./pg-store.ts')).createPgDelegationStore(t.open(4), h.tenantId) };
      await Promise.all([executeOccurrence(h.deps, occurrenceId, created.authorizationId), executeOccurrence(other, occurrenceId, created.authorizationId)]);
      for (let i = 0; i < 3; i++) await executeOccurrence(h.deps, occurrenceId, created.authorizationId);
      const all = await h.store.executions(h.owner, { limit: 10 });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ state: 'BLOCKED', code: 'EXECUTOR_GAS_PAYER_REFUSED' });
      expect(h.evm.control.sends()).toBe(0);
      expect(h.evm.control.balance('USDC', h.evmOwner.address)).toBe(1_000_000_000n);
    } finally { await t.drop(); }
  });

  it('an authorization that expires between the trigger and execution cannot execute', async () => {
    const t = await createTestDatabase();
    try {
      const { h, created } = await setup(t.db, h => h.multichainInput({ expiresAt: '2026-10-12T08:01:00Z' }, false));
      await h.trigger(created.ruleId);
      h.set('2026-10-12T08:02:00Z');
      await h.drain();
      expect((await last(h)).state).toBe('BLOCKED');
      expect(['AUTHORIZATION_EXPIRED', 'CREDENTIAL_EXPIRED', 'AUTHORIZATION_NOT_ACTIVE']).toContain((await last(h)).code);
      expect(h.evm.control.sends()).toBe(0);
    } finally { await t.drop(); }
  });
});

describe('BUILD-AUTOMATION-002 authority graph before authorization (PostgreSQL)', () => {
  it('a missing Solana Credential fails the workflow before authorization with the precise requirement', async () => {
    const t = await createTestDatabase();
    try {
      const h = await delegationHarness(t.db);
      const passkeyId = await h.registerPasskey();
      await h.enrollEvm(passkeyId);
      const preview = await h.service.automationPreview(h.owner, h.multichainInput());
      expect(preview).toMatchObject({ ok: false, problem: 'DELEGATED_AUTHORITY_UNAVAILABLE', manifest: null,
        requiredEnrollments: [{ stepIndex: 1, namespace: 'solana', network: 'Solana Devnet', mechanism: 'SOLANA_SPL_DELEGATE_V1', reason: 'DELEGATED_AUTHORITY_UNAVAILABLE' }] });
      expect(preview.steps[0]!.binding).not.toBeNull();
      await expect(h.service.automationCreate(h.owner, h.multichainInput())).rejects.toThrow('DELEGATED_AUTHORITY_UNAVAILABLE');
      expect(await t.db.query('SELECT count(*)::int AS n FROM delegated_authorizations')).toMatchObject({ rows: [{ n: 0 }] });
    } finally { await t.drop(); }
  });

  it('an under-scoped Credential is named per step; another owner can neither see nor use the authorization', async () => {
    const t = await createTestDatabase();
    try {
      const h = await delegationHarness(t.db);
      const passkeyId = await h.registerPasskey();
      await h.enrollEvm(passkeyId, { pairs: [{ input: 'USDC', output: 'WETH', perCallCap: '49' }] });
      const preview = await h.service.automationPreview(h.owner, h.multichainInput({}, false));
      expect(preview.requiredEnrollments).toEqual([{ stepIndex: 0, namespace: 'eip155', network: 'Base Sepolia', mechanism: 'EVM_ERC7710_METAMASK_V1_3', reason: 'CREDENTIAL_SCOPE_AMOUNT' }]);
      await h.enrollEvm(passkeyId);
      const { created } = await h.authorize(h.multichainInput({}, false));
      const other = { namespace: 'eip155' as const, address: '0x' + 'b2'.repeat(20) };
      await expect(h.service.authorizationReview(other, created.authorizationId)).rejects.toThrow('AUTHORIZATION_NOT_FOUND');
      await expect(h.service.authorizationRevoke(other, created.authorizationId)).rejects.toThrow('AUTHORIZATION_NOT_FOUND');
      await expect(h.service.credentialPrepare(other, [other], { mechanism: 'EVM_ERC7710_METAMASK_V1_3', walletAddress: h.evmOwner.address, network: 'base-sepolia',
        pairs: [{ input: 'USDC', output: 'WETH', perCallCap: '1' }], maxCalls: 2, expiresAt: '2026-12-31T00:00:00Z', passkeyId, label: 'x' })).rejects.toThrow('WALLET_SESSION_REQUIRED');
      expect((await h.service.overview(other)).authorizations).toEqual([]);
    } finally { await t.drop(); }
  });
});
