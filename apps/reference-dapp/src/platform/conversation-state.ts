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
import { BATCH_PAYMENT_MAX_RECIPIENTS, BATCH_PAYMENT_MIN_RECIPIENTS } from '@defi-workflow-engine/workflow-contracts';
import { MAX_WORKFLOW_STEPS } from '../engine/strategy-spec';

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
    // Reconciled with a recorded attention item: the strict evidence check (no error code) may never pass, so it is never left "pending".
    RECONCILED_WITH_ATTENTION: () => options.reconciled === false ? conversationState('NEEDS_ATTENTION', 'RECONCILED_WITH_ATTENTION')
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
  readonly updatedAt?: string; readonly terminal?: boolean; readonly landed?: string | null;
  /** FloFi still observes the run (`sharedRunsRead`): a final-looking outcome is not final yet. */
  readonly observing?: boolean;
  /** A run's own canonical lifecycle when its reader computed it from the full facts (Pix); otherwise it is derived from the summary. */
  readonly lifecycle?: CanonicalLifecycle };
export type WorkflowRunFacts = { readonly state: string; readonly nextAction: string; readonly halted: 'PARTIAL' | 'NOTHING_SENT' | 'STOPPED' | null; readonly resumable: boolean;
  readonly currentStep?: number; readonly steps?: readonly { readonly index?: number; readonly state: string; readonly code?: string | null }[];
  readonly groups?: readonly { readonly state: string; readonly steps: readonly [number, number]; readonly code?: string | null }[] };
/** A wallet batch handed to the owner's wallet that FloFi never heard back about: it may have executed (`workflow-runs/state-machine.ts`). */
const BATCH_OUTCOME_UNKNOWN = 'WALLET_BATCH_OUTCOME_UNKNOWN';
/**
 * What is in flight in a RUNNING multi-step run once the owner has nothing to sign (`WAITING_FOR_RECONCILIATION` is the view's fallback, not proof
 * of a submission): the current group's and step's own records decide; a step loaded for the owner but not proven submitted is UNKNOWN.
 */
function inFlightState(run: WorkflowRunFacts): ConversationState {
  const current = run.currentStep ?? -1;
  const step = (run.steps ?? []).find((s, i) => (s.index ?? i) === current);
  const group = (run.groups ?? []).find(g => g.steps[0] <= current && current <= g.steps[1]);
  if (group?.state === 'UNCERTAIN' || step?.state === 'UNCERTAIN') return conversationState('NEEDS_ATTENTION', 'OUTCOME_NOT_PROVEN');
  if (group?.state === 'SUBMITTED') return conversationState('PENDING_CONFIRMATION');
  if (group?.state === 'AUTHORIZED') return conversationState('SUBMITTED', 'GROUP_AUTHORIZED');
  return conversationState('STATUS_UNKNOWN', 'STEP_IN_SIGNING_FLOW');
}
export type ApprovalFacts = { readonly status: string; readonly runs?: readonly ApprovalRunFacts[]; readonly runsVisible?: boolean; readonly runsComplete?: boolean;
  readonly runsTruncated?: boolean; readonly workflowRun?: WorkflowRunFacts | null; readonly executionPlan?: string; readonly claimed?: boolean;
  /** A one-step run's state withheld because its owner did not share status (`approvalProgress`): read exactly as an unshared one-step proposal. */
  readonly statusHidden?: boolean };

/** A multi-step workflow run (`workflow-runs/service.ts` RunView) in the conversational vocabulary. */
export function workflowRunState(run: WorkflowRunFacts): ConversationState {
  const reconciledSteps = (run.steps ?? []).some(step => step.state === 'RECONCILED');
  // An ended or stopped run that handed a batch to the wallet and never heard back: it may have executed — never "cancelled" or "not run".
  if (run.state !== 'COMPLETED' && ((run.groups ?? []).some(g => g.code === BATCH_OUTCOME_UNKNOWN) || (run.steps ?? []).some(s => s.code === BATCH_OUTCOME_UNKNOWN)))
    return conversationState('NEEDS_ATTENTION', 'BATCH_OUTCOME_UNKNOWN', { final: false, nextStep: 'OWNER_DECIDES_IN_SIGNING_PAGE' });
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
      if (run.nextAction === 'OWNER_DECIDES') return conversationState('NEEDS_ATTENTION', 'OWNER_DECIDES');
      // The wallet already returned a batch id: it may have executed; the owner reopens FloFi so the wallet reports it. Never "sign again".
      if (run.nextAction === 'OWNER_CONFIRMS_BATCH') return conversationState('SUBMITTED', 'WALLET_BATCH_REPORT_PENDING', { nextStep: 'OPEN_SIGNING_LINK' });
      if (run.nextAction === 'OWNER_SIGNS_STEP' || run.nextAction === 'OWNER_SIGNS_GROUP')
        return reconciledSteps ? conversationState('AWAITING_SIGNATURE', 'NEXT_STEP') : conversationState('AWAITING_SIGNATURE');
      return inFlightState(run);
    default: return conversationState('STATUS_UNKNOWN', 'UNRECOGNIZED_RUN_STATE');
  }
}

