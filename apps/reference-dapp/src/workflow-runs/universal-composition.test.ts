// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 universal execution — the composition promise proven through the REAL code paths, never through card connections: every catalog action
 * (Swap, Transfer, Bridge, Supply, Borrow, Repay, Withdraw, Add liquidity) on every mainnet where it exists (Ethereum, Base, Arbitrum One,
 * Robinhood Chain, Solana) is composed with the product's own grammar (`composeWorkflowBound` → `workflowRequirement`, the hash bound), then
 * planned by the product's own planner (`planExecutionGroups` with the product's own per-step builder check, `userFundedBuildable`) for a
 * MetaMask-like EVM wallet that reports EIP-5792 atomic batching on every EVM mainnet and a Wallet Standard Solana wallet that signs several
 * transactions in one prompt.
 *
 *   - every ordered pair of actions, bound wherever the documented binding rules allow (producers swap / bridge to the own wallet / withdraw /
 *     borrow → consumers swap / bridge / supply / repay / transfer / add_liquidity on the chain the output lands on); every other pair refused
 *     as a binding ONLY with the documented role code, and still composed as ordered steps with their own amounts;
 *   - every ordered triple from every network (bridges change the network), chained the same way;
 *   - representative workflows with their exact groups and wallet interaction counts.
 *
 * Plan invariants checked on every composition: each step exactly once and in order; a group never spans chains; a step bound to an output of an
 * earlier group (a cross-chain delivery included) spends the RECONCILED actual amount and is signed WHEN_DUE; consecutive batchable steps of one
 * chain share ONE EVM_WALLET_BATCH / SOLANA_SIGN_ALL group (a Solana step spending an unlanded output of its group excepted, which starts a
 * new sign-all group and says so: SOLANA_GROUP_STEP_DEPENDENT); bridge and add_liquidity stand alone in an owner-step group with their closed
 * reason; the interaction count is exactly what the wallet is asked for, and "single" only ever means one group and one prompt. Planner +
 * composer only: deterministic, no network, no chain double, nothing signed.
 */
