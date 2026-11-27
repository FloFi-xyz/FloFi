// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20, WS02 surfaces 9.2 item 15): what a chat hears about a run holding a Solana Batch Payment. Its
 * legs are ONE of the person's steps, named as the Batch Payment with its exact total and its recipients in their exact letter case (never lower-cased),
 * and its one SOLANA_SIGN_ALL group never gets the EVM wallet-batch "owner decides" wording (a Solana group's signature is known before it is sent and
 * its expiry is provable). Presentation only: no network, no wallet.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../../engine/strategy-engine';
import type { HandoffRecord } from '../../platform/index.ts';
import { plannedNotifications, statusReplies } from './status.ts';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
// Seed-derived wallet keys on the curve (never paid); mixed letter case on purpose.
const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', C = '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG';
const STRATEGY = { action: 'batch_payment', network: 'solana', asset: 'SOL',
  recipients: [{ recipient: A, amount: '0.01' }, { recipient: B, amount: '0.02' }, { recipient: C, amount: '0.03' }] };
const composed = composeWorkflow(STRATEGY);
if (!composed.ok) throw new Error(composed.code);
const handoff = { handoffId: 'apr_' + 's'.repeat(26), shareStatus: true, strategy: composed.strategy, workflowHash: composed.workflowHash } as unknown as HandoffRecord;
const ORIGIN = 'https://flofi.test';
type Run = Record<string, unknown> & { readonly steps: readonly Record<string, unknown>[] };
const leg = (index: number, state: string) => ({ index, action: 'transfer', state, flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null });
const group = (state: string, signed = false) => ({ index: 0, chain: SOLANA, strategy: 'SOLANA_SIGN_ALL', signing: 'WHEN_DUE', steps: [0, 2], state, awaitsDelivery: null,
  code: null, validUntil: '2026-11-09T10:10:00.000Z', feePayer: 'NATIVE', maxFee: null, gasPaid: null, submissions: [], batchId: null, signed, planned: null });
const runOf = (patch: Partial<Run> = {}): Run => ({ workflowRunId: 'wfr_' + 's'.repeat(26), approvalId: handoff.handoffId, state: 'RUNNING', mode: 'USER_FUNDED', stepCount: 3,
  currentStep: 0, code: null, workflowHash: composed.workflowHash, expiresAt: '2026-11-09T12:00:00.000Z', completedAt: null, createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z', stepsVisible: true, nextAction: 'OWNER_SIGNS_GROUP', authority: 'NONE', note: null, halted: null, resumable: false,
  steps: [leg(0, 'DELEGATED'), leg(1, 'DELEGATED'), leg(2, 'DELEGATED')], groups: [group('PREPARED')], ...patch });
const progressOf = (run: Run) => ({ status: 'APPLIED', expiresAt: '2026-11-09T10:15:00.000Z', runs: [], runsVisible: true, workflowRun: run, note: null }) as never;
const status = (run: Run, language: 'EN' | 'PT' = 'EN') => statusReplies(language, { handoff, progress: progressOf(run) })[0]!.text;
const OWNER_DECIDES_BATCH = /FloFi never recorded your wallet's answer to this Batch Payment request|nunca registrou a resposta da sua carteira a este pedido de Pagamento em lote/;
/** A recipient as the chat shows it: the address itself, or its shortened form, in its exact letter case. */
const shown = (text: string, address: string) => text.includes(address) || text.includes(`${address.slice(0, 4)}…${address.slice(-4)}`);

describe('KAN-20: a Solana Batch Payment run in a chat', () => {
  it('is ONE step: "Batch Payment of 0.06 SOL to 3 recipients", every recipient in its exact letter case (EN/PT)', () => {
    const en = status(runOf()), pt = status(runOf(), 'PT');
    expect(en).toContain(`\n1. Batch Payment of 0.06 SOL to 3 recipients (${A}, ${B}, ${C}) — `);
    expect(pt).toContain(`\n1. Pagamento em lote de 0.06 SOL para 3 destinatários (${A}, ${B}, ${C}) — `);
    for (const text of [en, pt]) {
      expect(text).not.toMatch(/^[23]\. /m);
      for (const address of [A, B, C]) {
        expect(shown(text, address), address).toBe(true);
        // Never a lower-cased (another, or no) key.
        expect(text.includes(address.toLowerCase()) || text.includes(`${address.slice(0, 4).toLowerCase()}…${address.slice(-4).toLowerCase()}`), address).toBe(false);
      }
    }
  });

  it('never gets the EVM wallet-batch "owner decides" wording, even when the server says the owner decides', () => {
    for (const run of [runOf({ nextAction: 'OWNER_DECIDES' }), runOf({ state: 'ATTENTION', nextAction: 'OWNER_DECIDES' })])
      for (const language of ['EN', 'PT'] as const) {
        expect(status(run, language)).not.toMatch(OWNER_DECIDES_BATCH);
        for (const n of plannedNotifications(language, handoff, progressOf(run), ORIGIN).due) expect(n.text).not.toMatch(OWNER_DECIDES_BATCH);
      }
  });
});
