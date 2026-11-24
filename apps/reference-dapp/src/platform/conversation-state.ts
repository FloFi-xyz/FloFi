// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNELS-001: one conversational lifecycle vocabulary for every external surface (ChatGPT / Claude over MCP,
 * Telegram), derived ONLY from FloFi's authoritative state: the deterministic composition/review, the durable approval handoff and the
 * durable run records (`domain/canonical-execution-status.ts`). Nothing here reads a model's words, a provider's "success" or a client's
 * claim, and nothing here authorizes anything.
 *
 *   DRAFT_CREATED                the engine composed a canonical workflow (no blocker found by the deterministic review)
 *   MISSING_INFORMATION          the request lacks a required field (amount, asset, network, recipient…): ask the person, never guess
 *   VALIDATION_REQUIRED          the workflow is not valid/executable as written (an invalid value, a BLOCK finding, a changed hash)
 *   SIMULATION_COMPLETED         a read-only simulation preview answered (never authorization, never execution)
 *   REVIEW_REQUIRED              composed and reviewed without blockers: ready for the owner's approval request
 *   AWAITING_WALLET_CONNECTION   an approval request exists; the owner has not opened it / proven a wallet yet
 *   AWAITING_SIGNATURE           the owner proved a wallet and loaded the proposal; their wallet decision is pending
 *   SUBMITTED                    a submission is recorded; its transaction hash is not known yet
 *   PENDING_CONFIRMATION         a hash is known or a step landed; the outcome is not reconciled yet
 *   PARTIALLY_EXECUTED           earlier steps reconciled and stay done; a later step did not complete
 *   CONFIRMED                    the outcome is reconciled (the only "completed" state)
 *   FAILED                       the action failed or reverted (final)
 *   CANCELLED                    cancelled, withdrawn, replaced by a newer request, or the wallet request was rejected
 *   EXPIRED                      the request or its quote expired, or is no longer reproducible: a fresh review is required
 *   NEEDS_ATTENTION              something may have been sent and is not proven either way, or a run stopped: never "not run", never "done"
 *   STATUS_UNKNOWN               FloFi could not read the status now, or the owner has not shared it: never "nothing happened"
 *
 * `final` means nothing changes without a new action by the person. Only CONFIRMED is ever reported as completion.
 */
import { canonicalRunLifecycle, type CanonicalExecutionStatus, type CanonicalLifecycle } from '../domain/canonical-execution-status.ts';

export const CONVERSATION_STATES = Object.freeze(['DRAFT_CREATED', 'MISSING_INFORMATION', 'VALIDATION_REQUIRED', 'SIMULATION_COMPLETED', 'REVIEW_REQUIRED',
  'AWAITING_WALLET_CONNECTION', 'AWAITING_SIGNATURE', 'SUBMITTED', 'PENDING_CONFIRMATION', 'PARTIALLY_EXECUTED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED',
  'NEEDS_ATTENTION', 'STATUS_UNKNOWN'] as const);
export type ConversationStateName = (typeof CONVERSATION_STATES)[number];
/** What the person (or the assistant on their behalf) can do next; never an action FloFi or a model performs for them. */
export type NextStep = 'PROVIDE_DETAILS' | 'FIX_REQUEST' | 'REVIEW_OR_SIMULATE' | 'REQUEST_APPROVAL' | 'OPEN_SIGNING_LINK' | 'CONFIRM_IN_WALLET' | 'WAIT_AND_CHECK_STATUS'
  | 'OWNER_DECIDES_IN_SIGNING_PAGE' | 'NEW_REQUEST' | 'NONE';
export type ConversationState = { readonly state: ConversationStateName; readonly final: boolean; readonly completed: boolean; readonly nextStep: NextStep;
  /** A closed reason qualifying the state (e.g. SUPERSEDED, NOT_SHARED, SIGNATURE_REJECTED); never free text. */
  readonly reason: string | null };

