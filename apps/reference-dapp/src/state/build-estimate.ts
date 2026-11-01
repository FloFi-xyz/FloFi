// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { estimateMatchesNode, requestBuildEstimate, type BuildEstimate, type BuildEstimateResult } from '../domain/build-estimate';
import { bridgeEstimateRequest } from '../domain/bridge-estimate';
import { createJourney, reportJourney } from '../domain/journey-metrics';
import type { DiscoveryResult } from '../server/universal-router/discovery';

/**
 * UX-007: the card's live quote. `calculating` from the first edit of a quotable snapshot until its own answer; `unavailable` when the
 * provider has no route or answer for exactly that snapshot. Display only: it never simulates, creates Review, authorizes or executes.
 */
export type LiveQuote = { readonly status: 'idle' } | { readonly status: 'calculating' } | { readonly status: 'ready'; readonly estimate: BuildEstimate }
  | { readonly status: 'unavailable'; readonly code?: string; readonly correlationId?: string; readonly discovery?: DiscoveryResult };
// Answers already received, per exact snapshot (workflow hash, node, owner), reused only until the estimate's own expiry so that returning
// to an amount shows it at once. Never a Review input; a different amount, node, owner, chain or provider is a different key.
const answered = new Map<string, BuildEstimate>();
const ANSWERED_LIMIT = 32;
function remember(scope: string, estimate: BuildEstimate) {
  answered.delete(scope); answered.set(scope, estimate);
  while (answered.size > ANSWERED_LIMIT) answered.delete(answered.keys().next().value!);
}
function recalled(scope: string): BuildEstimate | null {
  const estimate = answered.get(scope);
  if (estimate && Date.parse(estimate.expiresAt) > Date.now()) return estimate;
  answered.delete(scope); return null;
}
/** Test seam: forget every answered snapshot. */
export function clearLiveQuoteCache(): void { answered.clear(); }

export function useLiveQuote(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null, destinationWallet?: string | null): LiveQuote {
  const serialized = workflow ? JSON.stringify(workflow) : null;
  // Catalog/layout renders may recreate the preview object. Only changed snapshot contents invalidate its request.
  const snapshot = useMemo(() => serialized ? JSON.parse(serialized) as SemanticWorkflow : undefined, [serialized]);
  const key = serialized ? hashArtifactBytes('semantic-workflow', new TextEncoder().encode(serialized)) : null;
  const scope = JSON.stringify([key, nodeId, owner ?? null, destinationWallet ?? null]);
  const node = snapshot?.nodes.find(node => node.nodeId === nodeId);
  const chain = node?.chainId;
  const bridge = node?.actionType === 'asset.bridge' ? bridgeEstimateRequest(node) : null;
  const provider = node?.adapterConstraints.protocols.some(protocol => protocol === 'uniswap' || protocol === 'uniswap-v3') ? 'Uniswap V3'
    : node?.adapterConstraints.protocols.includes('jupiter') ? 'Jupiter'
      : node?.adapterConstraints.protocols.includes('orca-whirlpools') ? 'Orca Whirlpools' : bridge ? 'Bridge' : null;
  const [result, setResult] = useState<{ key: string; estimate: BuildEstimate | null; failed: boolean; failure?: Extract<BuildEstimateResult, { ok: false }> } | null>(null);
  // Latest request wins: every snapshot takes a new generation; an older answer (even one the transport could not abort) is discarded.
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const quotable = Boolean(workflow && key && chain && provider);
  useEffect(() => {
    if (!snapshot || !key || !chain || !provider) return;
    const ticket = ++generation.current;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const accept = (estimate: BuildEstimate | null, failed: boolean, failure?: Extract<BuildEstimateResult, { ok: false }>) => {
      if (ticket !== generation.current) return;
      setResult({ key: scope, estimate, failed, ...failure ? { failure } : {} });
      if (estimate) expire = setTimeout(() => { if (ticket === generation.current) { answered.delete(scope); setResult(null); setRefresh(v => v + 1); } },
        Math.max(0, Date.parse(estimate.expiresAt) - Date.now()));
    };
    const known = recalled(scope);
    if (known) { accept(known, false); return () => { clearTimeout(expire); }; }
    const correlationId = crypto.randomUUID();
    // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: intent → first quote, content-free (the chain and provider label only), reported once per answered snapshot.
    const journey = createJourney({ operation: bridge ? 'bridge' : 'swap', network: chain, provider, id: correlationId });
    journey.mark('intent');
    const cancel = requestBuildEstimate(async signal => {
      const response = await fetch('/api/build-estimate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-quote-correlation-id': correlationId },
        body: JSON.stringify({ workflow: snapshot, nodeId, owner, ...destinationWallet ? { destinationWallet } : {} }), signal });
      const result = await response.json() as BuildEstimateResult;
      if (!result || typeof result !== 'object' || result.ok !== true && result.ok !== false || result.ok && (!result.estimate || typeof result.estimate !== 'object'))
        return { ok: false, code: 'ESTIMATE_RESPONSE_INVALID', correlationId };
      return response.ok === false && result.ok ? { ok: false, code: 'ESTIMATE_RESPONSE_INVALID', correlationId } : result;
    }, response => {
      const estimate = response.ok && response.estimate.workflowHash === key && response.estimate.nodeId === nodeId && response.estimate.chain === chain &&
        (provider === 'Bridge' || response.estimate.provider === provider) && estimateMatchesNode(response.estimate, snapshot, nodeId) && Date.parse(response.estimate.expiresAt) > Date.now() ? response.estimate : null;
      if (estimate) remember(scope, estimate);
      if (estimate && ticket === generation.current) { journey.mark('first_quote'); reportJourney(journey.event('in_progress')); }
      accept(estimate, !estimate, response.ok ? { ok: false, code: 'ESTIMATE_RESPONSE_MISMATCH' } : response);
    });
    return () => { cancel(); clearTimeout(expire); };
  }, [key, scope, snapshot, nodeId, owner, destinationWallet, chain, provider, refresh]);
  if (!quotable) return { status: 'idle' };
  if (result?.key !== scope) return { status: 'calculating' };
  return result.estimate ? { status: 'ready', estimate: result.estimate } : result.failed ? { status: 'unavailable', ...result.failure ? { code: result.failure.code, ...result.failure.correlationId ? { correlationId: result.failure.correlationId } : {},
    ...result.failure.discovery ? { discovery: result.failure.discovery } : {} } : {} } : { status: 'idle' };
}

/** The current estimate, or null (calculating, unavailable, expired or not quotable). */
export function useBuildEstimate(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null) {
  const quote = useLiveQuote(workflow, nodeId, owner);
  return quote.status === 'ready' ? quote.estimate : null;
}