import { describe, expect, it } from 'vitest';
import { requirementOf, workflowRequirement, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine';
import { evmStepBuildable } from '../user-funded/evm-calls.ts';
import { planExecutionGroups, type ExecutionGroup, type GroupPlan, type UserFundedFacts, type WalletProfile } from './execution-groups.ts';
import { userFundedBuildable } from './service.ts';

const OWNER = '0x1111111111111111111111111111111111111111', EVM_TO = '0x4444444444444444444444444444444444444444';
const SOL_TO = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
const CHAINS = { ethereum: 'eip155:1', base: 'eip155:8453', 'arbitrum-one': 'eip155:42161', robinhood: 'eip155:4663',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } as const;
type Net = keyof typeof CHAINS;
const NETS = Object.keys(CHAINS) as Net[];
const EVM_CHAINS = Object.values(CHAINS).filter(c => c.startsWith('eip155:'));
/** A deployment with user-funded execution on every mainnet and no ERC-4337 bundler configured (`FLOFI_BUNDLER_RPC_<id>` unset). */
const FACTS: UserFundedFacts = { enabled: true, code: null, chains: Object.values(CHAINS), bundlerChains: [], solanaNonceAccounts: false };
/** MetaMask-like: EIP-5792 `atomic: supported` on every EVM mainnet; a Wallet Standard Solana wallet with multi-transaction signing. */
const METAMASK: WalletProfile = { eip155: { wallet: 'INJECTED', atomic: Object.fromEntries(EVM_CHAINS.map(c => [c, 'supported' as const])), typedData: true },
  solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };

const ACTIONS = ['swap', 'transfer', 'bridge', 'supply', 'borrow', 'repay', 'withdraw', 'add_liquidity'] as const;
type Action = (typeof ACTIONS)[number];
/** The documented binding roles (`engine/workflow-bindings.ts`, report §B), restated here so a silent change of the product shows up. */
const PRODUCERS: ReadonlySet<Action> = new Set(['swap', 'bridge', 'withdraw', 'borrow']);
const CONSUMERS: ReadonlySet<Action> = new Set(['swap', 'bridge', 'supply', 'repay', 'transfer', 'add_liquidity']);
/** What the user-funded builders batch (report §D): everything else is an owner step of its own, with this closed reason. */
const BATCHABLE: Readonly<Record<'eip155' | 'solana', ReadonlySet<Action>>> = { eip155: new Set(['swap', 'supply', 'borrow', 'repay', 'withdraw', 'transfer']),
  solana: new Set(['swap', 'transfer']) };
const OWNER_STEP_REASON: Partial<Record<Action, string>> = { bridge: 'USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE', add_liquidity: 'USER_FUNDED_ACTION_NOT_BUILDABLE:ADD_LIQUIDITY' };
/** Aave V3 markets exist on Ethereum, Base and Arbitrum One only (no market on Robinhood Chain or Solana: a protocol fact). */
const AAVE: ReadonlySet<Net> = new Set(['ethereum', 'base', 'arbitrum-one']);
const exists = (net: Net, a: Action) => ['supply', 'borrow', 'repay', 'withdraw'].includes(a) ? AAVE.has(net) : true;

/** The asset that flows between steps on a network (`S`), and the other side of its swaps and positions (`V`). */
const S = (n: Net) => n === 'robinhood' ? 'USDG' : 'USDC', V = (n: Net) => n === 'solana' ? 'SOL' : 'WETH';
/** Where a bridge from each network goes: an EVM-only map and one through Solana (all 20 directed pairs are composable; these are representative). */
const TO_EVM: Readonly<Record<Net, Net>> = { ethereum: 'base', base: 'arbitrum-one', 'arbitrum-one': 'base', robinhood: 'base', solana: 'arbitrum-one' };
const TO_SOLANA: Readonly<Record<Net, Net>> = { ethereum: 'solana', base: 'solana', 'arbitrum-one': 'solana', robinhood: 'solana', solana: 'ethereum' };
type Spec = Record<string, unknown>;
type Binding = { step: number; amountFrom: number };
/** One step in the product's grammar. `form`: a swap that delivers S (producer) or spends it (consumer); every other action spends or delivers S. */
function stepOf(a: Action, n: Net, form: 'producer' | 'consumer', to: Readonly<Record<Net, Net>>): Spec {
  switch (a) {
    case 'swap': return form === 'producer' ? { action: 'swap', network: n, inputAsset: V(n), outputAsset: S(n), amount: n === 'solana' ? '0.05' : '0.002' }
      : { action: 'swap', network: n, inputAsset: S(n), outputAsset: V(n), amount: '5' };
    case 'transfer': return { action: 'transfer', network: n, asset: S(n), amount: '2', recipient: n === 'solana' ? SOL_TO : EVM_TO };
    case 'bridge': return { action: 'bridge', sourceNetwork: n, destinationNetwork: to[n], asset: S(n), amount: '5' };
    case 'supply': case 'repay': case 'borrow': return { action: a, network: n, asset: S(n), amount: '1', beneficiary: OWNER };
    case 'withdraw': return { action: 'withdraw', network: n, asset: S(n), amount: '1' };
    case 'add_liquidity': return n === 'solana' ? { action: 'add_liquidity', network: n, maxAmounts: { SOL: '0.01', USDC: '0.3' }, range: { unit: 'tick', lower: '-29952', upper: '-25600' } }
      : { action: 'add_liquidity', network: n, maxAmounts: { [S(n)]: '10', WETH: '0.003' }, range: { unit: 'full' }, feeTier: n === 'robinhood' ? 100 : 500 };
  }
}
/**
 * A sequence of actions placed from `start`: each step on the chain the previous bridge delivered to; each consumer bound to the latest earlier
 * producer of S on its own chain (a swap with such a producer spends S, else it delivers S). Null when an action does not exist on its network.
 */
function place(actions: readonly Action[], start: Net, to: Readonly<Record<Net, Net>> = TO_EVM): { steps: Spec[]; bindings: Binding[] } | null {
  let net = start;
  const steps: Spec[] = [], bindings: Binding[] = [], producers: { index: number; net: Net }[] = [];
  for (const [i, a] of actions.entries()) {
    if (!exists(net, a)) return null;
    const producer = producers.filter(p => p.net === net).at(-1);
    const form = a === 'swap' && !producer ? 'producer' : 'consumer';
    steps.push(stepOf(a, net, form, to));
    if (producer && CONSUMERS.has(a) && form === 'consumer') bindings.push({ step: i, amountFrom: producer.index });
    if (a === 'bridge') { producers.push({ index: i, net: to[net] }); net = to[net]; }
    else if (a === 'withdraw' || a === 'borrow' || a === 'swap' && form === 'producer') producers.push({ index: i, net });
  }
  return { steps, bindings };
}
/** A v2 strategy: `bindings` is present only when there is one (the schema refuses an empty list). */
const workflow = (steps: readonly Spec[], bindings: readonly Binding[] = []): Spec => ({ version: 2, steps, ...bindings.length ? { bindings } : {} });
const bind = (...pairs: [number, number][]): Binding[] => pairs.map(([step, amountFrom]) => ({ step, amountFrom }));

type Composed = { readonly ok: true; readonly requirement: WorkflowRequirement } | { readonly ok: false; readonly code: string };
/** The product's grammar: composition, then the requirement every surface plans from, bound to the composition's hash. */
function compose(strategy: Spec, fast = false): Composed {
  const composed = composeWorkflowBound(strategy, undefined);
  if (!composed.ok) return { ok: false, code: composed.code };
  const r = fast ? requirementOf(composed) : workflowRequirement(strategy, composed.workflowHash);
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, requirement: r.value };
}
const plan = (r: WorkflowRequirement, facts = FACTS, wallets = METAMASK): GroupPlan => planExecutionGroups(r, facts, wallets, userFundedBuildable(facts, OWNER));
const OWNER_STEP = new Set(['EVM_OWNER_STEP', 'SOLANA_OWNER_STEP']);
const BATCH = new Set(['EVM_WALLET_BATCH', 'SOLANA_SIGN_ALL', 'EVM_USER_OPERATION']);
const label = (g: ExecutionGroup) => `${({ EVM_WALLET_BATCH: 'B', EVM_USER_OPERATION: 'U', EVM_OWNER_STEP: 'O', SOLANA_SIGN_ALL: 'S', SOLANA_DURABLE_NONCE: 'N',
  SOLANA_OWNER_STEP: 'SO' } as const)[g.strategy]}${g.signing === 'WHEN_DUE' ? "'" : ''}[${g.stepFrom === g.stepTo ? g.stepFrom : `${g.stepFrom}-${g.stepTo}`}]`;
/** `B[0-1] O'[2] B'[3]  1+2`: groups (' = signed when due) and the interactions asked upfront + when due. */
const shapeOf = (p: Extract<GroupPlan, { ok: true }>) => `${p.groups.map(label).join(' ')}  ${p.interactions.upfront}+${p.interactions.whenDue}`;

