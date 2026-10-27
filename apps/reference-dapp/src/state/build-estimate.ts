// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { requestBuildEstimate, type BuildEstimate, type BuildEstimateResult } from '../domain/build-estimate';

/**
 * UX-007: the card's live quote. `calculating` from the first edit of a quotable snapshot until its own answer; `unavailable` when the
 * provider has no route or answer for exactly that snapshot. Display only: it never simulates, creates Review, authorizes or executes.
 */
export type LiveQuote = { readonly status: 'idle' } | { readonly status: 'calculating' } | { readonly status: 'ready'; readonly estimate: BuildEstimate }
  | { readonly status: 'unavailable'; readonly code?: string; readonly correlationId?: string };
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

export function useLiveQuote(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null): LiveQuote {
  const serialized = workflow ? JSON.stringify(workflow) : null;
  // Catalog/layout renders may recreate the preview object. Only changed snapshot contents invalidate its request.
  const snapshot = useMemo(() => serialized ? JSON.parse(serialized) as SemanticWorkflow : undefined, [serialized]);
  const key = serialized ? hashArtifactBytes('semantic-workflow', new TextEncoder().encode(serialized)) : null;
  const scope = JSON.stringify([key, nodeId, owner ?? null]);
  const node = snapshot?.nodes.find(node => node.nodeId === nodeId);
  const chain = node?.chainId;
  const provider = node?.adapterConstraints.protocols.some(protocol => protocol === 'uniswap' || protocol === 'uniswap-v3') ? 'Uniswap V3'
    : node?.adapterConstraints.protocols.includes('jupiter') ? 'Jupiter'
      : node?.adapterConstraints.protocols.includes('orca-whirlpools') ? 'Orca Whirlpools' : null;
  const [result, setResult] = useState<{ key: string; estimate: BuildEstimate | null; failed: boolean; failure?: Extract<BuildEstimateResult, { ok: false }> } | null>(null);
  // Latest request wins: every snapshot takes a new generation; an older answer (even one the transport could not abort) is discarded.
  const generation = useRef(0);
  const quotable = Boolean(workflow && key && chain && provider);
  useEffect(() => {
    if (!snapshot || !key || !chain || !provider) return;
    const ticket = ++generation.current;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const accept = (estimate: BuildEstimate | null, failed: boolean, failure?: Extract<BuildEstimateResult, { ok: false }>) => {
      if (ticket !== generation.current) return;
      setResult({ key: scope, estimate, failed, ...failure ? { failure } : {} });
      if (estimate) expire = setTimeout(() => { if (ticket === generation.current) setResult({ key: scope, estimate: null, failed: false }); },
        Math.max(0, Date.parse(estimate.expiresAt) - Date.now()));
    };
    const known = recalled(scope);
    if (known) { accept(known, false); return () => { clearTimeout(expire); }; }
    const cancel = requestBuildEstimate(async signal => {
      const response = await fetch('/api/build-estimate', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: snapshot, nodeId, owner }), signal });
      return await response.json() as BuildEstimateResult;
    }, response => {
      const estimate = response.ok && response.estimate.workflowHash === key && response.estimate.nodeId === nodeId && response.estimate.chain === chain && response.estimate.provider === provider && Date.parse(response.estimate.expiresAt) > Date.now() ? response.estimate : null;
      if (estimate) remember(scope, estimate);
      accept(estimate, !estimate, response.ok ? { ok: false, code: 'ESTIMATE_RESPONSE_MISMATCH' } : response);
    });
    return () => { cancel(); clearTimeout(expire); };
  }, [key, scope, snapshot, nodeId, owner, chain, provider]);
  if (!quotable) return { status: 'idle' };
  if (result?.key !== scope) return { status: 'calculating' };
  return result.estimate ? { status: 'ready', estimate: result.estimate } : result.failed ? { status: 'unavailable', ...result.failure ? { code: result.failure.code, ...result.failure.correlationId ? { correlationId: result.failure.correlationId } : {} } : {} } : { status: 'idle' };
}

/** The current estimate, or null (calculating, unavailable, expired or not quotable). */
export function useBuildEstimate(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null) {
  const quote = useLiveQuote(workflow, nodeId, owner);
  return quote.status === 'ready' ? quote.estimate : null;
}
