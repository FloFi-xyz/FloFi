// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { BUILD_ESTIMATE_STREAM, estimateMatchesNode, requestBuildEstimate, type BuildEstimate, type BuildEstimateResult } from '../domain/build-estimate';
import { bridgeEstimateRequest } from '../domain/bridge-estimate';
import { networkIdentity } from '../domain/network-registry';
import { createJourney, reportJourney } from '../domain/journey-metrics';
import type { DiscoveryResult } from '../server/universal-router/discovery';
import { isUsdEstimate, type DisplayPrices, type UsdEstimate } from '../domain/usd-estimate';
import { DISPLAY_PRICE_ASSETS } from '../domain/price-assets';

const noPrices: DisplayPrices = {};
let recentPrices: { values: DisplayPrices; refreshAt: number } | undefined;
let readingPrices: Promise<NonNullable<typeof recentPrices>> | undefined;

function readDisplayPrices() {
  if (recentPrices && recentPrices.refreshAt > Date.now()) return Promise.resolve(recentPrices);
  readingPrices ??= fetch('/api/build-estimate', { cache: 'no-store', signal: AbortSignal.timeout(3_500) }).then(async response => {
    const raw = response.ok ? await response.json() as DisplayPrices | null : null;
    const values: DisplayPrices = {};
    const now = Date.now();
    for (const name of DISPLAY_PRICE_ASSETS) {
      const price = raw?.[name];
      if (price && /^(0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/.test(price.priceUsd) &&
        Number.isFinite(Date.parse(price.observedAt)) && Number.isFinite(price.validUntil) && price.validUntil > now && price.validUntil <= now + 30_000 &&
        (price.evidence === 'MOCKED' || price.evidence === 'PUBLIC_READ_ONLY')) values[name] = price;
    }
    return { values, refreshAt: Math.min(now + 30_000, ...Object.values(values).map(price => price.validUntil)) };
  }).catch(() => ({ values: noPrices, refreshAt: Date.now() + 30_000 })).then(result => (recentPrices = result)).finally(() => { readingPrices = undefined; });
  return readingPrices;
}

/** The same read-only prices are shared by open Build cards, without sending their quantities or accounts. */
export function useDisplayPrices(enabled: boolean) {
  const [prices, setPrices] = useState<DisplayPrices>(noPrices);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    function request() {
      void readDisplayPrices().then(({ values, refreshAt }) => {
        if (!active) return;
        setPrices(values);
        clearTimeout(refresh);
        refresh = setTimeout(() => { setPrices(noPrices); if (document.visibilityState === 'visible') request(); }, Math.max(100, refreshAt - Date.now()));
      });
    }
    function onVisible() {
      if (document.visibilityState === 'visible' && (!recentPrices || recentPrices.refreshAt <= Date.now())) { clearTimeout(refresh); request(); }
    }
    request();
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; clearTimeout(refresh); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled]);
  return enabled ? prices : noPrices;
}

/**
 * UX-007: the card's live quote. `calculating` from the first edit of a quotable snapshot until its own answer; `unavailable` when the
 * provider has no route or answer for exactly that snapshot. Display only: it never simulates, creates Review, authorizes or executes.
 */
export type LiveQuote = { readonly status: 'idle' } | { readonly status: 'calculating' } | { readonly status: 'ready'; readonly estimate: BuildEstimate }
  /** P0 workflow execution: the card's last answer for exactly this snapshot passed its expiry. It stays visible, explicitly marked as expired,
   *  while a fresh quote is requested (only while the page is visible) — never silently replaced by a dash, and never a Review or signing input. */
  | { readonly status: 'expired'; readonly estimate: BuildEstimate }
  | { readonly status: 'unavailable'; readonly code?: string; readonly correlationId?: string; readonly discovery?: DiscoveryResult };
/**
 * P0 workflow execution: what a card's quote depends on — its own node alone (no links, no other steps) at a normalized revision. Editing ANOTHER
 * card (an Aave amount, a recipient) or any revision bump no longer changes a swap card's snapshot, so its quote is neither re-requested nor
 * blanked; the server's preview of an identical snapshot is shared too. A node that spends an earlier step's output keeps the whole workflow
 * (the server refuses to quote an unresolved dependency).
 */
