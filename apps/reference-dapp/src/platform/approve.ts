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
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import type { HandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime as EngineRuntime } from '../mcp/runtime.ts';
import { resolveApprovalSecret, type ApprovalLinkScheme } from './approval-links.ts';
import { approvalView, CLAIM_SECONDS, openApprovalSession, planNamespace, planNamespaces, verifyHandoff, type ApprovalView, type ClaimedProposal } from './approvals.ts';
import { authorizationReviewSequential, authorizeSequential, cancelSequential, claimSequential, continueSequential, ownedRun, resumeSequential, startSequential,
  type WorkflowRunSurface } from './workflow-run-approvals.ts';
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
export async function viewApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], now = new Date()): Promise<ApprovalView> {
  const { handoff: h, profile } = await locate(surface, secret, now);
  const sequenceStarted = h.plan.kind === 'SEQUENTIAL' && h.status !== 'PENDING';
  const verified = !sequenceStarted && (h.status === 'PENDING' || h.status === 'CLAIMED' || h.status === 'APPLIED') ? await verifyHandoff(h, surface.runtime, profile.policy) : null;
  const view = approvalView(h, verified, await viewerOf(profile, wallets));
  // BUILD-CHAT-E2E-001: once a sequence's run exists, its owner (and only its owner) sees the run here.
  const run = sequenceStarted && surface.workflowRuns ? await surface.workflowRuns.store.byHandoff(h.handoffId) : null;
  if (!run || !surface.workflowRuns) return view;
  try { return (await continueSequential(surface.workflowRuns, await ownedRun(surface.workflowRuns, h.handoffId, wallets), wallets, view)).view; }
  catch { return view; }
}

/** BUILD-FLOFI-UX-UI-002: what FloFi needs to show an open proposal on its normal Canvas before the owner proves a wallet. */
export type ApprovalPreview = { readonly approvalId: string; readonly workflow: Workflow; readonly workflowHash: string };
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
  return { approvalId: h.handoffId, workflow: verified.composition.workflow, workflowHash: verified.composition.workflowHash };
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
/** The Universal Workflow Authorization Review of the run: what the owner's passkey signs ONCE (delegated mode). */
export async function workflowRunReview(surface: ApprovalSurface, approvalId: unknown, wallets: readonly WalletRef[]) {
  const c = await runContext(surface, approvalId, wallets);
  return authorizationReviewSequential(c.runs, c.run, wallets);
}
/**
 * The owner's ONE passkey signature for the whole workflow (delegated mode). The approval link the browser holds is marked APPLIED with it:
 * the proposal now lives in FloFi as this run, so the link cannot be claimed or applied again.
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

/** The claimant turns status sharing with the requester on or off. */
export async function shareApproval(surface: ApprovalSurface, secret: unknown, wallets: readonly WalletRef[], share: boolean, now = new Date()): Promise<{ statusShared: boolean }> {
  const { handoff: current, digest, kinds } = await locate(surface, secret, now);
  const updated = await surface.handoffs.setSharing(digest, claimantOf(current, wallets), share === true, now, kinds) ?? refuse('HANDOFF_NOT_FOUND');
  return { statusShared: updated.shareStatus };
}