/** Every invariant of a plan, against the requirement it was made from. Throws with the workflow's own description on the first violation. */
function checkPlan(r: WorkflowRequirement, p: GroupPlan, options: { readonly facts?: UserFundedFacts; readonly capable?: boolean } = {}):
  asserts p is Extract<GroupPlan, { ok: true }> {
  const facts = options.facts ?? FACTS, capable = options.capable ?? true;
  const where = r.steps.map(s => `${s.action}@${s.network}`).join(' → ') + ` ${JSON.stringify(r.bindings.map(b => [b.step, b.amountFrom]))}`;
  expect(p.ok, where).toBe(true);
  if (!p.ok) return;
  const groupOf = new Map<number, ExecutionGroup>();
  // (b) every step exactly once, in order; a group is one chain and one namespace; the fee payer is always the owner's own wallet.
  expect(p.groups.flatMap(g => g.steps.map(s => s.index)), where).toEqual(r.steps.map(s => s.index));
  for (const [i, g] of p.groups.entries()) {
    expect(g.index, where).toBe(i);
    expect(g.steps.map(s => s.index), where).toEqual(Array.from({ length: g.stepTo - g.stepFrom + 1 }, (_, k) => g.stepFrom + k));
    expect(new Set(g.steps.map(s => r.steps[s.index]!.chain)), where).toEqual(new Set([g.chain]));
    expect(g.namespace, where).toBe(g.chain.startsWith('solana:') ? 'solana' : 'eip155');
    expect(g.feePayer, where).toBe('OWNER_WALLET');
    for (const s of g.steps) { groupOf.set(s.index, g); expect(s.action, where).toBe(r.steps[s.index]!.action); }
  }
  // (b) a bound step spends its producer's guaranteed output inside its own group, or the RECONCILED actual amount of an earlier group's output —
  // a cross-chain delivery always — and such a group is signed when it becomes due, never upfront.
  for (const b of r.bindings) {
    const g = groupOf.get(b.step)!, s = g.steps.find(x => x.index === b.step)!, producer = r.steps[b.amountFrom]!;
    expect(s.boundTo, where).toBe(b.amountFrom);
    const sameGroup = groupOf.get(b.amountFrom) === g;
    expect(s.amount, where).toBe(sameGroup ? 'GUARANTEED_MINIMUM' : 'RECONCILED_ACTUAL');
    if (!sameGroup) expect(g.signing, where).toBe('WHEN_DUE');
    if (producer.action === 'bridge') { expect(sameGroup, where).toBe(false); expect(producer.destinationChain, where).toBe(g.chain); }
    // Solana never signs a transaction spending an output of its own group that has not landed (it could not be simulated first).
    if (g.namespace === 'solana') expect(sameGroup, where).toBe(false);
  }
  for (const s of r.steps) if (!r.bindings.some(b => b.step === s.index)) expect(groupOf.get(s.index)!.steps.find(x => x.index === s.index)!.amount, where).toBe('EXACT');
  // A group right after a bridge on its destination waits for that delivery; a wallet batch or sign-all group after the first is signed when due.
  for (const g of p.groups) {
    const before = p.groups[g.index - 1], last = before ? r.steps[before.stepTo]! : null;
    expect(g.awaitsDelivery, where).toBe(last?.action === 'bridge' && last.destinationChain === g.chain ? last.index : null);
    if (g.index > 0 && g.strategy !== 'EVM_USER_OPERATION') expect(g.signing, where).toBe('WHEN_DUE');
    if (OWNER_STEP.has(g.strategy)) expect(g.signing, where).toBe('WHEN_DUE');
  }
  // (c) a batchable step (every chain enabled, the wallet batches everywhere) is in a wallet batch / sign-all group; bridge and add_liquidity
  // stand alone in an owner-step group with their closed reason, whatever the wallet.
  for (const s of r.steps) {
    const g = groupOf.get(s.index)!;
    if (BATCHABLE[s.namespace].has(s.action as Action)) {
      if (!capable) continue;
      if (s.namespace === 'eip155') expect(evmStepBuildable(s, facts.chains, OWNER), where).toBeNull();
      expect(BATCH.has(g.strategy), `${where}: step ${s.index} ${s.action} in ${g.strategy} ${g.downgrades.join()}`).toBe(true);
    } else {
      expect([g.strategy, g.stepFrom, g.stepTo], where).toEqual([s.namespace === 'solana' ? 'SOLANA_OWNER_STEP' : 'EVM_OWNER_STEP', s.index, s.index]);
      expect(g.downgrades, where).toContain(OWNER_STEP_REASON[s.action as Action]);
    }
  }
  // (c) maximal groups: two consecutive batchable steps on one chain are cut apart only for a Solana step spending an output of its group — and
  // exactly that cut (one more wallet prompt, signed when the output landed) says so with its closed code, SOLANA_GROUP_STEP_DEPENDENT.
  for (let i = 1; capable && i < r.steps.length; i++) {
    const a = r.steps[i - 1]!, b = r.steps[i]!, ga = groupOf.get(i - 1)!;
    const sameChainBatchable = a.chain === b.chain && BATCHABLE[a.namespace].has(a.action as Action) && BATCHABLE[b.namespace].has(b.action as Action);
    const dependent = b.namespace === 'solana' && r.bindings.some(x => x.step === i && x.amountFrom >= ga.stepFrom);
    expect(groupOf.get(i) === ga, `${where}: steps ${i - 1}/${i}`).toBe(sameChainBatchable && !dependent);
    if (groupOf.get(i) !== ga) expect(groupOf.get(i)!.downgrades.includes('SOLANA_GROUP_STEP_DEPENDENT'), `${where}: group at ${i}`).toBe(sameChainBatchable && dependent);
  }
  expect(p.groups[0]!.downgrades, where).not.toContain('SOLANA_GROUP_STEP_DEPENDENT');
  // (d) the count is what the wallet is asked for: one prompt per batch / sign-all group, at least one per owner step; "single" only for ONE
  // group answered by ONE prompt with no owner step (whose own flow may ask more than once).
  for (const g of p.groups) expect(g.interactions, where).toBe(OWNER_STEP.has(g.strategy) ? g.steps.length : 1);
  const total = p.groups.reduce((n, g) => n + g.interactions, 0), i = p.interactions;
  expect(i.upfront + i.whenDue, where).toBe(total);
  expect(i.upfront, where).toBe(p.groups.filter(g => g.signing === 'UPFRONT').reduce((n, g) => n + g.interactions, 0));
  expect((i.perNamespace.eip155 ?? 0) + (i.perNamespace.solana ?? 0), where).toBe(total);
  expect(i.atLeast, where).toBe(p.groups.some(g => OWNER_STEP.has(g.strategy)));
  expect(i.single, where).toBe(p.groups.length === 1 && total === 1 && !i.atLeast);
  if (i.single) expect(p.groups, where).toHaveLength(1);
  const evm = p.groups.filter(g => g.namespace === 'eip155');
  expect(i.networkSwitches, where).toBe(evm.filter((g, k) => k > 0 && evm[k - 1]!.chain !== g.chain).length);
}

