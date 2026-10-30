// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: the FloFi chat's own lifecycle over BUILD → SIMULATE → REVIEW → AUTHORIZE → EXECUTE → RECONCILE. Pure: no
 * React, wallet, network, quote or execution. Conversational state is intent and presentation only. The canonical workflow, the selected
 * runtime's simulation/Review record and the durable execution record stay authoritative, and every answer applies only to the one question
 * FloFi has open. A confirmation binds the exact reviewed workflow revision and hash, the Review authority key and Strategy Manifest, the
 * wallet, its network and the quote's expiry; any change retires it. Nothing here signs, submits, approves or retries anything: the chat
 * reaches the existing Simulate, Authorize-in-wallet, Continue and observation-only Check-status controls, whose own gates re-check at the click.
 */
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from './initial-workflow';
import { composerActions, composerSummary } from './composer-presentation';
import { projectReview, type ReviewAuthorization, type ReviewWallet } from './review-presentation';
import { projectSimulation, type SimulationLine, type SimulationSource, type SimulationWarning } from './simulation-presentation';
import type { ExecutionLifecycle, LifecycleOperation } from './execution-lifecycle';
import { currentExecution, projectExecutionResult } from './execution-result';
import { shellChainLabel } from './product-shell';
import type { Command } from './commands';
import { conversationCopy } from './conversation-copy';
import { portuguese } from '../i18n/pt';
import type { SequencePresentation } from './sequence-presentation';

export type ConversationLanguage = 'EN' | 'PT';
/** Conceptual chat states. They name what the conversation waits for; the runtimes' own state machines stay the source of truth. */
export type ConversationPhase = 'AUTHORING' | 'AWAITING_MISSING_FIELDS' | 'READY_TO_REVIEW' | 'SIMULATING' | 'REVIEW_AVAILABLE' | 'AWAITING_WORKFLOW_CONFIRMATION'
  | 'WORKFLOW_CONFIRMED' | 'AWAITING_EXECUTION_CONFIRMATION' | 'AWAITING_WALLET' | 'EXECUTING' | 'RECONCILING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'UNCERTAIN';
/** What the chat reads from the shell: the same values the Canvas lifecycle action and the Review/Execute workspaces present. */
export type LifecycleView = {
  readonly workflow: Workflow; readonly context: ReviewContext; readonly source: SimulationSource; readonly authorization: ReviewAuthorization;
  readonly wallet: ReviewWallet; readonly progress: ExecutionLifecycle | null | undefined; readonly invalidWorkflow: boolean;
  /**
   * BUILD-FLOFI-CHAT-E2E-FIX-002: a workflow of several independent owner-wallet actions. `workflow` (and so the Review, binding and execution
   * record) is then the CURRENT step alone; this lists every canonical action with its state, how a funded step is funded, and why a step
   * cannot run (`issue`). Null for a one-action workflow or an existing composition.
   */
  readonly sequence?: ConversationSequence | null | undefined;
};
export type ConversationSequence = SequencePresentation & { readonly issue: string | null; readonly awaitingDelivery: boolean };
/** Exactly what one conversational confirmation is about. */
export type ReviewBinding = {
  readonly workflowId: string; readonly revision: number; readonly workflowHash: string; readonly source: SimulationSource['kind'];
  readonly authorizationKey: string; readonly manifestHash: string | null; readonly account: string; readonly chain: string | null; readonly expiresAt: number | null;
};
export type BindingIssue = 'WORKFLOW_CHANGED' | 'REVIEW_REPLACED' | 'WALLET_CHANGED' | 'NETWORK_CHANGED' | 'QUOTE_EXPIRED' | 'REVIEW_UNAVAILABLE';
/** FloFi's one open question. Only an explicit answer to it, while its binding still holds, does anything. */
export type PendingQuestion =
  | { readonly kind: 'NEXT_STEP'; readonly workflowId: string; readonly revision: number }
  | { readonly kind: 'CONFIRM_WORKFLOW'; readonly binding: ReviewBinding }
  | { readonly kind: 'CONFIRM_EXECUTION'; readonly binding: ReviewBinding }
  /** The next never-attempted wallet request of a run already authorized (e.g. the swap after a confirmed approval). */
  | { readonly kind: 'CONFIRM_CONTINUE'; readonly binding: ReviewBinding; readonly runKey: string | null; readonly fingerprint: string }
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: a Canvas card has a typed amount that was never applied; apply it (YES) or discard it (NO) before the Review. */
  | { readonly kind: 'RESOLVE_EDIT'; readonly nodeId: string; readonly workflowId: string; readonly revision: number };
