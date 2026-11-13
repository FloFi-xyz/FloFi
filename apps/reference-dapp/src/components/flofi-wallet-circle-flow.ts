// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (owner requirement: FloFi Wallet + Circle): the ORDER in which `/approve` — the page every MCP,
 * channel and chat approval opens — continues a FloFi Wallet owner-step group whose network fee Circle may pay. Nothing here signs, records or
 * sends by itself: each step is a server action or a wallet request that FloFi re-derives and verifies on the server.
 *
 *   ask first   before the group's first step is loaded into its own flow, the server is asked to prepare it (`prepare`). It prepares such a
 *               group ONLY as a Circle-paid operation (the owner's ETH short, Circle eligible). CIRCLE_NOT_NEEDED (the owner's ETH pays) or any
 *               other answer that is not a Circle preparation → the step is loaded exactly as before (`loadStep`); its own Review then shows
 *               its native fee, or its native shortfall. A transient answer (`CIRCLE_ASK_AGAIN`) is shown and nothing is loaded, so asking
 *               again can still find Circle (a loaded step never becomes a Circle-paid operation any more).
 *   consent     a Circle preparation planned from owner steps, nothing of which was signed yet, shows FloFi's consent card (`consent`) before
 *               the wallet is asked anything. "Not now" → `decline`: the preparation is withdrawn and the step loaded into its own flow (ETH
 *               pays); nothing is signed. Agreed → `authorize`: the upgrade authorization (first use only), the USDC permit, then the
 *               operation, each re-derived by the page and verified by the server (`signCirclePaidGroup`).
 */
import { circlePaymaster } from '@defi-workflow-engine/reference-compiler';
import { circleFactsOf } from '../user-funded/circle-facts';

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
/** What the server's preparation of a group returns (`PreparedGroupView`): the artifact and the run's wallet that signs it. */
export type PreparedCircleGroup = { readonly prepared: unknown; readonly feePayer: string };
/** What FloFi's consent card asks about: the network, whether the address is upgraded this time, and the fee's USDC cap (base units). */
export type CircleConsentOffer = { readonly chainId: number; readonly upgrade: boolean; readonly maxFee: string };

/** The networks where Circle's paymaster is pinned (Ethereum, Base, Arbitrum One): only there may a group's fee be paid in USDC through Circle. */
const circleChain = (chain: string) => /^eip155:[1-9][0-9]{0,18}$/.test(chain) && circlePaymaster.circlePinsOf(Number(chain.slice('eip155:'.length))) !== null;
type RunLike = { readonly mode: string | null; readonly state: string; readonly currentStep: number;
  readonly steps: readonly { readonly index: number; readonly state: string }[];
  readonly groups?: readonly { readonly index: number; readonly chain: string; readonly strategy: string; readonly state: string; readonly steps: readonly [number, number] }[] | null };
/**
 * The index of the run's current group when it must be asked about BEFORE its first step is loaded: the owner signs with FloFi Wallet (as this
 * browser reported it), the group is an EVM owner-step group on a Circle network, nothing of it was prepared, and none of its steps was loaded
 * into its own flow yet (PENDING or READY). Null for every other wallet, group or state: the step is loaded exactly as before.
 */
export function floFiWalletCircleGroup(run: RunLike, wallet: string | null | undefined): number | null {
  if (wallet !== 'FLOFI_WALLET' || run.mode !== 'USER_FUNDED' || !['RUNNING', 'ATTENTION'].includes(run.state)) return null;
  const g = (run.groups ?? []).find(x => x.steps[0] <= run.currentStep && run.currentStep <= x.steps[1]);
  if (!g || g.strategy !== 'EVM_OWNER_STEP' || g.state !== 'PLANNED' || g.steps[0] !== run.currentStep || !circleChain(g.chain)) return null;
  const steps = run.steps.filter(s => s.index >= g.steps[0] && s.index <= g.steps[1]);
  return steps.length === g.steps[1] - g.steps[0] + 1 && steps.every(s => s.state === 'PENDING' || s.state === 'READY') ? g.index : null;
}
/**
 * The consent a Circle preparation needs before anything of it is signed — only one planned from a FloFi Wallet group's owner steps whose upgrade
 * authorization, permit and operation are all still unsigned; null for any other artifact (another wallet's Circle fee is confirmed in that wallet).
 */
export function circleConsentOffer(prepared: unknown): CircleConsentOffer | null {
  const p = prepared && typeof prepared === 'object' ? prepared as Readonly<Record<string, unknown>> : null;
  const c = p?.kind === 'EVM_USER_OPERATION' ? circleFactsOf(p) : null;
  if (!c || c.plannedStrategy !== 'EVM_OWNER_STEP' || c.stage === 'OPERATION' || c.permitSignature || c.upgrade?.signature) return null;
  const chainId = Number(p!.chainId);
  return Number.isSafeInteger(chainId) && chainId > 0 ? { chainId, upgrade: Boolean(c.upgrade), maxFee: c.permitCap } : null;
}
/**
 * Answers of the server's preparation after which asking again may still find Circle: shown, and nothing is loaded (the owner asks again).
 * APPROVAL_FAILED is the server action's own unexpected failure.
 */
export const CIRCLE_ASK_AGAIN: ReadonlySet<string> = new Set(['USER_FUNDED_RPC_UNAVAILABLE', 'DELEGATION_RPC_UNAVAILABLE', 'WORKFLOW_RUN_CHANGED', 'EXECUTION_PAUSED',
  'EXECUTION_PAUSE_CONFIGURATION_INVALID', 'APPROVAL_FAILED']);

export type CircleGroupSteps<T> = {
  readonly consent: (offer: CircleConsentOffer) => Promise<boolean>;
  /** "Not now": the server withdraws the unsigned preparation and loads the group's first step into its own flow. */
  readonly decline: () => Promise<Answer<T>>;
  /** The signatures (the upgrade only when `agreed` was asked on this card), then the owner's answer for the group. */
  readonly authorize: (group: PreparedCircleGroup, agreed: boolean) => Promise<Answer<T>>;
};
export type OwnerStepCircleSteps<T> = CircleGroupSteps<T> & {
  readonly prepare: () => Promise<Answer<PreparedCircleGroup>>;
  /** The group's first step, loaded into its own flow exactly as before (`continueWorkflowRunHandoff`). */
  readonly loadStep: () => Promise<Answer<T>>;
};

/** A prepared Circle-paid group: FloFi's consent card first when it needs one ("Not now" signs nothing), then the signatures. */
export async function circlePaidGroup<T>(steps: CircleGroupSteps<T>, group: PreparedCircleGroup): Promise<Answer<T>> {
  const offer = circleConsentOffer(group.prepared);
  if (offer && !await steps.consent(offer)) return steps.decline();
  return steps.authorize(group, offer !== null);
}
/** A FloFi Wallet owner-step group the server may pay in USDC through Circle, asked about before its first step is loaded (see the header). */
export async function askCircleFirst<T>(steps: OwnerStepCircleSteps<T>): Promise<Answer<T>> {
  const prepared = await steps.prepare();
  if (!prepared.ok) return CIRCLE_ASK_AGAIN.has(prepared.code.split(':')[0]!) ? prepared : steps.loadStep();
  // The server prepares such a group only as a Circle-paid operation: anything else is never handed to the wallet from here.
  const p = prepared.value.prepared as Readonly<Record<string, unknown>> | null;
  if (p?.kind !== 'EVM_USER_OPERATION' || !circleFactsOf(p)) return { ok: false, code: 'USER_FUNDED_GROUP_NOT_PREPARABLE' };
  return circlePaidGroup(steps, prepared.value);
}
