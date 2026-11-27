// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (FE-BATCH-02/03): how many workflow-run steps each Canvas card is, and what a run record proves about
 * a workflow of ONE card, for the Editor in the browser and for the server alike. Client-safe: it reads the Canvas workflow with the Canvas's own domain
 * readers only (no strategy engine, platform, automations, server or Node module), so `components/app-shell.tsx` uses it without pulling server code
 * into the browser bundle (`components/app-shell-client-safety.test.tsx` walks its imports).
 *
 *   legs     a Batch Payment card is its payments: one run step per recipient, in order (exactly the legs `composeWorkflow` expands it into, its
 *            `batches` range); every other card is one step. A Batch Payment card whose payments cannot be read is 0 steps: no run is ever mapped
 *            onto it (fail closed, `runCanvasExecution` colors nothing)
 *   order    the cards in the order the workflow run executes them: `sequenceOrder`, the order `editor/workflow-strategy.ts` builds the run from
 *   verdict  a run of exactly the card's steps: RECONCILED only once it COMPLETED and every step reconciled, else the run's own state; a run of
 *            another step count proves nothing about the card (null)
 *
 * The server proves more with the same reading (`singleCardRunRecord`: the run's canonical hash is exactly this card's). Pure: it reads records and
 * never signs, submits, retries or reconciles anything.
 */
import { isBatchPaymentNode } from '@defi-workflow-engine/workflow-contracts';
import { batchPaymentDetails } from './batch-payment-authoring';
import type { Workflow } from './initial-workflow';
import { sequenceOrder } from './workflow-sequence';

type CardNode = Workflow['nodes'][number];
/** A card in run order with the run steps it is. */
export type CanvasRunCard = { readonly nodeId: string; readonly legs: number };
/** The part of a workflow-run record (`RunView`) a verdict reads. */
export type RunRecordSteps = { readonly state: string; readonly stepCount: number; readonly steps: readonly { readonly state: string }[] };

/** How many workflow-run steps a Canvas card is (see the module comment). */
export function cardRunLegs(node: CardNode): number {
  if (!isBatchPaymentNode(node)) return 1;
  return batchPaymentDetails(node as unknown as Parameters<typeof batchPaymentDetails>[0])?.fields.payments.length ?? 0;
}

/** The Canvas cards in the order their workflow run executes them, each with the run steps it is; nothing for a value that is not a workflow. */
export function canvasRunOrder(workflow: Pick<Workflow, 'nodes'> | null | undefined): readonly CanvasRunCard[] {
  if (!workflow || !Array.isArray(workflow.nodes)) return [];
  return sequenceOrder(workflow as Workflow).map(node => ({ nodeId: node.nodeId, legs: cardRunLegs(node) }));
}

/** A run of exactly `stepCount` steps: RECONCILED once it completed with every step reconciled, else its own state; null for any other step count. */
export function runRecordVerdict(run: RunRecordSteps, stepCount: number): string | null {
  if (!Number.isSafeInteger(stepCount) || stepCount < 1 || run.stepCount !== stepCount || run.steps.length !== stepCount) return null;
  return run.state === 'COMPLETED' && run.steps.every(step => step.state === 'RECONCILED') ? 'RECONCILED' : run.state;
}

/** What a run record proves about a workflow of exactly ONE financial card (its steps are that card's legs), or null. The hash is the server's to prove. */
export function loneCardRunVerdict(run: RunRecordSteps, workflow: Pick<Workflow, 'nodes'>): string | null {
  const cards = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  return cards.length === 1 ? runRecordVerdict(run, cardRunLegs(cards[0]!)) : null;
}
