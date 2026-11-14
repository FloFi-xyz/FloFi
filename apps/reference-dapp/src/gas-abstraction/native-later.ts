// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review B1/LQ1 (ADR-0010 §2): a later step that cannot pay its own network fee without the chain's
 * native coin, after an earlier step on the SAME chain whose fee may be paid in a token. Token-paid fees are offered exactly when the owner's ETH
 * or SOL is short, so such a run would execute the token-paid step and then stop at the later one, leaving the funds midway (a Robinhood bridge
 * after a 0x Gasless swap; a Relay deposit or Orca liquidity after a Kora-paid Jupiter swap; a Uniswap liquidity step after a Circle-paid swap).
 *
 * Pure and presentation-facing: the Editor's whole-workflow Review and the /approve plan show one visible warning per such chain BEFORE the first
 * signature, naming the later steps and the native coin they need. It never cancels the design, never changes a plan, a group or a mechanism,
 * and never claims the owner's balance (a Review that prepared a group knows only that group's fee payer).
 *
 * Which fees may be paid in a token (the mechanisms' own scope, ADR-0010 §3–§5):
 *   Circle (USDC)  a wallet batch or user operation group on a Circle-enabled EVM chain (`tokenGasChains`); never a step through its own flow
 *   Kora (USDC/T)  a Solana swap or transfer (a sign-all group or its own Jupiter / transfer flow) when Kora is enabled (`koraTokenGas`)
 *   0x Gasless     an ERC-20 → ERC-20 swap on Robinhood Chain when 0x Gasless is enabled (`gaslessSwapChains`), in confirm-each-step mode
 * Everything else on those chains needs native gas: liquidity (Uniswap, Orca), bridges outside a Circle batch (a Robinhood bridge, a Relay Solana
 * deposit), lending or transfers through their own flows, native-ETH swaps on Robinhood Chain.
 */
import type { StepRequirement } from '../delegation/steps.ts';
import { NETWORKS } from '../engine/strategy-engine.ts';
import type { GroupStrategy, UserFundedFacts } from '../workflow-runs/execution-groups.ts';
import { gaslessSwapStep } from '../user-funded/gasless-groups.ts';

export type NativeLaterWarning = {
  readonly chain: string; readonly network: string; readonly symbol: 'ETH' | 'SOL';
  /** The earliest step (0-based) on this chain whose network fee may be paid in a token. */
  readonly after: number;
  /** The later steps (0-based) on this chain whose own flow needs `symbol` for its network fee, in order, with their actions. */
  readonly steps: readonly { readonly index: number; readonly action: string }[];
};
type Step = Pick<StepRequirement, 'index' | 'action' | 'chain' | 'network' | 'inputs' | 'outputs'>;
type Group = { readonly index: number; readonly stepFrom: number; readonly stepTo: number; readonly strategy: GroupStrategy };
const CIRCLE_STRATEGIES: readonly GroupStrategy[] = ['EVM_WALLET_BATCH', 'EVM_USER_OPERATION'];
const KORA_ACTIONS: readonly string[] = ['swap', 'transfer'];

/**
 * The warnings for a workflow's steps. `groups`: the user-funded plan's groups (null: every step through its own flow, confirm-each-step mode).
 * `decided`: groups whose fee payer a Review already knows from preparing them — 'TOKEN' (Circle pays it) or 'NATIVE' (the owner's own coin
 * covers it now): such a group's steps are neither a token-paid trigger ('NATIVE') nor a possibility ('TOKEN' is certain).
 */
export function nativeLaterWarnings(steps: readonly Step[], groups: readonly Group[] | null, facts: Pick<UserFundedFacts, 'tokenGasChains' | 'koraTokenGas' | 'gaslessSwapChains'>,
  decided: ReadonlyMap<number, 'TOKEN' | 'NATIVE'> = new Map()): readonly NativeLaterWarning[] {
  const circle = facts.tokenGasChains ?? [], gasless = facts.gaslessSwapChains ?? [];
  const payable = (step: Step): 'TOKEN' | 'NATIVE' | 'NATIVE_NOW' => {
    const group = groups?.find(g => g.stepFrom <= step.index && step.index <= g.stepTo) ?? null;
    const known = group ? decided.get(group.index) : undefined;
    if (known === 'NATIVE') return 'NATIVE_NOW';
    if (known === 'TOKEN') return 'TOKEN';
    if (step.chain.startsWith('solana:')) return facts.koraTokenGas === true && KORA_ACTIONS.includes(step.action) ? 'TOKEN' : 'NATIVE';
    if (circle.includes(step.chain) && group && CIRCLE_STRATEGIES.includes(group.strategy)) return 'TOKEN';
    if (gasless.includes(step.chain) && gaslessSwapStep(step)) return 'TOKEN';
    return 'NATIVE';
  };
  const byChain = new Map<string, { after: number; network: string; steps: { index: number; action: string }[] }>();
  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    const pay = payable(step), seen = byChain.get(step.chain);
    if (pay === 'NATIVE_NOW') continue;
    if (pay === 'TOKEN') { if (!seen) byChain.set(step.chain, { after: step.index, network: NETWORKS[step.network]?.label ?? step.chain, steps: [] }); continue; }
    if (seen) seen.steps.push({ index: step.index, action: step.action });
  }
  return [...byChain].filter(([, w]) => w.steps.length > 0).map(([chain, w]) => ({ chain, network: w.network,
    symbol: chain.startsWith('solana:') ? 'SOL' as const : 'ETH' as const, after: w.after, steps: w.steps }));
}