export function quoteSnapshot(workflow: SemanticWorkflow, nodeId: string): SemanticWorkflow | undefined {
  const node = workflow.nodes.find(item => item.nodeId === nodeId);
  if (!node) return undefined;
  if (node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE')) return workflow;
  return { ...workflow, revision: 0, nodes: [{ ...node, dependencies: [] }], resourceEdges: [] };
}
// Answers already received, per exact snapshot (workflow hash, node, owner), reused only until the estimate's own expiry so that returning
// to an amount shows it at once. Never a Review input; a different amount, node, owner, chain or provider is a different key.
const answered = new Map<string, BuildEstimate>();
const pendingUsd = new WeakMap<BuildEstimate, Promise<UsdEstimate | null>>();
const ANSWERED_LIMIT = 32;
async function readEstimate(response: Response): Promise<BuildEstimateResult> {
  if (response.headers.get('content-type') !== BUILD_ESTIMATE_STREAM || !response.body) return await response.json() as BuildEstimateResult;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let handedOff = false;
  async function line() {
    let end = buffer.indexOf('\n');
    while (end < 0) {
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += chunk.value;
      end = buffer.indexOf('\n');
    }
    const value: unknown = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    return value;
  }
  try {
    const result = await line() as BuildEstimateResult | null;
    if (result?.ok && result.estimate) {
      // Display only, but still checked: a second line that is not a well-formed USD estimate is dropped (the token amount stays as it is).
      const enrichment = line().then(value => isUsdEstimate(value) ? value : null, () => null).finally(() => reader.cancel().catch(() => undefined));
      pendingUsd.set(result.estimate, enrichment);
      handedOff = true;
      return result;
    }
    return result ?? { ok: false, code: 'ESTIMATE_RESPONSE_INVALID' };
  } finally {
    if (!handedOff) void reader.cancel().catch(() => undefined);
  }
}
function remember(scope: string, estimate: BuildEstimate) {
  answered.delete(scope); answered.set(scope, estimate);
  while (answered.size > ANSWERED_LIMIT) answered.delete(answered.keys().next().value!);
  knownVersion += 1;
  for (const listener of knownListeners) listener();
}
// BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A07): readers of `knownLiveEstimate` (a dependent card's consistency) re-read when an answer arrives.
let knownVersion = 0;
const knownListeners = new Set<() => void>();
const subscribeKnown = (listener: () => void) => { knownListeners.add(listener); return () => { knownListeners.delete(listener); }; };
/** A counter that changes whenever this tab learns a new live estimate (never requests anything). */
export function useKnownEstimateVersion(): number {
  return useSyncExternalStore(subscribeKnown, () => knownVersion, () => 0);
}
function recalled(scope: string): BuildEstimate | null {
  const estimate = answered.get(scope);
  if (estimate && Date.parse(estimate.expiresAt) > Date.now()) return estimate;
  answered.delete(scope); return null;
}
/**
 * P0 catalog reliability: one request per exact snapshot (same scope as `answered`) while it is in flight. Every card, layout or re-render that
 * asks for the same snapshot joins it instead of sending its own; the request is cancelled (and the server abandons its preview) only when the
 * last caller has stopped waiting. Different amounts, nodes, owners or chains are different scopes and never share.
 */
const inflight = new Map<string, { readonly result: Promise<BuildEstimateResult>; users: number; readonly controller: AbortController }>();
export function sharedEstimate(scope: string, start: (signal: AbortSignal) => Promise<BuildEstimateResult>, signal: AbortSignal): Promise<BuildEstimateResult> {
  let entry = inflight.get(scope);
  if (!entry) {
    const controller = new AbortController(), created = { result: start(controller.signal), users: 0, controller };
    inflight.set(scope, created);
    created.result.then(() => undefined, () => undefined).finally(() => { if (inflight.get(scope) === created) inflight.delete(scope); });
    entry = created;
  }
  const joined = entry;
  joined.users++;
  return new Promise<BuildEstimateResult>((resolve, reject) => {
    let done = false;
    const finish = () => { if (done) return false; done = true; joined.users--; signal.removeEventListener('abort', cancel); return true; };
    const cancel = () => {
      if (!finish()) return;
      if (joined.users === 0) { joined.controller.abort(); if (inflight.get(scope) === joined) inflight.delete(scope); }
      reject(new DOMException('The estimate request was cancelled.', 'AbortError'));
    };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    joined.result.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
  });
}
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS04): the live estimate this tab already holds for `nodeId`'s current snapshot (any owner), still
 * within its own expiry — or null. Never requests anything. Used only to PROPOSE a connected card's amount (an editable draft the person
 * applies); never a Review, simulation or execution input.
 */
