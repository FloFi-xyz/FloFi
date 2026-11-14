// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-DEVELOPER-001: FloFi's approval surface (`/approve`), for every requester kind — moved out of the BUILD-MCP-002 server actions
 * so it no longer presumes an MCP requester or MCP OAuth. The page's server actions are thin adapters over these functions.
 *
 * A browser holds an approval secret (from the URL fragment, never sent in a URL to a server). It may SEE the proposal. To CLAIM it, the
 * browser must hold a proven wallet session of the namespace the workflow needs (EIP-4361 or Sign-In With Solana, verified server-side
 * from HttpOnly cookies — never a client-supplied address), and the requester kind's claim policy must accept that wallet. The
 * stored strategy is re-composed with the current engine and must reproduce its workflow hash; the requester kind's handoff policy
 * and the deployment are re-evaluated. The result is the same authoring command FloFi's own chat produces, which then enters FloFi's
 * existing proposal → flow → fresh simulation → Strategy Manifest Review → wallet signature path. Nothing here builds, signs or sends.
 *
 * A deployment's surface is assembled from per-surface CONTRIBUTIONS (each: an approval-link scheme and the profiles of the requester
 * kinds it serves); a requester kind without a profile, or a secret no registered scheme owns, is simply not found.
 */
import { isReviewedGas } from '../editor/authorize-binding.ts';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import type { HandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import { resolveApprovalSecret, type ApprovalLinkScheme } from './approval-links.ts';
import { approvalView, CLAIM_SECONDS, openApprovalSession, planNamespace, planNamespaces, verifyHandoff, type ApprovalView, type ClaimedProposal } from './approvals.ts';
import { authorizationReviewSequential, authorizeSequential, cancelSequential, claimSequential, continueSequential, ownedRun, resumeSequential, startSequential,
  statusSequential, type WorkflowRunClaim, type WorkflowRunSurface, userFundedAuthorizeSequential, userFundedConsentSequential, userFundedDeclineSequential,
  userFundedPermitSequential, userFundedPrepareSequential, userFundedUpgradeSequential,
  userFundedReportSequential, userFundedStartSequential } from './workflow-run-approvals.ts';
import type { OwnerAnswer, WalletProfile } from '../workflow-runs/execution-groups.ts';
import type { ApprovalRequesterKind, HandoffRecord, HandoffStore, RequesterScope, WalletRef } from './handoff-store.ts';
import { refuse } from './refusal.ts';

/** A requester kind's own rule for who may claim its handoffs (e.g. only an intended wallet). Evaluated on the handoff's immutable data. */
export type ClaimPolicy = (handoff: HandoffRecord, wallet: WalletRef) => Promise<ClaimVerdict> | ClaimVerdict;
export type ClaimVerdict = { readonly ok: true } | { readonly ok: false; readonly code: string };
/** How /approve treats one requester kind. */
export type ApprovalKindProfile = {
  /** The kind's handoff policy (test funds, mainnet networks), re-evaluated whenever its handoff is viewed or claimed. */
  readonly policy: HandoffPolicy;
  /** An extra claim rule of this kind; none means any proven wallet of the workflow's namespace may claim. */
  readonly claimPolicy?: ClaimPolicy;
  /** The requester this browser itself is, if any (an MCP account's own browser): its status sharing defaults on. */
  readonly viewerRequester?: () => Promise<RequesterScope | null>;
};
export type ApprovalContribution = { readonly scheme: ApprovalLinkScheme; readonly profiles: Partial<Readonly<Record<ApprovalRequesterKind, ApprovalKindProfile>>> };
/** Where the deployment's approval handoffs live, and how a contribution reads this request's cookies (its own sign-in cookie, if any). */
export type ApprovalHost = { readonly db: Database; readonly tenantId: string };
export type CookieReader = (name: string) => string | undefined;
/** One FloFi surface's part of /approve, built per request; `null` from its factory when the surface is not enabled. */
export type ApprovalContributor = (host: ApprovalHost, cookie: CookieReader) => ApprovalContribution;
export type ApprovalSurface = { readonly schemes: readonly ApprovalLinkScheme[]; readonly profiles: Partial<Readonly<Record<ApprovalRequesterKind, ApprovalKindProfile>>>;
  readonly handoffs: HandoffStore; readonly runtime: EngineRuntime;
  /** BUILD-CHAT-E2E-001: workflow runs (multi-step workflows), where this deployment enables them; absent: a sequence is refused. */
  readonly workflowRuns?: WorkflowRunSurface | null };

/**
 * One surface from the deployment's contributions. Every scheme prefix and every requester kind is owned by exactly one contribution,
 * and a contribution may only describe kinds its own scheme serves; anything else is `APPROVAL_SURFACE_INVALID` (fail closed).
 */
export function assembleApprovalSurface(contributions: readonly ApprovalContribution[], handoffs: HandoffStore, runtime: EngineRuntime,
  workflowRuns: WorkflowRunSurface | null = null): ApprovalSurface {
  const prefixes = new Set<string>(), kinds = new Set<string>(), profiles: Partial<Record<ApprovalRequesterKind, ApprovalKindProfile>> = {};
  for (const { scheme, profiles: own } of contributions) {
    if (prefixes.has(scheme.prefix)) throw new Error('APPROVAL_SURFACE_INVALID');
    prefixes.add(scheme.prefix);
    for (const kind of scheme.kinds) { if (kinds.has(kind)) throw new Error('APPROVAL_SURFACE_INVALID'); kinds.add(kind); }
    for (const [kind, profile] of Object.entries(own) as [ApprovalRequesterKind, ApprovalKindProfile][]) {
      if (!scheme.kinds.includes(kind)) throw new Error('APPROVAL_SURFACE_INVALID');
      profiles[kind] = profile;
    }
  }
  return Object.freeze({ schemes: Object.freeze(contributions.map(c => c.scheme)), profiles: Object.freeze(profiles), handoffs, runtime, workflowRuns });
}

type Located = { readonly handoff: HandoffRecord; readonly digest: Buffer; readonly kinds: readonly ApprovalRequesterKind[]; readonly profile: ApprovalKindProfile };
/** The handoff behind a presented secret, limited to the kinds of the scheme that owns the secret; unknown in every other case. */
async function locate(surface: ApprovalSurface, secret: unknown, now: Date): Promise<Located> {
  const resolved = resolveApprovalSecret(surface.schemes, secret) ?? refuse('HANDOFF_NOT_FOUND');
  const handoff = await surface.handoffs.bySecret(resolved.digest, now, resolved.kinds) ?? refuse('HANDOFF_NOT_FOUND');
  const profile = surface.profiles[handoff.requesterKind] ?? refuse('HANDOFF_NOT_FOUND');
  return { handoff, digest: resolved.digest, kinds: resolved.kinds, profile };
}
const viewerOf = async (profile: ApprovalKindProfile, wallets: readonly WalletRef[]) => ({ wallets, requester: await profile.viewerRequester?.() ?? null });
const claimantOf = (h: HandoffRecord, wallets: readonly WalletRef[]) =>
  wallets.find(w => w.namespace === h.claimed?.namespace && w.address === h.claimed.address) ?? refuse('HANDOFF_NOT_FOUND');

/** Nonsecret MCP fallback. Only the creating account's existing HttpOnly OAuth cookie can turn an id into a handoff session. */
export async function openBrowserApproval(surface: ApprovalSurface, approvalId: unknown, origin: string) {
  if (typeof approvalId !== 'string' || !/^apr_[a-z2-7]{26}$/.test(approvalId)) return refuse('HANDOFF_NOT_FOUND');
  const scope = await surface.profiles.MCP_ACCOUNT?.viewerRequester?.();
  if (!scope || scope.kind !== 'MCP_ACCOUNT') return refuse('APPROVAL_ACCOUNT_REQUIRED');
  const h = await surface.handoffs.forRequester(approvalId, scope, new Date()) ?? refuse('HANDOFF_NOT_FOUND');
  const scheme = surface.schemes.find(s => s.kinds.includes('MCP_ACCOUNT')) ?? refuse('HANDOFF_NOT_FOUND');
  return openApprovalSession({ origin, scheme, handoffs: surface.handoffs }, { kind: 'MCP_ACCOUNT', ref: scope.ref,
    grantId: h.grantId!, clientId: h.clientId, displayName: h.clientName }, approvalId);
}

/** An APPLIED link is consumed. Recovery uses its public id plus the claimant's proven wallet, re-verifying the exact proposal.
 * No capability is reissued, no status changes, no simulation/Review/authorization survives a reload. */
export async function resumeApproval(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  if (typeof approvalId !== 'string' || !/^apr_[a-z2-7]{26}$/.test(approvalId)) return refuse('HANDOFF_NOT_FOUND');
  let h: HandoffRecord | null = null;
  for (const wallet of wallets) { h = await surface.handoffs.forClaimant(approvalId, wallet); if (h) break; }
  if (!h) return refuse('HANDOFF_NOT_FOUND');
  const profile = surface.profiles[h.requesterKind] ?? refuse('HANDOFF_NOT_FOUND');
  // BUILD-CHAT-E2E-001: a sequence resumes at its run's current step (each step was re-verified when it became ready).
  if (h.plan.kind === 'SEQUENTIAL') {
    const runs = surface.workflowRuns ?? refuse('WORKFLOW_RUNS_NOT_ENABLED');
    return continueSequential(runs, await ownedRun(runs, h.handoffId, wallets), wallets, approvalView(h, null, await viewerOf(profile, wallets)));
  }
  const verified = await verifyHandoff(h, surface.runtime, profile.policy);
  if (!verified.ok) return refuse(verified.code);
  return { view: approvalView(h, verified, await viewerOf(profile, wallets)), command: verified.composition.command,
    workflow: verified.composition.workflow, workflowHash: verified.composition.workflowHash, workflowId: verified.composition.workflow.workflowId };
}

/** The proposal behind a secret, re-verified now. Seeing it grants nothing. */
export async function viewApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], now = new Date()):
  Promise<ApprovalView & { readonly workflowRun?: WorkflowRunClaim }> {
  const { handoff: h, profile } = await locate(surface, secret, now);
  const sequenceStarted = h.plan.kind === 'SEQUENTIAL' && h.status !== 'PENDING';
  const verified = !sequenceStarted && (h.status === 'PENDING' || h.status === 'CLAIMED' || h.status === 'APPLIED') ? await verifyHandoff(h, surface.runtime, profile.policy) : null;
  const view = approvalView(h, verified, await viewerOf(profile, wallets));
  // BUILD-CHAT-E2E-001: once a sequence's run exists, its owner (and only its owner) sees the run here.
  const run = sequenceStarted && surface.workflowRuns ? await surface.workflowRuns.store.byHandoff(h.handoffId) : null;
  if (!run || !surface.workflowRuns) return view;
  try { return (await statusSequential(surface.workflowRuns, await ownedRun(surface.workflowRuns, h.handoffId, wallets), wallets, view)).view; }
  catch { return view; }
}

