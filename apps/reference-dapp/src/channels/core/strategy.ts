// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: from the channel's pending proposal to the canonical strategy every FloFi surface shares.
 *
 * A channel proposal is the same authoring `Command` FloFi's own chat produces (the exact grammar, or the Copilot through the exact
 * grammar), authored against the editor's initial state. It becomes a StrategySpec (v1) by the inverse of the engine's own mapping,
 * and that spec is composed by the shared platform (`composeWorkflowOrRefuse`). The parity guard then requires the platform to
 * reproduce the very same command — so the canonical IR and workflow hash are exactly what MCP, the Developer API and FloFi's chat
 * produce for it. Any difference fails closed (`CHANNEL_STRATEGY_PARITY_FAILED`): nothing is handed off.
 *
 * Addresses are compared case-insensitively, because the canonical strategy stores them lower-cased. An address the user typed is
 * only strategy input: it becomes the handoff's intended wallet, which FloFi checks against a PROVEN wallet at claim time.
 */
import type { Command } from '../../domain/commands';
import type { UniversalBridgeInput, UniversalBridgeRouting } from '../../domain/universal-bridge-authoring';
import type { WorkflowStep } from '../../domain/workflow-steps';
import { CATALOG_NETWORK_IDENTITIES, networkIdentity } from '../../domain/network-registry';
import { AAVE_V3_LENDING_PROFILES } from '@defi-workflow-engine/action-registry';
import type { NetworkId, StrategyInput, StrategySpec } from '../../engine/strategy-spec';
import { composeWorkflowOrRefuse, PlatformRefusal, type WalletRef } from '../../platform/index.ts';
import { workflowVisualModel, type WorkflowVisualModel } from '../../platform/workflow-visual.ts';
import { sameAsset, stepInputs, stepOutput } from '../../engine/workflow-bindings';

const LENDING_NETWORK: Readonly<Record<string, NetworkId>> = Object.fromEntries(AAVE_V3_LENDING_PROFILES.map(profile => [profile.network, networkIdentity(profile.chain)!.key as NetworkId]));
/** BUILD-BASE-001: the catalog networks (Canvas name → strategy network): Robinhood Chain and Base. */
const CATALOG_NETWORK: Readonly<Record<string, NetworkId>> = Object.fromEntries(CATALOG_NETWORK_IDENTITIES.map(network => [network.name, network.key as NetworkId]));
const SWAP_NETWORK: Readonly<Record<string, NetworkId>> = { ADD_SWAP: 'base', ADD_TESTNET_SWAP: 'base-sepolia', ADD_ETHEREUM_SEPOLIA_SWAP: 'ethereum-sepolia' };
const ROUTING = { AUTO: 'auto', LIFI: 'lifi', ACROSS: 'across' } as const;
/** The router's chain names as strategy networks (BUILD-RH-002 adds Robinhood Chain in and out of Base and Arbitrum One). */
const ROUTER_NETWORK: Readonly<Record<string, NetworkId>> = { 'Ethereum': 'ethereum', 'Base': 'base', 'Base Sepolia': 'base-sepolia', 'Arbitrum': 'arbitrum-one', 'Arbitrum Sepolia': 'arbitrum-sepolia',
  'Robinhood Chain': 'robinhood' };
