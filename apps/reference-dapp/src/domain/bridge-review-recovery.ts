// SPDX-License-Identifier: AGPL-3.0-only
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import type { RouterRecord } from '../server/router-service';
import type { UniversalRecord } from '../server/universal-router/service';
import type { EditorState } from './editor';

/**
 * Refresh only an unsubmitted suffix of this exact run. Approval is evidence, never bridge completion or renewed authority.
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a run whose quote changed at the execution boundary (`requote`, nothing ever attempted) is re-quoted in place,
 * so its route changes stay on the same record (and the Dashboard does not gain an empty run); the new quote still needs its own Review.
 */
export function refreshBridgeAfterApproval(record: RouterRecord | UniversalRecord | null, workflow: EditorState['workflow'], retired: boolean): boolean {
  if (!record || retired || record.verdict !== 'PENDING' || !['PREPARED', 'AUTHORIZED'].includes(record.phase)) return false;
  if (hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(record.workflow))) !==
    hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)))) return false;
  if (record.requote && record.attempts.length === 0) return true;
  return record.attempts.some(a => a.step === 'APPROVAL' && a.state === 'CONFIRMED' && a.reconciled) &&
    record.attempts.every(a => a.step === 'APPROVAL' && ['CONFIRMED','CANCELLED','NOT_FOUND'].includes(a.state));
}