/** BUILD-FLOFI-UX-UI-002: what FloFi needs to show an open proposal on its normal Canvas before the owner proves a wallet. */
export type ApprovalPreview = { readonly approvalId: string; readonly workflow: Workflow; readonly workflowHash: string;
  /** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: a multi-step proposal's canonical strategy (what the requester composed), so the whole workflow can open in the Canvas. */
  readonly sequence?: { readonly strategy: unknown; readonly workflowHash: string; readonly stepCount: number } };
/**
 * The canonical workflow of an open (PENDING) proposal, for whoever holds its secret — the cards FloFi shows on the Canvas while the
 * owner connects a wallet. It is re-composed now and must reproduce the stored hash under the current deployment and policy (as `view`
 * and `claim` do). Previewing changes no state and grants nothing: claiming still needs the proven wallet and the requester's claim rule,
 * applying still needs the exact hash, and the fresh simulation, Review and signatures stay separate. A claimed, applied or ended
 * proposal is refused (`APPROVAL_PREVIEW_CLAIMED`, `APPROVAL_<STATUS>`): from then on only its proven claimant loads it, through claim
 * or recovery.
 */
export async function previewApproval(surface: ApprovalSurface, secret: unknown, now = new Date()): Promise<ApprovalPreview> {
  const { handoff: h, profile } = await locate(surface, secret, now);
  if (h.status !== 'PENDING') return refuse(h.status === 'CLAIMED' || h.status === 'APPLIED' ? 'APPROVAL_PREVIEW_CLAIMED' : `APPROVAL_${h.status}`);
  const verified = await verifyHandoff(h, surface.runtime, profile.policy);
  if (!verified.ok) return refuse(verified.code);
  return { approvalId: h.handoffId, workflow: verified.composition.workflow, workflowHash: verified.composition.workflowHash,
    ...verified.workflow.steps.length > 1 ? { sequence: { strategy: verified.workflow.strategy, workflowHash: verified.workflow.workflowHash, stepCount: verified.workflow.steps.length } } : {} };
}