const UNIVERSAL_ROUTING: Readonly<Partial<Record<UniversalBridgeRouting, string>>> = { BEST: 'best', RELAY: 'relay', LIFI: 'lifi', MAYAN: 'mayan', ACROSS: 'across' };
const bps = (value: string) => /^(0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : NaN;

/** The StrategySpec (v1) an authoring command expresses, or null for anything that is not one of the Copilot's authoring commands. */
export function strategyOfCommand(command: Command): StrategySpec | null {
  const c = command as Command & Record<string, unknown>;
  switch (command.type) {
    case 'ADD_SWAP': case 'ADD_TESTNET_SWAP': case 'ADD_ETHEREUM_SEPOLIA_SWAP': {
      const usdcIn = c.direction === 'USDC_TO_WETH';
      return { version: 1, action: 'swap', network: SWAP_NETWORK[command.type]!, inputAsset: usdcIn ? 'USDC' : 'WETH', outputAsset: usdcIn ? 'WETH' : 'USDC',
        amount: String(c.amount), slippageBps: bps(String(c.slippage)) } as StrategySpec;
    }
    case 'ADD_SOLANA_SWAP': {
      const i = c.input as { network: string; from: string; to: string; amount: string; slippage: string };
      return { version: 1, action: 'swap', network: i.network === 'Solana' ? 'solana' : 'solana-devnet', inputAsset: i.from, outputAsset: i.to, amount: i.amount,
        slippageBps: bps(i.slippage) } as StrategySpec;
    }
    case 'ADD_ROUTER_BRIDGE': {
      const i = c.input as { source: string; destination: string; token: string; amount: string; recipient: string; slippage: string; routing: keyof typeof ROUTING };
      return { version: 1, action: 'bridge', sourceNetwork: ROUTER_NETWORK[i.source], destinationNetwork: ROUTER_NETWORK[i.destination], asset: i.token, amount: i.amount,
        routing: ROUTING[i.routing], slippageBps: bps(i.slippage), ...i.recipient ? { recipient: i.recipient } : {} } as StrategySpec;
    }
    // BUILD-CROSSCHAIN-UNIVERSAL-001: the universal bridge (the five mainnets). Quote-only policies are still representable; Review checks execution eligibility.
    case 'ADD_UNIVERSAL_BRIDGE': {
      const i = c.input as UniversalBridgeInput, routing = UNIVERSAL_ROUTING[i.routing];
      if (!routing) return null;
      return { version: 1, action: 'bridge', sourceNetwork: i.source, destinationNetwork: i.destination, asset: i.inputAsset, outputAsset: i.outputAsset, amount: i.amount,
        routing, slippageBps: bps(i.slippage), ...i.recipient ? { recipient: i.recipient } : {} } as StrategySpec;
    }
    // BUILD-RH-002: Robinhood Chain swaps and positions over the official catalog, and Robinhood Chain transfers (BUILD-BASE-001: and Base's).
    case 'ADD_CRYPTO_ACTION': {
      const i = c.input as { selection: { action: string; network: string; from: string; to?: string }; amount: string; secondAmount?: string; slippage: string;
        fee?: number; rangeUnit?: string; lower?: string; upper?: string };
      const network = CATALOG_NETWORK[i.selection.network];
      if (!network || !i.selection.to) return null;
      if (i.selection.action === 'swap') return { version: 1, action: 'swap', network, inputAsset: i.selection.from, outputAsset: i.selection.to,
        amount: i.amount, slippageBps: bps(i.slippage) } as StrategySpec;
      if (i.selection.action !== 'pool') return null;
      return { version: 1, action: 'add_liquidity', network, maxAmounts: { [i.selection.from]: i.amount, [i.selection.to]: i.secondAmount ?? '0' },
        range: i.rangeUnit === 'TICK' ? { unit: 'tick', lower: i.lower, upper: i.upper } : { unit: 'full' }, ...i.fee === undefined ? {} : { feeTier: i.fee },
        slippageBps: bps(i.slippage) } as StrategySpec;
    }
    case 'ADD_RH_TRANSFER': {
      const i = c.input as { network: string; asset: string; amount: string; recipient: string; decimals?: string; program?: 'spl-token' | 'token-2022' };
      // BUILD-SOLANA-TRANSFER-UX-001: a Solana transfer always carries its explicit recipient wallet (and, for a mint, its decimals and program).
      if (i.network === 'Solana' || i.network === 'Solana Devnet') return i.recipient === 'CONNECTED_OWNER' ? null : { version: 1, action: 'transfer',
        network: i.network === 'Solana' ? 'solana' : 'solana-devnet', asset: i.asset, amount: i.amount, recipient: i.recipient,
        ...i.decimals === undefined ? {} : { decimals: Number(i.decimals) }, ...i.program === undefined ? {} : { tokenProgram: i.program } } as StrategySpec;
      const network = i.network === 'Ethereum Sepolia' ? 'ethereum-sepolia' : i.network === 'Robinhood Chain Testnet' ? 'robinhood-testnet' : CATALOG_NETWORK[i.network];
      return !network ? null : { version: 1, action: 'transfer', network, asset: i.asset, amount: i.amount,
        ...i.recipient === 'CONNECTED_OWNER' ? {} : { recipient: i.recipient } } as StrategySpec;
    }
    case 'ADD_SUPPLY': case 'ADD_BORROW': case 'ADD_REPAY': {
      const i = c.input as { network: string; asset: string; amount: string; beneficiary: string };
      return { version: 1, action: command.type === 'ADD_SUPPLY' ? 'supply' : command.type === 'ADD_BORROW' ? 'borrow' : 'repay', network: LENDING_NETWORK[i.network],
        asset: i.asset, amount: i.amount, beneficiary: i.beneficiary } as StrategySpec;
    }
    case 'ADD_WITHDRAW': {
      const i = c.input as { network: string; asset: string; amount: string };
      return { version: 1, action: 'withdraw', network: LENDING_NETWORK[i.network], asset: i.asset, amount: i.amount } as StrategySpec;
    }
    case 'ADD_UNISWAP_LIQUIDITY': {
      const i = c.input as { network: string; maxUsdc: string; maxWeth: string; rangeUnit: 'PRICE' | 'TICK'; lower: string; upper: string; slippage: string };
      return { version: 1, action: 'add_liquidity', network: LENDING_NETWORK[i.network], maxAmounts: { USDC: i.maxUsdc, WETH: i.maxWeth },
        range: { unit: i.rangeUnit === 'PRICE' ? 'price' : 'tick', lower: i.lower, upper: i.upper }, slippageBps: bps(i.slippage) } as StrategySpec;
    }
    case 'ADD_SOLANA_LIQUIDITY': {
      const i = c.input as { network: string; maxSol: string; maxDevUsdc: string; rangeUnit: 'PRICE' | 'TICK'; lower: string; upper: string; slippage: string };
      const mainnet = i.network === 'Solana';
      return { version: 1, action: 'add_liquidity', network: mainnet ? 'solana' : 'solana-devnet', maxAmounts: { SOL: i.maxSol, [mainnet ? 'USDC' : 'devUSDC']: i.maxDevUsdc },
        range: { unit: i.rangeUnit === 'PRICE' ? 'price' : 'tick', lower: i.lower, upper: i.upper }, slippageBps: bps(i.slippage) } as StrategySpec;
    }
    case 'AUTHOR_LENDING': {
      const i = c.input as { supply: string; borrow: string; slippage: string; owner: string };
      return { version: 1, action: 'lending_composition', network: 'base-sepolia', asset: 'USDC', supplyAmount: i.supply, borrowAmount: i.borrow, outputAsset: 'WETH',
        slippageBps: bps(i.slippage), owner: i.owner } as StrategySpec;
    }
    default: return null;
  }
}

/** A structure with keys sorted and EVM addresses lower-cased: what "the same command" means for the parity guard. */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  return value;
}
export const sameCommand = (a: Command, b: Command) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The one address a strategy names (beneficiary, owner or recipient): the wallet that alone may claim its handoff. A bridge from Solana, or
 * to a recipient of another ecosystem, names no claiming wallet: the recipient there cannot sign on the source network.
 */
