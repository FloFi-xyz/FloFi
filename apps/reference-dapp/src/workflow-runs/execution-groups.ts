// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: execution groups and their user-funded authorization strategies — pure, deterministic, no I/O.
 *
 * A workflow run in mode USER_FUNDED is cut into execution groups. A group is a maximal run of consecutive steps that one wallet can
 * authorize with ONE interaction on ONE chain:
 *
 *   - every step of a group is on the same chain (so the same wallet namespace and the same fee-paying account);
 *   - a bridge ends its group (its output arrives on another chain, later);
 *   - a step FloFi cannot build exact calls/transactions for (see `USER_FUNDED_BUILDABLE`) is a group of its own, signed through its own
 *     flow exactly as in confirm-each-step mode (`*_OWNER_STEP`);
 *   - a step bound to an earlier step of the SAME group spends that producer's guaranteed output (a swap's signed minimum, a borrow's exact
 *     amount), fixed when the owner signs; anything received above it stays in the owner's wallet.
 *
 * A group is DELAYED when it waits for a cross-chain delivery (it follows a group that ends with a bridge). A delayed group is either signed
 * upfront with amounts fixed to the bridge's guaranteed minimum (`EVM_USER_OPERATION`, `SOLANA_DURABLE_NONCE`: FloFi submits it once the
 * delivery reconciled at or above that minimum, never before and never more), or signed when it becomes due, with the actually delivered
 * amount (`whenDue`). Nothing is ever signed with an estimate.
 *
 * Strategies (gas payer is ALWAYS the run's owner wallet on that chain — invariant S1; no paymaster, sponsor, relayer or FloFi account):
 *
 *   EVM_WALLET_BATCH       EIP-5792 `wallet_sendCalls` (atomic required, no capabilities): one wallet confirmation; the wallet signs and
 *                          sends from the owner's account. A wallet reporting `atomic: ready` upgrades the account to its own smart account
 *                          inside that same confirmation (one-time setup, shown by the wallet).
 *   EVM_USER_OPERATION     an ERC-4337 v0.7 user operation of the owner's own EIP-7702 MetaMask smart account, signed upfront as EIP-712
 *                          typed data (one signature); FloFi relays it through a bundler when due; the EntryPoint charges the gas to the
 *                          owner's account prefund. Needs an upgraded account and a bundler for that chain.
 *   EVM_OWNER_STEP         the step's own flow (simulate → review → wallet confirmation), one or more confirmations per step.
 *   SOLANA_SIGN_ALL        one wallet prompt signs every transaction of the group (Wallet Standard `solana:signTransaction` with several
 *                          inputs); FloFi submits them in order, each after the previous confirmed. Recent blockhashes: submitted at once.
 *   SOLANA_DURABLE_NONCE   the same, signed upfront with owner-controlled durable nonce accounts (one-time setup transaction, owner-paid
 *                          rent, refundable), so a delayed group stays valid until its delivery; revocable by advancing the nonce.
 *   SOLANA_OWNER_STEP      the step's own flow, one wallet prompt per transaction.
 *
 * The interaction count is reported per wallet and is never rounded down: one interaction is not one signature for every chain (an EVM
 * signature never authorizes a Solana transaction), and a network switch the wallet asks to confirm is counted separately.
 */
import type { StepRequirement, WorkflowRequirement } from '../delegation/steps.ts';

export type Namespace = 'eip155' | 'solana';
export const GROUP_STRATEGIES = ['EVM_WALLET_BATCH', 'EVM_USER_OPERATION', 'EVM_OWNER_STEP', 'SOLANA_SIGN_ALL', 'SOLANA_DURABLE_NONCE', 'SOLANA_OWNER_STEP'] as const;
export type GroupStrategy = (typeof GROUP_STRATEGIES)[number];
/** When the group's wallet interaction happens: before anything executes, or when the group becomes due (after its delivery reconciled). */
export type SigningTime = 'UPFRONT' | 'WHEN_DUE';
/** How a step's spend is fixed in what the owner signs. */
export type AmountBasis = 'EXACT' | 'GUARANTEED_MINIMUM' | 'RECONCILED_ACTUAL';

/**
 * The actions the user-funded builders produce exact, owner-signed calls/transactions for (`src/user-funded/*-calls.ts`). Anything else is
 * a group of its own through the step's flow. Keep in step with the builders: a capability is never advertised before it is built.
 */
export const USER_FUNDED_BUILDABLE: Readonly<Record<Namespace, ReadonlySet<string>>> = Object.freeze({
  eip155: new Set(['swap', 'supply', 'borrow', 'transfer']),
  solana: new Set(['transfer', 'swap']),
});

/** What the deployment offers (from `user-funded/config.ts`): opted-in chains and chains with an ERC-4337 bundler. */
export type UserFundedFacts = { readonly enabled: boolean; readonly code: string | null; readonly chains: readonly string[]; readonly bundlerChains: readonly string[];
  readonly solanaNonceAccounts: boolean };
/**
 * What the owner's wallets can do, as reported in the browser at `/approve` (EIP-5792 `wallet_getCapabilities`, Wallet Standard features).
 * Reports only choose the interaction; every artifact is still verified server-side (signer, account code, calls) before it is used.
 */
export type WalletProfile = {
  readonly eip155?: { readonly wallet: 'INJECTED' | 'FLOFI_WALLET';
    /** Per CAIP-2 chain: the wallet's EIP-5792 `atomic` capability status. Absent: unknown / not reported. */
    readonly atomic: Readonly<Record<string, 'supported' | 'ready' | 'unsupported'>>;
    /** The wallet signs EIP-712 typed data for the account's own user operations. */
    readonly typedData: boolean };
  readonly solana?: { readonly wallet: 'WALLET_STANDARD' | 'FLOFI_WALLET';
    /** The wallet signs several transactions in one prompt. */
    readonly signMultiple: boolean;
    /** Owner-controlled durable nonce accounts already initialized for this wallet (FloFi reads them on chain). */
    readonly nonceAccounts: number };
};
/** What the owner's wallet returned for a prepared group (verified server-side against the frozen artifact before it is used). */
export type OwnerAnswer = { readonly kind: 'EVM_WALLET_BATCH'; readonly batchId: string } | { readonly kind: 'EVM_USER_OPERATION'; readonly signature: string }
  | { readonly kind: 'SOLANA_SIGN_ALL'; readonly transactions: readonly string[] };
export type GroupStep = { readonly index: number; readonly action: string; readonly amount: AmountBasis; readonly boundTo: number | null };
export type ExecutionGroup = {
  readonly index: number; readonly namespace: Namespace; readonly chain: string; readonly steps: readonly GroupStep[];
  readonly stepFrom: number; readonly stepTo: number;
  readonly strategy: GroupStrategy; readonly signing: SigningTime;
  /** Waits for the cross-chain delivery of this bridge step (its reconciled received amount on this group's chain). */
  readonly awaitsDelivery: number | null;
  /** Wallet interactions this group needs from its owner (never rounded down). */
  readonly interactions: number;
  /** One-time account setup this group may need before its first use (shown by the wallet itself, owner-paid). */
  readonly setup: readonly ('EVM_SMART_ACCOUNT_UPGRADE' | 'SOLANA_NONCE_ACCOUNTS')[];
  /** Why a cheaper strategy was not chosen (closed codes), empty when the best one applies. */
  readonly downgrades: readonly string[];
  /** The fee payer: always the run's owner wallet on this namespace (S1). */
  readonly feePayer: 'OWNER_WALLET';
};
export type InteractionSummary = {
  readonly upfront: number; readonly whenDue: number;
  readonly perNamespace: Readonly<Partial<Record<Namespace, number>>>;
  /** EVM network changes between consecutive EVM groups (a wallet may ask to confirm each). */
  readonly networkSwitches: number;
  readonly oneTimeSetup: readonly ('EVM_SMART_ACCOUNT_UPGRADE' | 'SOLANA_NONCE_ACCOUNTS')[];
  /** True when a step runs through its own flow: its count is a minimum (a token approval or a bridge deposit may add a confirmation). */
  readonly atLeast: boolean;
  /** True only when exactly one wallet interaction (one wallet, one chain) authorizes everything. */
  readonly single: boolean;
};
export type GroupPlan = { readonly ok: true; readonly groups: readonly ExecutionGroup[]; readonly interactions: InteractionSummary }
  | { readonly ok: false; readonly code: string };

const namespaceOfChain = (chain: string): Namespace => chain.startsWith('solana:') ? 'solana' : 'eip155';
/** Default buildability: the action is in `USER_FUNDED_BUILDABLE` and spends at most one asset. Callers may narrow it further per step. */
export const defaultBuildable = (s: StepRequirement): boolean => USER_FUNDED_BUILDABLE[s.namespace].has(s.action) && s.inputs.length <= 1;

/** Consecutive same-chain buildable steps form one candidate group; a bridge closes its group; any other step stands alone. */
function partition(steps: readonly StepRequirement[], buildable: (s: StepRequirement) => boolean, bindings: WorkflowRequirement['bindings']): StepRequirement[][] {
  const out: StepRequirement[][] = [];
  let current: StepRequirement[] = [];
  const close = () => { if (current.length) out.push(current); current = []; };
  for (const step of steps) {
    const last = current.at(-1);
    // Solana: every transaction of a sign-all group is simulated before the owner signs, so a step that spends the output of an earlier step
    // of the same group (not yet on chain) starts a group of its own. EVM groups keep it: the batch enforces the producer's signed minimum.
    const dependsInside = step.namespace === 'solana' && bindings.some(b => b.step === step.index && current.some(c => c.index === b.amountFrom));
    const joinable = last && !dependsInside && buildable(step) && buildable(last) && last.chain === step.chain && last.action !== 'bridge';
    if (!joinable) close();
    current.push(step);
    if (!buildable(step) || step.action === 'bridge') close();
  }
  close();
  return out;
}

/**
 * The execution groups of a workflow for these wallets on this deployment. Without a wallet profile (before `/approve`) the plan assumes the
 * capable wallet families FloFi supports report their documented capabilities, and says so (`assumed`) — the binding plan is the one made
 * with the owner's real wallet.
 */
export function planExecutionGroups(requirement: WorkflowRequirement, facts: UserFundedFacts, wallets?: WalletProfile,
  isBuildable: (s: StepRequirement) => boolean = defaultBuildable): GroupPlan {
  const buildable = (s: StepRequirement) => defaultBuildable(s) && isBuildable(s);
  if (!facts.enabled) return { ok: false, code: facts.code ?? 'USER_FUNDED_NOT_ENABLED' };
  if (requirement.steps.length < 1) return { ok: false, code: 'WORKFLOW_STEPS_EMPTY' };
  const assumed = !wallets;
  const profile: WalletProfile = wallets ?? {
    eip155: { wallet: 'INJECTED', atomic: Object.fromEntries(facts.chains.filter(c => c.startsWith('eip155:')).map(c => [c, 'supported' as const])), typedData: true },
    solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 },
  };
  const bindingOf = (index: number) => requirement.bindings.find(b => b.step === index) ?? null;
  const groups: ExecutionGroup[] = [];
  let stepCursor = 0;
  for (const members of partition(requirement.steps, buildable, requirement.bindings)) {
    const first = members[0]!, chain = first.chain, namespace = namespaceOfChain(chain);
    if (first.index !== stepCursor) return { ok: false, code: 'WORKFLOW_GROUP_ORDER_INVALID' };
    stepCursor = members.at(-1)!.index + 1;
    const previous = groups.at(-1);
    const previousLast = previous ? requirement.steps[previous.stepTo]! : null;
    const awaitsDelivery = previousLast && previousLast.action === 'bridge' && previousLast.destinationChain === chain ? previousLast.index : null;
    const downgrades: string[] = [];
    const chainEnabled = facts.chains.includes(chain);
    if (!chainEnabled) downgrades.push('USER_FUNDED_CHAIN_DISABLED');
    const allBuildable = members.every(buildable);
    if (!allBuildable) downgrades.push(`USER_FUNDED_ACTION_NOT_BUILDABLE:${members.find(m => !buildable(m))!.action.toUpperCase()}`);
    let strategy: GroupStrategy, signing: SigningTime = 'UPFRONT';
    const setup: ExecutionGroup['setup'][number][] = [];
    if (namespace === 'eip155') {
      const evm = profile.eip155;
      const atomic = evm?.atomic[chain] ?? null;
      const canBatch = chainEnabled && allBuildable && (atomic === 'supported' || atomic === 'ready');
      // A user operation needs the account to ALREADY be a smart account (`supported`): a typed-data signature cannot upgrade it, and an
      // operation signed for a plain account is only refused by the bundler after the delivery landed.
      const canUserOp = chainEnabled && allBuildable && evm?.wallet === 'INJECTED' && evm.typedData && facts.bundlerChains.includes(chain) && atomic === 'supported';
      // P0 workflow execution: an Aave step is only ever signed after FloFi simulated its exact calls on the chain state they run on (health factor
      // at least 2.0 after a borrow, the supply cap). A user operation is signed upfront and relayed later, so such a group is a wallet batch
      // prepared, simulated and signed when due instead.
      const aave = members.some(m => m.action === 'supply' || m.action === 'borrow');
      if (awaitsDelivery !== null) {
        if (canUserOp && !aave) strategy = 'EVM_USER_OPERATION';
        else {
          if (chainEnabled && allBuildable) downgrades.push(canUserOp ? 'USER_OPERATION_AAVE_SIGNED_WHEN_DUE' : !facts.bundlerChains.includes(chain) ? 'USER_OPERATION_BUNDLER_UNAVAILABLE'
            : evm?.wallet !== 'INJECTED' || !evm.typedData ? 'WALLET_TYPED_DATA_USER_OPERATION_UNSUPPORTED' : 'EVM_SMART_ACCOUNT_REQUIRED');
          strategy = canBatch ? 'EVM_WALLET_BATCH' : 'EVM_OWNER_STEP'; signing = 'WHEN_DUE';
        }
      } else if (canBatch) strategy = 'EVM_WALLET_BATCH';
      else { if (chainEnabled && allBuildable) downgrades.push(atomic === 'unsupported' ? 'WALLET_ATOMIC_BATCH_UNSUPPORTED' : 'WALLET_ATOMIC_BATCH_UNKNOWN'); strategy = 'EVM_OWNER_STEP'; }
      if (strategy === 'EVM_WALLET_BATCH' && atomic === 'ready') setup.push('EVM_SMART_ACCOUNT_UPGRADE');
    } else {
      const sol = profile.solana;
      const canSignAll = chainEnabled && allBuildable && sol?.signMultiple === true;
      // Durable nonces (SOLANA_DURABLE_NONCE) are not offered in this build (ADR-0008): FloFi's Solana builders need the input balance to
      // simulate the exact message, which a post-delivery group does not have yet. Such a group is signed when due (one more interaction).
      if (awaitsDelivery !== null) {
        if (canSignAll) downgrades.push('SOLANA_DURABLE_NONCE_NOT_OFFERED');
        strategy = canSignAll ? 'SOLANA_SIGN_ALL' : 'SOLANA_OWNER_STEP'; signing = 'WHEN_DUE';
      } else strategy = canSignAll ? 'SOLANA_SIGN_ALL' : 'SOLANA_OWNER_STEP';
      if (chainEnabled && allBuildable && !canSignAll) downgrades.push('SOLANA_MULTI_SIGN_UNSUPPORTED');
    }
    const ownerStep = strategy === 'EVM_OWNER_STEP' || strategy === 'SOLANA_OWNER_STEP';
    // An owner step is its flow's own confirmation(s): at least one per step (a token approval may add one more, which the flow shows).
    if (ownerStep) signing = 'WHEN_DUE';
    // Only the first group, or a user operation (relayed by FloFi when due), is signed upfront. A later wallet batch is SENT by the wallet when
    // the owner confirms (it would run before the groups ahead of it) and a Solana blockhash lives about a minute: both are signed when due.
    if (first.index > 0 && (strategy === 'EVM_WALLET_BATCH' || strategy === 'SOLANA_SIGN_ALL')) signing = 'WHEN_DUE';
    const steps: GroupStep[] = members.map(m => {
      const b = bindingOf(m.index);
      const sameGroup = b !== null && b.amountFrom >= first.index;
      // A bridge is executed through its own flow (its route is quoted when it runs), so a delivery's guaranteed minimum is not known when the
      // owner authorizes upfront: a step bound to an earlier group spends the reconciled actual amount and is signed when it becomes due.
      const amount: AmountBasis = !b ? 'EXACT' : sameGroup ? 'GUARANTEED_MINIMUM' : 'RECONCILED_ACTUAL';
      return { index: m.index, action: m.action, amount, boundTo: b?.amountFrom ?? null };
    });
    // A step bound to an earlier group that is not this group's own delivery (e.g. two hops back) is resolved when due, from reconciled facts.
    if (signing === 'UPFRONT' && steps.some(s => s.amount === 'RECONCILED_ACTUAL')) {
      downgrades.push('WORKFLOW_BINDING_RESOLVED_WHEN_DUE'); signing = 'WHEN_DUE';
      if (strategy === 'EVM_USER_OPERATION') strategy = profile.eip155?.atomic[chain] === 'supported' || profile.eip155?.atomic[chain] === 'ready' ? 'EVM_WALLET_BATCH' : 'EVM_OWNER_STEP';
    }
    const interactions = ownerStep ? members.length : 1;
    groups.push({ index: groups.length, namespace, chain, steps, stepFrom: first.index, stepTo: members.at(-1)!.index, strategy, signing, awaitsDelivery,
      interactions, setup: [...new Set(setup)], downgrades: assumed ? [...downgrades, 'WALLET_CAPABILITIES_ASSUMED'] : downgrades, feePayer: 'OWNER_WALLET' });
  }
  return { ok: true, groups, interactions: summarize(groups) };
}