/**
 * Claims the proposal for the wallet this browser proved (the namespace the workflow needs) and returns the re-composed authoring
 * command. `share` is the owner's choice to let the requester see the status of runs started from it.
 */
export async function claimApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], share: boolean, now = new Date()): Promise<ClaimedProposal> {
  const { handoff: current, digest, kinds, profile } = await locate(surface, secret, now);
  const namespace = planNamespace(current.plan), sequence = current.plan.kind === 'SEQUENTIAL';
  const wallet = wallets.find(w => w.namespace === namespace) ?? refuse(namespace === 'solana' ? 'SOLANA_WALLET_PROOF_REQUIRED' : 'EVM_WALLET_PROOF_REQUIRED');
  // BUILD-CHAT-E2E-001: a sequence needs this deployment's workflow runs and a proven wallet of EVERY namespace it uses, before it is claimed.
  if (sequence && !surface.workflowRuns) refuse('WORKFLOW_RUNS_NOT_ENABLED');
  if (sequence) for (const ns of planNamespaces(current.plan)) if (!wallets.some(w => w.namespace === ns)) refuse(ns === 'solana' ? 'SOLANA_WALLET_PROOF_REQUIRED' : 'EVM_WALLET_PROOF_REQUIRED');
  const verified = await verifyHandoff(current, surface.runtime, profile.policy);
  // The requester's own rule reads only the handoff's immutable requester data, so deciding it before the row lock is exact.
  const rule = profile.claimPolicy ? await profile.claimPolicy(current, wallet) : { ok: true } as const;
  const claimed = await surface.handoffs.claim(digest, wallet, now, CLAIM_SECONDS, h => h.workflowHash !== current.workflowHash ? { ok: false, code: 'HANDOFF_STALE', stale: true }
    : !verified.ok ? { ok: false, code: verified.code, ...'stale' in verified && verified.stale ? { stale: true } : {} }
      : !rule.ok ? { ok: false, code: rule.code } : { ok: true, share: share === true }, kinds);
  if (!claimed.ok) return refuse(claimed.code);
  if (!verified.ok) return refuse(verified.code);
  const view = approvalView(claimed.handoff, verified, await viewerOf(profile, wallets));
  if (sequence) return claimSequential(surface.workflowRuns!, claimed.handoff, verified.workflow, wallets, view);
  return { view, command: verified.composition.command, workflow: verified.composition.workflow,
    workflowHash: verified.composition.workflowHash, workflowId: verified.composition.workflow.workflowId };
}

