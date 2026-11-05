// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the Editor's "Run workflow" (the shared workflow run started from the Canvas) and its approval wording. */
export const portugueseEditorRuns: Readonly<Record<string, string>> = {
  'Run workflow': 'Executar fluxo', 'Run the whole workflow': 'Executar o fluxo inteiro', 'Starting workflow run…': 'Iniciando a execução do fluxo…',
  'Runs all {0} steps in order on FloFi\'s approval page: confirm each step in your wallet, or authorize the whole workflow once where available. Nothing is signed here.':
    'Executa as {0} etapas em ordem na página de aprovação do FloFi: confirme cada etapa na sua carteira ou autorize o fluxo inteiro uma vez, quando disponível. Nada é assinado aqui.',
  'Fix the workflow on the Canvas before running it.': 'Corrija o fluxo no Canvas antes de executá-lo.',
  'Simulate the workflow before running it.': 'Simule o fluxo antes de executá-lo.',
  'The workflow changed after it was simulated. Simulate it again to run it.': 'O fluxo mudou depois de ser simulado. Simule-o de novo para executá-lo.',
  'The simulation is no longer current. Simulate the workflow again to run it.': 'A simulação já não está atual. Simule o fluxo de novo para executá-lo.',
  'FloFi could not start this workflow run ({0}). Nothing was authorized.': 'O FloFi não conseguiu iniciar a execução deste fluxo ({0}). Nada foi autorizado.',
  'Sign in to FloFi to run this workflow from the Editor.': 'Entre no FloFi para executar este fluxo a partir do Editor.',
  'Running a whole workflow is not enabled on this FloFi deployment.': 'Executar um fluxo inteiro não está ativado nesta instalação do FloFi.',
  'Step {0} cannot run as part of a workflow run yet. Execute this workflow step by step here instead.':
    'A etapa {0} ainda não pode ser executada numa execução de fluxo. Execute este fluxo etapa por etapa aqui.',
  'Step {0} is not exactly what FloFi would run for it. Execute this workflow step by step here instead.':
    'A etapa {0} não é exatamente o que o FloFi executaria para ela. Execute este fluxo etapa por etapa aqui.',
  'Too many workflow runs were started recently. Try again later.': 'Foram iniciadas muitas execuções de fluxo recentemente. Tente de novo mais tarde.',
  'Too many workflow runs are waiting for you. Open or finish one of them first.': 'Há muitas execuções de fluxo à sua espera. Abra ou conclua uma delas primeiro.',
  'FloFi\'s review blocks this workflow. Fix it on the Canvas first.': 'A revisão do FloFi bloqueia este fluxo. Corrija-o primeiro no Canvas.',
  'This workflow uses a test network. FloFi runs on mainnets only.': 'Este fluxo usa uma rede de teste. O FloFi funciona apenas em mainnets.',
  // The approval page, for a workflow the owner started from their own Editor.
  'Started by you from the FloFi Editor. It is not financial advice; you decide, and only your wallet can sign.':
    'Iniciado por você no Editor do FloFi. Não é aconselhamento financeiro; você decide, e só a sua carteira pode assinar.',
  'This wallet does not belong to the FloFi account that started this workflow. Connect one of that account\'s wallets.':
    'Esta carteira não pertence à conta FloFi que iniciou este fluxo. Conecte uma das carteiras dessa conta.',
  'Getting the workflow you started in the Editor…': 'Obtendo o fluxo que você iniciou no Editor…',
  'Start the workflow again from the FloFi Editor if it is still on your Canvas.': 'Inicie o fluxo de novo a partir do Editor do FloFi se ele ainda estiver no seu Canvas.',
};