export function summarize(groups: readonly ExecutionGroup[]): InteractionSummary {
  const perNamespace: Partial<Record<Namespace, number>> = {};
  let upfront = 0, whenDue = 0, networkSwitches = 0, lastEvmChain: string | null = null;
  for (const g of groups) {
    perNamespace[g.namespace] = (perNamespace[g.namespace] ?? 0) + g.interactions;
    if (g.signing === 'UPFRONT') upfront += g.interactions; else whenDue += g.interactions;
    if (g.namespace === 'eip155') { if (lastEvmChain && lastEvmChain !== g.chain) networkSwitches++; lastEvmChain = g.chain; }
  }
  const oneTimeSetup = [...new Set(groups.flatMap(g => g.setup))];
  const atLeast = groups.some(g => g.strategy === 'EVM_OWNER_STEP' || g.strategy === 'SOLANA_OWNER_STEP');
  // One interaction means exactly that: one group, one wallet prompt, no setup prompt of its own (an in-confirmation upgrade is not a prompt),
  // and no step whose own flow may ask more than once.
  const single = upfront + whenDue === 1 && !oneTimeSetup.includes('SOLANA_NONCE_ACCOUNTS') && !atLeast;
  return { upfront, whenDue, perNamespace, networkSwitches, oneTimeSetup, single, atLeast };
}

/** The groups' public description (MCP, channels, the review): codes only, never a key, calldata or signature. */
export function describeGroup(g: ExecutionGroup): string {
  const steps = g.stepFrom === g.stepTo ? `step ${g.stepFrom + 1}` : `steps ${g.stepFrom + 1}–${g.stepTo + 1}`;
  const how: Record<GroupStrategy, string> = {
    EVM_WALLET_BATCH: 'one wallet confirmation (atomic batch)', EVM_USER_OPERATION: 'one typed-data signature now; FloFi relays it when the delivery lands',
    EVM_OWNER_STEP: 'one wallet confirmation per step', SOLANA_SIGN_ALL: 'one Solana wallet prompt for every transaction',
    SOLANA_DURABLE_NONCE: 'one Solana wallet prompt now (durable nonces); FloFi submits when the delivery lands', SOLANA_OWNER_STEP: 'one Solana wallet prompt per step',
  };
  return `${steps} on ${g.chain}: ${how[g.strategy]}${g.signing === 'WHEN_DUE' && g.strategy !== 'EVM_USER_OPERATION' && g.strategy !== 'SOLANA_DURABLE_NONCE' && g.awaitsDelivery !== null ? ', when the delivery lands' : ''}; fees paid by your own wallet.`;
}
