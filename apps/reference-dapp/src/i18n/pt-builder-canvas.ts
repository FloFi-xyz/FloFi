// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-BUILDER-UX-002: the Canvas step card's summary rows (new keys only; every existing translation keeps precedence). */
export const portugueseBuilderCanvas: Readonly<Record<string, string>> = {
  'Fee tier': 'Nível de comissão',
  // Canvas link labels: the short label of a link that only orders two steps, and the lending composition's two links.
  'Then': 'Depois', 'Then: after the previous step': 'Depois: após a etapa anterior',
  'Health factor ≥ 2': 'Fator de saúde ≥ 2', 'Borrowed USDC': 'USDC emprestado',
  // The lending composition's Swap card flow line (the other flow lines are assets, networks and protocols, which stay as they are).
  'Borrowed USDC → WETH': 'USDC emprestado → WETH',
  // BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): card status, workflow header, FloFi panel summary, footer notices and the stepper.
  // "Configured" never means simulated, approved or executable; the detail says so.
  'Draft': 'Rascunho', 'Configured': 'Configurado',
  'Configured. Simulation, Review and your signature come next.': 'Configurado. Depois vêm a simulação, a revisão e a sua assinatura.',
  'This step could not be reviewed. Check its settings.': 'Não foi possível revisar esta etapa. Confira as configurações dela.',
  'An edit was not applied.': 'Uma edição não foi aplicada.', 'No step warnings': 'Nenhuma etapa com aviso',
  'Check this step’s slippage limit.': 'Confira o limite de desvio de preço desta etapa.',
  'The slippage limit is above what FloFi accepts for review.': 'O limite de desvio de preço está acima do que o FloFi aceita para revisão.',
  'Set one slippage limit for this step.': 'Defina um limite de desvio de preço para esta etapa.',
  'Not applied to the workflow yet.': 'Ainda não aplicado ao fluxo.',
  'Check this step’s settings.': 'Verifique as configurações desta etapa.',
  'No steps yet': 'Nenhuma etapa ainda',
  'Add a step from the toolbar or describe it to FloFi.': 'Adicione uma etapa pela barra de ferramentas ou descreva-a ao FloFi.',
  'Some changes are not applied to the workflow yet.': 'Algumas alterações ainda não foram aplicadas ao fluxo.',
  'Check the step that needs attention.': 'Verifique a etapa que requer atenção.',
  'Configured. Simulate and review before signing.': 'Configurado. Simule e revise antes de assinar.',
  'Workflow networks': 'Redes do fluxo', 'Workflow state:': 'Estado do fluxo:',
  'Workflow summary': 'Resumo do fluxo', 'Show step {0}: {1} ({2})': 'Mostrar etapa {0}: {1} ({2})',
  'Step {0} needs attention': 'A etapa {0} requer atenção', 'Show step': 'Mostrar etapa',
  '1 step needs attention': '1 etapa requer atenção', '{0} steps need attention': '{0} etapas requerem atenção', 'Step {0}: {1}': 'Etapa {0}: {1}',
  '1 change not applied yet': '1 alteração ainda não aplicada', '{0} changes not applied yet': '{0} alterações ainda não aplicadas',
  'Editor steps': 'Etapas do editor', 'Create': 'Criar',
  // The workflow review's slippage findings, now shown as a card's "Needs attention" detail (the engine's text is unchanged).
  'Review the prototype slippage limit.': 'Revise o limite de desvio de preço.',
  'Above the BUILD-003A review limit.': 'Acima do limite de desvio aceito para revisão.',
  'Set one explicit slippage limit.': 'Defina um limite de desvio de preço explícito.',
};