describe('P0 universal composition: every catalog action pair on every mainnet, through the real composer and planner', () => {
  it('every ordered pair composes as ordered steps; a binding is refused ONLY for its documented role; every plan keeps the invariants', () => {
    const refused: Record<string, string> = {}, shapes: string[] = [], bound = new Set<string>();
    let pairs = 0;
    for (const to of [TO_EVM, TO_SOLANA]) for (const net of NETS) for (const a of ACTIONS) for (const b of ACTIONS) {
      // The second destination map only adds the bridge-first pairs (a bridge into Solana or out of it); every other pair is the same.
      if (to === TO_SOLANA && a !== 'bridge') continue;
      const bNet = a === 'bridge' ? to[net] : net;
      if (!exists(net, a) || !exists(bNet, b)) continue;
      pairs++;
      // The first step delivers S where it can, the second spends S where it can: only the actions' roles decide whether they bind.
      const steps = [stepOf(a, net, 'producer', to), stepOf(b, bNet, 'consumer', to)];
      const expected = !CONSUMERS.has(b) ? 'WORKFLOW_BINDING_CONSUMER_UNSUPPORTED' : !PRODUCERS.has(a) ? 'WORKFLOW_BINDING_PRODUCER_UNSUPPORTED' : 'BOUND';
      const attempt = compose(workflow(steps, bind([1, 0])));
      const pair = `${a}→${b}`, at = `${pair} ${net}→${bNet}`;
      expect(attempt.ok ? 'BOUND' : attempt.code, at).toBe(expected);
      if (attempt.ok) bound.add(at);
      else { expect(refused[pair] ?? attempt.code, at).toBe(attempt.code); refused[pair] = attempt.code; }
      // Composed as ordered steps (each with its own amount) whatever the binding verdict.
      const used = attempt.ok ? attempt : compose(workflow(steps));
      if (!used.ok) throw new Error(`${at}: ${used.code}`);
      const p = plan(used.requirement);
      checkPlan(used.requirement, p);
      shapes.push(`${at} ${shapeOf(p)}`);
    }
    // 5 networks × the actions each has (Aave on Ethereum, Base and Arbitrum One only), plus the bridge-first pairs into and out of Solana.
    expect(pairs).toBe(256);
    expect(shapes).toHaveLength(pairs);
    // The table of pairs that do NOT bind (every one still composes and plans as ordered steps): the role is the only reason, on every network.
    expect(refused).toEqual(Object.fromEntries(ACTIONS.flatMap(a => ACTIONS.map(b => [`${a}→${b}`,
      !CONSUMERS.has(b) ? 'WORKFLOW_BINDING_CONSUMER_UNSUPPORTED' : !PRODUCERS.has(a) ? 'WORKFLOW_BINDING_PRODUCER_UNSUPPORTED' : null] as const)).filter(([, c]) => c !== null)));
    // The audit's own list (report §B) binds on EVERY network where both actions exist, a bridge's consumer on its destination.
    const audited: readonly [Action, Action][] = [['swap', 'swap'], ['swap', 'transfer'], ['swap', 'supply'], ['borrow', 'swap'], ['borrow', 'repay'], ['swap', 'add_liquidity'],
      ['withdraw', 'swap'], ['withdraw', 'transfer'], ['bridge', 'swap'], ['bridge', 'supply'], ['bridge', 'transfer'], ['swap', 'bridge'], ['bridge', 'bridge']];
    for (const [a, b] of audited) for (const to of [TO_EVM, TO_SOLANA]) for (const net of NETS) {
      const bNet = a === 'bridge' ? to[net] : net;
      if (exists(net, a) && exists(bNet, b)) expect(bound.has(`${a}→${b} ${net}→${bNet}`), `${a}→${b} ${net}→${bNet}`).toBe(true);
    }
    // Rejected for real reasons as AMOUNT bindings (Borrow and Withdraw take funds from Aave, not the wallet; Supply and Repay deliver nothing).
    for (const pair of ['supply→borrow', 'repay→withdraw', 'bridge→borrow']) expect(refused[pair]).toBe('WORKFLOW_BINDING_CONSUMER_UNSUPPORTED');
    console.info(`P0 universal composition: ${pairs} ordered pairs composed and planned (${bound.size} bound); pairs that compose only unbound, on every network:\n` +
      Object.entries(refused).map(([pair, code]) => `  ${pair.padEnd(28)} ${code}`).join('\n'));
  });

  it('every ordered triple from every network (bridges change the network), chained by the documented bindings, plans with the invariants', () => {
    let count = 0, boundTriples = 0, crossChain = 0;
    for (const net of NETS) for (const a of ACTIONS) for (const b of ACTIONS) for (const c of ACTIONS) {
      const placed = place([a, b, c], net);
      if (!placed) continue;
      count++;
      // The requirement straight from the composition (`requirementOf`, what `workflowRequirement` does after composing): one composition per
      // triple keeps 1,784 of them fast. The pairs above go through `workflowRequirement` itself, hash-bound.
      const composed = compose(workflow(placed.steps, placed.bindings), true);
      if (!composed.ok) throw new Error(`${a}→${b}→${c} from ${net}: ${composed.code}`);
      expect(composed.requirement.bindings.map(x => ({ step: x.step, amountFrom: x.amountFrom })), `${a}→${b}→${c} from ${net}`).toEqual(placed.bindings);
      if (placed.bindings.length) boundTriples++;
      if (new Set(composed.requirement.steps.map(s => s.chain)).size > 1) crossChain++;
      checkPlan(composed.requirement, plan(composed.requirement));
    }
    // Every combination of the 8 actions from each network where they exist (after a bridge, on its destination): 512 from each Aave network,
    // 124 from Robinhood Chain and from Solana (4 local actions, all 8 after a bridge). A bridge in the first two positions changes the network:
    // 120 triples from each Aave network, 88 from each of the other two.
    expect({ count, crossChain }).toEqual({ count: 3 * 512 + 2 * 124, crossChain: 3 * 120 + 2 * 88 });
    expect(boundTriples).toBeGreaterThan(count / 2);
    // About 5 s on a developer machine, ~90% of it the 5,352 real step compositions (planning and these checks take ~0.5 s): a wide margin keeps
    // a loaded CI runner from failing a deterministic test on time alone.
  }, 60_000);
});

