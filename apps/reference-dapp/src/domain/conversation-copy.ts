// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: what the FloFi chat says about its own lifecycle, in English and Brazilian Portuguese. Copy only: every value
 * shown (amounts, quotes, fees, hashes) comes from the canonical workflow and the existing simulation, Review and execution records.
 */
import type { BindingIssue, ConversationLanguage } from './conversation-lifecycle';

export type ConversationCopy = {
  readonly added: (action: string, detail: string) => string; readonly updated: (action: string, detail: string) => string; readonly removed: (action: string) => string;
  readonly changed: string; readonly nextQuestion: string; readonly addAnother: string; readonly review: string; readonly addPrompt: string; readonly undo: string;
  /** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: after a final completed result, the next steps the side chat offers to keep building. */
  readonly afterExecution: string; readonly afterExecutionWhole: string; readonly modify: string; readonly modifyPrompt: string;
  /** Without the Copilot: the Canvas card is how a step changes. After a completed run, a "no" closes the question without claims about funds. */
  readonly modifyOnCanvas: string; readonly closedAfterExecution: string;
  /** A committed change after an execution: executed actions kept as completed steps, or an executed action the next Review covers again. */
  readonly executedKept: (executed: number) => string; readonly executedAgain: string;
  readonly undone: string; readonly undoUnavailable: string; readonly emptyWorkflow: string; readonly reviewStarting: string; readonly reviewBlocked: (reason: string) => string;
  readonly reviewFailed: (reason: string) => string; readonly reviewReady: string; readonly reviewNotApprovable: (reason: string) => string; readonly confirmWorkflow: string;
  readonly confirmYes: string; readonly confirmNo: string; readonly workflowConfirmed: (revision: number, account: string) => string; readonly executeQuestion: string;
  readonly executeYes: string; readonly executeNo: string; readonly walletRequests: (requests: string) => string; readonly walletRequestsUnknown: string;
  readonly executing: string; readonly continueQuestion: string; readonly continueYes: string; readonly declined: string;
  readonly unclear: string; readonly invalidated: Readonly<Record<BindingIssue, string>>; readonly executeNeedsReview: string; readonly executeConfirmedFirst: string;
  readonly restored: string; readonly statusChecking: string; readonly statusUnavailable: string; readonly executionStartFailed: string; readonly checkStatus: string;
  readonly destructive: (steps: string) => string; readonly busy: string; readonly connectWallet: string; readonly switchNetwork: (network: string) => string;
  readonly approvalContext: string; readonly finished: string; readonly startNew: string; readonly positionPrepared: string; readonly noChange: string; readonly locked: string;
  // BUILD-FLOFI-CHAT-E2E-FIX-002: sequences of independent steps, unapplied Canvas edits and the wallet network switch.
  readonly sequenceReviewReady: (current: number, total: number) => string; readonly confirmStep: (current: number, total: number) => string;
  readonly executeStepQuestion: (current: number, total: number) => string;
  readonly stepCompleted: (current: number, total: number, delivered: string | null) => string; readonly stepSimulatingNext: (next: number) => string;
  readonly workflowCompleted: (total: number) => string; readonly awaitingDelivery: (current: number) => string;
  readonly stepStopped: (current: number, total: number) => string;
  readonly editPending: (step: number, action: string, value: string) => string; readonly applyEdit: string; readonly discardEdit: string;
  readonly editApplied: string; readonly editDiscarded: string; readonly editRefused: (reason: string) => string; readonly editQuestion: string;
  readonly switchNetworkFor: (wallet: string | null, network: string) => string; readonly switchFailed: (reason: string) => string; readonly switched: (network: string) => string;
  readonly checkingProviders: string;
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: honest start wording, provider-side settlement, start refusals and quote-change recovery.
  readonly approvalIfNeeded: string; readonly providerSettles: (steps: string) => string; readonly executionNotStarted: (reason: string) => string;
  /** BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the chat has no Authorize control, so its not-ready wallet message points to Review workflow. */
  readonly walletNotReady: string; readonly walletNotReadyToContinue: string;
  readonly quoteMoved: (reason: string) => string; readonly quoteChanges: (changes: string) => string; readonly quoteUnchanged: string;
  readonly confirmUpdated: string; readonly anotherRoute: string; readonly refreshing: string;
  /**
   * BUILD-FLOFI-E2E-RELIABILITY-001: the continuation of a run whose earlier wallet request already landed (e.g. the swap after its confirmed
   * approval). It names what is confirmed and what has not been sent, and never says "nothing was sent" about the run as a whole.
   */
  readonly continueAfter: (done: string, next: string, approval: boolean) => string;
  readonly continuationRequote: (reason: string | null) => string; readonly continuationReview: (next: string) => string;
  readonly continuationQuestion: string; readonly continueFailed: (reason: string) => string;
  /** The answer that accepts a fresh continuation Review (distinct from the plain Continue of an already accepted one). */
  readonly continueAccept: string;
  /** Owner-bound networks: the swap after a landed approval is a new transaction from the wallet, with its own fresh Review. */
  readonly ownerBoundNext: (done: string, next: string) => string;
  readonly continuationRefreshing: (next: string) => string; readonly otherWallet: (wallet: string) => string;
  readonly checkThenContinue: string; readonly reviewToContinue: string; readonly quoteStillValid: string;
};
const en: ConversationCopy = {
  added: (action, detail) => `${action} added to your workflow: ${detail}.`,
  updated: (action, detail) => `${action} updated: ${detail}.`,
  removed: action => `${action} removed from your workflow. The other steps are unchanged.`,
  changed: 'Any earlier simulation or review of this workflow no longer applies.',
  nextQuestion: 'Would you like to add another action or review your workflow?',
  addAnother: 'Add another action', review: 'Review workflow',
  addPrompt: 'Describe the next action, for example “bridge 5 USDC from Base to Arbitrum”.',
  afterExecution: 'What would you like to do next? Add another action to keep building this workflow (what already executed is not sent again), change it, or create a new workflow.',
  afterExecutionWhole: 'What would you like to do next? You can change this workflow, add an action or create a new workflow. This workflow runs as a whole, so after a change the next review covers everything in it again, including what already executed; nothing is sent until you confirm it in your wallet.',
  modify: 'Modify this workflow',
  modifyOnCanvas: 'To change a step, open its card on the Canvas and edit its amount or settings; to add a step, describe the action here, for example “bridge 5 USDC from Base to Arbitrum”. Any change gets a fresh simulation and review before your wallet is asked to sign.',
  closedAfterExecution: 'Okay. The completed run stays in your history; add an action or create a new workflow whenever you like.',
  modifyPrompt: 'Tell me what to change in a step (its amount, asset, network or slippage), or edit that step’s card on the Canvas. Any change gets a fresh simulation and review before your wallet is asked to sign.',
  executedKept: executed => executed === 1 ? 'The action you already executed stays completed and is not sent again: reviews cover only the steps not executed yet.'
    : `The ${executed} steps you already executed stay completed and are not sent again: reviews cover only the steps not executed yet.`,
  executedAgain: 'This workflow still holds an action you already executed, and as it is now the next review covers it again: confirming would send it again. Undo this change if that is not what you want.',
  undo: 'Undo this change', undone: 'Undone. Your workflow is back to its previous version.',
  undoUnavailable: 'There is no chat change to undo: the workflow changed after it.',
  emptyWorkflow: 'Your workflow has no actions yet. Describe an action to add, for example “swap 10 USDC to WETH on Base”.',
  reviewStarting: 'Simulating your workflow with current provider data. Nothing is signed or sent.',
  reviewBlocked: reason => `I can’t start the review yet: ${reason}`,
  reviewFailed: reason => `The simulation did not produce a review: ${reason}`,
  reviewReady: 'Here is the review of your workflow. Amounts are estimates from this simulation, not executed results.',
  reviewNotApprovable: reason => `This review cannot be confirmed yet: ${reason}`,
  confirmWorkflow: 'Do you confirm this workflow?', confirmYes: 'Yes, I confirm', confirmNo: 'No',
  workflowConfirmed: (revision, account) => `Workflow confirmed (revision ${revision}, wallet ${account}). Nothing has been signed or sent.`,
  executeQuestion: 'Would you like to execute this workflow now?', executeYes: 'Yes, execute', executeNo: 'Not now',
  walletRequests: requests => `Your wallet will ask you to confirm each request separately: ${requests}.`,
  walletRequestsUnknown: 'Your wallet shows each request before you confirm it; FloFi never signs for you.',
  executing: 'Preparing your reviewed wallet request: FloFi re-checks the quote, your wallet and its network first. Then confirm or reject it in your wallet; FloFi never signs for you.',
  continueQuestion: 'The previous wallet request is confirmed. The next reviewed request needs its own confirmation in your wallet. Continue to your wallet?',
  continueYes: 'Continue',
  declined: 'Okay. Nothing was signed or sent. Say “review workflow” when you are ready.',
  unclear: 'Please answer yes or no. Nothing changes until you do; to edit the workflow, answer no first.',
  invalidated: {
    WORKFLOW_CHANGED: 'The workflow changed after this review, so the confirmation no longer applies. Review it again before executing.',
    REVIEW_REPLACED: 'A new simulation replaced the reviewed quote, so the confirmation no longer applies. Review the new result before executing.',
    WALLET_CHANGED: 'The connected wallet changed, so the confirmation no longer applies. Review the workflow again with this wallet.',
    NETWORK_CHANGED: 'Your wallet’s network changed, so the confirmation no longer applies. Review the workflow again on the reviewed network.',
    QUOTE_EXPIRED: 'The reviewed quote expired, so the confirmation no longer applies. Review the workflow again for a fresh quote.',
    REVIEW_UNAVAILABLE: 'This review can no longer be authorized, so the confirmation no longer applies. Review the workflow again.',
  },
  executeNeedsReview: 'Execution starts only after a fresh review and your explicit confirmation. Say “review workflow” to begin.',
  executeConfirmedFirst: 'Confirm the reviewed workflow first.',
  restored: 'FloFi restored this workflow’s execution from its saved record. Its status comes from that record; nothing is resent. The Editor’s execution view and the Dashboard show every step.',
  statusChecking: 'Checking the recorded execution. No transaction is resent.',
  statusUnavailable: 'There is no execution to check right now.',
  executionStartFailed: 'The wallet request could not start, and nothing was sent.',
  checkStatus: 'Check status',
  destructive: steps => `This change would also remove ${steps}. Review it on the Canvas before applying; nothing changed yet.`,
  busy: 'FloFi is still working on the previous step. Wait for it to finish.',
  connectWallet: 'Connect the wallet that will sign this workflow, then ask me to review it.',
  switchNetwork: network => `Switch your wallet to ${network}, then ask me to review the workflow again.`,
  approvalContext: 'This proposal came from an approval link. Review and authorize it with the controls on this page.',
  finished: 'This run has a final result. Its record stays in your history.', startNew: 'Create new workflow',
  positionPrepared: 'Prepared for simulation. Nothing is removed until you review, confirm and sign in your wallet.',
  noChange: 'That step already has these values. Nothing changed.',
  locked: 'That step’s amount is locked. Unlock it in the step’s settings first. Nothing changed.',
  sequenceReviewReady: (current, total) => `Here is the review of step ${current} of ${total}. Amounts are estimates from this simulation, not executed results. Each later step is simulated with a fresh quote after the steps before it reconcile, and you confirm it before your wallet is asked.`,
  confirmStep: (current, total) => current === 1 ? 'Do you confirm this workflow?' : `Do you confirm step ${current} of ${total}?`,
  executeStepQuestion: (current, total) => current === 1 && total === 1 ? 'Would you like to execute this workflow now?' : `Would you like to execute step ${current} of ${total} now?`,
  stepCompleted: (current, total, delivered) => `Step ${current} of ${total} is completed and reconciled${delivered ? `: it delivered ${delivered}` : ''}.`,
  stepSimulatingNext: next => `Simulating step ${next} with current provider data. Nothing is signed or sent.`,
  workflowCompleted: total => `All ${total} steps of this workflow are completed and reconciled. Their records stay in your history.`,
  awaitingDelivery: current => `Step ${current} is confirmed. FloFi is waiting for its reconciled delivery before the next step can be simulated. Nothing is resent.`,
  stepStopped: (current, total) => `Step ${current} of ${total} did not complete, so the steps after it were not started. Steps before it stay executed.`,
  editPending: (step, action, value) => `Step ${step} (${action}) has an amount you typed but did not apply: ${value}.`,
  applyEdit: 'Apply it', discardEdit: 'Discard it',
  editApplied: 'Applied. Any earlier simulation or review of this workflow no longer applies.', editDiscarded: 'Discarded. The step keeps its previous amount.',
  editRefused: reason => `That amount cannot be applied: ${reason}`, editQuestion: 'Should I apply it before reviewing the workflow?',
  switchNetworkFor: (wallet, network) => `Your wallet is on ${wallet ?? 'another network'}, but this step runs on ${network}. Switch your wallet to ${network}; I will continue the review once it is done.`,
  switchFailed: reason => `The network switch did not complete: ${reason} Nothing was simulated or sent.`,
  switched: network => `Your wallet is now on ${network}. Continuing the review.`,
  checkingProviders: 'Checking which providers serve this workflow on this deployment. I will continue the review as soon as they answer.',
  approvalIfNeeded: 'A token approval is requested only if your current allowance is still too low when you execute.',
  providerSettles: steps => `Then the provider completes ${steps} on its own: FloFi observes and reconciles it, and your wallet signs nothing for it.`,
  executionNotStarted: reason => `Nothing was sent and no wallet request was opened. ${reason}`,
  walletNotReady: 'Your FloFi wallet is still loading in this page. Wait a moment, then choose Review workflow and confirm again. Nothing was signed.',
  walletNotReadyToContinue: 'Your FloFi wallet is still loading in this page. Wait a moment, then choose Continue again. Nothing was signed.',
  quoteMoved: reason => `Nothing was sent. ${reason} I am getting a fresh quote now; you review and confirm it again before anything is signed.`,
  quoteChanges: changes => `The quote changed since your last Review: ${changes}.`,
  quoteUnchanged: 'The fresh quote has the same amounts as your last Review.',
  confirmUpdated: 'Do you confirm the updated workflow?',
  anotherRoute: 'FloFi asks the provider policy configured on this action again (the Bridge card\'s routing). To force a single provider, change the routing on the card; FloFi never switches providers by itself.',
  refreshing: 'Getting a fresh quote and simulation. Nothing is signed or sent.',
  continueAfter: (done, next, approval) => `${done} is confirmed on-chain.${approval ? ' An approval only allows the spend; it is not the action itself.' : ''} ${next} has not been sent yet and needs its own confirmation in your wallet. Continue to your wallet?`,
  continuationRequote: reason => `Your earlier confirmed request stays in place, and nothing new was sent.${reason ? ` ${reason}` : ' The reviewed quote is no longer valid.'} I am getting a fresh quote for the next request now; you confirm it before your wallet is asked.`,
  continuationReview: next => `Here is the fresh quote for ${next}, which has not been sent yet. Your earlier confirmed request stays in place and is not repeated. Amounts are estimates from this simulation, not executed results.`,
  continuationQuestion: 'Accept this updated quote and continue to your wallet for this request?', continueAccept: 'Accept and continue',
  ownerBoundNext: (done, next) => `${done} is confirmed on-chain. An approval only allows the spend; it is not the action itself. ${next} is a new transaction from your wallet, so FloFi is preparing its own fresh Review now (read-only); you confirm it before your wallet is asked.`,
  continuationRefreshing: next => `Getting a fresh quote for ${next}. Nothing is signed or sent.`,
  otherWallet: wallet => `This run's earlier request came from another wallet (${wallet}). Connect that wallet to continue it, or review the workflow with this wallet to start a separate swap.`,
  checkThenContinue: 'Check the status, then continue again.', reviewToContinue: 'Review the workflow again to continue.',
  quoteStillValid: 'The reviewed quote is still valid for the next request. Answer Continue when you are ready.',
  continueFailed: reason => `The next wallet request did not start, so nothing new was sent. Earlier confirmed requests stay recorded. ${reason}`,
};
const pt: ConversationCopy = {
  added: (action, detail) => `Adicionado ao seu workflow: ${action} · ${detail}.`,
  updated: (action, detail) => `Etapa atualizada: ${action} · ${detail}.`,
  removed: action => `Removido do seu workflow: ${action}. As outras etapas não mudaram.`,
  changed: 'Qualquer simulação ou revisão anterior deste workflow deixou de valer.',
  nextQuestion: 'Quer adicionar outra ação ou revisar o seu workflow?',
  addAnother: 'Adicionar outra ação', review: 'Revisar workflow',
  addPrompt: 'Descreva a próxima ação, por exemplo “bridge 5 USDC from Base to Arbitrum”.',
  afterExecution: 'O que quer fazer agora? Adicione outra ação para continuar este workflow (o que já foi executado não é reenviado), altere-o ou crie um novo fluxo.',
  afterExecutionWhole: 'O que quer fazer agora? Você pode alterar este workflow, adicionar uma ação ou criar um novo fluxo. Este workflow é executado como um todo, então depois de uma alteração a próxima revisão volta a incluir tudo, até o que já foi executado; nada é enviado sem a sua confirmação na carteira.',
  modify: 'Modificar este workflow',
  modifyOnCanvas: 'Para alterar uma etapa, abra o card dela no Canvas e edite o montante ou as configurações; para adicionar uma etapa, descreva a ação aqui, por exemplo “bridge 5 USDC from Base to Arbitrum”. Qualquer alteração recebe uma nova simulação e revisão antes de a carteira pedir a sua assinatura.',
  closedAfterExecution: 'Certo. A execução concluída fica no seu histórico; adicione uma ação ou crie um novo fluxo quando quiser.',
  modifyPrompt: 'Diga o que quer alterar em uma etapa (montante, ativo, rede ou slippage), ou edite o card dessa etapa no Canvas. Qualquer alteração recebe uma nova simulação e revisão antes de a carteira pedir a sua assinatura.',
  executedKept: executed => executed === 1 ? 'A ação que você já executou continua concluída e não é reenviada: as revisões cobrem apenas as etapas ainda não executadas.'
    : `As ${executed} etapas que você já executou continuam concluídas e não são reenviadas: as revisões cobrem apenas as etapas ainda não executadas.`,
  executedAgain: 'Este workflow ainda contém uma ação que você já executou e, do jeito que está, a próxima revisão volta a incluí-la: confirmar faria com que fosse enviada de novo. Desfaça esta alteração se não for isso que você quer.',
  undo: 'Desfazer esta alteração', undone: 'Desfeito. O seu workflow voltou à versão anterior.',
  undoUnavailable: 'Não há alteração do chat para desfazer: o workflow mudou depois dela.',
  emptyWorkflow: 'O seu workflow ainda não tem ações. Descreva uma ação para adicionar, por exemplo “swap 10 USDC to WETH on Base”.',
  reviewStarting: 'Simulando o seu workflow com dados atuais dos provedores. Nada é assinado nem enviado.',
  reviewBlocked: reason => `Ainda não consigo iniciar a revisão: ${reason}`,
  reviewFailed: reason => `A simulação não gerou uma revisão: ${reason}`,
  reviewReady: 'Esta é a revisão do seu workflow. Os montantes são estimativas desta simulação, não resultados executados.',
  reviewNotApprovable: reason => `Esta revisão ainda não pode ser confirmada: ${reason}`,
  confirmWorkflow: 'Você confirma este workflow?', confirmYes: 'Sim, confirmo', confirmNo: 'Não',
  workflowConfirmed: (revision, account) => `Workflow confirmado (revisão ${revision}, carteira ${account}). Nada foi assinado nem enviado.`,
  executeQuestion: 'Quer executar este workflow agora?', executeYes: 'Sim, executar', executeNo: 'Agora não',
  walletRequests: requests => `A sua carteira vai pedir a confirmação de cada pedido separadamente: ${requests}.`,
  walletRequestsUnknown: 'A sua carteira mostra cada pedido antes de você confirmar; a FloFi nunca assina por você.',
  executing: 'Preparando o seu pedido revisado na carteira: a FloFi confere de novo a cotação, a carteira e a rede. Depois confirme ou rejeite na sua carteira; a FloFi nunca assina por você.',
  continueQuestion: 'O pedido anterior na carteira está confirmado. O próximo pedido revisado precisa da sua própria confirmação na carteira. Continuar para a carteira?',
  continueYes: 'Continuar',
  declined: 'Certo. Nada foi assinado nem enviado. Diga “revisar workflow” quando quiser.',
  unclear: 'Responda sim ou não. Nada muda até lá; para editar o workflow, responda não primeiro.',
  invalidated: {
    WORKFLOW_CHANGED: 'O workflow mudou depois desta revisão, então a confirmação deixou de valer. Revise-o novamente antes de executar.',
    REVIEW_REPLACED: 'Uma nova simulação substituiu a cotação revisada, então a confirmação deixou de valer. Revise o novo resultado antes de executar.',
    WALLET_CHANGED: 'A carteira conectada mudou, então a confirmação deixou de valer. Revise o workflow novamente com esta carteira.',
    NETWORK_CHANGED: 'A rede da sua carteira mudou, então a confirmação deixou de valer. Revise o workflow novamente na rede revisada.',
    QUOTE_EXPIRED: 'A cotação revisada expirou, então a confirmação deixou de valer. Revise o workflow novamente para uma cotação nova.',
    REVIEW_UNAVAILABLE: 'Esta revisão já não pode ser autorizada, então a confirmação deixou de valer. Revise o workflow novamente.',
  },
  executeNeedsReview: 'A execução só começa depois de uma revisão nova e da sua confirmação explícita. Diga “revisar workflow” para começar.',
  executeConfirmedFirst: 'Confirme primeiro o workflow revisado.',
  restored: 'A FloFi restaurou a execução deste workflow a partir do registro salvo. O estado vem desse registro; nada é reenviado. A vista de execução do Editor e o Painel mostram cada etapa.',
  statusChecking: 'Verificando a execução registrada. Nenhuma transação é reenviada.',
  statusUnavailable: 'Não há execução para verificar agora.',
  executionStartFailed: 'Não foi possível iniciar o pedido na carteira e nada foi enviado.',
  checkStatus: 'Verificar status',
  destructive: steps => `Esta alteração também removeria ${steps}. Revise-a no Canvas antes de aplicar; nada mudou ainda.`,
  busy: 'A FloFi ainda está a tratar do passo anterior. Aguarde terminar.',
  connectWallet: 'Conecte a carteira que vai assinar este workflow e depois peça para eu revisá-lo.',
  switchNetwork: network => `Mude a sua carteira para ${network} e depois peça para eu revisar o workflow novamente.`,
  approvalContext: 'Esta proposta veio de um link de aprovação. Revise e autorize-a com os controles desta página.',
  finished: 'Esta execução tem um resultado final. O registro fica no seu histórico.', startNew: 'Criar novo fluxo',
  positionPrepared: 'Preparado para a simulação. Nada é removido até você revisar, confirmar e assinar na sua carteira.',
  noChange: 'Essa etapa já tem esses valores. Nada mudou.',
  locked: 'O montante dessa etapa está travado. Destrave-o nas configurações da etapa primeiro. Nada mudou.',
  sequenceReviewReady: (current, total) => `Esta é a revisão da etapa ${current} de ${total}. Os montantes são estimativas desta simulação, não resultados executados. Cada etapa seguinte é simulada com uma cotação nova depois que as anteriores forem reconciliadas, e você a confirma antes de a carteira ser chamada.`,
  confirmStep: (current, total) => current === 1 ? 'Você confirma este workflow?' : `Você confirma a etapa ${current} de ${total}?`,
  executeStepQuestion: (current, total) => current === 1 && total === 1 ? 'Quer executar este workflow agora?' : `Quer executar a etapa ${current} de ${total} agora?`,
  stepCompleted: (current, total, delivered) => `A etapa ${current} de ${total} foi concluída e reconciliada${delivered ? `: entregou ${delivered}` : ''}.`,
  stepSimulatingNext: next => `Simulando a etapa ${next} com dados atuais dos provedores. Nada é assinado nem enviado.`,
  workflowCompleted: total => `As ${total} etapas deste workflow foram concluídas e reconciliadas. Os registros ficam no seu histórico.`,
  awaitingDelivery: current => `A etapa ${current} está confirmada. A FloFi aguarda a entrega reconciliada antes de simular a etapa seguinte. Nada é reenviado.`,
  stepStopped: (current, total) => `A etapa ${current} de ${total} não foi concluída, então as etapas seguintes não foram iniciadas. As etapas anteriores continuam executadas.`,
  editPending: (step, action, value) => `A etapa ${step} (${action}) tem um montante digitado que não foi aplicado: ${value}.`,
  applyEdit: 'Aplicar', discardEdit: 'Descartar',
  editApplied: 'Aplicado. Qualquer simulação ou revisão anterior deste workflow deixou de valer.', editDiscarded: 'Descartado. A etapa mantém o montante anterior.',
  editRefused: reason => `Esse montante não pode ser aplicado: ${reason}`, editQuestion: 'Devo aplicá-lo antes de revisar o workflow?',
  switchNetworkFor: (wallet, network) => `A sua carteira está em ${wallet ?? 'outra rede'}, mas esta etapa é executada em ${network}. Mude a sua carteira para ${network}; eu continuo a revisão assim que terminar.`,
  switchFailed: reason => `A troca de rede não foi concluída: ${reason} Nada foi simulado nem enviado.`,
  switched: network => `A sua carteira agora está em ${network}. Continuando a revisão.`,
  checkingProviders: 'Verificando quais provedores atendem este workflow nesta implantação. Continuo a revisão assim que responderem.',
  approvalIfNeeded: 'Uma aprovação de token só é pedida se a sua permissão atual ainda for insuficiente no momento da execução.',
  providerSettles: steps => `Depois, o provedor conclui ${steps} por conta própria: a FloFi observa e reconcilia, e a sua carteira não assina nada para isso.`,
  executionNotStarted: reason => `Nada foi enviado e nenhum pedido foi aberto na carteira. ${reason}`,
  walletNotReady: 'Sua carteira FloFi ainda está carregando nesta página. Aguarde um momento, escolha Revisar workflow e confirme de novo. Nada foi assinado.',
  walletNotReadyToContinue: 'Sua carteira FloFi ainda está carregando nesta página. Aguarde um momento e escolha Continuar de novo. Nada foi assinado.',
  quoteMoved: reason => `Nada foi enviado. ${reason} Estou buscando uma nova cotação agora; você revisa e confirma de novo antes de qualquer assinatura.`,
  quoteChanges: changes => `A cotação mudou desde a sua última revisão: ${changes}.`,
  quoteUnchanged: 'A nova cotação tem os mesmos valores da sua última revisão.',
  confirmUpdated: 'Você confirma o workflow atualizado?',
  anotherRoute: 'A FloFi consulta de novo a política de provedores configurada nesta ação (o roteamento do card de Bridge). Para forçar um único provedor, altere o roteamento no card; a FloFi nunca troca de provedor sozinha.',
  refreshing: 'Buscando uma nova cotação e simulação. Nada é assinado nem enviado.',
  continueAfter: (done, next, approval) => `${done}: confirmado na rede.${approval ? ' Uma aprovação apenas autoriza o gasto; não é a ação em si.' : ''} ${next}: ainda não enviado, precisa da sua própria confirmação na carteira. Continuar para a carteira?`,
  continuationRequote: reason => `O seu pedido anterior já confirmado continua válido, e nada novo foi enviado.${reason ? ` ${reason}` : ' A cotação revisada já não é válida.'} Estou buscando uma nova cotação para o próximo pedido; você a confirma antes de a carteira ser chamada.`,
  continuationReview: next => `Esta é a nova cotação para ${next}, que ainda não foi enviado. O seu pedido anterior já confirmado continua válido e não é repetido. Os montantes são estimativas desta simulação, não resultados executados.`,
  continuationQuestion: 'Aceitar esta cotação atualizada e continuar para a carteira com este pedido?', continueAccept: 'Aceitar e continuar',
  ownerBoundNext: (done, next) => `${done}: confirmado na rede. Uma aprovação apenas autoriza o gasto; não é a ação em si. ${next} é uma nova transação da sua carteira, então a FloFi está preparando a revisão própria dela agora (somente leitura); você a confirma antes de a carteira ser chamada.`,
  continuationRefreshing: next => `Buscando uma nova cotação para ${next}. Nada é assinado nem enviado.`,
  otherWallet: wallet => `O pedido anterior desta execução veio de outra carteira (${wallet}). Conecte essa carteira para continuá-la, ou revise o workflow com esta carteira para iniciar uma troca separada.`,
  checkThenContinue: 'Verifique o status e depois continue de novo.', reviewToContinue: 'Revise o workflow de novo para continuar.',
  quoteStillValid: 'A cotação revisada ainda é válida para o próximo pedido. Responda Continuar quando quiser.',
  continueFailed: reason => `O próximo pedido na carteira não começou, então nada novo foi enviado. Os pedidos já confirmados continuam registrados. ${reason}`,
};
export const conversationCopy = (language: ConversationLanguage): ConversationCopy => language === 'PT' ? pt : en;