export function knownLiveEstimate(workflow: unknown, nodeId: string): BuildEstimate | null {
  const projected = quoteSnapshot(workflow as SemanticWorkflow, nodeId);
  if (!projected) return null;
  const key = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(projected)));
  for (const scope of [...answered.keys()].reverse()) {
    let parsed: unknown;
    try { parsed = JSON.parse(scope); } catch { continue; }
    if (!Array.isArray(parsed) || parsed[0] !== key || parsed[1] !== nodeId) continue;
    const estimate = recalled(scope);
    if (estimate) return estimate;
  }
  return null;
}
/** Test seam: forget every answered snapshot. */
export function clearLiveQuoteCache(): void { answered.clear(); inflight.clear(); }

/**
 * `frozen` (BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001): the step is executing. The card keeps the answer it already shows (or the one this tab
 * already holds for the same snapshot) and asks nothing: no request, no refresh at expiry. Nothing about the execution reads this estimate.
 */
export function useLiveQuote(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null, destinationWallet?: string | null, frozen = false): LiveQuote {
  const projected = workflow ? quoteSnapshot(workflow, nodeId) : undefined;
  const serialized = projected ? JSON.stringify(projected) : null;
  // Catalog/layout renders may recreate the preview object. Only changed snapshot contents invalidate its request.
  const snapshot = useMemo(() => serialized ? JSON.parse(serialized) as SemanticWorkflow : undefined, [serialized]);
  const key = useMemo(() => serialized ? hashArtifactBytes('semantic-workflow', new TextEncoder().encode(serialized)) : null, [serialized]);
  const node = snapshot?.nodes.find(node => node.nodeId === nodeId);
  const chain = node?.chainId;
  const marketSwap = node?.actionType === 'asset.swap.exact-input' && networkIdentity(chain)?.environment === 'MAINNET';
  const quoteOwner = marketSwap ? undefined : owner;
  const scope = JSON.stringify([key, nodeId, quoteOwner ?? null, destinationWallet ?? null]);
  const unresolved = node?.inputs.some(input => input.kind === 'OUTPUT_REFERENCE');
  const bridge = node?.actionType === 'asset.bridge' ? bridgeEstimateRequest(node) : null;
  const provider = node?.adapterConstraints.protocols.some(protocol => protocol === 'uniswap' || protocol === 'uniswap-v3') ? 'Uniswap V3'
    : node?.adapterConstraints.protocols.includes('jupiter') ? 'Jupiter'
      : node?.adapterConstraints.protocols.includes('orca-whirlpools') ? 'Orca Whirlpools' : bridge ? 'Bridge' : null;
  const [result, setResult] = useState<{ key: string; estimate: BuildEstimate | null; failed: boolean; failure?: Extract<BuildEstimateResult, { ok: false }> } | null>(null);
  // P0 workflow execution: the last answer of THIS snapshot after it expired (shown marked as expired until its fresh answer replaces it).
  const [expired, setExpired] = useState<{ key: string; estimate: BuildEstimate } | null>(null);
  // Latest request wins: every snapshot takes a new generation; an older answer (even one the transport could not abort) is discarded.
  const generation = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const quotable = Boolean(workflow && key && chain && provider);
  useEffect(() => {
    if (!snapshot || !key || !chain || !provider || unresolved) return;
    if (frozen) {
      const known = recalled(scope);
      if (known) setResult(current => current?.key === scope ? current : { key: scope, estimate: known, failed: false });
      return;
    }
    const ticket = ++generation.current;
    let expire: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const accept = (estimate: BuildEstimate | null, failed: boolean, failure?: Extract<BuildEstimateResult, { ok: false }>) => {
      if (ticket !== generation.current) return;
      setResult({ key: scope, estimate, failed, ...failure ? { failure } : {} });
      if (estimate) {
        setExpired(null);
        void pendingUsd.get(estimate)?.then(usd => {
          if (!usd || disposed || ticket !== generation.current || Date.parse(estimate.expiresAt) <= Date.now()) return;
          const enriched = { ...estimate, usd };
          if (recalled(scope) === estimate) remember(scope, enriched);
          setResult(current => current?.key === scope && current.estimate === estimate ? { ...current, estimate: enriched } : current);
        });
        expire = setTimeout(() => {
        if (ticket !== generation.current) return;
        answered.delete(scope); setExpired({ key: scope, estimate }); setResult(null);
        // A fresh quote is requested at once while the page is visible; a hidden tab waits until it is shown again (no background polling).
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') setRefresh(v => v + 1);
        else document.addEventListener('visibilitychange', () => { if (ticket === generation.current) setRefresh(v => v + 1); }, { once: true });
        }, Math.max(0, Date.parse(estimate.expiresAt) - Date.now()));
      }
    };
    const known = recalled(scope);
    if (known) { accept(known, false); return () => { disposed = true; clearTimeout(expire); }; }
    const correlationId = crypto.randomUUID();
    // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: intent → first quote, content-free (the chain and provider label only), reported once per answered snapshot.
    // Its own random id, never the quote correlation id: a journey line must not join the quote's server trace.
    const journey = createJourney({ operation: bridge ? 'bridge' : 'swap', network: chain, provider });
    journey.mark('intent');
    // An answer that arrived for this exact snapshot while this card waited out its debounce is used as is (still bound to its own expiry).
    // Only the card whose request reached the quote service reports the intent → first quote journey (a joined or reused answer is not another one).
    let sent = false;
    const cancel = requestBuildEstimate(signal => { const ready = recalled(scope); return ready ? Promise.resolve({ ok: true as const, estimate: ready }) : sharedEstimate(scope, async shared => {
      sent = true;
      const response = await fetch('/api/build-estimate', { method: 'POST', headers: { 'content-type': 'application/json', accept: BUILD_ESTIMATE_STREAM, 'x-quote-correlation-id': correlationId },
        body: JSON.stringify({ workflow: snapshot, nodeId, owner: quoteOwner, ...destinationWallet ? { destinationWallet } : {} }), signal: shared });
      const result = await readEstimate(response);
      if (!result || typeof result !== 'object' || result.ok !== true && result.ok !== false || result.ok && (!result.estimate || typeof result.estimate !== 'object'))
        return { ok: false, code: 'ESTIMATE_RESPONSE_INVALID', correlationId };
      return response.ok === false && result.ok ? { ok: false, code: 'ESTIMATE_RESPONSE_INVALID', correlationId } : result;
    }, signal); }, response => {
      const estimate = response.ok && response.estimate.workflowHash === key && response.estimate.nodeId === nodeId && response.estimate.chain === chain &&
        (provider === 'Bridge' || response.estimate.provider === provider) && estimateMatchesNode(response.estimate, snapshot, nodeId) && Date.parse(response.estimate.expiresAt) > Date.now() ? response.estimate : null;
      if (estimate) remember(scope, estimate);
      if (estimate && sent && ticket === generation.current) { journey.mark('first_quote'); reportJourney(journey.event('in_progress')); }
      accept(estimate, !estimate, response.ok ? { ok: false, code: 'ESTIMATE_RESPONSE_MISMATCH' } : response);
    });
    return () => { disposed = true; cancel(); clearTimeout(expire); };
  }, [key, scope, snapshot, nodeId, quoteOwner, destinationWallet, chain, provider, refresh, frozen, unresolved]);
  if (!quotable) return { status: 'idle' };
  if (unresolved) return { status: 'unavailable', code: 'ESTIMATE_DEPENDENCY_UNRESOLVED' };
  // A frozen card that never had an answer for this snapshot shows none (never "calculating": nothing is asked); an answer it keeps past its
  // expiry is marked expired (no refresh is asked while frozen).
  if (frozen && result?.key !== scope && expired?.key !== scope) return { status: 'idle' };
  if (frozen && result?.key === scope && result.estimate && Date.parse(result.estimate.expiresAt) <= Date.now()) return { status: 'expired', estimate: result.estimate };
  if (result?.key !== scope) return expired?.key === scope ? { status: 'expired', estimate: expired.estimate } : { status: 'calculating' };
  return result.estimate ? { status: 'ready', estimate: result.estimate } : result.failed ? { status: 'unavailable', ...result.failure ? { code: result.failure.code, ...result.failure.correlationId ? { correlationId: result.failure.correlationId } : {},
    ...result.failure.discovery ? { discovery: result.failure.discovery } : {} } : {} } : { status: 'idle' };
}

/** The current estimate, or null (calculating, unavailable, expired or not quotable). */
export function useBuildEstimate(workflow: SemanticWorkflow | undefined, nodeId: string, owner?: string | null) {
  const quote = useLiveQuote(workflow, nodeId, owner);
  return quote.status === 'ready' ? quote.estimate : null;
}