/**
 * An approval request (durable handoff) and, when the owner shares them, the runs started from it. Runs are authoritative over the
 * handoff once they exist; a run read that failed, or runs the owner did not share, are STATUS_UNKNOWN, never "not started".
 */
export function approvalState(approval: ApprovalFacts): ConversationState {
  // A multi-step workflow's run starts when the owner claims it and can sign steps while the handoff still reads CLAIMED (or, after the claim
  // window, EXPIRED/REVOKED): once a run exists it decides, whatever the handoff says.
  if (approval.workflowRun) return workflowRunState(approval.workflowRun);
  if (approval.statusHidden === true && approval.status !== 'PENDING') return conversationState('STATUS_UNKNOWN', 'NOT_SHARED');
  // A claimed multi-step proposal whose run was not read here may have signed steps: never "awaiting", "expired" or "cancelled".
  if (approval.executionPlan === 'SEQUENTIAL' && approval.status !== 'PENDING' && approval.claimed !== false) return conversationState('STATUS_UNKNOWN', 'WORKFLOW_RUN_NOT_READ');
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
  if (approval.runsComplete === false) return conversationState('STATUS_UNKNOWN', 'RUNS_READ_FAILED');
  if (approval.runsVisible === false) return conversationState('STATUS_UNKNOWN', 'NOT_SHARED');
  const runs = approval.runs ?? [];
  // Only the wallet's most recent runs were examined: a run of this approval may be among older ones.
  if (!runs.length && approval.runsTruncated) return conversationState('STATUS_UNKNOWN', 'RUNS_TRUNCATED');
  if (!runs.length) return conversationState('AWAITING_SIGNATURE', 'IN_SIGNING_PAGE');
  // Every run bound to the approval counts (an earlier reconciled run is never hidden by a later declined one). Anything not settled decides
  // first, then any confirmed run, then any partial one; "cancelled" only when every run was declined.
  const states = [...runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(runState);
  return states.find(s => s.state === 'NEEDS_ATTENTION' || s.state === 'STATUS_UNKNOWN') ?? states.find(s => !s.final)
    ?? states.find(s => s.state === 'CONFIRMED') ?? states.find(s => s.state === 'PARTIALLY_EXECUTED') ?? states[0]!;
}
/**
 * One run of a single-flow approval. Its summary carries no attempts: a run that still reads as not started or awaiting the wallet may already
 * have a request in flight (UNKNOWN), a declined or failed run with an earlier action confirmed onchain (`landed`) is never "cancelled", and a
 * final outcome that FloFi still observes (`terminal` false) is not final yet.
 */
function runState(run: ApprovalRunFacts): ConversationState {
  const lifecycle = run.lifecycle ?? canonicalRunLifecycle({ status: run.status, errorCode: run.errorCode ?? null, hasEvidence: run.evidenceOutcome != null,
    needsObservation: run.observing === true });
  if (!run.lifecycle && (lifecycle.status === 'NOT_STARTED' || lifecycle.status === 'AUTHORIZATION_PENDING')) return conversationState('STATUS_UNKNOWN', 'READ_EXECUTION_STATUS');
  const state = executionState(lifecycle, { reconciled: run.reconciled });
  if (run.landed && (state.state === 'CANCELLED' || state.state === 'FAILED')) return conversationState('NEEDS_ATTENTION', 'EARLIER_ACTION_CONFIRMED');
  // Still observed (the generic reader's flag), or a reader-computed lifecycle that is not final while its run reads final: not final yet.
  if (run.observing === true && state.final && !state.completed) return conversationState('STATUS_UNKNOWN', 'OBSERVATION_PENDING');
  return state;
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
  // BUILD-FLOFI-POST-257-HOTFIX-001 (P1-5): a bridge with no route FloFi can verify and execute (the providers' own definitive refusals included)
  // says so, instead of the generic "could not complete this step".
  [/(?:NO_EXECUTABLE_ROUTE|^(?:LIFI|ACROSS|RELAY|MAYAN|UNIVERSAL|BRIDGE)_NO_ROUTE$|^LIFI_UNDERLYING_PROTOCOL_NOT_RECONCILABLE$|^ROUTER_ROUTE_INTENT_MISMATCH$)/, {
    EN: 'No bridge route that FloFi can verify and execute is available for this amount right now. Nothing was signed or sent. Try again later or change the amount.',
    PT: 'Nenhuma rota de bridge que o FloFi consiga verificar e executar está disponível para esse valor agora. Nada foi assinado nem enviado. Tente mais tarde ou mude o valor.' }],
  [/(?:QUOTE|PREVIEW|SIMULATION_UNAVAILABLE|PROVIDER|UPSTREAM|ROUTE_UNAVAILABLE)/, { EN: 'The current quote is temporarily unavailable. You can try again without rebuilding your workflow.',
    PT: 'A cotação atual está temporariamente indisponível. Você pode tentar de novo sem refazer o seu fluxo.' }],
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P1): a workflow longer than FloFi accepts, or a step list that arrived with fewer steps than the
  // person asked for, is said so (before the TOO_MANY rate-limit family): FloFi never drops, merges or reorders a requested step.
  [/^WORKFLOW_TOO_MANY_STEPS$/, { EN: `FloFi accepts at most ${MAX_WORKFLOW_STEPS} steps in one workflow, and this one has more. Nothing was dropped, signed or sent. ` +
      'Remove steps or split it into two workflows.',
    PT: `O FloFi aceita no máximo ${MAX_WORKFLOW_STEPS} etapas em um fluxo, e este tem mais. Nenhuma etapa foi descartada, assinada ou enviada. Remova etapas ou ` +
      'divida-o em dois fluxos.' }],
  [/^WORKFLOW_STEP_COUNT_MISMATCH$/, { EN: 'FloFi received a different number of steps than you asked for, so it stopped. Nothing was signed or sent. Check the steps and ' +
      'try again.',
    PT: 'O FloFi recebeu um número de etapas diferente do que você pediu, então parou. Nada foi assinado nem enviado. Confira as etapas e tente de novo.' }],
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): Batch Payment refusals, each said as it is (before the generic families that would word them as
  // "too many requests", "invalid details" or "not available").
  [/^BATCH_PAYMENT_DUPLICATE_RECIPIENT$/, { EN: 'A recipient appears more than once. A Batch Payment pays each recipient once, and FloFi never merges or drops a payment: ' +
      'give that recipient one amount.',
    PT: 'Um destinatário aparece mais de uma vez. Um Pagamento em lote paga cada destinatário uma vez, e o FloFi nunca junta nem descarta um pagamento: dê um único ' +
      'valor a esse destinatário.' }],
  [/^BATCH_PAYMENT_(?:ATOMIC_EXECUTION_UNAVAILABLE|REQUIRES_ATOMIC_EXECUTION)$/, { EN: 'This Batch Payment can only run as one atomic authorization of your own wallet ' +
      '(every payment, or none), and that is not available here. Nothing was signed or sent. Use a wallet that supports atomic batches, or send separate transfers.',
    PT: 'Este Pagamento em lote só pode executar como uma autorização atômica da sua própria carteira (todos os pagamentos, ou nenhum), e isso não está disponível ' +
      'aqui. Nada foi assinado nem enviado. Use uma carteira que suporte lotes atômicos, ou envie transferências separadas.' }],
  // Review MCP-5: a recipient count outside 2..8 is said as such (TOO_MANY would otherwise read as the rate-limit family, TOO_FEW as the fallback).
  [/^BATCH_PAYMENT_TOO_MANY_RECIPIENTS$/, { EN: `A Batch Payment pays at most ${BATCH_PAYMENT_MAX_RECIPIENTS} recipients, and this one has more. No recipient was ` +
      'dropped, and nothing was signed or sent. Remove recipients, or split the payments into two separate workflows.',
    PT: `Um Pagamento em lote paga no máximo ${BATCH_PAYMENT_MAX_RECIPIENTS} destinatários, e este tem mais. Nenhum destinatário foi descartado, e nada foi ` +
      'assinado nem enviado. Remova destinatários ou divida os pagamentos em dois fluxos separados.' }],
  [/^BATCH_PAYMENT_TOO_FEW_RECIPIENTS$/, { EN: `A Batch Payment pays at least ${BATCH_PAYMENT_MIN_RECIPIENTS} recipients. To pay one recipient, use a transfer. ` +
      'Nothing was signed or sent.',
    PT: `Um Pagamento em lote paga pelo menos ${BATCH_PAYMENT_MIN_RECIPIENTS} destinatários. Para pagar um único destinatário, use uma transferência. ` +
      'Nada foi assinado nem enviado.' }],
  // Review M6: an invalid recipient or amount names what each payment needs (the generic INVALID family would only say "some details are invalid").
  [/^BATCH_PAYMENT_RECIPIENT_INVALID$/, { EN: 'Every recipient of a Batch Payment must be a valid 0x wallet address: a mixed-case address must match its checksum, ' +
      'and a reserved system address (0x…00 to 0x…ff) is never a recipient. FloFi never corrects an address. Nothing was signed or sent. Check each address.',
    PT: 'Cada destinatário de um Pagamento em lote precisa ser um endereço de carteira 0x válido: um endereço com maiúsculas e minúsculas precisa corresponder ao ' +
      'seu checksum, e um endereço reservado do sistema (0x…00 a 0x…ff) nunca é destinatário. O FloFi nunca corrige um endereço. Nada foi assinado nem enviado. ' +
      'Confira cada endereço.' }],
  [/^BATCH_PAYMENT_AMOUNT_INVALID$/, { EN: 'Every recipient of a Batch Payment needs a positive amount. Nothing was signed or sent. Check each amount.',
    PT: 'Cada destinatário de um Pagamento em lote precisa de um valor positivo. Nada foi assinado nem enviado. Confira cada valor.' }],
  [/^BATCH_PAYMENT_ASSET_MIXED$/, { EN: 'One Batch Payment pays one asset on one network. Nothing was signed or sent.',
    PT: 'Um Pagamento em lote paga um único ativo em uma única rede. Nada foi assinado nem enviado.' }],
  [/^BATCH_PAYMENT_EXCEEDS_WORKFLOW_STEP_BUDGET$/, { EN: `Each recipient of a Batch Payment counts as one of the ${MAX_WORKFLOW_STEPS} steps of a workflow, and this ` +
      'workflow has more. Nothing was dropped, signed or sent. Pay fewer recipients or split it into two workflows.',
    PT: `Cada destinatário de um Pagamento em lote conta como uma das ${MAX_WORKFLOW_STEPS} etapas de um fluxo, e este fluxo tem mais. Nada foi descartado, assinado ` +
      'ou enviado. Pague menos destinatários ou divida em dois fluxos.' }],
  [/^WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT$/, { EN: 'The earlier step delivered less than the payments need, so no payment was made: FloFi never reduces a ' +
      'recipient\u2019s amount. Review the workflow again with amounts that fit.',
    PT: 'A etapa anterior entregou menos do que os pagamentos precisam, então nenhum pagamento foi feito: o FloFi nunca reduz o valor de um destinatário. Revise o fluxo ' +
      'de novo com valores que caibam.' }],
  [/^BATCH_PAYMENT_(?:NETWORK|ASSET|TOKEN|RECIPIENT)_UNSUPPORTED$/, { EN: 'Batch Payments are available for native ETH and catalog tokens on Base, Arbitrum One, ' +
      'Ethereum and Robinhood Chain (never Stock Tokens, never Solana in this version).',
    PT: 'Pagamentos em lote estão disponíveis para ETH nativo e tokens do catálogo na Base, Arbitrum One, Ethereum e Robinhood Chain (nunca Stock Tokens, nunca Solana ' +
      'nesta versão).' }],
  [/^BATCH_PAYMENT_AMOUNT_ABOVE_MAXIMUM$/, { EN: 'An ETH amount in this Batch Payment is above the per-payment maximum FloFi sends on this network. Nothing was signed or sent. '
      + 'Lower the amount or split the payment.',
    PT: 'Um valor em ETH neste Pagamento em lote está acima do máximo por pagamento que o FloFi envia nesta rede. Nada foi assinado nem enviado. Diminua o valor ou '
      + 'divida o pagamento.' }],
  [/^BATCH_PAYMENT_AMOUNT_TOO_PRECISE$/, { EN: 'An amount in this Batch Payment has more decimal places than the asset allows. Nothing was rounded, signed or sent.',
    PT: 'Um valor neste Pagamento em lote tem mais casas decimais do que o ativo permite. Nada foi arredondado, assinado nem enviado.' }],
  [/^BATCH_PAYMENT_EARLIER_REQUEST_UNPROVEN$/, { EN: 'FloFi cannot yet prove from the chain that the earlier request of this Batch Payment never executed, so it does not '
      + 'ask your wallet again (that could pay every recipient twice). Check your wallet\u2019s activity; you can end the run at any time.',
    PT: 'O FloFi ainda não consegue provar pela rede que o pedido anterior deste Pagamento em lote nunca executou, então não pede de novo à sua carteira (isso poderia '
      + 'pagar cada destinatário duas vezes). Confira a atividade da sua carteira; você pode encerrar a execução a qualquer momento.' }],
  // Review MCP-5: the earlier request can never be proven unexecuted (e.g. an ETH batch): FloFi will not ask the wallet again; the person starts afresh.
  [/^BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE$/, { EN: 'FloFi cannot prove from the chain that the earlier request of this Batch Payment never executed (for example, '
      + 'an ETH batch), so it will not ask your wallet again. Check your wallet’s activity first, then end the run and start a new Review.',
    PT: 'O FloFi não consegue provar pela rede que o pedido anterior deste Pagamento em lote nunca executou (por exemplo, um lote em ETH), então não vai pedir '
      + 'de novo à sua carteira. Confira primeiro a atividade da sua carteira; depois encerre a execução e comece uma nova Revisão.' }],
  [/^WALLET_BATCH_PARTIALLY_EXECUTED$/, { EN: 'Your wallet sent this batch as several transactions and only some of them succeeded, so part of it executed. FloFi records '
      + 'it for review and never sends it again; check each transaction before doing anything else.',
    PT: 'Sua carteira enviou este lote como várias transações e só algumas deram certo, então parte dele foi executada. O FloFi registra isso para revisão e nunca o '
      + 'envia de novo; confira cada transação antes de fazer qualquer outra coisa.' }],
  // BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P0): balance reads that this FloFi deployment has not turned on (an operator setting), before the
  // generic portfolio family: re-linking the wallet cannot change it, and it is never a zero balance.
  [/^PORTFOLIO_READS_NOT_ENABLED$/, { EN: 'This FloFi deployment does not read wallet balances through this connection yet. Linking your wallet again does not change ' +
      'that; your runs and history are still available.',
    PT: 'Esta implantação do FloFi ainda não lê saldos de carteira por esta conexão. Vincular a carteira de novo não muda isso; as suas execuções e o histórico ' +
      'continuam disponíveis.' }],
  [/^PORTFOLIO_REQUIRES_FLOFI_ACCOUNT$/, { EN: 'Wallet balances are read only for a FloFi account connection. This connection cannot read them.',
    PT: 'Saldos de carteira só são lidos para uma conexão de conta FloFi. Esta conexão não consegue lê-los.' }],
  [/(?:PENDING_LIMIT|HANDOFF_LIMIT)/, { EN: 'You already have the maximum number of open approval requests. Cancel one or let it expire, then try again.',
    PT: 'Você já tem o número máximo de solicitações de aprovação abertas. Cancele uma ou deixe-a expirar e tente de novo.' }],
  [/(?:RATE_LIMIT|BUSY|_LIMIT$|TOO_MANY)/, { EN: 'There are too many requests right now. Wait a moment and try again.',
    PT: 'Há muitas solicitações agora. Aguarde um momento e tente de novo.' }],
  [/WALLET_LINK_REQUIRED|WALLET_NOT_LINKED/, { EN: 'Link your wallet to FloFi first: open the FloFi link, connect your wallet and confirm its sign-in message. That message moves no funds.',
    PT: 'Vincule primeiro a sua carteira ao FloFi: abra o link do FloFi, conecte a carteira e confirme a mensagem de acesso. Essa mensagem não movimenta fundos.' }],
  [/RELINK_REQUIRED/, { EN: 'Link your wallet again on FloFi\u2019s Connections page to allow balance reads. It needs only a sign-in message and moves no funds.',
    PT: 'Vincule a carteira de novo na página Ligações (Connections) do FloFi para permitir a leitura de saldos. Só pede uma mensagem de acesso e não movimenta fundos.' }],
  [/(?:^PORTFOLIO_|^HISTORY_|POSITION_SCAN)/, { EN: 'FloFi cannot read balances, positions or history here right now. Try again in a few minutes.',
    PT: 'O FloFi não consegue ler saldos, posições ou histórico aqui agora. Tente de novo em alguns minutos.' }],
  [/(?:INSUFFICIENT_SCOPE|MCP_UNAUTHORIZED|^OAUTH_|INVALID_GRANT|ACCESS_TOKEN)/, { EN: 'FloFi needs you to reconnect and grant access again in this app.',
    PT: 'O FloFi precisa que você se reconecte e conceda o acesso de novo neste app.' }],
  [/^BETA_|ACCESS_DENIED|NOT_ELIGIBLE/, { EN: 'Your FloFi account does not have access to this yet.', PT: 'A sua conta FloFi ainda não tem acesso a isto.' }],
  [/INSUFFICIENT_(?:BALANCE|FUNDS)/, { EN: 'The wallet balance is too low for this amount. Choose a smaller amount or add funds.',
    PT: 'O saldo da carteira é insuficiente para esse valor. Escolha um valor menor ou adicione fundos.' }],
  [/INSUFFICIENT_GAS|GAS_BALANCE/, { EN: 'The wallet does not have enough of the network\'s native token to pay the network fee.',
    PT: 'A carteira não tem o token nativo da rede suficiente para pagar a taxa da rede.' }],
  [/(?:_EXPIRED$|^EXPIRED|QUOTE_STALE)/, { EN: 'This request expired. Check its status before asking FloFi for a fresh quote and review.',
    PT: 'Esta solicitação expirou. Consulte o status antes de pedir ao FloFi uma nova cotação e revisão.' }],
  [/(?:REVOKED|SUPERSEDED)/, { EN: 'This request was cancelled or replaced by a newer one.', PT: 'Esta solicitação foi cancelada ou substituída por uma mais recente.' }],
  [/(?:STALE|HASH_MISMATCH|WORKFLOW_CHANGED)/, { EN: 'The workflow or market conditions changed. Review it again before signing.',
    PT: 'O fluxo ou as condições de mercado mudaram. Revise-o de novo antes de assinar.' }],
  [/NOT_CANCELLABLE|IN_EXECUTION/, { EN: 'This request can no longer be cancelled from here. Reject it in your wallet or decide in the FloFi signing page.',
    PT: 'Esta solicitação não pode mais ser cancelada por aqui. Rejeite-a na sua carteira ou decida na página de assinatura do FloFi.' }],
  [/(?:NOT_FOUND|UNKNOWN_ID)/, { EN: 'FloFi could not find that for your account.', PT: 'O FloFi não encontrou isso na sua conta.' }],
  // BUILD-FLOFI-POST-257-HOTFIX-001 (P1-5): a deployment or policy gate is not an unsupported asset (a host relayed "the destination asset is not
  // supported" for a Universal Bridge this deployment simply did not hand off), and a read-only preview without a wallet subject never needs an
  // address typed in chat.
  [/^(?:EVM|SOLANA)_WALLET_REQUIRED$/, { EN: 'This read-only preview needs a wallet, and FloFi could not pick one of your linked wallets for it. You can skip the preview: ' +
      'requesting approval needs no address, and FloFi simulates again with your own wallet before you sign.',
    PT: 'Esta prévia somente leitura precisa de uma carteira, e o FloFi não conseguiu escolher uma das suas carteiras vinculadas. Você pode pular a prévia: ' +
      'pedir a aprovação não exige endereço, e o FloFi simula de novo com a sua própria carteira antes de você assinar.' }],
  [/(?:_IN_DEPLOYMENT$|_BY_POLICY$)/, { EN: 'FloFi supports this operation, but this FloFi deployment does not hand it off for signing right now. Nothing was signed or sent.',
    PT: 'O FloFi suporta esta operação, mas esta implantação do FloFi não a envia para assinatura agora. Nada foi assinado nem enviado.' }],
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