const FINAL: ReadonlySet<ConversationStateName> = new Set(['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const NEXT: Readonly<Record<ConversationStateName, NextStep>> = Object.freeze({
  DRAFT_CREATED: 'REVIEW_OR_SIMULATE', MISSING_INFORMATION: 'PROVIDE_DETAILS', VALIDATION_REQUIRED: 'FIX_REQUEST', SIMULATION_COMPLETED: 'REQUEST_APPROVAL',
  REVIEW_REQUIRED: 'REQUEST_APPROVAL', AWAITING_WALLET_CONNECTION: 'OPEN_SIGNING_LINK', AWAITING_SIGNATURE: 'CONFIRM_IN_WALLET', SUBMITTED: 'WAIT_AND_CHECK_STATUS',
  PENDING_CONFIRMATION: 'WAIT_AND_CHECK_STATUS', PARTIALLY_EXECUTED: 'OWNER_DECIDES_IN_SIGNING_PAGE', CONFIRMED: 'NONE', FAILED: 'NEW_REQUEST',
  CANCELLED: 'NEW_REQUEST', EXPIRED: 'NEW_REQUEST', NEEDS_ATTENTION: 'OWNER_DECIDES_IN_SIGNING_PAGE', STATUS_UNKNOWN: 'WAIT_AND_CHECK_STATUS' });
export function conversationState(state: ConversationStateName, reason: string | null = null, overrides: { readonly final?: boolean; readonly nextStep?: NextStep } = {}): ConversationState {
  return Object.freeze({ state, final: overrides.final ?? FINAL.has(state), completed: state === 'CONFIRMED', nextStep: overrides.nextStep ?? NEXT[state], reason });
}

/** A schema issue whose rule says a field is absent: the person must supply it (FloFi never invents amounts, assets or recipients). */
const MISSING_RULES = new Set(['required', 'missing', 'minItems']);
export type ValidationFacts = { readonly valid: boolean; readonly issues?: readonly { readonly rule: string }[]; readonly reviewSummary?: { readonly block: number } };
/** The state of a deterministic validation result. */
export function validationState(result: ValidationFacts): ConversationState {
  if (result.valid) return (result.reviewSummary?.block ?? 0) > 0 ? conversationState('VALIDATION_REQUIRED', 'REVIEW_BLOCKERS') : conversationState('REVIEW_REQUIRED');
  return (result.issues ?? []).some(issue => MISSING_RULES.has(issue.rule)) ? conversationState('MISSING_INFORMATION') : conversationState('VALIDATION_REQUIRED');
}
/** The state after composition or review: blockers from the deterministic review keep the request in VALIDATION_REQUIRED. */
export function authoringState(kind: 'COMPOSED' | 'REVIEWED', blockers: number): ConversationState {
  if (blockers > 0) return conversationState('VALIDATION_REQUIRED', 'REVIEW_BLOCKERS');
  return kind === 'COMPOSED' ? conversationState('DRAFT_CREATED') : conversationState('REVIEW_REQUIRED');
}
export const simulationState = (): ConversationState => conversationState('SIMULATION_COMPLETED');

/** The canonical lifecycle of one durable run, in the conversational vocabulary. `reconciled` is the approval read's strict evidence check. */
export function executionState(lifecycle: CanonicalLifecycle, options: { readonly reconciled?: boolean } = {}): ConversationState {
  const byStatus: Readonly<Record<CanonicalExecutionStatus, () => ConversationState>> = {
    NOT_STARTED: () => conversationState('AWAITING_SIGNATURE'),
    AUTHORIZATION_PENDING: () => conversationState('AWAITING_SIGNATURE'),
    REJECTED: () => conversationState('CANCELLED', 'SIGNATURE_REJECTED_OR_NOT_SUBMITTED'),
    SUBMITTED: () => conversationState('SUBMITTED'),
    HASH_KNOWN: () => conversationState('PENDING_CONFIRMATION'),
    CONFIRMED_ONCHAIN: () => conversationState('PENDING_CONFIRMATION', 'NOT_RECONCILED_YET'),
    SETTLEMENT_PENDING: () => conversationState('PENDING_CONFIRMATION', 'DESTINATION_SETTLEMENT_PENDING'),
    // Completion needs the evidence check where the caller has one: a reconciled label without it is still pending.
    RECONCILED: () => options.reconciled === false ? conversationState('PENDING_CONFIRMATION', 'NOT_RECONCILED_YET') : conversationState('CONFIRMED'),
    RECONCILED_WITH_ATTENTION: () => options.reconciled === false ? conversationState('PENDING_CONFIRMATION', 'NOT_RECONCILED_YET')
      : conversationState('CONFIRMED', 'RECONCILED_WITH_ATTENTION'),
    PARTIALLY_COMPLETED: () => conversationState('PARTIALLY_EXECUTED', null, { final: lifecycle.final }),
    REVERTED: () => conversationState('FAILED', 'REVERTED'),
    FAILED: () => conversationState('FAILED'),
    INCONCLUSIVE: () => conversationState('NEEDS_ATTENTION', 'OUTCOME_NOT_PROVEN'),
    INTERVENTION_REQUIRED: () => conversationState('NEEDS_ATTENTION', 'INTERVENTION_REQUIRED'),
  };
  return byStatus[lifecycle.status]();
}