export type Answer = 'YES' | 'NO' | 'UNCLEAR';

const sameAccount = (a: string, b: string) => a === b || /^0x/i.test(a) && a.toLowerCase() === b.toLowerCase();
/** The canonical semantic hash the Strategy Manifest binds (`semanticWorkflowHash`); null when the draft has no canonical form yet. */
export function workflowHash(workflow: Workflow): string | null {
  try { return hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))); } catch { return null; }
}
function manifestHash(manifest: unknown): string | null {
  if (!manifest) return null;
  try { return hashArtifactBytes('strategy-manifest', new TextEncoder().encode(JSON.stringify(manifest))); } catch { return JSON.stringify(manifest) ?? null; }
}
const actionable = (workflow: Workflow) => composerActions(workflow).length > 0;
const review = (view: LifecycleView, now: number) => projectReview(view.workflow, view.context, view.source, view.authorization, view.wallet, now, view.invalidWorkflow);

/** The binding of the Review FloFi presents now, or null when there is no approvable (or already approved) Review for this wallet. */
export function reviewBinding(view: LifecycleView, now = Date.now()): ReviewBinding | null {
  const current = review(view, now), key = view.authorization.key, account = view.wallet.account, hash = workflowHash(view.workflow);
  if (!key || !account || !hash || !(current.status === 'ready' || current.bindingValid)) return null;
  return { workflowId: view.workflow.workflowId, revision: view.workflow.revision, workflowHash: hash, source: view.source.kind, authorizationKey: key,
    manifestHash: manifestHash(view.authorization.manifest), account, chain: view.wallet.chain, expiresAt: current.expiresAt };
}
/** Why a confirmation no longer applies (checked again at every answer and before every wallet request), or null while it still holds. */
export function bindingIssue(binding: ReviewBinding, view: LifecycleView, now = Date.now()): BindingIssue | null {
  if (view.workflow.workflowId !== binding.workflowId || view.workflow.revision !== binding.revision || workflowHash(view.workflow) !== binding.workflowHash) return 'WORKFLOW_CHANGED';
  if (!view.wallet.account || !sameAccount(view.wallet.account, binding.account) || view.wallet.changed) return 'WALLET_CHANGED';
  if (view.wallet.chain !== binding.chain) return 'NETWORK_CHANGED';
  if (view.source.kind !== binding.source || view.authorization.key !== binding.authorizationKey || manifestHash(view.authorization.manifest) !== binding.manifestHash) return 'REVIEW_REPLACED';
  if (binding.expiresAt !== null && now >= binding.expiresAt) return 'QUOTE_EXPIRED';
  const current = review(view, now);
  if (current.status === 'expired') return 'QUOTE_EXPIRED';
  if (current.status === 'invalidated') return /Wallet changed/.test(current.message) ? 'WALLET_CHANGED' : /Network changed/.test(current.message) ? 'NETWORK_CHANGED' : 'WORKFLOW_CHANGED';
  if (current.status !== 'ready' && current.status !== 'approved') return 'REVIEW_UNAVAILABLE';
  return null;
}

