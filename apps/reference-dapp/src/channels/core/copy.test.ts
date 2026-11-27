// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (chat review C6): a run step a channel reports by its semantic action names a Batch Payment in the
 * person's language ("Batch Payment" / "Pagamento em lote"), never the raw action id. The other actions keep their names.
 */
import { describe, expect, it } from 'vitest';
import { channelCopy } from './copy.ts';

const run = (action: string) => ({ state: 'RUNNING', steps: [{ index: 0, action, state: 'READY', transaction: null }] });

describe('chat review C6: channel run copy names the Batch Payment action', () => {
  it('names a batch_payment step in English and Portuguese', () => {
    expect(channelCopy('EN').workflowRun(run('batch_payment'))).toBe('Workflow: running\n1. Batch Payment — ready for your signature');
    expect(channelCopy('PT').workflowRun(run('batch_payment'))).toBe('Fluxo: em execução\n1. Pagamento em lote — pronta para sua assinatura');
  });
  it('keeps the other action names and shows an unknown action as written', () => {
    expect(channelCopy('EN').workflowRun(run('transfer'))).toBe('Workflow: running\n1. Transfer — ready for your signature');
    expect(channelCopy('PT').workflowRun(run('transfer'))).toBe('Fluxo: em execução\n1. Transferência — pronta para sua assinatura');
    expect(channelCopy('EN').workflowRun(run('something_new'))).toBe('Workflow: running\n1. something_new — ready for your signature');
  });
});
