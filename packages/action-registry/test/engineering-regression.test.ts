// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import {
  executionCapabilityRegistry, resolveNodeCapability, resolveWorkflowCapability,
  type CapabilityRuntime, type ExecutionCapabilityProfile,
} from '../src/execution-capabilities.js';

/**
 * Registry-wide engineering contracts. These query capability declarations only:
 * no provider, wallet, signature or transaction is used, and readiness is never
 * evidence of chain execution. New registered paths inherit these checks.
 */
type Node = SemanticWorkflow['nodes'][number];
const label = (profile: ExecutionCapabilityProfile) =>
  `${profile.environment}/${profile.chainId}/${profile.actionType}/${profile.adapterId}`;
const publicProfiles = executionCapabilityRegistry.filter(profile =>
  profile.capabilities.EXECUTE && ['MAINNET', 'PUBLIC_TESTNET'].includes(profile.environment));
const forkProfiles = executionCapabilityRegistry.filter(profile =>
  profile.capabilities.EXECUTE && profile.environment === 'LOCAL_FORK');

// The resolver consumes identity and authorization fields. Action-specific amount,
// asset and protocol validation remains with the existing compiler/service tests.
function nodeFor(profile: ExecutionCapabilityProfile): Node {
  return {
    nodeId: 'engineering-action', actionType: profile.actionType, actionSchemaVersion: '1.0.0', chainId: profile.chainId,
    requiredCapabilities: [], inputs: [], expectedOutputs: [], dependencies: [], userConstraints: [],
    adapterConstraints: { adapters: [{ id: profile.adapterId, version: profile.adapterVersion }], protocols: [] },
    failurePolicy: 'ABORT', requiredAuthorizationClass: 'MODE_A', lockedParameters: [], editableBounds: [],
  };
}
function readyRuntime(profile: ExecutionCapabilityProfile): CapabilityRuntime {
  return {
    forkAvailable: true, forkEvidence: 'FORK_REPRODUCED', quoteProviderAvailable: true,
    walletConnected: true, walletChainId: profile.environment === 'LOCAL_FORK' ? 'eip155:31337' : profile.chainId,
    artifacts: 'CURRENT', simulationReady: true, authorizationReady: true,
  };
}
function resolve(profile: ExecutionCapabilityProfile, runtime = readyRuntime(profile), node = nodeFor(profile)) {
  return resolveWorkflowCapability({ nodes: [node] }, { environment: profile.environment, runtime });
}

