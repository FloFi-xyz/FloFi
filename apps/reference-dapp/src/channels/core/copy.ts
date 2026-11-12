// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: every sentence a channel sends, written by FloFi (EN/PT) — never by a model. Facts come only from FloFi's own
 * state: the canonical strategy, the shared platform's gates and approval status, the preview projection and the run's evidence as
 * recorded. Addresses and hashes are always shortened. No copy ever says or implies that a message authorized, signed or executed
 * anything; execution happens only in FloFi with the owner's wallet.
 */
import type { ChannelLanguage } from './config.ts';
import { LANDED_LABELS_PT, landedKind, type LandedKind } from '../../domain/landed-attempts.ts';

/** `0x1234…abcd` for every address or hash in a channel text. */
export const shorten = (text: string) => text.replace(/0x([0-9a-fA-F]{4})[0-9a-fA-F]{32,60}([0-9a-fA-F]{4})(?![0-9a-fA-F])/g, '0x$1…$2');
const NETWORK_LABEL: Readonly<Record<string, string>> = { 'base': 'Base', 'base-sepolia': 'Base Sepolia', 'arbitrum-one': 'Arbitrum One',
  'arbitrum-sepolia': 'Arbitrum Sepolia', 'ethereum': 'Ethereum', 'ethereum-sepolia': 'Ethereum Sepolia', 'solana': 'Solana', 'solana-devnet': 'Solana Devnet' };
export const networkLabel = (id: string) => NETWORK_LABEL[id] ?? id;

export type PreviewNote = { readonly kind: 'PASSED'; readonly provenance: string } | { readonly kind: 'FAILED'; readonly code: string }
  | { readonly kind: 'WORKFLOW'; readonly total: number; readonly simulated: number; readonly pending: number; readonly codes: readonly string[] }
  | { readonly kind: 'SKIPPED' } | { readonly kind: 'DISABLED' };
export type ReadyFacts = { readonly lines: readonly string[]; readonly networks: readonly string[]; readonly fundsClass: 'TEST_FUNDS' | 'REAL_FUNDS';
  readonly notes: readonly string[]; readonly preview: PreviewNote; readonly intendedWallet: string | null; readonly aiInterpreted: boolean; readonly expiresMinutes: number };
export type RunLine = { readonly status: string; readonly reconciled: boolean; readonly terminal: boolean; readonly errorCode: string | null;
  readonly evidenceEnvironment: string | null; readonly evidenceOutcome: string | null; readonly evidenceBundleHash: string | null; readonly receiptUrl?: string | null;
  /** BUILD-FLOFI-E2E-RELIABILITY-001: what of this run is confirmed onchain while it is not reconciled (the label of what landed). */
  readonly landed?: string | null };

/** Run statuses where something may be in flight or its outcome is not known: a landed label never says "not sent" over them. */
const MAY_BE_IN_FLIGHT = new Set(['RESERVED', 'SUBMITTING', 'SUBMITTED', 'PENDING', 'HASH', 'SUBMISSION_RESULT_UNKNOWN', 'UNKNOWN', 'RECONCILIATION_REQUIRED',
  'RECOVERY_REQUIRED', 'INCONCLUSIVE', 'SIGNED', 'POSTING', 'POSTED', 'SOURCE_SUBMITTED', 'IN_FLIGHT']);
/**
 * BUILD-FLOFI-E2E-RELIABILITY-001 (channels review): the follow-up a landed label allows. Only a main action that was not sent, not submitted or
 * still awaits the wallet can be continued; one that is pending or unresolved may already have been sent, so it is checked, never started again.
 */
export function runLandedKind(r: Pick<RunLine, 'status' | 'landed'>): LandedKind | null {
  if (!r.landed) return null;
  const kind = landedKind(r.landed);
  return MAY_BE_IN_FLIGHT.has(r.status) && (kind === 'not-sent' || kind === 'not-submitted' || kind === 'awaiting-wallet') ? 'unresolved' : kind;
}
const LANDED_EN: Readonly<Record<LandedKind, string>> = {
  'not-sent': 'The token approval is confirmed onchain, but it moves no funds by itself; the main action was not sent. You can continue in FloFi with your wallet.',
  'awaiting-wallet': 'The token approval is confirmed onchain; the main action\'s wallet request is prepared and no submission is recorded yet. Check it in FloFi before doing anything else.',
  'not-submitted': 'The token approval is confirmed onchain, but it moves no funds by itself; the main action was not submitted. You can review it again in FloFi.',
  'pending': 'The main action was sent and awaits confirmation onchain. FloFi keeps checking it — do not start it again.',
  'failed': 'The main action failed onchain; the token approval stays confirmed and moves no funds by itself. Review it in FloFi.',
  'unresolved': 'The outcome of the main action is not known yet — it may have been sent. FloFi checks the existing attempt before any further action and never resends it; do not start it again.',
  'confirmed-unreconciled': 'A transaction is confirmed onchain; FloFi is still reconciling the workflow outcome. Do not start it again.',
  'later-incomplete': 'Earlier actions are confirmed onchain and remain recorded; a later action is not complete. Check it in FloFi.',
};
const LANDED_PT: Readonly<Record<LandedKind, string>> = {
  'not-sent': 'A aprovação do token está confirmada na rede, mas sozinha não movimenta fundos; a ação principal não foi enviada. Você pode continuar no FloFi com a sua carteira.',
  'awaiting-wallet': 'A aprovação do token está confirmada na rede; a solicitação da ação principal à carteira está preparada e nenhum envio foi registrado ainda. Verifique no FloFi antes de qualquer outra ação.',
  'not-submitted': 'A aprovação do token está confirmada na rede, mas sozinha não movimenta fundos; a ação principal não foi submetida. Você pode revisá-la de novo no FloFi.',
  'pending': 'A ação principal foi enviada e aguarda confirmação na rede. O FloFi continua verificando — não a inicie de novo.',
  'failed': 'A ação principal falhou na rede; a aprovação do token continua confirmada e sozinha não movimenta fundos. Revise no FloFi.',
  'unresolved': 'O resultado da ação principal ainda não é conhecido — ela pode ter sido enviada. O FloFi verifica a tentativa existente antes de qualquer outra ação e nunca a reenvia; não a inicie de novo.',
  'confirmed-unreconciled': 'Uma transação está confirmada na rede; o FloFi ainda está reconciliando o resultado do workflow. Não a inicie de novo.',
  'later-incomplete': 'Ações anteriores estão confirmadas na rede e continuam registradas; uma ação posterior não foi concluída. Verifique no FloFi.',
};

