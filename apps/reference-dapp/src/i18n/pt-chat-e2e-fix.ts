// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-CHAT-E2E-FIX-002: sequences of independent steps, the in-chat Review and its costs, unapplied Canvas edits and honest run status. */
export const portugueseChatE2eFix: Readonly<Record<string, string>> = {
  'Workflow actions': 'Ações do workflow', 'Completed and reconciled': 'Concluída e reconciliada', 'Completed and reconciled · delivered {0}': 'Concluída e reconciliada · entregou {0}',
  'Simulated now': 'Simulada agora',
  'Simulated with a fresh quote after step {0} reconciles; you confirm it separately': 'Simulada com uma cotação nova depois que a etapa {0} for reconciliada; você a confirma separadamente',
  'Funded by step {0}: spends {1} (what step {0} delivered, at most {2})': 'Financiada pela etapa {0}: gasta {1} (o que a etapa {0} entregou, no máximo {2})',
  'Funded by step {0}: spends the smaller of {1} and what step {0} actually delivers': 'Financiada pela etapa {0}: gasta o menor entre {1} e o que a etapa {0} realmente entregar',
  'Costs': 'Custos', 'Estimated total cost': 'Custo total estimado', 'Not available from this simulation': 'Não disponível nesta simulação', 'Excludes: {0}': 'Não inclui: {0}',
  'Cost lines in another unit': 'Linhas de custo em outra unidade', 'Step {0} (simulated after the steps before it)': 'Etapa {0} (simulada depois das etapas anteriores)',
  'Steps {0} (simulated after the steps before them)': 'Etapas {0} (simuladas depois das etapas anteriores)',
  'This workflow runs as {0} separate wallet transactions, one step at a time. If a later step fails or you stop, the earlier steps stay executed and their assets stay in your wallet.':
    'Este workflow é executado como {0} transações separadas na carteira, uma etapa de cada vez. Se uma etapa posterior falhar ou você parar, as etapas anteriores continuam executadas e os ativos ficam na sua carteira.',
  'Approvals and limits': 'Aprovações e limites', 'Step {0} of {1}: {2}': 'Etapa {0} de {1}: {2}', '{0} of {1} workflow steps completed': '{0} de {1} etapas do workflow concluídas',
  'Step {0} ({1} on {2}) cannot run as part of a multi-action workflow yet: FloFi executes this action only as its own workflow. Nothing was simulated or sent.':
    'A etapa {0} ({1} em {2}) ainda não pode ser executada dentro de um workflow com várias ações: a FloFi executa esta ação apenas como um workflow próprio. Nada foi simulado nem enviado.',
  'Step {0} has nothing to spend: step {1} delivered none of its asset.': 'A etapa {0} não tem nada para gastar: a etapa {1} não entregou nenhuma quantidade do ativo.',
  'Step {0} cannot spend the amount step {1} delivered: the step refuses that amount.': 'A etapa {0} não pode gastar o montante que a etapa {1} entregou: a etapa recusa esse montante.',
  'This edit is no longer pending.': 'Esta edição já não está pendente.',
  'Not requested': 'Não solicitado',
  'Simulated or reviewed only: no wallet request was made, so nothing was sent.': 'Apenas simulado ou revisado: nenhum pedido foi feito à carteira, então nada foi enviado.',
  'The simulation or Review recorded an issue before any wallet request, so nothing was sent.': 'A simulação ou a revisão registrou um problema antes de qualquer pedido à carteira, então nada foi enviado.',
  'Simulation details': 'Detalhes da simulação', 'Execution details': 'Detalhes da execução', 'Result details': 'Detalhes do resultado',
};