describe('engineering regression: authorization across every registered public execution path', () => {
  it('has nonempty public and fork coverage and unambiguous exact registry identities', () => {
    expect(publicProfiles.length).toBeGreaterThan(0);
    expect(forkProfiles.length).toBeGreaterThan(0);
    const identities = executionCapabilityRegistry.map(profile => `${label(profile)}/${profile.adapterVersion}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it.each(publicProfiles.map(profile => ({ label: label(profile), profile })))('$label retains wallet and reviewed-authority boundaries', ({ profile }) => {
    expect(profile.requirements).toEqual(expect.arrayContaining(['INJECTED_WALLET', 'REVIEWED_ARTIFACTS']));
    expect(profile.authorizationModes).toEqual(['A']);
    expect(profile.capabilities.SIMULATE).toBe(true);
    expect(profile.capabilities.AUTHORIZE).toBe(true);

    const ready = resolve(profile);
    expect(ready.nodes[0]?.profile).toBe(profile);
    expect(ready.executionSupported).toBe(true);
    expect(ready.executionReady).toBe(true);

    const refusals: readonly [Partial<CapabilityRuntime>, string][] = [
      [{ walletConnected: false }, 'WALLET_NOT_CONNECTED'],
      [{ walletChainId: 'eip155:999999999' }, 'WRONG_WALLET_CHAIN'],
      [{ artifacts: 'MISSING' }, 'ARTIFACTS_MISSING'],
      [{ artifacts: 'STALE' }, 'ARTIFACTS_STALE'],
      [{ simulationReady: false }, 'SIMULATION_REQUIRED'],
      [{ authorizationReady: false }, 'AUTHORIZATION_REQUIRED'],
    ];
    for (const [override, code] of refusals) {
      const refused = resolve(profile, { ...readyRuntime(profile), ...override });
      expect(refused.executionSupported, code).toBe(true);
      expect(refused.executionReady, code).toBe(false);
      expect(refused.blockers).toContainEqual({ nodeId: 'engineering-action', dimension: 'EXECUTE', code });
    }

    const modeB = resolve(profile, readyRuntime(profile), { ...nodeFor(profile), requiredAuthorizationClass: 'MODE_B' });
    expect(modeB.executionSupported).toBe(false);
    expect(modeB.executionReady).toBe(false);
    expect(modeB.blockers).toContainEqual({ nodeId: 'engineering-action', dimension: 'AUTHORIZE', code: 'AUTHORIZATION_MODE_UNSUPPORTED' });
  });

  it.each(publicProfiles.map(profile => ({ label: label(profile), profile })))('$label refuses unsupported identities despite an otherwise ready runtime', ({ profile }) => {
    const node = nodeFor(profile);
    const substitutions: readonly [Node, string][] = [
      [{ ...node, actionType: 'asset.unsupported-engineering-action' }, 'UNKNOWN_ACTION'],
      [{ ...node, chainId: 'eip155:999999999' }, 'CHAIN_NOT_SUPPORTED'],
      [{ ...node, adapterConstraints: { adapters: [{ id: 'engineering.unsupported-adapter', version: '1.0.0' }], protocols: [] } }, 'ADAPTER_NOT_AVAILABLE'],
      [{ ...node, adapterConstraints: { adapters: [{ id: profile.adapterId, version: '999.0.0' }], protocols: [] } }, 'ADAPTER_VERSION_UNSUPPORTED'],
    ];
    for (const [changed, code] of substitutions) {
      const refused = resolve(profile, readyRuntime(profile), changed);
      expect(refused.executionSupported, code).toBe(false);
      expect(refused.executionReady, code).toBe(false);
      expect(refused.evidenceCeiling, code).toBeNull();
      expect(refused.blockers).toContainEqual({ nodeId: node.nodeId, dimension: 'EXECUTE', code });
    }
  });
});

describe('engineering regression: evidence cannot be inferred from readiness', () => {
  it.each(publicProfiles.map(profile => ({ label: label(profile), profile })))('$label preserves the declared evidence ceiling when readiness changes', ({ profile }) => {
    // MAINNET in a profile names an execution environment, not demonstrated
    // execution. Undemonstrated rows must keep a null ceiling even when ready.
    expect(resolve(profile).evidenceCeiling).toBe(profile.evidenceMaturity);
    expect(resolve(profile, { ...readyRuntime(profile), authorizationReady: false }).evidenceCeiling).toBe(profile.evidenceMaturity);
    if (profile.evidenceMaturity === null) expect(resolve(profile).evidenceCeiling).toBeNull();
    if (profile.environment === 'PUBLIC_TESTNET') expect(resolve(profile).evidenceCeiling).not.toBe('MAINNET_EXECUTED');
  });

  it.each(forkProfiles.map(profile => ({ label: label(profile), profile })))('$label downgrades local replay and never promotes it to public evidence', ({ profile }) => {
    const request = { environment: 'LOCAL_FORK', runtime: { ...readyRuntime(profile), forkEvidence: 'MOCKED' as const } };
    const mocked = resolveWorkflowCapability({ nodes: [nodeFor(profile)] }, request);
    const replayCeiling = profile.evidenceMaturity === null ? null : 'MOCKED';
    expect(mocked.executionReady).toBe(true);
    expect(mocked.evidenceCeiling).toBe(replayCeiling);
    expect(resolveNodeCapability(nodeFor(profile), request).evidenceCeiling).toBe(replayCeiling);
    expect(['MOCKED', 'FORK_REPRODUCED', null]).toContain(resolve(profile).evidenceCeiling);
    expect(resolveWorkflowCapability({ nodes: [nodeFor(profile)] }, {
      ...request, runtime: { ...request.runtime, authorizationReady: false },
    })).toMatchObject({ executionReady: false, evidenceCeiling: replayCeiling });
  });
});