// ── Deterministic answers (never the model) ─────────────────────────────────────────────────────────────────────────────────────────────
const normalize = (text: string) => text.normalize('NFC').trim().toLowerCase().replace(/[“”"'’]/g, '').replace(/[.!]+$/, '').replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ');
const pattern = (words: readonly string[]) => new RegExp(`^(?:${words.join('|')})$`);
const NO_WORDS = pattern(['no', 'nope', 'not now', 'not yet', 'cancel', 'stop', 'wait', 'dont', 'do not', 'no thanks', 'não', 'nao', 'agora não', 'agora nao', 'ainda não',
  'ainda nao', 'cancelar', 'cancela', 'parar', 'pare', 'espera', 'espere', 'não obrigado', 'nao obrigado']);
const CONFIRM_WORKFLOW = pattern(['yes', 'yes please', 'confirm', 'i confirm', 'confirmed', 'yes confirm', 'yes i confirm', 'confirm workflow', 'confirm the workflow',
  'confirm this workflow', 'confirm my workflow', 'yes confirm the workflow', 'yes confirm this workflow', 'sim', 'confirmo', 'eu confirmo', 'sim confirmo', 'confirmar',
  'confirmado', 'sim confirmar', 'confirmar workflow', 'confirmar o workflow', 'confirmo o workflow', 'confirmar fluxo', 'confirmo o fluxo', 'sim confirmo o workflow']);
const CONFIRM_EXECUTION = pattern(['yes', 'yes please', 'yes execute', 'yes execute it', 'yes execute now', 'yes execute the workflow', 'yes execute this workflow', 'execute',
  'execute it', 'execute now', 'execute the workflow', 'execute this workflow', 'execute my workflow', 'yes run it', 'run it', 'run it now', 'sim', 'sim executar',
  'sim executa', 'sim execute', 'executar', 'executa', 'executar agora', 'execute agora', 'pode executar', 'sim pode executar', 'executar workflow', 'executar o workflow',
  'executar o fluxo', 'sim executar agora']);
const CONTINUE = pattern(['yes', 'yes please', 'continue', 'yes continue', 'continue to wallet', 'yes continue to wallet', 'sim', 'continuar', 'sim continuar', 'continua', 'pode continuar']);
const APPLY_EDIT = pattern(['yes', 'yes please', 'apply', 'apply it', 'apply the edit', 'apply the amount', 'yes apply', 'yes apply it', 'use it', 'sim', 'aplicar', 'aplica',
  'aplicar a edição', 'aplicar a edicao', 'aplicar o montante', 'sim aplicar', 'sim aplica', 'usar']);
const DISCARD_EDIT = pattern(['discard', 'discard it', 'discard the edit', 'discard edit', 'no discard', 'drop it', 'descartar', 'descarta', 'descartar a edição',
  'descartar a edicao', 'descartar edição', 'descartar edicao', 'não descartar', 'nao descartar']);
const NEXT_REVIEW = pattern(['review', 'review workflow', 'review my workflow', 'review the workflow', 'review this workflow', 'lets review', 'let us review',
  'review it', 'simulate', 'simulate workflow', 'simulate my workflow', 'simulate the workflow', 'run simulation', 'revisar', 'revisar workflow', 'revisar o workflow',
  'revisar meu workflow', 'revisar fluxo', 'revisar o fluxo', 'revisar meu fluxo', 'revise', 'revise o workflow', 'revise meu workflow', 'vamos revisar', 'simular',
  'simular workflow', 'simular o workflow', 'simular meu workflow', 'simular fluxo', 'simular meu fluxo']);
// BUILD-FLOFI-BRIDGE-LIVE-FIX-003: recovery after a refused start or an expired/changed quote is a fresh simulation, asked for in chat.
const REFRESH_REQUEST = pattern(['simulate again', 'simulate it again', 'retry simulation', 'try again', 'refresh quote', 'refresh the quote', 'get a new quote',
  'get a fresh quote', 'new quote', 'requote', 'simular novamente', 'simular de novo', 'tentar novamente', 'tentar de novo', 'atualizar cotação', 'atualizar cotacao',
  'atualizar a cotação', 'atualizar a cotacao', 'nova cotação', 'nova cotacao']);
const ANOTHER_ROUTE = pattern(['try another route', 'try a different route', 'another route', 'different route', 'find another route', 'use another route',
  'tentar outra rota', 'outra rota', 'buscar outra rota', 'usar outra rota']);
const NEXT_ADD = pattern(['add another action', 'add another', 'add action', 'add more', 'another action', 'adicionar outra ação', 'adicionar outra acao',
  'adicionar ação', 'adicionar acao', 'outra ação', 'outra acao', 'adicionar mais']);
const EXECUTE_REQUEST = pattern(['execute', 'execute workflow', 'execute my workflow', 'execute the workflow', 'execute this workflow', 'run my workflow', 'run the workflow',
  'executar', 'executar workflow', 'executar meu workflow', 'executar o workflow', 'executar fluxo', 'executar meu fluxo', 'executar o fluxo']);
const STATUS_REQUEST = pattern(['status', 'check status', 'execution status', 'whats the status', 'what is the status', 'check execution', 'refresh status',
  'verificar status', 'ver status', 'status da execução', 'status da execucao', 'verificar execução', 'verificar execucao', 'atualizar status']);
const UNDO_REQUEST = pattern(['undo', 'undo that', 'undo this change', 'undo last change', 'desfazer', 'desfaz', 'desfazer isso', 'desfazer esta alteração', 'desfazer esta alteracao',
  'desfazer última alteração', 'desfazer ultima alteracao']);
const PT_LIFECYCLE = /\b(?:sim|não|nao|confirmo|confirmar|executar|executa|revisar|revise|simular|adicionar|outra|cancelar|verificar|desfazer|continuar|agora|fluxo|aplicar|aplica|descartar|descarta|novamente|cotação|cotacao|rota|tentar)\b/;

/** An explicit answer to FloFi's open question. Anything else — extra content, an edit, a hedge — is UNCLEAR and changes nothing. */
export function classifyAnswer(text: string, question: PendingQuestion['kind']): Answer {
  const value = normalize(text);
  if (question === 'RESOLVE_EDIT') return DISCARD_EDIT.test(value) ? 'NO' : APPLY_EDIT.test(value) ? 'YES' : NO_WORDS.test(value) ? 'NO' : 'UNCLEAR';
  if (NO_WORDS.test(value)) return 'NO';
  const yes = question === 'CONFIRM_WORKFLOW' ? CONFIRM_WORKFLOW : question === 'CONFIRM_EXECUTION' ? CONFIRM_EXECUTION : question === 'CONFIRM_CONTINUE' ? CONTINUE : null;
  return yes?.test(value) ? 'YES' : 'UNCLEAR';
}
/** A lifecycle request the chat handles itself, with no model: Review, Add another action, Execute, Status or Undo. */
export function lifecycleRequest(text: string): 'REVIEW' | 'REFRESH' | 'ROUTE' | 'ADD' | 'EXECUTE' | 'STATUS' | 'UNDO' | null {
  const value = normalize(text);
  return NEXT_REVIEW.test(value) ? 'REVIEW' : REFRESH_REQUEST.test(value) ? 'REFRESH' : ANOTHER_ROUTE.test(value) ? 'ROUTE' : NEXT_ADD.test(value) ? 'ADD' : EXECUTE_REQUEST.test(value) ? 'EXECUTE' : STATUS_REQUEST.test(value) ? 'STATUS'
    : UNDO_REQUEST.test(value) ? 'UNDO' : null;
}
/** The language of a short lifecycle message (PT words decide), else the interface language. */
export function answerLanguage(text: string, fallback: ConversationLanguage): ConversationLanguage {
  const value = normalize(text);
  return PT_LIFECYCLE.test(value) ? 'PT' : /\b(?:yes|no|confirm|execute|review|simulate|add|another|cancel|status|undo|continue|run|apply|discard|refresh|quote|route|retry|again)\b/.test(value) ? 'EN' : fallback;
}

// ── Phase ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const IN_FLIGHT = ['preparing', 'submitting', 'submitted', 'pending', 'signed', 'posted', 'settling', 'partial'];
/** The conceptual chat state, read from FloFi's open question and the existing records (execution first: it is the financial truth). */
export function conversationPhase(view: LifecycleView, question: PendingQuestion | null, draftOpen: boolean, now = Date.now()): ConversationPhase {
  const live = currentExecution(view.progress);
  if (live) {
    const operations = live.steps.flatMap(step => step.operations);
    if (operations.some(operation => operation.state === 'wallet')) return 'AWAITING_WALLET';
    if (live.state === 'uncertain') return 'UNCERTAIN';
    if (live.state === 'complete') return 'COMPLETED';
    if (live.state === 'attention') return projectExecutionResult(live)?.label === 'Execution partially completed' ? 'PARTIAL' : 'FAILED';
    if (question?.kind === 'CONFIRM_CONTINUE') return 'AWAITING_EXECUTION_CONFIRMATION';
    if (live.busy || operations.some(operation => ['submitted', 'pending', 'settling', 'partial'].includes(operation.state))) return 'RECONCILING';
    if (operations.some(operation => IN_FLIGHT.includes(operation.state))) return 'EXECUTING';
    return 'EXECUTING';
  }
  if (question?.kind === 'CONFIRM_EXECUTION') return 'AWAITING_EXECUTION_CONFIRMATION';
  if (question?.kind === 'CONFIRM_WORKFLOW') return 'AWAITING_WORKFLOW_CONFIRMATION';
  if (view.source.state.busy) return 'SIMULATING';
  if (draftOpen) return 'AWAITING_MISSING_FIELDS';
  const current = actionable(view.workflow) ? review(view, now) : null;
  if (current?.status === 'approved' && current.bindingValid) return 'WORKFLOW_CONFIRMED';
  if (current?.status === 'ready') return 'REVIEW_AVAILABLE';
  return actionable(view.workflow) ? 'READY_TO_REVIEW' : 'AUTHORING';
}

// ── Review summary (existing projections only; nothing is estimated here) ───────────────────────────────────────────────────────────────
export type ConversationReviewStep = { readonly number: number; readonly action: string; readonly input: string; readonly pair: string | null; readonly networks: string;
  readonly provider: string | null; readonly result: string | null; readonly resultLabel: string; readonly minimum: string | null; readonly slippage: string | null;
  readonly priceImpact: string | null; readonly details: readonly SimulationLine[] };
export type ConversationReview = {
  readonly status: string; readonly label: string; readonly message: string; readonly canConfirm: boolean; readonly steps: readonly ConversationReviewStep[];
  readonly fees: readonly SimulationLine[]; readonly limits: readonly SimulationLine[]; readonly warnings: readonly SimulationWarning[];
  readonly approvals: readonly { readonly symbol: string; readonly value: string; readonly spender: string; readonly network: string }[];
  /** The wallet requests the reviewed record plans, in order (each is a separate confirmation in the wallet). Empty: not known before execution starts. */
  readonly walletRequests: readonly string[];
  /** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: what the provider executes after the wallet requests (a bridge's destination settlement): no signature. */
  readonly providerSteps: readonly string[];
  readonly account: string | null; readonly network: string | null; readonly expiresAt: number | null;
  /** Fee lines the simulation does not itemize, named so the chat says "not provided" rather than inventing a value. */
  readonly unknown: readonly string[];
  /** The simulation's own reason when it cannot be used (a failed or refused simulation), else null. */
  readonly simulationProblem: string | null;
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: every canonical action of a sequence (the simulated one is `steps`), or null. */
  readonly sequence: ConversationSequence | null;
  /**
   * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the total additional payable cost. `additional`: exact per-asset sums of the estimates paid on top of the
   * amount sent (ADDITIONAL lines only); `ceilings`: exact per-asset sums of the maximums (never added to an estimate). A fee already included in
   * the quoted output, a component of such a fee and FloFi's unrecorded or obligation fee are never added; nothing is converted or estimated.
   * `excludes` names what the total cannot include (a cost the simulation does not provide, lines it cannot classify, later steps).
   */
  readonly totals: { readonly additional: readonly string[]; readonly ceilings: readonly string[];
    readonly excludes: readonly { readonly text: string; readonly parameters: readonly (string | number)[] }[] };
  /** FloFi's fee as this route actually accounts it: the recorded obligation line, or that nothing is charged or recorded. Never a guess. */
  readonly flofiFee: { readonly value: string; readonly note: string; readonly recorded: boolean };
};
/** Exact per-asset sums of decimal amounts written "<number> <symbol>"; a value that is not one is left out (and reported by the caller). */
export function sumByAsset(values: readonly string[]): { readonly sums: readonly string[]; readonly unreadable: number } {
  const totals = new Map<string, { units: bigint; scale: number }>();
  let unreadable = 0;
  for (const value of values) {
    const match = /^(\d+)(?:\.(\d+))? (\S.*)$/.exec(value.trim());
    if (!match) { unreadable += 1; continue; }
    const fraction = match[2] ?? '', symbol = match[3]!, units = BigInt(match[1]! + fraction), current = totals.get(symbol) ?? { units: 0n, scale: 0 };
    const scale = Math.max(current.scale, fraction.length);
    totals.set(symbol, { units: current.units * 10n ** BigInt(scale - current.scale) + units * 10n ** BigInt(scale - fraction.length), scale });
  }
  const sums = [...totals].map(([symbol, { units, scale }]) => {
    const padded = units.toString().padStart(scale + 1, '0'), whole = scale ? padded.slice(0, -scale) : padded, fraction = scale ? padded.slice(-scale).replace(/0+$/, '') : '';
    return `${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
  });
  return { sums, unreadable };
}
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the payable costs of a simulation's fee lines. A line counts only by its explicit treatment — never by blindly
 * summing every displayed fee line (the live Bridge Review once added a route fee total to its own components, showing 0.008206 USDC for a
 * 0.004103 USDC route fee that was already deducted from the quoted output). `additional`: exact per-asset sums of ADDITIONAL estimates;
 * `ceilings`: exact per-asset sums of CEILING maximums (never added to an estimate); a network cost with neither is `unknown`; lines without a
 * treatment (or an unreadable amount) are counted in `unclassified` and excluded. FloFi's fee is the OBLIGATION line, or "Not charged".
 */
export function payableCosts(fees: readonly SimulationLine[]) {
  const unknown: string[] = [];
  if (!fees.some(line => (line.treatment === 'ADDITIONAL' || line.treatment === 'CEILING') && /network|gas|execution fee/i.test(line.label))) unknown.push('Network cost');
  const additional = sumByAsset(fees.filter(line => line.treatment === 'ADDITIONAL').map(line => line.value));
  const ceilings = sumByAsset(fees.filter(line => line.treatment === 'CEILING').map(line => line.value));
  const unclassified = fees.filter(line => !line.treatment).length + additional.unreadable + ceilings.unreadable;
  const obligation = fees.find(line => line.treatment === 'OBLIGATION');
  const flofiFee = obligation ? { value: obligation.value, note: obligation.note ?? '', recorded: true }
    : { value: 'Not charged', note: 'FloFi\'s 0.1% fee per completed workflow is not collected on-chain, and this route records no fee obligation yet.', recorded: false };
  return { additional: additional.sums, ceilings: ceilings.sums, unknown, unclassified, flofiFee };
}
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: refusals at the execution boundary that mean the reviewed quote or chain state no longer stands (changed or
 * expired). Nothing was sent; the chat re-quotes and asks for a fresh Review instead of offering the dead one again.
 */
export const QUOTE_MOVED = /ROUTE_CHANGED|QUOTE_CHANGED|REQUOTE|STATE_CHANGED|GAS_CHANGED|REVIEW_EXPIRED|QUOTE_EXPIRED|STOCK_MULTIPLIER_CHANGED/;
/** What a fresh Review changed against the previous one of the same workflow revision: every step figure and cost line, by label (values as shown). */
export function reviewChanges(previous: ConversationReview, next: ConversationReview): readonly { readonly label: string; readonly before: string; readonly after: string }[] {
  const changes: { label: string; before: string; after: string }[] = [];
  const compare = (label: string, before: string | null | undefined, after: string | null | undefined) => {
    if ((before ?? null) !== (after ?? null)) changes.push({ label, before: before ?? '—', after: after ?? '—' });
  };
  for (const step of next.steps) {
    const old = previous.steps.find(item => item.number === step.number);
    if (!old) continue;
    compare('Expected receipt', old.result, step.result);
    compare('Minimum receipt', old.minimum, step.minimum); compare('Provider', old.provider, step.provider); compare('Max slippage', old.slippage, step.slippage);
  }
  const labels = [...new Set([...previous.fees, ...next.fees].map(line => line.label))];
  for (const label of labels) compare(label, previous.fees.find(line => line.label === label)?.value, next.fees.find(line => line.label === label)?.value);
  return changes;
}
export function conversationReview(view: LifecycleView, now = Date.now()): ConversationReview {
  const simulation = projectSimulation(view.workflow, view.context, view.source, now), current = review(view, now), sequence = view.sequence ?? null;
  const steps = simulation.steps.map(step => {
    const reviewed = current.steps.find(item => item.id === step.id);
    // A sequence simulates its current step alone: number it as that step of the whole workflow.
    return { number: sequence ? sequence.current : step.number, action: step.action, input: step.input, pair: step.pair, networks: step.networks.join(' → ') || reviewed?.network || '—',
      provider: step.provider ?? reviewed?.provider ?? null, result: step.result, resultLabel: step.resultLabel, minimum: step.minimum,
      slippage: step.slippage ?? step.configuredSlippage, priceImpact: step.priceImpact, details: step.details };
  });
  const fees = simulation.fees, { additional, ceilings, unknown, unclassified, flofiFee } = payableCosts(fees);
  const later = sequence ? sequence.steps.filter(step => step.state === 'NEXT').map(step => step.number) : [];
  const excludes = [...unknown.map(text => ({ text, parameters: [] })), ...unclassified ? [{ text: 'Cost lines FloFi cannot classify', parameters: [] }] : [],
    ...later.length ? [{ text: later.length === 1 ? 'Step {0} (simulated after the steps before it)' : 'Steps {0} (simulated after the steps before them)', parameters: [later.join(', ')] }] : []];
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: only requests the owner's wallet signs; provider settlement is observed and reconciled, never signed.
  const planned = view.progress && !view.progress.started ? view.progress.steps.flatMap(step => step.operations.filter(operation => operation.wallet).map(operation => operation.title)) : [];
  const settlement = view.progress && !view.progress.started ? view.progress.steps.flatMap(step => step.operations.filter(operation => !operation.wallet).map(operation => operation.title)) : [];
  return { status: current.status, label: current.label, message: current.status === 'ready' || current.status === 'approved' ? simulation.message : current.message,
    canConfirm: current.status === 'ready' || current.bindingValid, steps, fees, limits: current.limits, warnings: [...current.warnings],
    approvals: current.approvals.map(({ symbol, value, spender, network }) => ({ symbol, value, spender, network })), walletRequests: planned, providerSteps: settlement,
    account: view.wallet.account, network: view.wallet.chain ? shellChainLabel(view.wallet.chain) : null, expiresAt: current.expiresAt, unknown,
    simulationProblem: simulation.status === 'blocked' ? simulation.message : null, sequence, totals: { additional, ceilings, excludes }, flofiFee };
}

// ── Execution progress (the durable record's projection, never chat text) ──────────────────────────────────────────────────────────────
export type ConversationExecution = {
  readonly phase: ConversationPhase; readonly label: string; readonly message: string; readonly completed: number; readonly total: number;
  readonly current: string | null;
  readonly operations: readonly (Pick<LifecycleOperation, 'id' | 'title' | 'label' | 'state' | 'hash' | 'explorer' | 'chain'> & { readonly network: string })[];
  readonly received: readonly SimulationLine[]; readonly costs: readonly SimulationLine[]; readonly final: boolean;
  /** BUILD-FLOFI-CHAT-E2E-FIX-002: the sequence step this run executes, and how many steps the workflow has (null: not a sequence). */
  readonly sequenceStep: { readonly current: number; readonly total: number; readonly action: string; readonly completed: number } | null;
};
export function conversationExecution(view: LifecycleView): ConversationExecution | null {
  const live = currentExecution(view.progress);
  if (!live) return null;
  const result = projectExecutionResult(live), phase = conversationPhase(view, null, false);
  const operations = live.steps.flatMap(step => step.operations).map(({ id, title, label, state, hash, explorer, chain }) => ({ id, title, label, state, hash, explorer, chain, network: shellChainLabel(chain) }));
  const received = Object.values(live.evidence?.operations ?? {}).flatMap(operation => operation.values.filter(value => /received|deposited/i.test(value.label)));
  return { phase, label: result?.label ?? live.label, message: result?.message ?? live.message, completed: live.completed, total: live.steps.length,
    current: live.active ? `${live.active.number}. ${live.active.action}` : null, operations, received, costs: live.evidence?.knownCosts ?? [], final: Boolean(result),
    sequenceStep: view.sequence ? { current: view.sequence.current, total: view.sequence.total, action: view.sequence.steps[view.sequence.current - 1]?.action ?? '',
      completed: view.sequence.steps.filter(step => step.state === 'COMPLETED').length } : null };
}

// ── Authoring changes the chat committed ────────────────────────────────────────────────────────────────────────────────────────────────
const label = (language: ConversationLanguage, value: string) => language === 'PT' ? portuguese[value] ?? value : value;
/**
 * Steps a chat command would drop that the owner did not name (a linked step, or a whole workflow a composition replaces). Such a change is not
 * committed from chat: it stays the existing Canvas proposal, so nothing unrelated disappears without an explicit Apply.
 */
export function lostSteps(before: Workflow, after: Workflow, command: Command, context: ReviewContext, language: ConversationLanguage = 'EN'): string[] {
  const named = command.type === 'REMOVE' ? [command.nodeId] : command.type === 'REMOVE_MANY' ? command.nodeIds : [];
  return composerActions(before).map((node, index) => ({ node, index })).filter(({ node }) => !named.includes(node.nodeId) && !after.nodes.some(kept => kept.nodeId === node.nodeId))
    .map(({ node, index }) => `${index + 1}. ${label(language, composerSummary(before, node, context).action)}`);
}
/** The chat's confirmation of a committed change, read from the stored workflow (never from the model's words). */
export function describeChatChange(before: Workflow, after: Workflow, context: ReviewContext, language: ConversationLanguage): string[] {
  const c = conversationCopy(language), lines: string[] = [];
  const detail = (workflow: Workflow, node: Workflow['nodes'][number]) => {
    const card = composerSummary(workflow, node, context), pair = card.bridgePair ?? card.detail;
    return [card.amount === 'Amount not available' ? null : card.amount, pair && !card.amount.includes(pair) ? pair : null, card.chain, card.provider === 'Provider not specified' ? null : card.provider]
      .filter((value): value is string => Boolean(value)).map(value => label(language, value)).join(' · ');
  };
  for (const node of composerActions(after)) {
    const old = before.nodes.find(item => item.nodeId === node.nodeId), action = label(language, composerSummary(after, node, context).action);
    if (!old) lines.push(c.added(action, detail(after, node)));
    else if (JSON.stringify(old) !== JSON.stringify(node)) lines.push(c.updated(action, detail(after, node)));
  }
  for (const node of composerActions(before)) if (!after.nodes.some(item => item.nodeId === node.nodeId)) lines.push(c.removed(label(language, composerSummary(before, node, context).action)));
  return lines;
}