const swap = (network: Net, inputAsset: string, outputAsset: string, amount: string, extra: Spec = {}) => ({ action: 'swap', network, inputAsset, outputAsset, amount, ...extra });
const aave = (action: 'supply' | 'borrow' | 'repay', network: Net, asset: string, amount: string, beneficiary = OWNER) => ({ action, network, asset, amount, beneficiary });
const withdraw = (network: Net, asset: string, amount: string) => ({ action: 'withdraw', network, asset, amount });
const send = (network: Net, asset: string, amount: string, recipient: string | undefined = network === 'solana' ? SOL_TO : EVM_TO) =>
  ({ action: 'transfer', network, asset, amount, ...recipient === undefined ? {} : { recipient } });
const bridge = (sourceNetwork: Net, destinationNetwork: Net, asset: string, amount: string, extra: Spec = {}) => ({ action: 'bridge', sourceNetwork, destinationNetwork, asset, amount, ...extra });
const pool = (network: Net, maxAmounts: Record<string, string>) => network === 'solana'
  ? { action: 'add_liquidity', network, maxAmounts, range: { unit: 'tick', lower: '-29952', upper: '-25600' } }
  : { action: 'add_liquidity', network, maxAmounts, range: { unit: 'full' } };
const BRIDGE_STEP = 'USER_FUNDED_ACTION_NOT_BUILDABLE:BRIDGE', LIQUIDITY_STEP = 'USER_FUNDED_ACTION_NOT_BUILDABLE:ADD_LIQUIDITY', NO_BUNDLER = 'USER_OPERATION_BUNDLER_UNAVAILABLE';
/** A deployment with an ERC-4337 bundler on Base (a delayed group may then be ONE typed-data signature given upfront). */
const BUNDLER_ON_BASE: UserFundedFacts = { ...FACTS, bundlerChains: ['eip155:8453'] };
type Expected = { readonly shape: string; readonly amounts: string; readonly waits: readonly (number | null)[]; readonly downgrades: readonly (readonly string[])[];
  readonly switches: number; readonly perNamespace: Partial<Record<'eip155' | 'solana', number>> };
/**
 * Representative workflows and exactly what the owner's wallets are asked: groups (B wallet batch, U user operation, O / SO owner step, S Solana
 * sign-all; ' = signed when due), interactions upfront + when due, each step's amount basis per group (E exact, G the producer's guaranteed
 * minimum in the same batch, R the reconciled actual amount), the delivery each group waits for, and every downgrade's closed reason.
 */
