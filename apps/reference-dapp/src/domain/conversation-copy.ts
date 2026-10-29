// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: what the FloFi chat says about its own lifecycle, in English and Brazilian Portuguese. Copy only: every value
 * shown (amounts, quotes, fees, hashes) comes from the canonical workflow and the existing simulation, Review and execution records.
 */
import type { BindingIssue, ConversationLanguage } from './conversation-lifecycle';

export type ConversationCopy = {
  readonly added: (action: string, detail: string) => string; readonly updated: (action: string, detail: string) => string; readonly removed: (action: string) => string;
  readonly changed: string; readonly nextQuestion: string; readonly addAnother: string; readonly review: string; readonly addPrompt: string; readonly undo: string;
  readonly undone: string; readonly undoUnavailable: string; readonly emptyWorkflow: string; readonly reviewStarting: string; readonly reviewBlocked: (reason: string) => string;
  readonly reviewFailed: (reason: string) => string; readonly reviewReady: string; readonly reviewNotApprovable: (reason: string) => string; readonly confirmWorkflow: string;
  readonly confirmYes: string; readonly confirmNo: string; readonly workflowConfirmed: (revision: number, account: string) => string; readonly executeQuestion: string;
  readonly executeYes: string; readonly executeNo: string; readonly walletRequests: (requests: string) => string; readonly walletRequestsUnknown: string;
  readonly executing: string; readonly continueQuestion: string; readonly continueYes: string; readonly declined: string;
  readonly unclear: string; readonly invalidated: Readonly<Record<BindingIssue, string>>; readonly executeNeedsReview: string; readonly executeConfirmedFirst: string;
  readonly restored: string; readonly statusChecking: string; readonly statusUnavailable: string; readonly executionStartFailed: string; readonly checkStatus: string;
  readonly destructive: (steps: string) => string; readonly busy: string; readonly connectWallet: string; readonly switchNetwork: (network: string) => string;
  readonly approvalContext: string; readonly finished: string; readonly startNew: string; readonly positionPrepared: string; readonly noChange: string; readonly locked: string;
};
const en: ConversationCopy = {
  added: (action, detail) => `${action} added to your workflow: ${detail}.`,
  updated: (action, detail) => `${action} updated: ${detail}.`,
  removed: action => `${action} removed from your workflow. The other steps are unchanged.`,
  changed: 'Any earlier simulation or review of this workflow no longer applies.',
  nextQuestion: 'Would you like to add another action or review your workflow?',
  addAnother: 'Add another action', review: 'Review workflow',
  addPrompt: 'Describe the next action, for example “bridge 5 USDC from Base to Arbitrum”.',
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
  executing: 'Opening the reviewed wallet request. Confirm or reject it in your wallet; FloFi never signs for you.',
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
  restored: 'FloFi restored this workflow’s execution from its saved record. The status below comes from that record; nothing is resent.',
  statusChecking: 'Checking the recorded execution. No transaction is resent.',
  statusUnavailable: 'There is no execution to check right now.',
  executionStartFailed: 'The wallet request could not start, and nothing was sent. The status below shows the recorded state.',
  checkStatus: 'Check status',
  destructive: steps => `This change would also remove ${steps}. Review it on the Canvas before applying; nothing changed yet.`,
  busy: 'FloFi is still working on the previous step. Wait for it to finish.',
  connectWallet: 'Connect the wallet that will sign this workflow, then ask me to review it.',
  switchNetwork: network => `Switch your wallet to ${network}, then ask me to review the workflow again.`,
  approvalContext: 'This proposal came from an approval link. Review and authorize it with the controls on this page.',
  finished: 'This run has a final result. Its record stays in your history.', startNew: 'Create new workflow',
  positionPrepared: 'Prepared for Simulate. Nothing is removed until you review, confirm and sign in your wallet.',
  noChange: 'That step already has these values. Nothing changed.',
  locked: 'That step’s amount is locked. Unlock it in the step’s settings first. Nothing changed.',
};
const pt: ConversationCopy = {
  added: (action, detail) => `Adicionado ao seu workflow: ${action} · ${detail}.`,
  updated: (action, detail) => `Etapa atualizada: ${action} · ${detail}.`,
  removed: action => `Removido do seu workflow: ${action}. As outras etapas não mudaram.`,
  changed: 'Qualquer simulação ou revisão anterior deste workflow deixou de valer.',
  nextQuestion: 'Quer adicionar outra ação ou revisar o seu workflow?',
  addAnother: 'Adicionar outra ação', review: 'Revisar workflow',
  addPrompt: 'Descreva a próxima ação, por exemplo “bridge 5 USDC from Base to Arbitrum”.',
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
  executing: 'Abrindo o pedido revisado na carteira. Confirme ou rejeite na sua carteira; a FloFi nunca assina por você.',
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
  restored: 'A FloFi restaurou a execução deste workflow a partir do registro salvo. O estado abaixo vem desse registro; nada é reenviado.',
  statusChecking: 'Verificando a execução registrada. Nenhuma transação é reenviada.',
  statusUnavailable: 'Não há execução para verificar agora.',
  executionStartFailed: 'Não foi possível iniciar o pedido na carteira e nada foi enviado. O estado abaixo mostra o registro.',
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
};
export const conversationCopy = (language: ConversationLanguage): ConversationCopy => language === 'PT' ? pt : en;