/**
 * The claimant applied the proposal: the workflow now in its FloFi editor must hash (canonically, on the server) to exactly the
 * proposal's workflow hash. Anything else — an edit, another proposal — is a mismatch and the handoff stays CLAIMED.
 */
export async function applyApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], workflow: unknown, now = new Date()): Promise<ApprovalView> {
  const { handoff: current, digest, kinds, profile } = await locate(surface, secret, now);
  let appliedHash: string;
  try { appliedHash = semanticWorkflowHash(workflow as Workflow); } catch { appliedHash = ''; }
  // BUILD-CHAT-E2E-001: a sequence's editor holds the run's current step, which must hash exactly to the step the run loaded for its owner.
  if (current.plan.kind === 'SEQUENTIAL') {
    const runs = surface.workflowRuns ?? refuse('WORKFLOW_RUNS_NOT_ENABLED'), run = await ownedRun(runs, current.handoffId, wallets);
    const step = (await runs.store.steps(run.runId))[run.currentStep];
    if (!step || step.state !== 'AWAITING_OWNER' || step.workflowHash !== appliedHash) refuse('HANDOFF_WORKFLOW_MISMATCH');
    const applied = await surface.handoffs.apply(digest, claimantOf(current, wallets), now, kinds);
    if (!applied.ok) return refuse(applied.code);
    return (await continueSequential(runs, run, wallets, approvalView(applied.handoff, null, await viewerOf(profile, wallets)))).view;
  }
  if (appliedHash !== current.workflowHash) refuse('HANDOFF_WORKFLOW_MISMATCH');
  const verified = await verifyHandoff(current, surface.runtime, profile.policy);
  if (!verified.ok) return refuse(verified.code);
  const applied = await surface.handoffs.apply(digest, claimantOf(current, wallets), now, kinds);
  if (!applied.ok) return refuse(applied.code);
  return approvalView(applied.handoff, await verifyHandoff(applied.handoff, surface.runtime, profile.policy), await viewerOf(profile, wallets));
}

