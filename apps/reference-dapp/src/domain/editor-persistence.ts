// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (execution continuity, production 2026-11-12): the Editor's workflow (the Canvas) and its identity survive a reload, a full-page
 * navigation (to /approve and back) and the end of a run. Before this, every page load minted a new workflow id on the server and the Canvas
 * started empty, so a finished Swap → Bridge left "0 steps" in the Editor and the sequence's step pointers (keyed by workflow id) were lost.
 *
 * Only this browser keeps it (localStorage, every access wrapped): the canonical workflow the owner authored, never a Review, a quote, an
 * authorization or an execution record. A restored Canvas is an authored draft like any other: simulation, Review, the owner's wallet signature
 * and every runtime's own gates still apply, and completed steps count again only once their runtimes' durable records prove them
 * (`sequence-restore.ts`). Only the owner's explicit "Create new workflow" replaces it (with a fresh, empty workflow of a new identity).
 */
import { validateSavedWorkflow } from './saved-workflow';
import type { Workflow } from './initial-workflow';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

export const EDITOR_WORKFLOW_STORAGE_KEY = 'flofi:editor-workflow:v1';
const FORMAT = 'flofi.editor-workflow.v1';
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type ReadStorage = Pick<Storage, 'getItem'> | null;
type WriteStorage = Pick<Storage, 'setItem'> | null;

/** What this browser remembers of the Editor: its workflow identity, and its workflow once it has an action (null: the empty draft). */
export type PersistedEditor = { readonly workflowId: string; readonly workflow: SemanticWorkflow | null };

/** The browser's storage, or null where it is blocked (private modes, sandboxed frames). */
export function editorStorage(): (Pick<Storage, 'getItem' | 'setItem'>) | null {
  try { return window.localStorage; } catch { return null; }
}
/** Only the product Editor (/app and its sections) keeps its Canvas; /approve, embedded signing and the engineering page never read or write it. */
export function editorPersistencePath(pathname: string | null | undefined): boolean {
  return pathname === '/app' || Boolean(pathname?.startsWith('/app/'));
}
/**
 * The persisted Editor, validated as a saved workflow (the same schema, size and network checks as a reopened saved workflow); null when
 * nothing usable is stored. A stored workflow whose identity disagrees with its record is refused rather than guessed.
 */
export function readPersistedEditor(storage: ReadStorage): PersistedEditor | null {
  if (!storage) return null;
  let value: unknown;
  try { value = JSON.parse(storage.getItem(EDITOR_WORKFLOW_STORAGE_KEY) ?? 'null'); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { format?: unknown; workflowId?: unknown; workflow?: unknown };
  if (record.format !== FORMAT || typeof record.workflowId !== 'string' || !WORKFLOW_ID.test(record.workflowId)) return null;
  // The empty draft is remembered as "nothing to restore": its identity is the visit's own (a run recovered from this browser may still be
  // brought back onto that untouched Canvas, exactly as before).
  if (record.workflow === null || record.workflow === undefined) return { workflowId: record.workflowId, workflow: null };
  try {
    const workflow = validateSavedWorkflow(record.workflow);
    return workflow.workflowId === record.workflowId ? { workflowId: record.workflowId, workflow } : null;
  } catch { return null; }
}
/** Remembers the Editor's current workflow (its identity alone while it has no action). Storage is optional: a failure changes nothing. */
export function persistEditor(storage: WriteStorage, workflow: Workflow): void {
  if (!storage || !WORKFLOW_ID.test(workflow.workflowId)) return;
  const actionable = workflow.nodes.some(node => !node.actionType.startsWith('mock-'));
  try { storage.setItem(EDITOR_WORKFLOW_STORAGE_KEY, JSON.stringify({ format: FORMAT, workflowId: workflow.workflowId, workflow: actionable ? workflow : null })); }
  catch { /* storage is optional (quota, private mode); the Canvas stays as it is this visit */ }
}
