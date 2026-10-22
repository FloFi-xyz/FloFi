// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: this deployment's facts about multi-step workflow runs, from its configuration (fail closed):
 *
 *   FLOFI_WORKFLOW_RUNS=enabled    multi-step workflows may be handed to their owner and run (default: disabled; a sequence is then refused
 *                                  with WORKFLOW_RUNS_NOT_ENABLED and nothing else changes)
 *   delegation                     BUILD-AUTOMATION-002's own configuration (`FLOFI_DELEGATION`, signer): a delegated run is possible only where
 *                                  a signer provider exists, which hosted deployments cannot configure (DELEGATED_SIGNER_UNAVAILABLE)
 */
import { executionAvailability, readDelegationConfig } from '../delegation/config.ts';
import type { SequenceFacts } from '../mcp/runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
export function sequenceFacts(env: Env): SequenceFacts {
  const config = readDelegationConfig(env);
  return { enabled: env.FLOFI_WORKFLOW_RUNS === 'enabled', delegation: config.enabled ? { mode: config.mode, unavailable: executionAvailability(config) } : null };
}
