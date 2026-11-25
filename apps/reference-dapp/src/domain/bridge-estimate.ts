// SPDX-License-Identifier: AGPL-3.0-only
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { universalBridgeDetails, universalKeyOfCanvasLabel, universalBridgeFields, universalCanvasInput } from './universal-bridge-authoring';
import { routerDetails, ROUTER_ROUTING } from './router-authoring';
import type { DiscoveryRequestInput } from '../server/universal-router/requests';
import { operationWalletAddress } from './wallet-inventory';

/** One node's declared economics; dependencies stay in the original IR and remain mandatory at execution. */
export function bridgeEstimateRequest(node: SemanticWorkflow['nodes'][number], owner?: string | null, destinationWallet?: string | null): DiscoveryRequestInput | null {
  const universal = universalBridgeDetails(node), legacy = routerDetails(node);
  const source = legacy ? universalKeyOfCanvasLabel(legacy.source) : null, destination = legacy ? universalKeyOfCanvasLabel(legacy.destination) : null;
  const fields = universal?.fields ?? (legacy && source && destination ? {
    ...universalBridgeFields({ ...universalCanvasInput({ source, destination }, legacy.amount, { inputAsset: legacy.token, outputAsset: legacy.destinationToken }),
      recipient: legacy.recipient, slippage: legacy.slippage }), providers: ROUTER_ROUTING[legacy.routing],
  } : null);
  const src = universal?.source ?? source, dst = universal?.destination ?? destination;
  if (!fields || !src || !dst) return null;
  const display = (symbol: string | undefined) => symbol && !symbol.includes('@') ? { symbol } : {};
  const inputToken = fields.inputAsset.kind === 'NATIVE' ? { kind: 'NATIVE' as const } : { ...fields.inputAsset, ...display(universal?.inputSymbol ?? legacy?.token) };
  const outputToken = fields.outputAsset.kind === 'NATIVE' ? { kind: 'NATIVE' as const } : { ...fields.outputAsset, ...display(universal?.outputSymbol ?? legacy?.destinationToken) };
  const sourceWallet = operationWalletAddress(src === 'solana' ? 'solana' : 'evm', owner);
  const receivingWallet = operationWalletAddress(dst === 'solana' ? 'solana' : 'evm', destinationWallet);
  const recipient = fields.recipient === 'CONNECTED_OWNER' ? sourceWallet : fields.recipient === 'CONNECTED_DESTINATION_WALLET' ? receivingWallet : fields.recipient;
  return { source: src, destination: dst, inputToken, outputToken, amount: fields.amount, slippageBps: fields.slippageBps, providers: fields.providers,
    ...sourceWallet ? { owner: sourceWallet } : {}, ...recipient ? { recipient } : {} };
}
