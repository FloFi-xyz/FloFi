// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (FE-BATCH-01/08): the Batch Payment card's drafts live in the workflow store beside the Canvas's other
 * drafts. While one exists the unapplied-edits gate (`authoringIncomplete`) holds Simulate, Execute and saving back; leaving Build never loses it; a
 * saved step's draft holds only while the step still declares what the draft started from (an undo, a chat edit or a deletion drops it); a new or
 * reopened workflow drops them all. Apply is the editor's own command; nothing is signed or sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { BATCH_PAYMENT_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { HookHarness } from '../test-utils/hook-harness';
import { WorkflowProvider, useWorkflow } from './workflow-store';
import type { Command } from '../domain/commands';
import type { BatchPaymentInput } from '../domain/batch-payment-authoring';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const initialContext = { registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry };
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const PAYMENTS = [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }];
let host: HookHarness, store: ReturnType<typeof useWorkflow>;
function Probe() { store = useWorkflow(); return <span>{store.state.workflow.nodes.length}</span>; }
const render = () => host.render(() => renderToStaticMarkup(<WorkflowProvider initialContext={initialContext} initialWorkflowId="workflow-batch-1"><Probe/></WorkflowProvider>));
const batchNodes = () => store.state.workflow.nodes.filter(node => node.actionType === BATCH_PAYMENT_ACTION);
const fill = (id: string, payments: readonly { recipient: string; amount: string }[]) => { store.editBatchDraft!(id, draft => ({ ...draft, payments })); render(); };
/** A saved Batch Payment step, applied from a new card. */
function savedStep(): string {
  const id = store.startBatchSetup!({ x: 10, y: 20 }); render();
  fill(id, PAYMENTS);
  expect(store.applyBatchDraft!(id)).toBeNull(); render();
  return batchNodes()[0]!.nodeId;
}
beforeEach(() => {
  host = new HookHarness();
  const storage = new Map<string, string>();
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { documentElement: { lang: '' } }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage, sessionStorage: localStorage, setTimeout, clearTimeout, setInterval, clearInterval }));
  render();
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('FE-BATCH-01: a Batch Payment draft is an unapplied Canvas edit held by the workflow store', () => {
  it('a new card is a draft that holds the gate until it is applied as ONE step (refused while invalid, nothing changes then)', () => {
    expect(store.authoringIncomplete).toBe(false);
    const id = store.startBatchSetup!({ x: 10, y: 20 }); render();
    expect(store.batchSetup).toMatchObject({ id, position: { x: 10, y: 20 }, edited: false });
    expect(store.batchDrafts![id]).toMatchObject({ network: 'Base', asset: 'USDC', payments: [{ recipient: '', amount: '' }, { recipient: '', amount: '' }] });
    expect(store.authoringIncomplete).toBe(true);
    expect(store.eligibility.eligible).toBe(false);
    // A second start keeps the one card being set up.
    expect(store.startBatchSetup!({ x: 0, y: 0 })).toBe(id);
    expect(store.applyBatchDraft!(id)).toBe('Enter a valid 0x address for every recipient (a mixed-case address must match its checksum).');
    render();
    expect(batchNodes()).toHaveLength(0);
    fill(id, PAYMENTS);
    expect(store.batchSetup?.edited).toBe(true);
    // Dragged before Apply: the card keeps where it was moved to.
    store.moveCanvasNodes({ [id]: { x: 300, y: 40 } }); render();
    expect(store.batchSetup?.position).toEqual({ x: 300, y: 40 });
    expect(store.applyBatchDraft!(id)).toBeNull(); render();
    expect(batchNodes()).toHaveLength(1);
    expect(store.canvasLayout[batchNodes()[0]!.nodeId]).toMatchObject({ x: 300, y: 40 });
    expect(store.batchSetup).toBeNull();
    expect(store.batchDrafts).toEqual({});
    expect(store.authoringIncomplete).toBe(false);
  });

  it('a saved step\'s draft holds the gate, is applied as SET on the same step, and an edit back to the saved values is no draft', () => {
    const nodeId = savedStep();
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '60' }]);
    expect(store.batchDrafts![nodeId]?.payments[1]?.amount).toBe('60');
    expect(store.authoringIncomplete).toBe(true);
    store.editBatchDraft!(nodeId, draft => ({ ...draft, payments: [draft.payments[0]!, { recipient: B, amount: '50' }] })); render();
    expect(store.batchDrafts![nodeId]).toBeUndefined();
    expect(store.authoringIncomplete).toBe(false);
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '60' }, { recipient: C, amount: '75' }]);
    expect(store.applyBatchDraft!(nodeId)).toBeNull(); render();
    expect(batchNodes()).toHaveLength(1);
    expect(batchNodes()[0]!.nodeId).toBe(nodeId);
    expect(batchNodes()[0]!.inputs.filter(input => input.kind === 'QUANTITY').map(input => (input.value as { amount: string }).amount)).toEqual(['25000000', '60000000', '75000000']);
    expect(store.batchDrafts).toEqual({});
  });

  it('a discarded draft is gone; Cancel on a new card removes the card', () => {
    const id = store.startBatchSetup!({ x: 0, y: 0 }); render();
    store.discardBatchDraft!(id); render();
    expect(store.batchSetup).toBeNull();
    expect(store.authoringIncomplete).toBe(false);
  });
});