/** Pre-submission records are created by preparation, without a wallet request or any movement of funds. */
const RUN_EN: Readonly<Record<string, string>> = {
  SIMULATED: 'Simulation complete (read-only). Waiting for your review and wallet authorization in FloFi.',
  AUTHORIZED: 'Review accepted in FloFi. Wallet authorization is still required before submission.',
  PREPARED: 'Transaction prepared. Waiting for wallet authorization; submission is not confirmed.',
  SUBMITTING: 'Wallet authorization or submission is pending. No verified execution receipt is available.',
  SUBMISSION_RESULT_UNKNOWN: 'Submission outcome is unknown. FloFi must check the existing attempt before any further action.',
  HASH: 'Transaction reference recorded. Chain observation and independent reconciliation are still pending.',
  PENDING: 'Waiting for chain observation and independent reconciliation. No verified execution receipt is available yet.',
  CONFIRMED: 'Transaction confirmed. Independent reconciliation is still pending.',
  RECONCILED: 'Checking reconciliation evidence. No verified execution receipt is available yet.',
};
const RUN_PT: Readonly<Record<string, string>> = {
  SIMULATED: 'Simulação concluída (somente leitura). Aguardando sua revisão e autorização na carteira no FloFi.',
  AUTHORIZED: 'Revisão aceita no FloFi. A autorização na carteira ainda é necessária antes do envio.',
  PREPARED: 'Transação preparada. Aguardando autorização na carteira; o envio não está confirmado.',
  SUBMITTING: 'Autorização na carteira ou envio pendente. Ainda não há recibo de execução verificado.',
  SUBMISSION_RESULT_UNKNOWN: 'O resultado do envio é desconhecido. O FloFi precisa verificar a tentativa existente antes de qualquer outra ação.',
  HASH: 'Referência da transação registrada. A observação na rede e a reconciliação independente ainda estão pendentes.',
  PENDING: 'Aguardando observação na rede e reconciliação independente. Ainda não há recibo de execução verificado.',
  CONFIRMED: 'Transação confirmada. A reconciliação independente ainda está pendente.',
  RECONCILED: 'Verificando as evidências de reconciliação. Ainda não há recibo de execução verificado.',
};