export function intendedWalletOf(spec: StrategySpec): WalletRef | null {
  const s = spec as StrategySpec & { beneficiary?: string; owner?: string; recipient?: string };
  if (s.action === 'bridge' && (s.sourceNetwork.startsWith('solana') || s.recipient !== undefined && !/^0x/i.test(s.recipient))) return null;
  const address = s.action === 'lending_composition' ? s.owner : s.action === 'bridge' ? s.recipient : s.action === 'supply' || s.action === 'borrow' || s.action === 'repay'
    ? s.beneficiary : undefined;
  return address ? { namespace: 'eip155', address: address.toLowerCase() } : null;
}

export type ChannelStrategy = { readonly ok: true; readonly spec: StrategySpec; readonly workflowHash: string; readonly command: Command; readonly summary: string;
  readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS'; readonly notes: readonly string[]; readonly intendedWallet: WalletRef | null;
  /** The financial steps of the canonical IR (the editor's authoring-only template is not a step). */
  readonly steps: readonly WorkflowStep[];
  /** BUILD-WORKFLOW-VISUAL-PRESENTATION-001: the presentation model of the same canonical workflow (its `workflowHash` is this one). */
  readonly visual: WorkflowVisualModel };
/** The canonical strategy of a pending authoring command, composed by the shared platform and checked for parity; or a closed code. */
export function canonicalStrategy(command: Command): ChannelStrategy | { readonly ok: false; readonly code: string } {
  const spec = strategyOfCommand(command);
  if (!spec) return { ok: false, code: 'CHANNEL_COMMAND_NOT_AUTHORING' };
  let workflow;
  try { workflow = composeWorkflowOrRefuse(spec, undefined); }
  catch (cause) { return { ok: false, code: cause instanceof PlatformRefusal ? cause.message : 'CHANNEL_STRATEGY_PARITY_FAILED' }; }
  const step = workflow.steps.length === 1 ? workflow.steps[0]! : null;
  if (!step || !sameCommand(step.command, command)) return { ok: false, code: 'CHANNEL_STRATEGY_PARITY_FAILED' };
  return { ok: true, spec: workflow.strategy as StrategySpec, workflowHash: workflow.workflowHash, command: step.command, summary: step.summary,
    fundsClass: workflow.fundsClass, notes: workflow.notes, intendedWallet: intendedWalletOf(workflow.strategy as StrategySpec),
    steps: step.steps.filter(s => s.kind !== 'TEMPLATE'), visual: workflowVisualModel(workflow) };
}

