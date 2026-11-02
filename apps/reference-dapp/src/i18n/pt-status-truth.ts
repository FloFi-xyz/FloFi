// SPDX-License-Identifier: AGPL-3.0-only
import { LANDED_LABELS_PT } from '../domain/landed-attempts.ts';
/**
 * Issue #149 (financial truth): the Dashboard's landed-attempt indicator and the Automations History's run phases (simulation, refusal,
 * submission, onchain confirmation, reconciliation). Only new keys: shared wording keeps its existing translation.
 */
export const portugueseStatusTruth: Readonly<Record<string, string>> = {
  ...LANDED_LABELS_PT,
  // Dashboard: what landed onchain, from the run's recorded attempts.
  'Landed onchain': 'Confirmado onchain',
  'Confirmed onchain · workflow outcome not reconciled yet': 'Confirmada onchain · resultado do workflow ainda não reconciliado',
  'Earlier actions confirmed onchain · a later action is not complete': 'Ações anteriores confirmadas onchain · uma ação posterior não foi concluída',
  'Only the token approval is confirmed onchain. An approval moves no funds by itself, and the main action has not completed.':
    'Apenas a aprovação do token está confirmada onchain. Uma aprovação não move fundos por si só, e a ação principal não foi concluída.',
  'A wallet request is prepared and awaits your wallet confirmation. Nothing is sent without it.':
    'Uma solicitação à carteira está preparada e aguarda a sua confirmação na carteira. Nada é enviado sem ela.',
  'A recorded transaction needs review before anything else happens. Open the run.': 'Uma transação registrada precisa ser revista antes de qualquer outra ação. Abra a execução.',
  'The recorded requests of this run could not be read, so FloFi does not claim that nothing was sent. Refresh history to check again.':
    'Não foi possível ler as solicitações registradas desta execução, por isso a FloFi não afirma que nada foi enviado. Atualize o histórico para verificar novamente.',
  // Automations History: one run started from a proposal, by what its records prove.
  'Intention only — not simulated or sent yet': 'Apenas a intenção — ainda não simulada nem enviada',
  'Run status could not be read now — not evidence that nothing was sent': 'O status das execuções não pôde ser lido agora — não é prova de que nada foi enviado',
  'No run of this exact proposal recorded yet': 'Ainda não há execução registrada desta proposta exata',
  'Simulated only — nothing was sent': 'Apenas simulada — nada foi enviado',
  'Reviewed only — nothing was sent': 'Apenas revisada — nada foi enviado',
  'Awaiting your wallet confirmation — nothing sent yet': 'Aguardando a confirmação na sua carteira — nada enviado ainda',
  'Refused or not submitted — nothing was sent': 'Recusada ou não submetida — nada foi enviado',
  'Submitted — awaiting confirmation': 'Submetida — aguardando confirmação',
  'Transaction sent — awaiting onchain confirmation': 'Transação enviada — aguardando confirmação onchain',
  'Confirmed onchain — reconciling': 'Confirmada onchain — em reconciliação',
  'Origin confirmed — settlement pending': 'Origem confirmada — liquidação pendente',
  'Outcome recorded — not yet verified as reconciled': 'Resultado registrado — ainda não verificado como reconciliado',
  'Partially completed — earlier actions confirmed': 'Parcialmente concluída — ações anteriores confirmadas',
  'Transaction reverted': 'Transação revertida',
  'Status unresolved — no transaction is repeated': 'Estado não resolvido — nenhuma transação é repetida',
  'Needs your review — open the run': 'Precisa da sua revisão — abra a execução',
};