export type ApprovalRunFacts = { readonly status: string; readonly reconciled: boolean; readonly errorCode?: string | null; readonly evidenceOutcome?: string | null;
  readonly updatedAt?: string };
export type WorkflowRunFacts = { readonly state: string; readonly nextAction: string; readonly halted: 'PARTIAL' | 'NOTHING_SENT' | 'STOPPED' | null; readonly resumable: boolean;
  readonly steps?: readonly { readonly state: string }[] };
export type ApprovalFacts = { readonly status: string; readonly runs?: readonly ApprovalRunFacts[]; readonly runsVisible?: boolean; readonly runsComplete?: boolean;
  readonly workflowRun?: WorkflowRunFacts | null; readonly executionPlan?: string };

/** A multi-step workflow run (`workflow-runs/service.ts` RunView) in the conversational vocabulary. */
export function workflowRunState(run: WorkflowRunFacts): ConversationState {
  const reconciledSteps = (run.steps ?? []).some(step => step.state === 'RECONCILED');
  switch (run.state) {
    case 'COMPLETED': return conversationState('CONFIRMED');
    case 'CANCELLED': return reconciledSteps ? conversationState('PARTIALLY_EXECUTED', 'CANCELLED_AFTER_PARTIAL', { final: true }) : conversationState('CANCELLED');
    case 'EXPIRED': return reconciledSteps ? conversationState('PARTIALLY_EXECUTED', 'EXPIRED_AFTER_PARTIAL', { final: true }) : conversationState('EXPIRED');
    case 'FAILED': return reconciledSteps ? conversationState('PARTIALLY_EXECUTED', 'FAILED_AFTER_PARTIAL', { final: true }) : conversationState('FAILED');
    case 'ATTENTION': return conversationState('NEEDS_ATTENTION', 'INTERVENTION_REQUIRED');
    case 'HALTED':
      if (run.halted === 'PARTIAL') return conversationState('PARTIALLY_EXECUTED', run.resumable ? 'RESUMABLE' : 'HALTED', { final: !run.resumable });
      // Nothing sent is proven: the owner may resume or leave it. Otherwise neither progress nor "nothing sent" is claimed.
      return conversationState('NEEDS_ATTENTION', run.halted === 'NOTHING_SENT' ? 'HALTED_NOTHING_SENT' : 'HALTED');
    case 'PENDING': return conversationState('AWAITING_SIGNATURE', 'OWNER_CHOOSES_MODE');
    case 'RUNNING':
      if (run.nextAction === 'WAITING_FOR_RECONCILIATION') return conversationState('PENDING_CONFIRMATION');
      if (run.nextAction === 'OWNER_DECIDES') return conversationState('NEEDS_ATTENTION', 'OWNER_DECIDES');
      return reconciledSteps ? conversationState('AWAITING_SIGNATURE', 'NEXT_STEP') : conversationState('AWAITING_SIGNATURE');
    default: return conversationState('STATUS_UNKNOWN', 'UNRECOGNIZED_RUN_STATE');
  }
}

