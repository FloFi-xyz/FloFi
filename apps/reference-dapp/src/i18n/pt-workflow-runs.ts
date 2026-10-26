// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-CHAT-E2E-001: a multi-step workflow on the approval page — its steps, the authorization mode and partial completion. */
export const portugueseWorkflowRuns: Readonly<Record<string, string>> = {
  'Workflow steps': 'Etapas do fluxo', '{0}-step workflow': 'Fluxo de {0} etapas', 'Step {0}': 'Etapa {0}',
  'Waiting': 'Em espera', 'Ready for your signature': 'Pronta para a sua assinatura', 'In your wallet': 'Na sua carteira', 'Authorized': 'Autorizada',
  'Reconciled': 'Reconciliada', 'Failed': 'Falhou', 'Outcome pending': 'Resultado pendente', 'Not run': 'Não executada', 'Stopped before submission': 'Parada antes do envio',
  'Choose how to authorize': 'Escolha como autorizar', 'Running': 'Em execução', 'Completed': 'Concluído', 'Partially completed': 'Parcialmente concluído',
  'Needs attention': 'Requer atenção', 'Ended': 'Encerrado', 'Expired': 'Expirado',
  'Swap': 'Trocar', 'Bridge': 'Transferir entre redes', 'Supply': 'Depositar', 'Borrow': 'Pedir emprestado', 'Repay': 'Reembolsar', 'Withdraw': 'Levantar',
  'Add liquidity': 'Adicionar liquidez', 'Transfer': 'Transferir', 'Lending composition': 'Composição de empréstimo',
  'Authorized once with your passkey': 'Autorizado uma vez com a sua passkey', 'You confirm each step in your wallet': 'Você confirma cada etapa na sua carteira',
  'Choose how to authorize this workflow. Each step starts only after the previous one is reconciled on chain.':
    'Escolha como autorizar este fluxo. Cada etapa só começa depois de a anterior ser reconciliada na rede.',
  'Confirm each step in my wallet ({0} confirmations at least)': 'Confirmar cada etapa na minha carteira (pelo menos {0} confirmações)',
  'Authorize the whole workflow once': 'Autorizar o fluxo inteiro uma vez', 'Authorizing once is not available here.': 'Autorizar uma vez não está disponível aqui.',
  'Enroll a Credential for every network of this workflow in FloFi → Automations → Credentials first.':
    'Registre primeiro uma Credencial para cada rede deste fluxo em FloFi → Automações → Credenciais.',
  'This FloFi deployment cannot sign delegated steps.': 'Esta instalação do FloFi não pode assinar etapas delegadas.',
  'Not enabled on this FloFi deployment.': 'Não está ativado nesta instalação do FloFi.',
  'Your Credentials for these networks use different passkeys.': 'As suas Credenciais para estas redes usam passkeys diferentes.',
  'This browser cannot use a passkey.': 'Este navegador não consegue usar uma passkey.', 'Authorization limits': 'Limites da autorização',
  'Your passkey signs these limits once. FloFi then executes each step within them, without asking your wallet again, and stops at the first step that would exceed them.':
    'A sua passkey assina estes limites uma vez. O FloFi executa depois cada etapa dentro deles, sem voltar a pedir à sua carteira, e para na primeira etapa que os excederia.',
  'Networks': 'Redes', 'Max {0}': 'Máximo de {0}', 'Max slippage': 'Desvio máximo', 'Valid until': 'Válido até', 'Executions': 'Execuções',
  'This workflow, once': 'Este fluxo, uma vez', 'Sign once with my passkey': 'Assinar uma vez com a minha passkey', 'Back': 'Voltar',
  'Continue to step {0}': 'Continuar para a etapa {0}',
  'Partially completed: the reconciled steps stay done and their funds rest in your wallet. Nothing later was submitted.':
    'Parcialmente concluído: as etapas reconciliadas ficam feitas e os seus fundos ficam na sua carteira. Nada posterior foi enviado.',
  'Revoke workflow authorization': 'Revogar autorização do fluxo',
  'Revocation stops future delegated steps. Submitted transactions keep being observed.': 'A revogação impede etapas delegadas futuras. As transações enviadas continuam a ser observadas.',
  'Try this step again': 'Tentar esta etapa de novo', 'End workflow': 'Encerrar fluxo',
  'A submitted step has no final outcome yet. FloFi keeps observing it and never resubmits it.':
    'Uma etapa enviada ainda não tem resultado final. O FloFi continua a observá-la e nunca a reenvia.',
  'Every step reconciled.': 'Todas as etapas reconciliadas.', 'Your conversation can show the result.': 'A sua conversa pode mostrar o resultado.',
  'This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.':
    'Este fluxo usa uma carteira EVM e uma carteira Solana: as duas precisam ser comprovadas antes de ele começar.',
  'Each step starts only after the previous step reconciled on chain.': 'Cada etapa só começa depois de a anterior ser reconciliada na rede.',
  'A dependent step spends what an earlier step actually delivered (after reconciliation), capped by its own amount.':
    'Uma etapa dependente gasta o que uma etapa anterior realmente entregou (após a reconciliação), limitado ao seu próprio valor.',
  'One authorization is not one transaction: every step still submits its own transactions and pays its own network fees.':
    'Uma autorização não é uma transação: cada etapa continua a enviar as suas próprias transações e a pagar as suas próprias taxas de rede.',
};