const REPRESENTATIVE: readonly (readonly [string, readonly Spec[], readonly Binding[], Expected, UserFundedFacts?])[] = [
  ['Arbitrum Swap → Supply → Borrow', [swap('arbitrum-one', 'USDC', 'WETH', '3'), aave('supply', 'arbitrum-one', 'WETH', '0.001'), aave('borrow', 'arbitrum-one', 'USDC', '1')],
    bind([1, 0]), { shape: 'B[0-2]  1+0', amounts: 'EGE', waits: [null], downgrades: [[]], switches: 0, perNamespace: { eip155: 1 } }],
  ['Arbitrum Repay → Withdraw → Swap', [aave('repay', 'arbitrum-one', 'USDC', '0.4'), withdraw('arbitrum-one', 'WETH', '0.0005'), swap('arbitrum-one', 'WETH', 'USDC', '0.0005')],
    bind([2, 1]), { shape: 'B[0-2]  1+0', amounts: 'EEG', waits: [null], downgrades: [[]], switches: 0, perNamespace: { eip155: 1 } }],
  ['Robinhood Swap WETH→USDG → Transfer', [swap('robinhood', 'WETH', 'USDG', '0.001'), send('robinhood', 'USDG', '2')],
    bind([1, 0]), { shape: 'B[0-1]  1+0', amounts: 'EG', waits: [null], downgrades: [[]], switches: 0, perNamespace: { eip155: 1 } }],
  ['Arbitrum Swap → Supply → Uniswap liquidity → Withdraw → Transfer', [swap('arbitrum-one', 'USDC', 'WETH', '3'), aave('supply', 'arbitrum-one', 'WETH', '0.0005'),
    pool('arbitrum-one', { USDC: '1', WETH: '0.001' }), withdraw('arbitrum-one', 'WETH', '0.0003'), send('arbitrum-one', 'WETH', '0.0003')], bind([1, 0], [2, 0], [4, 3]),
  { shape: "B[0-1] O'[2] B'[3-4]  1+2", amounts: 'EG|R|EG', waits: [null, null, null], downgrades: [[], [LIQUIDITY_STEP], []], switches: 0, perNamespace: { eip155: 3 } }],
  ['Ethereum Swap → Bridge to Base → Base Supply + Transfer of the delivery', [swap('ethereum', 'WETH', 'USDC', '0.002'), bridge('ethereum', 'base', 'USDC', '5'),
    aave('supply', 'base', 'USDC', '3'), send('base', 'USDC', '5')], bind([1, 0], [2, 1], [3, 1]),
  { shape: "B[0] O'[1] B'[2-3]  1+2", amounts: 'E|R|RR', waits: [null, null, 1], downgrades: [[], [BRIDGE_STEP], [NO_BUNDLER]], switches: 1, perNamespace: { eip155: 3 } }],
  ['Base Borrow → Bridge to Arbitrum → Swap the delivery → Supply its output', [aave('borrow', 'base', 'USDC', '2'), bridge('base', 'arbitrum-one', 'USDC', '2'),
    swap('arbitrum-one', 'USDC', 'WETH', '2'), aave('supply', 'arbitrum-one', 'WETH', '0.001')], bind([1, 0], [2, 1], [3, 2]),
  { shape: "B[0] O'[1] B'[2-3]  1+2", amounts: 'E|R|RG', waits: [null, null, 1], downgrades: [[], [BRIDGE_STEP], [NO_BUNDLER]], switches: 1, perNamespace: { eip155: 3 } }],
  ['Solana Swap + Transfer → Bridge to Arbitrum → Repay with the delivery', [swap('solana', 'SOL', 'USDC', '0.05'), send('solana', 'SOL', '0.01'),
    bridge('solana', 'arbitrum-one', 'USDC', '5'), aave('repay', 'arbitrum-one', 'USDC', '1')], bind([2, 0], [3, 2]),
  { shape: "S[0-1] SO'[2] B'[3]  1+2", amounts: 'EE|R|R', waits: [null, null, 2], downgrades: [[], [BRIDGE_STEP], [NO_BUNDLER]], switches: 0, perNamespace: { solana: 2, eip155: 1 } }],
  ['Robinhood Swap → Bridge to Solana → Jupiter swap + Orca liquidity of the delivery', [swap('robinhood', 'WETH', 'USDG', '0.002'), bridge('robinhood', 'solana', 'USDG', '5'),
    swap('solana', 'USDC', 'SOL', '2'), pool('solana', { SOL: '0.01', USDC: '1' })], bind([1, 0], [2, 1], [3, 1]),
  { shape: "B[0] O'[1] S'[2] SO'[3]  1+3", amounts: 'E|R|R|R', waits: [null, null, 1, null], downgrades: [[], [BRIDGE_STEP], ['SOLANA_DURABLE_NONCE_NOT_OFFERED'], [LIQUIDITY_STEP]],
    switches: 0, perNamespace: { eip155: 2, solana: 2 } }],
  ['Base Swap → Arbitrum Swap → Base Transfer (network changes, no bridge)', [swap('base', 'USDC', 'WETH', '5'), swap('arbitrum-one', 'USDC', 'WETH', '5'), send('base', 'WETH', '0.001')], [],
    { shape: "B[0] B'[1] B'[2]  1+2", amounts: 'E|E|E', waits: [null, null, null], downgrades: [[], [], []], switches: 2, perNamespace: { eip155: 3 } }],
  ['Solana Swap → Swap its output → Transfer the first output', [swap('solana', 'SOL', 'USDC', '0.05'), swap('solana', 'USDC', 'SOL', '2'), send('solana', 'USDC', '1')], bind([1, 0], [2, 0]),
    { shape: "S[0] S'[1-2]  1+1", amounts: 'E|RR', waits: [null, null], downgrades: [[], ['SOLANA_GROUP_STEP_DEPENDENT']], switches: 0, perNamespace: { solana: 2 } }],
  ['Arbitrum 8 steps: Swap, Supply, Borrow, Repay, Withdraw, Transfer, Uniswap liquidity, Swap', [swap('arbitrum-one', 'USDC', 'WETH', '3'), aave('supply', 'arbitrum-one', 'WETH', '0.001'),
    aave('borrow', 'arbitrum-one', 'USDC', '1'), aave('repay', 'arbitrum-one', 'USDC', '0.5'), withdraw('arbitrum-one', 'WETH', '0.0004'), send('arbitrum-one', 'WETH', '0.0004'),
    pool('arbitrum-one', { USDC: '0.5', WETH: '0.0002' }), swap('arbitrum-one', 'WETH', 'USDC', '0.0002')], bind([1, 0], [3, 2], [5, 4]),
  { shape: "B[0-5] O'[6] B'[7]  1+2", amounts: 'EGEGEG|E|E', waits: [null, null, null], downgrades: [[], [LIQUIDITY_STEP], []], switches: 0, perNamespace: { eip155: 3 } }],
  ['Solana Swap → Bridge to Ethereum → Ethereum Swap → Bridge to Robinhood → Robinhood Transfer', [swap('solana', 'SOL', 'USDC', '0.05'), bridge('solana', 'ethereum', 'USDC', '5'),
    swap('ethereum', 'USDC', 'WETH', '5'), bridge('ethereum', 'robinhood', 'USDC', '5'), send('robinhood', 'USDG', '5')], bind([1, 0], [2, 1], [4, 3]),
  { shape: "S[0] SO'[1] B'[2] O'[3] B'[4]  1+4", amounts: 'E|R|R|E|R', waits: [null, null, 1, null, 3], downgrades: [[], [BRIDGE_STEP], [NO_BUNDLER], [BRIDGE_STEP], [NO_BUNDLER]],
    switches: 1, perNamespace: { solana: 2, eip155: 3 } }],
  // One step: "single" only when one prompt surely authorizes it; an owner step's own flow may ask more than once (a token approval).
  ['Solana Transfer alone', [send('solana', 'USDC', '1')], [],
    { shape: 'S[0]  1+0', amounts: 'E', waits: [null], downgrades: [[]], switches: 0, perNamespace: { solana: 1 } }],
  ['Base Uniswap liquidity alone', [pool('base', { USDC: '10', WETH: '0.003' })], [],
    { shape: "O'[0]  0+1", amounts: 'E', waits: [null], downgrades: [[LIQUIDITY_STEP]], switches: 0, perNamespace: { eip155: 1 } }],
  // With a bundler on the destination, a delayed group that spends nothing of the delivery is ONE typed-data signature given upfront (relayed by
  // FloFi when the delivery lands, paid by the owner's account); one that spends the delivery is a wallet batch signed when due.
  ['Arbitrum Bridge → Base Transfer (bundler on Base, unbound)', [bridge('arbitrum-one', 'base', 'USDC', '5'), send('base', 'USDC', '5')], [],
    { shape: "O'[0] U[1]  1+1", amounts: 'E|E', waits: [null, 0], downgrades: [[BRIDGE_STEP], []], switches: 1, perNamespace: { eip155: 2 } }, BUNDLER_ON_BASE],
  ['Arbitrum Bridge → Base Transfer of the delivery (bundler on Base)', [bridge('arbitrum-one', 'base', 'USDC', '5'), send('base', 'USDC', '5')], bind([1, 0]),
    { shape: "O'[0] B'[1]  0+2", amounts: 'E|R', waits: [null, 0], downgrades: [[BRIDGE_STEP], ['WORKFLOW_BINDING_RESOLVED_WHEN_DUE']], switches: 1, perNamespace: { eip155: 2 } },
    BUNDLER_ON_BASE],
];