const latest = (runs: readonly ApprovalRunFacts[]) => [...runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
/**
 * An approval request (durable handoff) and, when the owner shares them, the runs started from it. Runs are authoritative over the
 * handoff once they exist; a run read that failed, or runs the owner did not share, are STATUS_UNKNOWN, never "not started".
 */
export function approvalState(approval: ApprovalFacts): ConversationState {
  switch (approval.status) {
    case 'PENDING': return conversationState('AWAITING_WALLET_CONNECTION');
    case 'CLAIMED': return conversationState('AWAITING_SIGNATURE', 'WALLET_PROVEN');
    case 'EXPIRED': return conversationState('EXPIRED');
    case 'STALE': return conversationState('EXPIRED', 'NO_LONGER_REPRODUCIBLE');
    case 'REVOKED': return conversationState('CANCELLED', 'WITHDRAWN');
    case 'SUPERSEDED': return conversationState('CANCELLED', 'SUPERSEDED');
    case 'APPLIED': break;
    default: return conversationState('STATUS_UNKNOWN', 'UNRECOGNIZED_APPROVAL_STATE');
  }
  if (approval.workflowRun) return workflowRunState(approval.workflowRun);
  if (approval.executionPlan === 'SEQUENTIAL') return conversationState('AWAITING_SIGNATURE', 'OWNER_CHOOSES_MODE');
  if (approval.runsComplete === false) return conversationState('STATUS_UNKNOWN', 'RUNS_READ_FAILED');
  if (approval.runsVisible === false) return conversationState('STATUS_UNKNOWN', 'NOT_SHARED');
  const run = latest(approval.runs ?? []);
  if (!run) return conversationState('AWAITING_SIGNATURE', 'IN_SIGNING_PAGE');
  const lifecycle = canonicalRunLifecycle({ status: run.status, errorCode: run.errorCode ?? null, hasEvidence: run.evidenceOutcome != null });
  return executionState(lifecycle, { reconciled: run.reconciled });
}

// ── Plain-language explanations of refusals ────────────────────────────────────────────────────────────────────────────────────
export type MessageLanguage = 'EN' | 'PT';
type Plain = { readonly EN: string; readonly PT: string };
/**
 * Closed refusal codes → what an ordinary person can understand and do. The code stays in the structured result for clients; the
 * person never needs it. Every message is true for every surface that uses it: none of these requests signs or sends anything.
 */
const FAMILIES: readonly (readonly [RegExp, Plain])[] = [
  [/(?:TIMEOUT|DEADLINE|REQUEST_CANCELLED)/, { EN: 'FloFi did not get an answer in time. Check the status before trying again; nothing is repeated automatically.',
    PT: 'O FloFi não recebeu resposta a tempo. Consulte o status antes de tentar de novo; nada é repetido automaticamente.' }],
  [/(?:QUOTE|PREVIEW|SIMULATION_UNAVAILABLE|PROVIDER|UPSTREAM|ROUTE_UNAVAILABLE)/, { EN: 'The current quote is temporarily unavailable. You can try again without rebuilding your workflow.',
    PT: 'A cotação atual está temporariamente indisponível. Você pode tentar de novo sem refazer o seu fluxo.' }],
  [/(?:PENDING_LIMIT|HANDOFF_LIMIT)/, { EN: 'You already have the maximum number of open approval requests. Cancel one or let it expire, then try again.',
    PT: 'Você já tem o número máximo de solicitações de aprovação abertas. Cancele uma ou deixe-a expirar e tente de novo.' }],
  [/(?:RATE_LIMIT|BUSY|_LIMIT$|TOO_MANY)/, { EN: 'There are too many requests right now. Wait a moment and try again.',
    PT: 'Há muitas solicitações agora. Aguarde um momento e tente de novo.' }],
  [/WALLET_LINK_REQUIRED|WALLET_NOT_LINKED/, { EN: 'Link your wallet to FloFi first: open the FloFi link, connect your wallet and confirm its sign-in message. That message moves no funds.',
    PT: 'Vincule primeiro a sua carteira ao FloFi: abra o link do FloFi, conecte a carteira e confirme a mensagem de acesso. Essa mensagem não movimenta fundos.' }],
  [/(?:INSUFFICIENT_SCOPE|UNAUTHORIZED|TOKEN|OAUTH)/, { EN: 'FloFi needs you to reconnect and grant access again in this app.',
    PT: 'O FloFi precisa que você se reconecte e conceda o acesso de novo neste app.' }],
  [/^BETA_|ACCESS_DENIED|NOT_ELIGIBLE/, { EN: 'Your FloFi account does not have access to this yet.', PT: 'A sua conta FloFi ainda não tem acesso a isto.' }],
  [/INSUFFICIENT_(?:BALANCE|FUNDS)/, { EN: 'The wallet balance is too low for this amount. Choose a smaller amount or add funds.',
    PT: 'O saldo da carteira é insuficiente para esse valor. Escolha um valor menor ou adicione fundos.' }],
  [/INSUFFICIENT_GAS|GAS_BALANCE/, { EN: 'The wallet does not have enough of the network\'s native token to pay the network fee.',
    PT: 'A carteira não tem o token nativo da rede suficiente para pagar a taxa da rede.' }],
  [/(?:_EXPIRED$|^EXPIRED|QUOTE_STALE)/, { EN: 'This request expired. Ask FloFi for a fresh quote and review; nothing was signed.',
    PT: 'Esta solicitação expirou. Peça ao FloFi uma nova cotação e revisão; nada foi assinado.' }],
  [/(?:REVOKED|SUPERSEDED)/, { EN: 'This request was cancelled or replaced by a newer one.', PT: 'Esta solicitação foi cancelada ou substituída por uma mais recente.' }],
  [/(?:STALE|HASH_MISMATCH|WORKFLOW_CHANGED)/, { EN: 'The workflow or market conditions changed. Review it again before signing.',
    PT: 'O fluxo ou as condições de mercado mudaram. Revise-o de novo antes de assinar.' }],
  [/NOT_CANCELLABLE|IN_EXECUTION/, { EN: 'This request can no longer be cancelled from here. Reject it in your wallet or decide in the FloFi signing page.',
    PT: 'Esta solicitação não pode mais ser cancelada por aqui. Rejeite-a na sua carteira ou decida na página de assinatura do FloFi.' }],
  [/(?:NOT_FOUND|UNKNOWN_ID)/, { EN: 'FloFi could not find that for your account.', PT: 'O FloFi não encontrou isso na sua conta.' }],
  [/(?:TEST_NETWORK|NETWORK_NOT|NOT_ENABLED|NOT_SUPPORTED|UNSUPPORTED|DISABLED|NOT_AVAILABLE)/, { EN: 'That network, asset or action is not available on FloFi right now.',
    PT: 'Essa rede, ativo ou ação não está disponível no FloFi agora.' }],
  [/(?:RUNTIME_REQUIRED|RUNTIME_NOT_CONFIGURED|NOT_CONFIGURED)/, { EN: 'FloFi cannot read this here right now. Try again later or use another FloFi connection.',
    PT: 'O FloFi não consegue ler isso aqui agora. Tente mais tarde ou use outra conexão do FloFi.' }],
  [/(?:INVALID|MISSING|FIELD_REQUIRED|SCHEMA|AMBIGUOUS)/, { EN: 'Some details are missing or invalid. Check the amount, asset, network and recipient.',
    PT: 'Faltam detalhes ou há dados inválidos. Confira o valor, o ativo, a rede e o destinatário.' }],
  [/(?:STORE_UNAVAILABLE|UNAVAILABLE|CONFIGURATION)/, { EN: 'FloFi is temporarily unavailable. Try again in a few minutes.',
    PT: 'O FloFi está temporariamente indisponível. Tente de novo em alguns minutos.' }],
];
const FALLBACK: Plain = { EN: 'FloFi could not complete this step, and this request did not sign or send anything. Try again or adjust the request.',
  PT: 'O FloFi não conseguiu concluir esta etapa, e esta solicitação não assinou nem enviou nada. Tente de novo ou ajuste o pedido.' };
/** The plain explanation of a closed refusal code, in EN and PT (never the code, a stack trace or an internal identifier). */
export function userFacingError(code: string): Plain {
  for (const [pattern, plain] of FAMILIES) if (pattern.test(code)) return plain;
  return FALLBACK;
}