/**
 * BUILD-CHAT-E2E-001: the canonical workflow of a channel's step list (the steps the conversation kept, then the pending command), composed by
 * the shared platform as one v2 workflow. Every step passes the same parity guard as a single command: the platform must reproduce exactly
 * that step's command. A list that FloFi would collapse into another shape (e.g. the lending composition) is refused rather than silently
 * re-authored. One intended wallet at most, and only for the wallet that claims the workflow (its first step's).
 */
export type ChannelWorkflow = Omit<ChannelStrategy, 'spec'> & { readonly spec: StrategyInput; readonly commands: readonly Command[]; readonly stepCount: number;
  readonly stepSummaries: readonly string[] };
export function canonicalWorkflow(commands: readonly Command[]): ChannelWorkflow | { readonly ok: false; readonly code: string } {
  if (commands.some(command => command.type === 'ADD_SEQUENCE')) return sequenceWorkflow(commands);
  if (commands.length === 1) {
    const one = canonicalStrategy(commands[0]!);
    return one.ok ? { ...one, commands: [one.command], stepCount: 1, stepSummaries: [one.summary] } : one;
  }
  const specs = commands.map(strategyOfCommand);
  if (specs.some(spec => !spec)) return { ok: false, code: 'CHANNEL_COMMAND_NOT_AUTHORING' };
  let workflow;
  try { workflow = composeWorkflowOrRefuse({ version: 2, steps: specs }, undefined); }
  catch (cause) { return { ok: false, code: cause instanceof PlatformRefusal ? cause.message : 'CHANNEL_STRATEGY_PARITY_FAILED' }; }
  if (workflow.steps.length !== commands.length || workflow.steps.some((step, i) => !sameCommand(step.command, commands[i]!)))
    return { ok: false, code: 'CHANNEL_STRATEGY_PARITY_FAILED' };
  const named = [...new Map(workflow.steps.map(step => intendedWalletOf(step.strategy)).filter((w): w is WalletRef => w !== null).map(w => [w.address, w])).values()];
  if (named.length > 1) return { ok: false, code: 'CHANNEL_INTENDED_WALLETS_DIFFER' };
  return channelWorkflowOf(workflow, commands, named[0] ?? null);
}
/**
 * BUILD-FLOFI-INTELLIGENCE-001: a goal plan's `ADD_SEQUENCE` is the channel's step list — its steps in order, after any kept steps — composed as one
 * v2 workflow. A step of the sequence that spends exactly the asset an earlier step of the same sequence delivers to the owner carries the typed
 * binding (`{ step, amountFrom }`), so MCP, the Developer API and the handoff run it as FloFi's chat does: it spends what that step actually
 * delivered, up to its own amount. The same parity guard applies to every step.
 */