describe('P0 universal composition: representative workflows, their groups and the wallet interactions they need', () => {
  it('each representative workflow plans exactly as documented (MetaMask-like EVM wallet, Wallet Standard Solana wallet)', () => {
    const rows: string[] = [];
    for (const [name, steps, bindings, expected, facts = FACTS] of REPRESENTATIVE) {
      const c = compose(workflow(steps, bindings));
      if (!c.ok) throw new Error(`${name}: ${c.code}`);
      const p = plan(c.requirement, facts);
      checkPlan(c.requirement, p, { facts });
      const basis = { EXACT: 'E', GUARANTEED_MINIMUM: 'G', RECONCILED_ACTUAL: 'R' } as const;
      expect({ shape: shapeOf(p), amounts: p.groups.map(g => g.steps.map(s => basis[s.amount]).join('')).join('|'), waits: p.groups.map(g => g.awaitsDelivery),
        downgrades: p.groups.map(g => g.downgrades), switches: p.interactions.networkSwitches, perNamespace: p.interactions.perNamespace }, name).toEqual(expected);
      // Only a workflow whose every step one batch carries is a single wallet confirmation.
      expect(p.interactions.single, name).toBe(expected.shape.endsWith('  1+0') && p.groups.length === 1);
      rows.push(`  ${String(p.interactions.upfront + p.interactions.whenDue).padStart(2)} ${p.interactions.single ? '(single)' : p.interactions.atLeast ? '(at least)' : '         '} ${name}`);
    }
    console.info(`P0 universal composition: wallet interactions per representative workflow (upfront + when due):\n${rows.join('\n')}`);
  });

  it('the documented real reasons a binding is refused; each such workflow still composes as ordered steps with their own amounts', () => {
    const refusedAs = (steps: readonly Spec[], bindings: readonly Binding[]) => { const c = compose(workflow(steps, bindings)); return c.ok ? 'BOUND' : c.code; };
    const freely = (steps: readonly Spec[]) => {
      const c = compose(workflow(steps));
      if (!c.ok) throw new Error(c.code);
      checkPlan(c.requirement, plan(c.requirement), { capable: false });
      return true;
    };
    // Native ETH never funds Aave (the Pool takes WETH): an ETH output is not the WETH the supply spends; supplying ETH itself is refused.
    const ethThenSupply = [swap('arbitrum-one', 'USDC', 'ETH', '3'), aave('supply', 'arbitrum-one', 'WETH', '0.001')];
    expect(refusedAs(ethThenSupply, bind([1, 0]))).toBe('WORKFLOW_BINDING_ASSET_MISMATCH');
    expect(freely(ethThenSupply)).toBe(true);
    expect(refusedAs([aave('supply', 'arbitrum-one', 'ETH', '0.001')], [])).toBe('SUPPLY_DEPLOYMENT_UNSUPPORTED');
    // A bridge to an explicit third-party recipient funds nothing the owner can spend next.
    const toThirdParty = [bridge('arbitrum-one', 'base', 'USDC', '5', { recipient: EVM_TO }), send('base', 'USDC', '5')];
    expect(refusedAs(toThirdParty, bind([1, 0]))).toBe('WORKFLOW_BINDING_PRODUCER_UNSUPPORTED');
    expect(freely(toThirdParty)).toBe(true);
    // A binding across chains without a bridge: the same symbol on another chain is another token.
    for (const crossed of [[swap('base', 'WETH', 'USDC', '0.002'), aave('supply', 'arbitrum-one', 'USDC', '1')], [swap('solana', 'SOL', 'USDC', '0.05'), aave('repay', 'base', 'USDC', '1')]]) {
      expect(refusedAs(crossed, bind([1, 0]))).toBe('WORKFLOW_BINDING_ASSET_MISMATCH');
      expect(freely(crossed)).toBe(true);
    }
    // A transfer is never a producer, even to the owner's own wallet (no recipient: the connected owner receives it).
    const toSelf = [send('arbitrum-one', 'USDC', '1', undefined), swap('arbitrum-one', 'USDC', 'WETH', '1')];
    expect(refusedAs(toSelf, bind([1, 0]))).toBe('WORKFLOW_BINDING_PRODUCER_UNSUPPORTED');
    expect(freely(toSelf)).toBe(true);
    // Up to 8 steps: a ninth is refused by the schema, never silently dropped.
    const nine = Array.from({ length: 9 }, () => send('arbitrum-one', 'USDC', '1'));
    expect(refusedAs(nine.slice(0, 8), [])).toBe('BOUND');
    expect(refusedAs(nine, [])).toBe('STRATEGY_SCHEMA_INVALID');
  });

  it('a step FloFi cannot batch, or a wallet that cannot batch, runs step by step with its closed reason; the count says "at least"', () => {
    const planned = (steps: readonly Spec[], facts = FACTS, wallets = METAMASK) => {
      const c = compose(workflow(steps));
      if (!c.ok) throw new Error(c.code);
      const p = plan(c.requirement, facts, wallets);
      checkPlan(c.requirement, p, { facts, capable: false });
      return p;
    };
    const after = send('arbitrum-one', 'USDC', '1');
    const cases: readonly [string, Spec, string][] = [
      ['native ETH in a swap (the router\'s value path: the catalog swap\'s own flow)', swap('arbitrum-one', 'ETH', 'USDC', '0.001'), 'USER_FUNDED_NATIVE_SWAP_UNSUPPORTED'],
      ['a WETH9 wrap (not a Uniswap swap)', swap('arbitrum-one', 'ETH', 'WETH', '0.001'), 'USER_FUNDED_SWAP_ADAPTER_UNSUPPORTED'],
      ['an Aave position credited to another account', aave('supply', 'arbitrum-one', 'USDC', '1', '0x2222222222222222222222222222222222222222'), 'AAVE_BENEFICIARY_NOT_OWNER'],
    ];
    for (const [why, step, code] of cases) {
      const p = planned([step, after]);
      expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.downgrades]), why).toEqual([['EVM_OWNER_STEP', 0, 0, [code]], ['EVM_WALLET_BATCH', 1, 1, []]]);
      expect(p.interactions, why).toMatchObject({ upfront: 0, whenDue: 2, atLeast: true, single: false });
    }
    // Base's USDC ⇄ WETH reference swap accepts up to 5% slippage; a batch signs at most 3% (every catalog swap refuses more when composed).
    expect(planned([swap('base', 'USDC', 'WETH', '5', { slippageBps: 400 }), send('base', 'USDC', '1')]).groups.map(g => [g.strategy, g.downgrades]))
      .toEqual([['EVM_OWNER_STEP', ['WORKFLOW_SLIPPAGE_UNSUPPORTED']], ['EVM_WALLET_BATCH', []]]);
    expect(compose(workflow([swap('arbitrum-one', 'USDC', 'WETH', '5', { slippageBps: 301 })]))).toEqual({ ok: false, code: 'CATALOG_SWAP_SLIPPAGE_INVALID' });
    // A chain the deployment did not opt in: every step through its own flow, each a group of its own.
    const off = planned([swap('arbitrum-one', 'USDC', 'WETH', '3'), after], { ...FACTS, chains: FACTS.chains.filter(c => c !== 'eip155:42161') });
    expect(off.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.downgrades])).toEqual([['EVM_OWNER_STEP', 0, 0, ['USER_FUNDED_CHAIN_DISABLED']],
      ['EVM_OWNER_STEP', 1, 1, ['USER_FUNDED_CHAIN_DISABLED']]]);
    // The wallet decides: `unsupported` and unreported chains are confirmed per step (one group, one interaction per step, never "single").
    const batchable = [swap('arbitrum-one', 'USDC', 'WETH', '3'), aave('supply', 'arbitrum-one', 'WETH', '0.001'), after];
    for (const [atomic, code] of [['unsupported', 'WALLET_ATOMIC_BATCH_UNSUPPORTED'], [undefined, 'WALLET_ATOMIC_BATCH_UNKNOWN']] as const) {
      const wallets: WalletProfile = { ...METAMASK, eip155: { ...METAMASK.eip155!, atomic: atomic ? { 'eip155:42161': atomic } : {} } };
      const p = planned(batchable, FACTS, wallets);
      expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.interactions, g.downgrades])).toEqual([['EVM_OWNER_STEP', 0, 2, 3, [code]]]);
      expect(p.interactions).toMatchObject({ upfront: 0, whenDue: 3, atLeast: true, single: false });
    }
    // A Solana wallet without multi-transaction signing: one prompt per transaction.
    const solana = planned([swap('solana', 'SOL', 'USDC', '0.05'), send('solana', 'SOL', '0.01')], FACTS, { ...METAMASK, solana: { wallet: 'FLOFI_WALLET', signMultiple: false, nonceAccounts: 0 } });
    expect(solana.groups.map(g => [g.strategy, g.interactions, g.downgrades])).toEqual([['SOLANA_OWNER_STEP', 2, ['SOLANA_MULTI_SIGN_UNSUPPORTED']]]);
  });
});