// ── BUILD-CHAT-E2E-001: a multi-step approval's workflow run, for its proven owner wallets ─────────────────────────────────────────
/** The run's handoff and the base view, for the run's own proven wallets (another wallet sees nothing). */
async function runContext(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]) {
  const runs = surface.workflowRuns ?? refuse('WORKFLOW_RUNS_NOT_ENABLED');
  if (typeof approvalId !== 'string' || !/^apr_[a-z2-7]{26}$/.test(approvalId)) return refuse('WORKFLOW_RUN_NOT_FOUND');
  let h: HandoffRecord | null = null;
  for (const wallet of wallets) { h = await surface.handoffs.forRunOwner(approvalId, wallet); if (h) break; }
  if (!h) return refuse('WORKFLOW_RUN_NOT_FOUND');
  const profile = surface.profiles[h.requesterKind] ?? refuse('WORKFLOW_RUN_NOT_FOUND');
  return { runs, run: await ownedRun(runs, approvalId, wallets), base: approvalView(h, null, await viewerOf(profile, wallets)) };
}
/** The run's status for its owner, read-only (polled by the signing surface; it never loads or resolves a step). */
export async function workflowRunStatus(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return statusSequential(c.runs, c.run, wallets, c.base);
}
/** The run's status and, when one waits for the owner, the step to sign now (also after a reload, in another browser, by id + wallet proof). */
export async function workflowRunContinue(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return continueSequential(c.runs, c.run, wallets, c.base);
}
/** The owner chose to confirm each step in their wallet. */
export async function workflowRunStart(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return startSequential(c.runs, c.run, wallets, c.base);
}
/** The owner ends the run (nothing in flight), or stops a delegated run by revoking its authorization. */
export async function workflowRunCancel(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return cancelSequential(c.runs, c.run, wallets, c.base);
}
/** The owner resumes a halted run whose stopped step submitted nothing. */
export async function workflowRunResume(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return resumeSequential(c.runs, c.run, wallets, c.base);
}
/** The Universal Workflow Authorization Review of the run: the exact workflow grants the owner's wallet signs ONCE (delegated mode). */
export async function workflowRunReview(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]) {
  const c = await runContext(surface, approvalId, wallets);
  return authorizationReviewSequential(c.runs, c.run, wallets);
}
/**
 * The owner's ONE wallet authorization for the whole workflow (delegated mode: one signed workflow grant per EVM network). The approval link the
 * browser holds is marked APPLIED with it: the proposal now lives in FloFi as this run, so the link cannot be claimed or applied again. A retry
 * after a lost answer is idempotent and still applies the link.
 */