function sequenceWorkflow(commands: readonly Command[]): ChannelWorkflow | { readonly ok: false; readonly code: string } {
  const flat: Command[] = [], group: number[] = [];
  for (const [index, command] of commands.entries()) {
    if (command.type !== 'ADD_SEQUENCE') { flat.push(command); group.push(-1); continue; }
    for (const step of command.steps) { flat.push({ ...step, source: command.source, baseRevision: 0 } as Command); group.push(index); }
  }
  const specs = flat.map(strategyOfCommand);
  if (specs.some(spec => !spec)) return { ok: false, code: 'CHANNEL_COMMAND_NOT_AUTHORING' };
  let workflow;
  try {
    const unbound = composeWorkflowOrRefuse({ version: 2, steps: specs }, undefined);
    const bindings = flat.flatMap((_, consumer) => {
      if (group[consumer] === -1) return [];
      return stepInputs(unbound.steps[consumer]!).flatMap(input => {
        for (let producer = consumer - 1; producer >= 0; producer -= 1) {
          if (group[producer] !== group[consumer]) break;
          const output = stepOutput(unbound.steps[producer]!);
          if (output && sameAsset(output, input)) return [{ step: consumer, amountFrom: producer }];
        }
        return [];
      });
    });
    workflow = bindings.length ? composeWorkflowOrRefuse({ version: 2, steps: specs, bindings }, undefined) : unbound;
  } catch (cause) { return { ok: false, code: cause instanceof PlatformRefusal ? cause.message : 'CHANNEL_STRATEGY_PARITY_FAILED' }; }
  if (workflow.steps.length !== flat.length || workflow.steps.some((step, i) => !sameCommand({ ...step.command, baseRevision: 0 } as Command, flat[i]!)))
    return { ok: false, code: 'CHANNEL_STRATEGY_PARITY_FAILED' };
  const named = [...new Map(workflow.steps.map(step => intendedWalletOf(step.strategy)).filter((w): w is WalletRef => w !== null).map(w => [w.address, w])).values()];
  if (named.length > 1) return { ok: false, code: 'CHANNEL_INTENDED_WALLETS_DIFFER' };
  return channelWorkflowOf(workflow, flat, named[0] ?? null);
}
function channelWorkflowOf(workflow: ReturnType<typeof composeWorkflowOrRefuse>, commands: readonly Command[], named: WalletRef | null): ChannelWorkflow {
  const first = workflow.steps[0]!.strategy, firstSolana = (first.action === 'bridge' ? first.sourceNetwork : first.network).startsWith('solana');
  return { ok: true, spec: workflow.strategy, workflowHash: workflow.workflowHash, command: commands.at(-1)!, commands: workflow.steps.map(s => s.command),
    summary: workflow.steps.map(s => s.summary).join(' → '), stepSummaries: workflow.steps.map(s => s.summary), fundsClass: workflow.fundsClass, notes: workflow.notes,
    intendedWallet: firstSolana ? null : named, steps: workflow.steps.flatMap(c => c.steps.filter(s => s.kind !== 'TEMPLATE')),
    visual: workflowVisualModel(workflow), stepCount: workflow.steps.length };
}