const EN = {
  firstContact: (support: string, privacy: string) => `FloFi (automated assistant). I compose DeFi strategies for you to review and sign in FloFi. I can't sign, execute or move funds, and nothing you write here authorizes anything. Never send a private key or seed phrase. Human support: ${support}. Privacy: ${privacy}. Reply STOP to stop messages.`,
  help: (support: string, privacy: string) => `What I can do: compose a strategy from your message (for example "Supply 100 USDC on Aave on Base"), ask for anything missing, correct it ("make it 50"), and tell you its status (STATUS). LINK sends a fresh approval link, NEW starts over, STOP stops messages.\nWorkflows: after a proposal, ADD STEP keeps it and you describe the next action; STEPS, REMOVE STEP n and MOVE STEP n TO m edit the list; the whole workflow gets ONE approval link.\nExecution happens only in FloFi, with your own wallet, after a fresh simulation and your review of the Strategy Manifest. Messages here never authorize anything.\nHuman support: ${support}. Privacy: ${privacy}.`,
  ready: 'Strategy ready:',
  network: (labels: string, real: boolean) => `Network: ${labels}${real ? ' — REAL FUNDS' : ' (test funds)'}`,
  preview: (p: PreviewNote) => p.kind === 'PASSED' ? `Simulation preview passed (read-only${p.provenance === 'MOCKED' ? ', MOCKED' : ''}). FloFi simulates again before your review.`
    : p.kind === 'WORKFLOW' ? `Workflow preview: ${p.simulated}/${p.total} steps simulated against current state.${p.pending ? ` ${p.pending} await earlier steps' received funds.` : ''}${p.codes.length ? ` Details: ${p.codes.join(', ')}.` : ''} FloFi freshly simulates every step after the previous step reconciles, before your Manifest review and wallet signature.`
    : p.kind === 'FAILED' ? `Simulation preview did not pass (${p.code}). FloFi will show the details when you open it.`
      : p.kind === 'SKIPPED' ? 'FloFi runs the simulation when you open it.' : 'FloFi runs the simulation when you open it.',
  authorize: (wallet: string | null, minutes: number) => `Nothing is authorized yet: open FloFi${wallet ? `, connect the wallet ${wallet}` : ', connect your wallet'}, review the Strategy Manifest and sign there. The link works once and expires in ${minutes} minutes.`,
  ai: 'Interpreted from your message with an AI assistant. It is not financial advice; you decide.',
  linkLabel: 'Authorize',
  authority: 'Nothing can be authorized here — not with "yes", "confirm" or any other message. To execute, open FloFi with the approval link, connect your wallet, check the fresh simulation and the Strategy Manifest, and sign there. Send LINK for a fresh link.',
  refused: (code: string) => REFUSALS_EN[code] ?? `FloFi couldn't prepare an approval link (${code}). Nothing was proposed.`,
  noPending: 'There is no pending strategy. Tell me what you want to do.',
  cancelled: 'Cancelled. The previous approval link no longer works.',
  replaced: 'The previous approval link no longer works.',
  linkLost: 'Your approval link could not be delivered, so it was withdrawn. Send LINK for a fresh one.',
  noApproval: 'There is no proposal from this chat yet.',
  approval: (status: string, expires: string) => APPROVAL_EN[status]?.(expires) ?? `Proposal: ${status}.`,
  notShared: 'The wallet owner has not shared run status with this chat (it can be turned on in FloFi).',
  noRuns: 'No simulation or execution record is available from this proposal yet.',
  runsOlder: 'No run of this proposal is among the wallet\'s most recent runs; older runs were not checked here. Open FloFi to see all your runs.',
  runsUnknown: 'Some run records of this proposal could not be read right now, so their status is unknown — this is not evidence that nothing was sent. Send STATUS again in a moment.',
  run: (r: RunLine) => r.reconciled ? `Execution reconciled ✅ · evidence: ${r.evidenceEnvironment ?? 'unknown'} · outcome: ${r.evidenceOutcome ?? 'unknown'}${r.evidenceBundleHash ? ` · bundle ${shorten(r.evidenceBundleHash)}` : ''}${r.receiptUrl ? `\nReceipt: ${r.receiptUrl}` : ''}`
    // A terminal run keeps its terminal sentence (never "continue"); the landed label only says what is confirmed onchain.
    : r.terminal ? `${r.landed ? `${r.landed}. ` : ''}Workflow ended without verified execution (${r.errorCode ?? r.status}). See FloFi for details.`
    : r.landed ? `${r.landed}. ${LANDED_EN[runLandedKind(r)!]}`
      : RUN_EN[r.status] ?? `Workflow status: ${r.status}. No verified execution receipt is available yet.`,
  loaded: 'Your proposal is loaded in FloFi for the connected wallet. Loading it does not authorize or submit a transaction. Check FloFi for the current workflow status.',
  secret: 'Never send a private key or seed phrase — FloFi never needs one. I did not store this message or send it to any AI, but it already reached the messaging provider: if it was real, treat it as compromised and move your funds to a new wallet.',
  unsupported: 'I can only read text messages. Please write what you want to do.',
  late: 'Your message reached FloFi late, so I did not act on it. Please send it again if you still want it.',
  optedOut: 'You will not receive more messages from FloFi here. Reply START to resume.',
  optedIn: 'Messages resumed.',
  subscribed: (owner: string, days: number) => `This chat now receives FloFi automation notifications for ${owner} (for ${days} days; send STOP to end them, or unlink in FloFi). A notification never authorizes anything: it only points you to FloFi, where your own wallet decides.`,
  subscribeFailed: 'That code is not valid (it may have expired or been used). Create a new one in FloFi → Automations → Notifications.',
  subscribeUnavailable: 'Automation notifications are not available in this chat.',
  /** Closed-beta guidance: never a grant. Linking uses FloFi's one-time automation code; Flight access is checked server-side afterwards. */
  betaAccess: (code: string) => code === 'BETA_CHANNEL_NOT_LINKED'
    ? 'This chat is not linked to a FloFi Flight wallet yet. In FloFi open Automations → Notifications, create a one-time code, then send: automations CODE. HELP shows commands; STOP ends messages. Linking does not authorize funds or grant Flight access by itself.'
    : code === 'BETA_ACCESS_REVOKED' || code === 'BETA_ACCESS_DENIED' || code === 'BETA_WALLET_NOT_LINKED' || code === 'BETA_WALLET_REQUIRED'
      ? 'FloFi Flight access for the linked wallet is not active. You can still check STATUS of earlier proposals and send STOP. New strategies need active Flight access in FloFi — messages here never authorize funds.'
      : code === 'BETA_NOT_OPEN'
        ? 'FloFi Flight boarding is not open yet. You can link this chat, ask HELP, or send STOP. Private strategies open with boarding.'
        : code === 'BETA_CHANNEL_ACCESS_CLOSED'
          ? 'Private authoring on this channel is not available during the closed Flight beta. HELP, privacy and STOP still work; delivery and status for earlier work continue.'
          : `Private channel authoring is unavailable right now (${code}). HELP and STOP still work; messages here never authorize funds.`,
  grammarOnly: 'I could not read that as a strategy. Try for example: "supply 100 USDC to Aave on Base beneficiary 0x…" or "swap 1 USDC to WETH on Base slippage 50 bps". Send HELP for more.',
  choose: 'Reply with the number of your choice.',
  busy: 'Too many messages right now — please wait a moment and try again.',
  error: 'Something went wrong on FloFi\'s side. Nothing was proposed or authorized. Please try again.',
  // BUILD-CHAT-E2E-001: multi-step workflows — the step list, authorization counts and the run's durable status.
  stepsFull: (max: number) => `A workflow has at most ${max} steps.`,
  stepUnknown: (count: number) => count ? `There is no such step. This workflow has ${count} step${count === 1 ? '' : 's'}.` : 'There are no steps yet. Tell me what you want to do.',
  stepKept: (n: number) => `Step ${n} kept. Describe step ${n + 1}: it runs only after step ${n} is reconciled. STEPS shows the workflow; NEW starts over.`,
  stepsList: (lines: readonly string[]) => lines.length ? `Workflow (${lines.length} step${lines.length === 1 ? '' : 's'}):\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
    : 'There are no steps yet. Tell me what you want to do.',
  authorizations: (a: AuthorizationFacts) => [...a.confirm !== null ? [`Authorizations: at least ${a.confirm} wallet confirmations in FloFi — one per step, each after a fresh simulation.`] : [],
    // User-funded groups: one line with the count and who pays (it replaces the per-step fee line: a batch runs several steps in one transaction).
    ...a.groups ? [`${a.confirm !== null ? 'Or, in groups' : 'Authorizations, in groups'} of same-network steps: ${a.groups.atLeast ? 'at least ' : ''}${a.groups.interactions} wallet `
      + `interaction${a.groups.interactions === 1 ? '' : 's'} in FloFi. ${a.confirm !== null ? 'Either way your' : 'Your'} own wallet pays every network fee; FloFi never pays gas.`]
      : ['One authorization is not one transaction: each step pays its own network fees.']],
  workflowRun: (r: RunFacts) => [`Workflow: ${RUN_STATE_EN[r.state] ?? r.state}`, ...r.steps.map(step => `${step.index + 1}. ${ACTION_EN[step.action] ?? step.action} — `
    + `${STEP_STATE_EN[step.state] ?? step.state}${step.transaction ? ` · tx ${shorten(step.transaction)}` : ''}`)].join('\n'),
  stepReady: (n: number, url: string) => `Step ${n} is ready for your signature in FloFi: ${url}\nYour wallet proves it is you there; nothing is authorized until you sign.`,
  batchAnswered: (from: number, to: number, url: string) => `Your wallet answered the batch request for ${from === to ? `step ${from}` : `steps ${from}–${to}`}; FloFi has `
    + `not recorded its transactions yet. If FloFi is not open, open it so your wallet can report them and FloFi can reconcile them: ${url}\n`
    + 'Do not send the batch again: it may already have executed.',
  runOpen: (url: string) => `This workflow is already running. Continue it in FloFi: ${url}\nA new link would start it again from the first step, so none was created.`,
  runDone: 'Workflow completed: every step reconciled ✅',
  runHalted: 'Workflow partially completed: the reconciled steps stay done and their funds rest in your wallet. See FloFi for the step that stopped.',
  runHaltedNothingSent: (resumable: boolean) => `Workflow stopped before anything was sent: your funds stay in your wallet. ${resumable
    ? 'In FloFi you can run each step through its own flow, or end it.' : 'Open FloFi to decide what happens next.'}`,
  runHaltedStopped: 'Workflow stopped before any step completed. FloFi submits nothing more of it; open FloFi to decide what happens next.',
  runHaltedUnclassified: 'Workflow stopped. FloFi submits nothing more of it; open FloFi to see what each step did and decide what happens next.',
  // A halt while a batch handed to the wallet was never answered: it may have executed, so never "before any step completed" or "nothing was sent".
  runHaltedBatchUnknown: (partial: boolean) => `${partial ? 'Workflow partially completed: the reconciled steps stay done. ' : 'Workflow stopped. '}A batch was `
    + 'handed to your wallet and its answer never reached FloFi: it may have executed before its on-chain deadline. Check your wallet\'s activity. FloFi submits '
    + 'nothing more of it; open FloFi to decide what happens next.',
  runAttention: 'A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.',
  runEnded: (code: string) => `Workflow ended without completing (${code}). See FloFi for details.`,
  runEndedBatchUnknown: 'Workflow ended. A batch was handed to your wallet and its answer never reached FloFi: it may have executed before its on-chain deadline. '
    + 'Check your wallet\'s activity.',
};
/** `groups`: the user-funded execution groups the owner is offered in FloFi (null: not offered); `atLeast` while the count is a lower bound. */
export type AuthorizationFacts = { readonly confirm: number | null; readonly groups: { readonly interactions: number; readonly atLeast: boolean } | null };
export type RunFacts = { readonly state: string; readonly steps: readonly { readonly index: number; readonly action: string; readonly state: string; readonly transaction: string | null }[] };
/** A bare HALTED (how it stopped is not known here) is worded neutrally: never "partially completed", never "nothing was sent". */
const RUN_STATE_EN: Readonly<Record<string, string>> = { PENDING: 'waiting for you to choose how to authorize it', RUNNING: 'running', COMPLETED: 'completed ✅',
  HALTED: 'stopped', HALTED_PARTIAL: 'partially completed', HALTED_NOTHING_SENT: 'stopped before anything was sent', HALTED_STOPPED: 'stopped', FAILED: 'failed',
  ATTENTION: 'needs attention', CANCELLED: 'ended', EXPIRED: 'expired' };
const STEP_STATE_EN: Readonly<Record<string, string>> = { PENDING: 'waiting', READY: 'ready for your signature', AWAITING_OWNER: 'in your wallet', DELEGATED: 'authorized',
  GROUP_WAITING: 'waiting for your wallet', GROUP_SIGNED: 'signed in your wallet', GROUP_NOT_SIGNED: 'not signed', OUTCOME_UNKNOWN: 'outcome unknown — it may have executed; check your wallet\'s activity',
  RECONCILED: 'reconciled ✅', FAILED: 'failed', UNCERTAIN: 'outcome pending', SKIPPED: 'not run', BLOCKED: 'stopped before submission' };
const ACTION_EN: Readonly<Record<string, string>> = { swap: 'Swap', bridge: 'Bridge', supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
  add_liquidity: 'Add liquidity', transfer: 'Transfer', lending_composition: 'Lending composition' };
const RUN_STATE_PT: Readonly<Record<string, string>> = { PENDING: 'esperando você escolher como autorizar', RUNNING: 'em execução', COMPLETED: 'concluído ✅',
  HALTED: 'interrompido', HALTED_PARTIAL: 'parcialmente concluído', HALTED_NOTHING_SENT: 'interrompido antes de qualquer envio', HALTED_STOPPED: 'interrompido', FAILED: 'falhou',
  ATTENTION: 'requer atenção', CANCELLED: 'encerrado', EXPIRED: 'expirado' };
const STEP_STATE_PT: Readonly<Record<string, string>> = { PENDING: 'em espera', READY: 'pronta para sua assinatura', AWAITING_OWNER: 'na sua carteira', DELEGATED: 'autorizada',
  GROUP_WAITING: 'aguardando a sua carteira', GROUP_SIGNED: 'assinada na sua carteira', GROUP_NOT_SIGNED: 'não assinada', OUTCOME_UNKNOWN: 'resultado desconhecido — pode ter sido executada; confira a atividade da sua carteira',
  RECONCILED: 'reconciliada ✅', FAILED: 'falhou', UNCERTAIN: 'resultado pendente', SKIPPED: 'não executada', BLOCKED: 'parada antes do envio' };
const ACTION_PT: Readonly<Record<string, string>> = { swap: 'Troca', bridge: 'Ponte entre redes', supply: 'Depósito', borrow: 'Empréstimo', repay: 'Reembolso', withdraw: 'Saque',
  add_liquidity: 'Liquidez', transfer: 'Transferência', lending_composition: 'Composição de empréstimo' };
const REFUSALS_EN: Readonly<Record<string, string>> = {
  MAINNET_HANDOFF_DISABLED_BY_POLICY: 'This strategy uses a mainnet (real funds). Proposals with real funds are disabled for this channel.',
  TEST_FUNDS_HANDOFF_DISABLED_BY_POLICY: 'Test-network proposals are disabled for this channel.',
  FLOW_NOT_ENABLED_IN_DEPLOYMENT: 'FloFi cannot execute this strategy on this deployment right now. Nothing was proposed.',
  OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT: 'FloFi cannot execute this strategy on this deployment right now. Nothing was proposed.',
  NO_EXECUTION_FLOW: 'FloFi has no execution flow for this strategy. Nothing was proposed.',
  OWNER_EXECUTION_NOT_IMPLEMENTED: 'FloFi has no execution flow for this strategy. Nothing was proposed.',
  CLOUD_RUNTIME_NOT_CONFIGURED: 'FloFi cannot execute strategies on this deployment. Nothing was proposed.',
  MCP_CLOUD_RUNTIME_REQUIRED: 'FloFi cannot execute strategies on this deployment. Nothing was proposed.',
  MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED: 'FloFi cannot execute this sequence of steps yet. Nothing was proposed.',
  REVIEW_BLOCKED: 'FloFi\'s review blocks this strategy, so no approval link was created.',
  HANDOFF_RATE_LIMITED: 'Too many approval links in a short time — please wait and try again.',
  HANDOFF_PENDING_LIMIT: 'Too many open approval links — send NEW to start over.',
  CHANNEL_STRATEGY_PARITY_FAILED: 'FloFi could not turn that into a canonical strategy. Nothing was proposed.',
  STRATEGY_SCHEMA_INVALID: 'FloFi could not turn that into a canonical strategy. Nothing was proposed.',
  TEST_NETWORK_NOT_AVAILABLE: 'FloFi runs on mainnets only, with real funds: test networks such as Base Sepolia or Solana Devnet are not available. Nothing was proposed. Name the mainnet you want (for example Base, Arbitrum One, Ethereum, Solana or Robinhood Chain) and the amount.',
  WORKFLOW_RUNS_NOT_ENABLED: 'FloFi cannot run multi-step workflows on this deployment yet. Nothing was proposed.',
  DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED: 'A step that spends what another step delivers could not resolve the earlier step\'s received amount here. Nothing was proposed.',
  CHANNEL_INTENDED_WALLETS_DIFFER: 'These steps name different wallets; one workflow is approved by one owner. Nothing was proposed.',
};
const APPROVAL_EN: Readonly<Record<string, (expires: string) => string>> = {
  PENDING: e => `Proposal waiting for you to open it in FloFi (expires ${e}).`, CLAIMED: () => 'Proposal loaded for a wallet in FloFi; nothing is signed yet.',
  APPLIED: () => 'Proposal in a FloFi workflow; any execution needs the wallet owner\'s review and signature there.', EXPIRED: () => 'Proposal expired. Send LINK for a fresh one.',
  SUPERSEDED: () => 'Proposal replaced by a newer one.', REVOKED: () => 'Proposal withdrawn.', STALE: () => 'Proposal no longer valid with FloFi\'s current rules. Send NEW.',
};

type Copy = typeof EN;
const PT: Copy = {
  firstContact: (support, privacy) => `FloFi (assistente automático). Eu monto estratégias DeFi para você revisar e assinar no FloFi. Não posso assinar, executar nem mover fundos, e nada do que você escrever aqui autoriza qualquer coisa. Nunca envie chave privada ou frase-semente. Suporte humano: ${support}. Privacidade: ${privacy}. Responda PARAR para não receber mais mensagens.`,
  help: (support, privacy) => `O que posso fazer: montar uma estratégia a partir da sua mensagem (por exemplo "Coloca 100 USDC na Aave na Base"), perguntar o que faltar, corrigir ("muda para 50") e informar o status (ESTADO). LINK envia um novo link de aprovação, NOVO recomeça, PARAR interrompe as mensagens.\nFluxos: depois de uma proposta, ADICIONAR ETAPA a mantém e você descreve a próxima ação; ETAPAS, REMOVER ETAPA n e MOVER ETAPA n PARA m editam a lista; o fluxo inteiro recebe UM link de aprovação.\nA execução acontece só no FloFi, com a sua própria carteira, depois de uma nova simulação e da sua revisão do Strategy Manifest. Mensagens aqui nunca autorizam nada.\nSuporte humano: ${support}. Privacidade: ${privacy}.`,
  ready: 'Estratégia pronta:',
  network: (labels, real) => `Rede: ${labels}${real ? ' — FUNDOS REAIS' : ' (fundos de teste)'}`,
  preview: p => p.kind === 'PASSED' ? `Prévia da simulação aprovada (somente leitura${p.provenance === 'MOCKED' ? ', MOCKED' : ''}). O FloFi simula de novo antes da sua revisão.`
    : p.kind === 'WORKFLOW' ? `Prévia do fluxo: ${p.simulated}/${p.total} etapas simuladas no estado atual.${p.pending ? ` ${p.pending} aguardam os fundos recebidos das etapas anteriores.` : ''}${p.codes.length ? ` Detalhes: ${p.codes.join(', ')}.` : ''} O FloFi simula cada etapa depois da reconciliação anterior, antes da revisão do Manifest e da assinatura da carteira.`
    : p.kind === 'FAILED' ? `A prévia da simulação não passou (${p.code}). O FloFi mostra os detalhes quando você abrir.` : 'O FloFi roda a simulação quando você abrir.',
  authorize: (wallet, minutes) => `Nada está autorizado ainda: abra o FloFi${wallet ? `, conecte a carteira ${wallet}` : ', conecte sua carteira'}, revise o Strategy Manifest e assine lá. O link funciona uma vez e expira em ${minutes} minutos.`,
  ai: 'Interpretado da sua mensagem com um assistente de IA. Não é recomendação financeira; a decisão é sua.',
  linkLabel: 'Autorizar',
  authority: 'Nada pode ser autorizado aqui — nem com "sim", "confirmo" ou qualquer outra mensagem. Para executar, abra o FloFi pelo link de aprovação, conecte sua carteira, confira a nova simulação e o Strategy Manifest e assine lá. Envie LINK para um novo link.',
  refused: code => REFUSALS_PT[code] ?? `O FloFi não conseguiu preparar um link de aprovação (${code}). Nada foi proposto.`,
  noPending: 'Não há estratégia pendente. Diga o que você quer fazer.',
  cancelled: 'Cancelado. O link de aprovação anterior não funciona mais.',
  replaced: 'O link de aprovação anterior não funciona mais.',
  linkLost: 'Seu link de aprovação não pôde ser entregue, então foi retirado. Envie LINK para um novo.',
  noApproval: 'Ainda não há proposta desta conversa.',
  approval: (status, expires) => APPROVAL_PT[status]?.(expires) ?? `Proposta: ${status}.`,
  notShared: 'O dono da carteira não compartilhou o status das execuções com esta conversa (dá para ativar no FloFi).',
  noRuns: 'Ainda não há registro de simulação ou execução disponível para esta proposta.',
  runsOlder: 'Nenhuma execução desta proposta está entre as execuções mais recentes da carteira; as mais antigas não foram verificadas aqui. Abra o FloFi para ver todas as suas execuções.',
  runsUnknown: 'Alguns registros de execução desta proposta não puderam ser lidos agora, então o status deles é desconhecido — isso não é prova de que nada foi enviado. Envie ESTADO de novo em instantes.',
  run: r => r.reconciled ? `Execução reconciliada ✅ · evidência: ${r.evidenceEnvironment ?? 'desconhecida'} · resultado: ${r.evidenceOutcome ?? 'desconhecido'}${r.evidenceBundleHash ? ` · bundle ${shorten(r.evidenceBundleHash)}` : ''}${r.receiptUrl ? `\nRecibo: ${r.receiptUrl}` : ''}`
    : r.terminal ? `${r.landed ? `${LANDED_LABELS_PT[r.landed] ?? r.landed}. ` : ''}Workflow terminou sem execução verificada (${r.errorCode ?? r.status}). Veja os detalhes no FloFi.`
    : r.landed ? `${LANDED_LABELS_PT[r.landed] ?? r.landed}. ${LANDED_PT[runLandedKind(r)!]}`
      : RUN_PT[r.status] ?? `Estado do workflow: ${r.status}. Ainda não há recibo de execução verificado.`,
  loaded: 'Sua proposta foi carregada no FloFi para a carteira conectada. Carregá-la não autoriza nem envia uma transação. Confira o estado atual do workflow no FloFi.',
  secret: 'Nunca envie chave privada ou frase-semente — o FloFi nunca precisa disso. Não guardei esta mensagem nem a enviei para nenhuma IA, mas ela já passou pelo provedor de mensagens: se era real, considere-a comprometida e mova seus fundos para uma nova carteira.',
  unsupported: 'Só consigo ler mensagens de texto. Escreva o que você quer fazer.',
  late: 'Sua mensagem chegou atrasada ao FloFi, então não agi sobre ela. Envie de novo se ainda quiser.',
  optedOut: 'Você não vai receber mais mensagens do FloFi aqui. Responda VOLTAR para retomar.',
  optedIn: 'Mensagens retomadas.',
  subscribed: (owner, days) => `Esta conversa agora recebe as notificações de automações do FloFi para ${owner} (por ${days} dias; envie PARAR para encerrar, ou desvincule no FloFi). Uma notificação nunca autoriza nada: ela só leva você ao FloFi, onde a sua própria carteira decide.`,
  subscribeFailed: 'Esse código não é válido (pode ter expirado ou já ter sido usado). Crie um novo no FloFi → Automações → Notificações.',
  subscribeUnavailable: 'As notificações de automações não estão disponíveis nesta conversa.',
  betaAccess: (code: string) => code === 'BETA_CHANNEL_NOT_LINKED'
    ? 'Esta conversa ainda não está vinculada a uma carteira FloFi Flight. No FloFi abra Automações → Notificações, crie um código de uso único e envie: automacoes CODIGO. AJUDA mostra os comandos; PARAR encerra as mensagens. Vincular não autoriza fundos nem concede acesso Flight sozinho.'
    : code === 'BETA_ACCESS_REVOKED' || code === 'BETA_ACCESS_DENIED' || code === 'BETA_WALLET_NOT_LINKED' || code === 'BETA_WALLET_REQUIRED'
      ? 'O acesso FloFi Flight da carteira vinculada não está ativo. Você ainda pode consultar ESTADO de propostas anteriores e enviar PARAR. Novas estratégias exigem acesso Flight ativo no FloFi — mensagens aqui nunca autorizam fundos.'
      : code === 'BETA_NOT_OPEN'
        ? 'O embarque FloFi Flight ainda não abriu. Você pode vincular esta conversa, pedir AJUDA ou enviar PARAR. Estratégias privadas abrem com o embarque.'
        : code === 'BETA_CHANNEL_ACCESS_CLOSED'
          ? 'A autoria privada neste canal não está disponível durante o beta fechado do Flight. AJUDA, privacidade e PARAR continuam; entrega e status de trabalhos anteriores seguem.'
          : `A autoria privada no canal está indisponível agora (${code}). AJUDA e PARAR continuam; mensagens aqui nunca autorizam fundos.`,
  grammarOnly: 'Não consegui ler isso como uma estratégia. Tente por exemplo: "supply 100 USDC to Aave on Base beneficiary 0x…" ou "swap 1 USDC to WETH on Base slippage 50 bps". Envie AJUDA para mais.',
  choose: 'Responda com o número da sua escolha.',
  busy: 'Muitas mensagens agora — espere um momento e tente de novo.',
  error: 'Algo deu errado do lado do FloFi. Nada foi proposto nem autorizado. Tente de novo.',
  stepsFull: max => `Um fluxo tem no máximo ${max} etapas.`,
  stepUnknown: count => count ? `Essa etapa não existe. Este fluxo tem ${count} etapa${count === 1 ? '' : 's'}.` : 'Ainda não há etapas. Diga o que você quer fazer.',
  stepKept: n => `Etapa ${n} mantida. Descreva a etapa ${n + 1}: ela só roda depois que a etapa ${n} for reconciliada. ETAPAS mostra o fluxo; NOVO recomeça.`,
  stepsList: lines => lines.length ? `Fluxo (${lines.length} etapa${lines.length === 1 ? '' : 's'}):\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
    : 'Ainda não há etapas. Diga o que você quer fazer.',
  authorizations: a => [...a.confirm !== null ? [`Autorizações: pelo menos ${a.confirm} confirmações na carteira no FloFi — uma por etapa, cada uma depois de uma nova simulação.`] : [],
    ...a.groups ? [`${a.confirm !== null ? 'Ou, em grupos' : 'Autorizações, em grupos'} de etapas na mesma rede: ${a.groups.atLeast ? 'pelo menos ' : ''}${a.groups.interactions} `
      + `interaç${a.groups.interactions === 1 ? 'ão' : 'ões'} na carteira no FloFi. ${a.confirm !== null ? 'Em qualquer caso, a' : 'A'} sua própria carteira paga todas as taxas `
      + 'de rede; o FloFi nunca paga gas.']
      : ['Uma autorização não é uma transação: cada etapa paga as suas próprias taxas de rede.']],
  workflowRun: r => [`Fluxo: ${RUN_STATE_PT[r.state] ?? r.state}`, ...r.steps.map(step => `${step.index + 1}. ${ACTION_PT[step.action] ?? step.action} — `
    + `${STEP_STATE_PT[step.state] ?? step.state}${step.transaction ? ` · tx ${shorten(step.transaction)}` : ''}`)].join('\n'),
  stepReady: (n, url) => `A etapa ${n} está pronta para a sua assinatura no FloFi: ${url}\nA sua carteira prova que é você lá; nada é autorizado até você assinar.`,
  batchAnswered: (from, to, url) => `A sua carteira respondeu ao pedido do lote ${from === to ? `da etapa ${from}` : `das etapas ${from}–${to}`}; o FloFi ainda não `
    + `registrou as transações dele. Se o FloFi não estiver aberto, abra-o para que a sua carteira as informe e o FloFi possa reconciliá-las: ${url}\n`
    + 'Não envie o lote de novo: ele pode já ter sido executado.',
  runOpen: url => `Este fluxo já está em execução. Continue no FloFi: ${url}\nUm novo link o começaria de novo pela primeira etapa, então nenhum foi criado.`,
  runDone: 'Fluxo concluído: todas as etapas reconciliadas ✅',
  runHalted: 'Fluxo parcialmente concluído: as etapas reconciliadas ficam feitas e os fundos delas ficam na sua carteira. Veja no FloFi a etapa que parou.',
  runHaltedNothingSent: resumable => `Fluxo interrompido antes de qualquer envio: seus fundos ficam na sua carteira. ${resumable
    ? 'No FloFi você pode executar cada etapa pelo próprio fluxo, ou encerrá-lo.' : 'Abra o FloFi para decidir o que acontece a seguir.'}`,
  runHaltedStopped: 'Fluxo interrompido antes de concluir qualquer etapa. O FloFi não envia mais nada dele; abra o FloFi para decidir o que acontece a seguir.',
  runHaltedUnclassified: 'Fluxo interrompido. O FloFi não envia mais nada dele; abra o FloFi para ver o que cada etapa fez e decidir o que acontece a seguir.',
  runHaltedBatchUnknown: partial => `${partial ? 'Fluxo parcialmente concluído: as etapas reconciliadas ficam feitas. ' : 'Fluxo interrompido. '}Um lote foi `
    + 'entregue à sua carteira e a resposta dela nunca chegou ao FloFi: ele pode ter sido executado antes do prazo na rede. Confira a atividade da sua carteira. '
    + 'O FloFi não envia mais nada dele; abra o FloFi para decidir o que acontece a seguir.',
  runAttention: 'Uma etapa enviada ainda não tem resultado final. O FloFi continua a observá-la e nunca a reenvia.',
  runEnded: code => `O fluxo terminou sem concluir (${code}). Veja os detalhes no FloFi.`,
  runEndedBatchUnknown: 'O fluxo terminou. Um lote foi entregue à sua carteira e a resposta dela nunca chegou ao FloFi: ele pode ter sido executado antes do prazo na rede. '
    + 'Confira a atividade da sua carteira.',
};
const REFUSALS_PT: Readonly<Record<string, string>> = {
  MAINNET_HANDOFF_DISABLED_BY_POLICY: 'Esta estratégia usa uma mainnet (fundos reais). Propostas com fundos reais estão desativadas neste canal.',
  TEST_FUNDS_HANDOFF_DISABLED_BY_POLICY: 'Propostas em redes de teste estão desativadas neste canal.',
  FLOW_NOT_ENABLED_IN_DEPLOYMENT: 'O FloFi não pode executar esta estratégia neste ambiente agora. Nada foi proposto.',
  OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT: 'O FloFi não pode executar esta estratégia neste ambiente agora. Nada foi proposto.',
  NO_EXECUTION_FLOW: 'O FloFi não tem fluxo de execução para esta estratégia. Nada foi proposto.',
  OWNER_EXECUTION_NOT_IMPLEMENTED: 'O FloFi não tem fluxo de execução para esta estratégia. Nada foi proposto.',
  CLOUD_RUNTIME_NOT_CONFIGURED: 'O FloFi não executa estratégias neste ambiente. Nada foi proposto.',
  MCP_CLOUD_RUNTIME_REQUIRED: 'O FloFi não executa estratégias neste ambiente. Nada foi proposto.',
  MULTI_STEP_SEQUENCE_NOT_IMPLEMENTED: 'O FloFi ainda não executa esta sequência de passos. Nada foi proposto.',
  REVIEW_BLOCKED: 'A revisão do FloFi bloqueia esta estratégia, então nenhum link de aprovação foi criado.',
  HANDOFF_RATE_LIMITED: 'Muitos links de aprovação em pouco tempo — espere e tente de novo.',
  HANDOFF_PENDING_LIMIT: 'Muitos links de aprovação abertos — envie NOVO para recomeçar.',
  CHANNEL_STRATEGY_PARITY_FAILED: 'O FloFi não conseguiu transformar isso em uma estratégia canônica. Nada foi proposto.',
  STRATEGY_SCHEMA_INVALID: 'O FloFi não conseguiu transformar isso em uma estratégia canônica. Nada foi proposto.',
  TEST_NETWORK_NOT_AVAILABLE: 'O FloFi funciona só em mainnets, com fundos reais: redes de teste como Base Sepolia ou Solana Devnet não estão disponíveis. Nada foi proposto. Diga a mainnet que você quer (por exemplo Base, Arbitrum One, Ethereum, Solana ou Robinhood Chain) e o valor.',
  WORKFLOW_RUNS_NOT_ENABLED: 'O FloFi ainda não roda fluxos de várias etapas neste ambiente. Nada foi proposto.',
  DEPENDENT_AMOUNT_SOURCE_NOT_IMPLEMENTED: 'Uma etapa que gasta o que outra etapa entrega não conseguiu resolver o montante recebido da etapa anterior. Nada foi proposto.',
  CHANNEL_INTENDED_WALLETS_DIFFER: 'Estas etapas indicam carteiras diferentes; um fluxo é aprovado por um único dono. Nada foi proposto.',
};
const APPROVAL_PT: Readonly<Record<string, (expires: string) => string>> = {
  PENDING: e => `Proposta esperando você abrir no FloFi (expira ${e}).`, CLAIMED: () => 'Proposta carregada para uma carteira no FloFi; nada foi assinado ainda.',
  APPLIED: () => 'Proposta em um workflow do FloFi; qualquer execução precisa da revisão e da assinatura do dono da carteira lá.',
  EXPIRED: () => 'Proposta expirada. Envie LINK para uma nova.', SUPERSEDED: () => 'Proposta substituída por uma mais nova.', REVOKED: () => 'Proposta retirada.',
  STALE: () => 'Proposta não é mais válida com as regras atuais do FloFi. Envie NOVO.',
};

export const channelCopy = (language: ChannelLanguage): Copy => language === 'PT' ? PT : EN;

/** The "Strategy ready" text (the approval link travels separately, as the reply's one link). */
export function readyText(language: ChannelLanguage, facts: ReadyFacts): string {
  const m = channelCopy(language);
  const lines = [m.ready, ...facts.lines.map((line, i) => `${i + 1}. ${line}`), m.network(facts.networks.map(networkLabel).join(' → '), facts.fundsClass === 'REAL_FUNDS'),
    ...facts.notes.slice(0, 3), m.preview(facts.preview), m.authorize(facts.intendedWallet, facts.expiresMinutes), ...facts.aiInterpreted ? [m.ai] : []];
  return shorten(lines.join('\n'));
}
