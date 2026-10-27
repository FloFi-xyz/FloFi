// SPDX-License-Identifier: AGPL-3.0-only
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { bridgeEstimateRequest } from '../domain/bridge-estimate.ts';
import { parseDiscoveryRequest } from './universal-router/requests.ts';
import { readBridgeDiscovery } from './bridge-discovery.ts';
import { simulationAmount } from '../domain/simulation-presentation.ts';
import type { BuildEstimateResult } from '../domain/build-estimate.ts';
import { quoteFailure } from './quote-failure.ts';

export async function readBridgeBuildEstimate(workflow: SemanticWorkflow, nodeId: string, workflowHash: string,
  owner: string | null, destinationWallet: string | null, env: Readonly<Record<string, string | undefined>>,
  now: () => Date, discover: typeof readBridgeDiscovery = readBridgeDiscovery, correlationId?: string): Promise<BuildEstimateResult> {
  const node = workflow.nodes.find(n => n.nodeId === nodeId);
  const input = node && bridgeEstimateRequest(node, owner, destinationWallet);
  if (!input) return quoteFailure(new Error('ESTIMATE_UNSUPPORTED'), correlationId);
  const request = parseDiscoveryRequest(input);
  let response: Awaited<ReturnType<typeof discover>>;
  try { response = await discover(input, env, correlationId); }
  catch (cause) { return quoteFailure(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause : new Error('ESTIMATE_INTERNAL_ERROR'), correlationId); }
  if (!response.ok) return quoteFailure(new Error(response.code), correlationId ?? response.correlationId);
  const result = response.value;
  const same = (a: typeof request.inputToken, b: typeof a) => a.kind === b.kind && a.chainId === b.chainId && a.address === b.address && a.decimals === b.decimals;
  if (result.format !== 'flofi.universal-discovery.v1' || result.sourceChain !== request.source.chain || result.destinationChain !== request.destination.chain ||
    result.amount !== request.amount || !same(result.inputToken, request.inputToken) || !same(result.outputToken, request.outputToken) ||
    !Number.isFinite(Date.parse(result.observedAt)) || Date.parse(result.observedAt) > now().getTime() + 5_000 || Date.parse(result.observedAt) + 30_000 <= now().getTime() ||
    !Array.isArray(result.candidates) || result.candidates.some(c => !request.providers.includes(c.provider))) return quoteFailure(new Error('ESTIMATE_RESPONSE_MISMATCH'), correlationId);
  const eligible = result.candidates.map((c, index) => ({ c, index })).filter(({ c }) => ['EXECUTABLE', 'LIVE_QUOTE'].includes(c.status) &&
    typeof c.expectedOutput === 'string' && /^[1-9][0-9]{0,77}$/.test(c.expectedOutput) && typeof c.minimumOutput === 'string' && /^[1-9][0-9]{0,77}$/.test(c.minimumOutput) &&
    BigInt(c.minimumOutput) <= BigInt(c.expectedOutput) && (!c.expiresAt || Date.parse(c.expiresAt) > now().getTime()));
  // Honor provider preference. BEST favors a verified builder, then the highest economic minimum among quote-only answers.
  eligible.sort((a, b) => Number(b.c.status === 'EXECUTABLE') - Number(a.c.status === 'EXECUTABLE') ||
    (BigInt(a.c.minimumOutput!) > BigInt(b.c.minimumOutput!) ? -1 : BigInt(a.c.minimumOutput!) < BigInt(b.c.minimumOutput!) ? 1 : 0));
  const selected = eligible[0];
  if (!selected) return { ...quoteFailure(new Error(['EXECUTABLE', 'LIVE_QUOTE'].includes(result.status) ? 'ESTIMATE_RESPONSE_INVALID' : `BRIDGE_${result.status}`), correlationId), discovery: result };
  const { c, index } = selected;
  return { ok: true, estimate: { workflowHash, nodeId, chain: node!.chainId, provider: c.provider, expected: simulationAmount(c.expectedOutput!, request.outputToken.decimals)!,
    minimum: simulationAmount(c.minimumOutput!, request.outputToken.decimals), symbol: result.outputToken.symbol, slippageBps: request.slippageBps,
    expiresAt: new Date(Math.min(Date.parse(result.observedAt) + 30_000, c.expiresAt ? Date.parse(c.expiresAt) : Infinity)).toISOString(),
    bridge: { discovery: result, selected: index, execution: c.status === 'EXECUTABLE' ? 'SIMULATION_AND_REVIEW_REQUIRED' : 'QUOTE_ONLY' } } };
}