describe('FE-BATCH-08: never a draft over a changed saved step', () => {
  it('an undo that changes the saved step drops its draft (the new values are never applied over another step)', () => {
    const nodeId = savedStep();
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '60' }, { recipient: C, amount: '75' }]);
    expect(store.applyBatchDraft!(nodeId)).toBeNull(); render();
    fill(nodeId, [{ recipient: A, amount: '1' }, { recipient: B, amount: '2' }]);
    expect(store.batchDrafts![nodeId]).toBeDefined();
    store.undo(); render();
    expect(batchNodes()[0]!.inputs.filter(input => input.kind === 'QUANTITY')).toHaveLength(2);
    expect(store.batchDrafts![nodeId]).toBeUndefined();
    expect(store.authoringIncomplete).toBe(false);
    // Nothing is left to apply for that step.
    expect(store.applyBatchDraft!(nodeId)).toBeNull();
  });

  it('a chat edit of the step, or deleting it, drops its draft', () => {
    const nodeId = savedStep();
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '60' }]);
    const chat = store.commitChatCommand({ type: 'SET_BATCH_PAYMENT', nodeId, input: { network: 'Base', asset: 'USDC', payments: [PAYMENTS[0]!, { recipient: C, amount: '5' }] } as BatchPaymentInput,
      source: 'CHAT', baseRevision: store.state.workflow.revision } as Command);
    expect(chat.ok).toBe(true); render();
    expect(store.batchDrafts![nodeId]).toBeUndefined();
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '61' }]);
    expect(store.batchDrafts![nodeId]).toBeDefined();
    store.dispatch({ type: 'REMOVE', nodeId, source: 'CANVAS', baseRevision: store.state.workflow.revision } as Command); render();
    expect(batchNodes()).toHaveLength(0);
    expect(store.batchDrafts).toEqual({});
    expect(store.authoringIncomplete).toBe(false);
  });

  it('a new workflow, or opening another one, drops every Batch Payment draft and the card being set up', () => {
    const nodeId = savedStep();
    fill(nodeId, [PAYMENTS[0]!, { recipient: B, amount: '60' }]);
    const saved = store.state.workflow;
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-0000000000b1' });
    store.createNewWorkflow(); render();
    expect(store.batchDrafts).toEqual({});
    expect(store.authoringIncomplete).toBe(false);
    store.restoreWorkflow(saved as never); render();
    expect(batchNodes()).toHaveLength(1);
    expect(store.batchDrafts).toEqual({});
    store.startBatchSetup!({ x: 0, y: 0 }); render();
    expect(store.batchSetup).not.toBeNull();
    store.restoreWorkflow(saved as never); render();
    expect(store.batchSetup).toBeNull();
    expect(store.authoringIncomplete).toBe(false);
  });
});

describe('F4 (WS02 review): one card is set up at a time', () => {
  it('while the Batch Payment card is set up, starting another card starts nothing and answers the Batch Payment card', () => {
    const id = store.startBatchSetup!({ x: 10, y: 20 }); render();
    expect(store.startActionSetup('swap', { x: 300, y: 20 })).toBe(id);
    expect(store.startStocksSetup({ x: 300, y: 20 })).toBe(id);
    render();
    expect(store.actionSetup).toBeNull();
    expect(store.batchSetup).toMatchObject({ id, position: { x: 10, y: 20 } });
    // Once it is gone, another card can be set up again.
    store.discardBatchDraft!(id); render();
    const swap = store.startActionSetup('swap', { x: 300, y: 20 }); render();
    expect(store.actionSetup?.id).toBe(swap);
  });

  it('while another card is set up, the Batch Payment card is not started and the card already set up is answered', () => {
    const swap = store.startActionSetup('swap', { x: 300, y: 20 }); render();
    expect(store.actionSetup?.id).toBe(swap);
    expect(store.startBatchSetup!({ x: 10, y: 20 })).toBe(swap);
    render();
    expect(store.batchSetup).toBeNull();
    expect(store.batchDrafts).toEqual({});
    store.removeActionSetup(); render();
    const id = store.startBatchSetup!({ x: 10, y: 20 }); render();
    expect(store.batchSetup?.id).toBe(id);
    expect(store.actionSetup).toBeNull();
  });
});
