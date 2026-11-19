// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (pt-BR): Caio's approved Editor and navigation copy — the global product areas, the Editor's stage indicator
 * reasons, the Simulate contextual panel, the Execute review states (valid and expired) and the Assistant's stage hints. New keys only; the
 * shared words (Simular fluxo, Autorizar fluxo, Painel…) reuse the existing catalog.
 */
export const portugueseUxEditorFinops: Readonly<Record<string, string>> = {
  // Global navigation (product areas)
  'Product areas': 'Áreas do produto', 'Operate': 'Operar', 'My Workflows': 'Meus Workflows', 'FloFi — go to Operate': 'FloFi — ir para Operar',
  // The Editor's stage indicator: why a future stage is still unavailable
  'Add an action to your workflow first': 'Adicione uma ação ao seu fluxo primeiro', 'Simulate the workflow first': 'Simule o fluxo primeiro',
  // Simulate (B2)
  'Simulation result': 'Resultado da simulação', 'Simulation blocked': 'Simulação bloqueada',
  'Check the expected result, costs and possible risks.': 'Verifique o resultado esperado, custos e possíveis riscos.',
  'What does the simulation do?': 'O que a simulação faz?',
  'It estimates the result of your operation and shows the expected costs, without moving your funds.': 'Estima o resultado da sua operação e mostra os custos previstos, sem movimentar seus fundos.',
  'Valid until {0}. Nothing has been signed or sent.': 'Válida até {0}. Nada foi assinado nem enviado.', 'Nothing has been signed or sent.': 'Nada foi assinado nem enviado.',
  'Simulate again to refresh the expected result and costs. The previous values are no longer current.': 'Simule novamente para atualizar o resultado esperado e os custos. Os valores anteriores não são mais atuais.',
  'Fix what is described below, then simulate again. Nothing has been signed or sent.': 'Corrija o que está descrito abaixo e simule novamente. Nada foi assinado nem enviado.',
  'This workflow already started. Follow its progress in Execute.': 'Este fluxo já começou. Acompanhe o progresso em Executar.',
  'Review operation': 'Revisar operação', 'After simulating, you can review the details and then execute.': 'Após simular, você poderá revisar os detalhes e, em seguida, executar.',
  'This workflow runs as one workflow run: choose Simulate workflow, then Review operation and Authorize workflow.': 'Este fluxo roda como uma única execução: escolha Simular fluxo, depois Revisar operação e Autorizar fluxo.',
  // Execute (C1 valid, C2 expired)
  'Operation summary': 'Resumo da operação', 'Your review expired': 'Sua revisão expirou',
  'Refresh the simulation and check the new values before authorizing.': 'Atualize a simulação e confira os novos valores antes de autorizar.',
  'Needs to be refreshed': 'Precisa ser atualizada', 'Depends on the updated review': 'Depende da revisão atualizada',
  'Review valid until {0}': 'Revisão válida até {0}', 'Refresh review': 'Atualizar revisão', 'Review expired': 'Revisão expirada',
  // FloFi Assistant: the composer's hint and the local note for the stage
  'Ask about results and costs': 'Pergunte sobre resultados e custos', 'Ask about this authorization': 'Pergunte sobre esta autorização',
  'Your review expired. Refresh the values to continue safely. Your workflow is still saved.': 'Sua revisão expirou. Atualize os valores para continuar com segurança. Seu fluxo continua salvo.',
};