export async function workflowRunAuthorize(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], revision: unknown, assertion: unknown,
  now = new Date()): Promise<ClaimedProposal> {
  const { handoff: h, digest, kinds } = await locate(surface, secret, now);
  if (h.plan.kind !== 'SEQUENTIAL') return refuse('WORKFLOW_RUN_NOT_FOUND');
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return refuse('AUTHORIZATION_REVISION_INVALID');
  const c = await runContext(surface, h.handoffId, wallets);
  const authorized = await authorizeSequential(c.runs, c.run, wallets, revision, assertion, c.base);
  await surface.handoffs.apply(digest, claimantOf(h, wallets), now, kinds);
  return authorized;
}

// ── BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups ─────────────────────────────────────────────────────────
const CHAIN = /^(eip155:[1-9][0-9]{0,18}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/;
/** The wallet capabilities the browser reported (EIP-5792 `atomic` per chain, Wallet Standard multi-sign): parsed strictly; they only choose the interaction. */
export function walletProfileOf(value: unknown): WalletProfile {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : refuse('WALLET_PROFILE_INVALID');
  let eip155: WalletProfile['eip155'] | null = null, solana: WalletProfile['solana'] | null = null;
  if (v.eip155 !== undefined && v.eip155 !== null) {
    const e = typeof v.eip155 === 'object' ? v.eip155 as Record<string, unknown> : refuse('WALLET_PROFILE_INVALID');
    const atomic: Record<string, 'supported' | 'ready' | 'unsupported'> = {};
    for (const [chain, status] of Object.entries(e.atomic && typeof e.atomic === 'object' ? e.atomic as Record<string, unknown> : {}))
      if (CHAIN.test(chain) && chain.startsWith('eip155:') && (status === 'supported' || status === 'ready' || status === 'unsupported')) atomic[chain] = status;
    eip155 = { wallet: e.wallet === 'FLOFI_WALLET' ? 'FLOFI_WALLET' : 'INJECTED', atomic: e.wallet === 'FLOFI_WALLET' ? {} : atomic, typedData: e.typedData === true };
  }
  if (v.solana !== undefined && v.solana !== null) {
    const so = typeof v.solana === 'object' ? v.solana as Record<string, unknown> : refuse('WALLET_PROFILE_INVALID');
    const nonce = typeof so.nonceAccounts === 'number' && Number.isInteger(so.nonceAccounts) && so.nonceAccounts >= 0 && so.nonceAccounts <= 8 ? so.nonceAccounts : 0;
    // FloFi Wallet (Privy) shows one confirmation per Solana transaction: never reported as signing several in one prompt.
    solana = { wallet: so.wallet === 'FLOFI_WALLET' ? 'FLOFI_WALLET' : 'WALLET_STANDARD', signMultiple: so.signMultiple === true && so.wallet !== 'FLOFI_WALLET', nonceAccounts: nonce };
  }
  return { ...eip155 ? { eip155 } : {}, ...solana ? { solana } : {} };
}
const groupIndexOf = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7 ? value : refuse('WORKFLOW_RUN_GROUP_NOT_FOUND');
function ownerAnswerOf(value: unknown): OwnerAnswer {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : refuse('USER_FUNDED_AUTHORIZATION_INVALID');
  if (v.kind === 'EVM_WALLET_BATCH' && typeof v.batchId === 'string' && v.batchId.length <= 256) return { kind: v.kind, batchId: v.batchId };
  if (v.kind === 'EVM_USER_OPERATION' && typeof v.signature === 'string' && v.signature.length <= 140) return { kind: v.kind, signature: v.signature };
  if (v.kind === 'SOLANA_SIGN_ALL' && Array.isArray(v.transactions) && v.transactions.length >= 1 && v.transactions.length <= 8
    && v.transactions.every(t => typeof t === 'string' && t.length <= 2_048)) return { kind: v.kind, transactions: v.transactions as string[] };
  return refuse('USER_FUNDED_AUTHORIZATION_INVALID');
}
/** The owner chose user-funded execution groups for these wallets (their own wallets pay every fee). */
export async function workflowRunUserFundedStart(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], profile: unknown): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return userFundedStartSequential(c.runs, c.run, wallets, walletProfileOf(profile), c.base);
}
/**
 * What the owner's wallet signs for one group now (exact calls / typed data / Solana transactions, the fee ceiling and its payer). `wallet`: the
 * owner's EVM wallet kind as this browser reports it ('INJECTED' or 'FLOFI_WALLET'); anything else is unknown (review C4: no Circle permit then).
 */
