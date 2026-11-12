// SPDX-License-Identifier: AGPL-3.0-only
/** P0 approved UX (boards 04 and 05, the Editor Create screen and choosing the network in the chat): Brazilian Portuguese for this workstream's
 * new copy, and Brazilian forms for older strings these surfaces show (spread after the product catalog, so these entries win). */
export const portugueseApprovedUxEditor: Readonly<Record<string, string>> = {
  // Canvas header (board 04): name, step count, state, Undo · Redo · ···, and the paused state during a run.
  'Rename workflow: {0}': 'Renomear fluxo: {0}', 'Click to rename': 'Clique para renomear', 'More options': 'Mais opções',
  '{0} step': '{0} passo', '{0} steps': '{0} passos', 'No warnings': 'Nenhum aviso', 'Network?': 'Rede?',
  'Editing paused during execution': 'Edição pausada durante a execução',
  // The configured state, shown once in the header (board 16 §4).
  'Configured': 'Pronto para simular',
  'Undo': 'Desfazer', 'Undo (Ctrl+Z)': 'Desfazer (Ctrl+Z)', 'Delete': 'Excluir', 'Select a card to delete': 'Selecione um cartão para excluir',
  // Steps are "passos" on the Editor (board 04: "1 passo", "Plano · 3 passos").
  '1 step needs attention': '1 passo requer atenção', '{0} steps need attention': '{0} passos requerem atenção',
  'Step {0} needs attention': 'O passo {0} requer atenção', 'Show step': 'Mostrar passo', 'Show step {0}: {1}': 'Mostrar passo {0}: {1}',
  'Show step {0}: {1} ({2})': 'Mostrar passo {0}: {1} ({2})', 'Step {0}: {1}': 'Passo {0}: {1}', 'Your Workflow': 'Meu fluxo',
  // Action rail and the selected card's toolbar.
  'Show action names': 'Mostrar nomes das ações', 'Selected step actions': 'Ações do passo selecionado',
  'Add an action from the toolbar, then select its card to configure it.': 'Adicione uma ação na barra de ferramentas e selecione o cartão para configurá-la.',
  'Start your workflow': 'Comece seu fluxo',
  // Step cards (board 04) and a step without a network yet (board 05).
  'You send': 'Você envia', 'You receive': 'Você recebe', 'You receive, approximately': 'Você recebe, aproximadamente',
  'calculated after the network': 'calculado depois da rede', 'Choose the network in the chat': 'Escolha a rede no chat',
  'Max price difference: {0}': 'Diferença máxima de preço: {0}', 'Adjust': 'Ajustar', 'Adjust max price difference': 'Ajustar a diferença máxima de preço',
  'Settings': 'Configurações', 'Press Enter to apply': 'Pressione Enter para aplicar', 'Review amount': 'Revisar valor', 'Apply amount': 'Aplicar valor',
  'Amount locked': 'Valor bloqueado', 'Show token amount first': 'Mostrar primeiro o valor em tokens', 'Fee tier': 'Faixa de taxa',
  'Custom range percentage': 'Porcentagem do intervalo personalizado', 'Liquidity range view': 'Visualização do intervalo de liquidez',
  'Provider': 'Provedor', 'Liquidity provider': 'Provedor de liquidez', 'Generate mocked artifacts to see outputs': 'Gere artefatos simulados para ver os resultados',
  'No supported networks in the connected wallet environment.': 'Não há redes compatíveis no ambiente da carteira conectada.',
  'Review the route in the simulation': 'Revise a rota na simulação', 'Select to review · non-atomic boundaries': 'Selecione para revisar · etapas sem atomicidade',
  // FloFi panel (board 04): header, plan line, composer.
  'FloFi Assistant': 'Assistente FloFi', 'Plan': 'Plano', 'Plan · {0} steps': 'Plano · {0} passos',
  'Ask or request a change': 'Pergunte ou peça uma mudança', 'Send message': 'Enviar mensagem', 'Interpreting your message…': 'Interpretando sua mensagem…',
  // Choosing the network in the chat (board 05).
  'Choose a network': 'Escolha uma rede', 'Your wallet': 'Sua carteira',
  // A card's settings set its slippage as "Max price difference" in percent (boards 04, 16).
  'Apply max price difference': 'Aplicar a diferença máxima de preço',
  'No max price difference is set for this step.': 'Este passo não tem diferença máxima de preço definida.',
  'Applied limit: {0}. A fresh simulation and Review use it.': 'Limite aplicado: {0}. Uma nova simulação e a Revisão usam esse limite.',
  'Enter a max price difference from 0.01% to 3%.': 'Informe uma diferença máxima de preço de 0,01% a 3%.',
  'Enter the max price difference as a percentage with up to two decimals (1 = 1%).': 'Informe a diferença máxima de preço em porcentagem, com até duas casas decimais (1 = 1%).',
  'This step is protected. Unlock it before changing its max price difference.': 'Este passo está protegido. Desbloqueie-o antes de alterar a diferença máxima de preço.',
  'This max price difference cannot be applied to this step.': 'Esta diferença máxima de preço não pode ser aplicada a este passo.',
  'Cross-chain max price difference (%)': 'Diferença máxima de preço entre redes (%)',
  'Universal bridge max price difference (%)': 'Diferença máxima de preço da ponte universal (%)',
};