export async function workflowRunUserFundedPrepare(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown,
  handout: unknown = undefined, wallet: unknown = undefined, reviewedGas: unknown = undefined) {
  const c = await runContext(surface, approvalId, wallets);
  // The hand-out token this browser kept for the group's wallet batch (service.ts `handedTo`); anything else is no token.
  // Final review (P3): the fee mechanism a Review showed for this group (the Editor's Authorize), when one was reviewed.
  return userFundedPrepareSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), typeof handout === 'string' && handout.length <= 64 ? handout : undefined,
    wallet === 'INJECTED' || wallet === 'FLOFI_WALLET' ? wallet : undefined, isReviewedGas(reviewedGas) ? reviewedGas : undefined);
}
/**
 * ADR-0010: the owner's USDC permit signature for a Circle-paid group (the first of its two typed-data signatures), verified against what FloFi
 * prepared; returns the group with the operation's typed data the owner's wallet signs next. Owner-gated exactly as prepare/authorize.
 */
export async function workflowRunUserFundedPermit(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown,
  permitSignature: unknown) {
  const c = await runContext(surface, approvalId, wallets);
  if (typeof permitSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(permitSignature)) return refuse('CIRCLE_PERMIT_INVALID');
  return userFundedPermitSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), permitSignature);
}
/**
 * Owner requirement (FloFi Wallet + Circle): the owner's explicit consent, in FloFi, to upgrade this FloFi Wallet address to the pinned
 * Simple7702Account v0.8 inside the group's Circle-paid operation (recorded before the wallet is asked; nothing is signed or sent).
 */
export async function workflowRunUserFundedConsent(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown) {
  const c = await runContext(surface, approvalId, wallets);
  return userFundedConsentSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex));
}
/** Owner requirement (FloFi Wallet + Circle): the owner's EIP-7702 upgrade authorization, verified against what FloFi prepared. */
export async function workflowRunUserFundedUpgrade(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown, signature: unknown) {
  const c = await runContext(surface, approvalId, wallets);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refuse('CIRCLE_AUTHORIZATION_INVALID');
  return userFundedUpgradeSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), signature);
}
/**
 * Owner requirement (FloFi Wallet + Circle): "Not now" on FloFi's consent card — a Circle preparation planned from owner steps, nothing of which was
 * signed, is withdrawn and the group's first step is loaded into its own flow (native gas), exactly as when the owner's ETH pays.
 */
export async function workflowRunUserFundedDecline(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return userFundedDeclineSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), c.base);
}
/** The owner's wallet answer for one prepared group, verified against what FloFi prepared. */
export async function workflowRunUserFundedAuthorize(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown, answer: unknown): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return userFundedAuthorizeSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), ownerAnswerOf(answer), c.base);
}
/**
 * The transaction hashes of a wallet batch, as the owner's wallet reported them (the chain decides the outcome); `notSent` true when the wallet
 * reported the batch failed off chain (nothing was sent).
 */
export async function workflowRunUserFundedReport(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[], groupIndex: unknown, hashes: unknown,
  notSent: unknown = false): Promise<ClaimedProposal> {
  const c = await runContext(surface, approvalId, wallets);
  return userFundedReportSequential(c.runs, c.run, wallets, groupIndexOf(groupIndex), Array.isArray(hashes) ? hashes as string[] : refuse('EIP5792_RESPONSE_INVALID'), c.base,
    notSent === true);
}

/** The claimant turns status sharing with the requester on or off. */
export async function shareApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], share: boolean, now = new Date()): Promise<{ statusShared: boolean }> {
  const { handoff: current, digest, kinds } = await locate(surface, secret, now);
  const updated = await surface.handoffs.setSharing(digest, claimantOf(current, wallets), share === true, now, kinds) ?? refuse('HANDOFF_NOT_FOUND');
  return { statusShared: updated.shareStatus };
}
