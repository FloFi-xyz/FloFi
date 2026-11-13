// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 approved UX (board 16 §4): Brazilian Portuguese for the shell, lifecycle, Review, blocker and execution copy, and the approved
 * terminology (workflow → fluxo). Spread LAST in `pt.ts`, so these entries also replace older European Portuguese forms of touched strings.
 */
export const portugueseApprovedUx: Readonly<Record<string, string>> = {
  // P0 Track B: the assistant's blocker explanation (approved-ux.ts).
  "Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}, and this fee can reach {4} {1}, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.":
    "Toda transação na {0} paga uma taxa de rede em {1}. Sua carteira {2} tem {3} {1}, e essa taxa pode chegar a {4} {1}, então falta no mínimo {5} {1}. Envie um pouco de {1} na rede {0} para {2} e depois escolha Simular novamente. Nada foi enviado.",
  // P0 Track B (main session): shell, Chat entry, footer, Review and blocker copy, and the board 16 §4 terminology.
  "New workflow": "Novo fluxo",
  "Library": "Biblioteca",
  "Access": "Acessos",
  "Log out": "Sair",
  "Logout": "Sair",
  "In testing": "Em teste",
  "Coming soon": "Em breve",
  "FloFi navigation": "Navegação da FloFi",
  "Settings": "Configurações",
  "Settings options": "Opções de configurações",
  "Disconnect": "Desconectar",
  "Your wallet is on {0}. Switch to {1} to continue.": "Sua carteira está na {0}. Troque para a {1} para continuar.",
  "Switch to {0}": "Trocar para {0}",
  "Back to {0}": "Voltar para {0}",
  "Open {0}": "Abrir {0}",
  "Choose the network in the chat first": "Escolha a rede no chat primeiro",
  "Your workflows": "Seus fluxos",
  "Passkeys": "Passkeys",
  "Workflow": "Fluxo",
  "Your workflow": "Seu fluxo",
  "Delete": "Excluir",
  "Wallet not connected": "Carteira não conectada",
  "Connect Wallet": "Conectar carteira",
  "Connect wallet": "Conectar carteira",
  "Wallet connection": "Conexão da carteira",
  "Restoring wallet…": "Restaurando a carteira…",
  "What do you want to": "O que você quer",
  "do?": "fazer?",
  "e.g. swap 10 USDC for ETH on Base": "Ex.: trocar 10 USDC por ETH na Base",
  "Create workflow": "Criar fluxo",
  "Describe what you want to do": "Descreva o que você quer fazer",
  "Press Enter to create the workflow, or Shift+Enter for a new line.": "Pressione Enter para criar o fluxo, ou Shift+Enter para uma nova linha.",
  "Swap tokens": "Trocar moedas",
  "Earn yield": "Render juros",
  "Provide liquidity": "Prover liquidez",
  "Use as collateral": "Usar como garantia",
  "Multi-step workflow": "Fluxo com vários passos",
  "Example requests": "Exemplos de pedidos",
  "Preparing…": "Preparando…",
  "1 step": "1 passo",
  "{0} steps": "{0} passos",
  "No warnings": "Nenhum aviso",
  "Choose the network in the chat to simulate": "Escolha a rede no chat para simular",
  "Simulation valid for {0}": "Simulação válida por {0}",
  "Expired, simulate again": "Expirada, simule novamente",
  "Nothing was sent": "Nada foi enviado",
  "Simulating workflow…": "Simulando o fluxo…",
  "Simulate workflow": "Simular fluxo",
  "Simulate again": "Simular novamente",
  "Authorize in wallet": "Autorizar na carteira",
  "Waiting for wallet…": "Aguardando a carteira…",
  "Configured": "Pronto para simular",
  "Create": "Criar",
  "Simulate": "Simular",
  "Execute": "Executar",
  "Review": "Revisão",
  "REVIEW": "REVISÃO",
  "You are authorizing": "Você está autorizando",
  "Minimum you receive": "Mínimo que você recebe",
  "Network fee, at most": "Taxa de rede, no máximo",
  "Token permission": "Permissão de token",
  "{0} uses up to {1}": "{0} usa até {1}",
  "Wallet requests": "Pedidos à carteira",
  "Your wallet pays the network fee. FloFi never signs or sends for you.": "Sua carteira paga a taxa de rede. A FloFi nunca assina nem envia por você.",
  "Technical details": "Detalhes técnicos",
  "Technical details, for support": "Detalhes técnicos, para o suporte",
  "Before authorizing": "Antes de autorizar",
  "BEFORE AUTHORIZING": "ANTES DE AUTORIZAR",
  "Not enough {0} on {1} for the network fee": "Falta {0} na {1} para a taxa de rede",
  "You have": "Você tem",
  "The fee can reach": "A taxa pode chegar a",
  "Missing, at least": "Falta, no mínimo",
  "Send a little {0} on the {1} network to this wallet, from an exchange or another wallet. Nothing was sent.": "Envie um pouco de {0} na rede {1} para esta carteira, a partir de uma exchange ou de outra carteira sua. Nada foi enviado.",
  "Open Credentials": "Abrir Credenciais",
  "Open Board": "Abrir o Board",
  "Sign in": "Entrar",
  "Copy address": "Copiar endereço",
  "Address copied.": "Endereço copiado.",
  "Address could not be copied.": "Não foi possível copiar o endereço.",
  // P0 Track A: bridge and liquidity refusals at Simulate (simulation-presentation.ts).
  "The bridge provider does not have enough liquidity for this amount right now, so this step was not simulated or sent. Try a smaller amount or try again later.":
    "O provedor da ponte não tem liquidez suficiente para este valor agora, por isso este passo não foi simulado nem enviado. Tente um valor menor ou tente novamente mais tarde.",
  "The amount is below the bridge provider’s minimum for this route, so this step was not simulated or sent. Choose a larger amount, then simulate again.":
    "O valor está abaixo do mínimo do provedor da ponte para esta rota, por isso este passo não foi simulado nem enviado. Escolha um valor maior e simule novamente.",
  "Not started: its simulation was refused": "Não iniciado: a simulação foi recusada",
  "FloFi cannot bridge WETH on this route: the bridge provider converts it to native ETH through contracts FloFi does not verify, so this step was not simulated or sent. Bridge ETH (unwrap the WETH first) or USDC instead.":
    "A FloFi não consegue enviar WETH pela ponte nesta rota: o provedor da ponte o converte em ETH nativo por meio de contratos que a FloFi não verifica, por isso este passo não foi simulado nem enviado. Envie ETH pela ponte (faça antes o unwrap do WETH) ou USDC.",
  "No bridge route that FloFi can verify and execute is available for this amount right now, so this step was not simulated or sent. Try again later or change the amount.":
    "Nenhuma rota de ponte que a FloFi consiga verificar e executar está disponível para este valor agora, por isso este passo não foi simulado nem enviado. Tente novamente mais tarde ou altere o valor.",
  "Below the provider minimum":
    "Abaixo do mínimo do provedor",
  "No executable bridge route":
    "Nenhuma rota de ponte executável",
  "Liquidity unavailable":
    "Liquidez indisponível",
  // P0 Track A: Flight Beta refusals (src/domain/flight-refusal.ts).
  "Wallet not linked to your FloFi account":
    "Carteira não vinculada à sua conta FloFi",
  "Link a wallet to your FloFi account":
    "Vincule uma carteira à sua conta FloFi",
  "Sign in again":
    "Entre novamente",
  "Flight access not active for this account":
    "O acesso ao Flight não está ativo nesta conta",
  "Flight access ended":
    "O acesso ao Flight foi encerrado",
  "Boarding has not opened yet":
    "O embarque ainda não abriu",
  "FloFi is not accepting new activity":
    "A FloFi não está aceitando novas operações",
  "Flight access could not be checked":
    "Não foi possível verificar seu acesso ao Flight",
  "This wallet is not linked to your FloFi account for Flight access, so FloFi stopped this request: it was not quoted, simulated or sent. Save it in Credentials (you sign a message, never a transaction), then choose Board now on the Board page to add it to your access — or switch to a wallet you already linked.":
    "Esta carteira não está vinculada à sua conta FloFi para o acesso ao Flight, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. Salve-a em Credenciais (você assina uma mensagem, nunca uma transação) e depois toque em Embarcar agora na página do Board para adicioná-la ao seu acesso — ou troque para uma carteira que você já vinculou.",
  "Your FloFi account has no wallet linked for Flight access yet, so FloFi stopped this request: it was not quoted, simulated or sent. Link the wallet you will sign with in Credentials, then choose Board now on the Board page.":
    "Sua conta FloFi ainda não tem uma carteira vinculada para o acesso ao Flight, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. Vincule em Credenciais a carteira com que você vai assinar e depois toque em Embarcar agora na página do Board.",
  "Your FloFi session ended, so FloFi stopped this request. Sign in again to continue; anything already sent stays tracked.":
    "Sua sessão na FloFi terminou, por isso a FloFi interrompeu este pedido. Entre novamente para continuar; o que já foi enviado continua sendo acompanhado.",
  "This FloFi account does not have active Flight access, so FloFi stopped this request: it was not quoted, simulated or sent. Open the Board page to check your access.":
    "Esta conta FloFi não tem acesso ativo ao Flight, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. Abra a página do Board para verificar seu acesso.",
  "Flight access for this account has ended, so FloFi stopped this request: it was not quoted, simulated or sent. Anything already sent stays tracked.":
    "O acesso ao Flight desta conta foi encerrado, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. O que já foi enviado continua sendo acompanhado.",
  "Boarding has not opened yet, so FloFi stopped this request: it was not quoted, simulated or sent. Open the Board page to see when it opens.":
    "O embarque ainda não abriu, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. Abra a página do Board para ver quando ele abre.",
  "FloFi is not accepting new activity right now, so FloFi stopped this request: it was not quoted, simulated or sent. Anything already sent stays tracked.":
    "A FloFi não está aceitando novas operações agora, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. O que já foi enviado continua sendo acompanhado.",
  "FloFi could not check your Flight access right now, so FloFi stopped this request: it was not quoted, simulated or sent. Try again in a moment.":
    "A FloFi não conseguiu verificar seu acesso ao Flight agora, por isso a FloFi interrompeu este pedido: ele não foi cotado, simulado nem enviado. Tente novamente em instantes.",
  // Board 08 (Confirm in wallet)
  'EXECUTION · REQUEST {0} OF {1}': 'EXECUÇÃO · PEDIDO {0} DE {1}', 'EXECUTION · REQUEST {0}': 'EXECUÇÃO · PEDIDO {0}',
  'Confirm in your wallet': 'Confirme na sua carteira', 'This request has 1 call:': 'Este pedido tem 1 chamada:',
  'This request has {0} calls:': 'Este pedido tem {0} chamadas:',
  'Token permission for step {0}': 'Permissão de token para o passo {0}', 'Swap on Uniswap (step {0})': 'Troca na Uniswap (passo {0})',
  'Supply on Aave (step {0})': 'Depósito no Aave (passo {0})', 'Borrow on Aave (step {0})': 'Empréstimo no Aave (passo {0})',
  'Repay on Aave (step {0})': 'Pagamento no Aave (passo {0})', 'Withdraw from Aave (step {0})': 'Saque do Aave (passo {0})',
  'Transfer (step {0})': 'Transferência (passo {0})', 'Call for step {0}': 'Chamada do passo {0}', 'Step {0}: {1}': 'Passo {0}: {1}',
  'This request also sends': 'Este pedido também envia',
  'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this request sends {6} {1} and its fee can reach {4} {1}, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.':
    'Toda transação na {0} paga uma taxa de rede em {1}. Sua carteira {2} tem {3} {1}; este pedido envia {6} {1} e a taxa pode chegar a {4} {1}, então faltam pelo menos {5} {1}. Envie um pouco de {1} na rede {0} para {2} e depois escolha Simular novamente. Nada foi enviado.',
  'Not enough ETH for the network fee': 'Falta ETH para a taxa de rede',
  "Your wallet does not hold enough of the network's native token for this request.": 'Sua carteira não tem o suficiente do token nativo da rede para este pedido.',
  'Anything already sent stays tracked.': 'O que já foi enviado continua sendo acompanhado.',
  'Add to workflow': 'Adicionar ao fluxo', 'Simulation valid': 'Simulação válida', 'Simulation expires in less than 15 seconds': 'A simulação expira em menos de 15 segundos',
  'Editing is paused while this workflow executes. You can change it once the run finishes or is ended.': 'A edição está pausada enquanto este fluxo é executado. Você pode alterá-lo quando a execução terminar ou for encerrada.',
  'Your workflow already has 1 step. A new request is added to it.': 'Seu fluxo já tem 1 passo. Um novo pedido é adicionado a ele.',
  'Your workflow already has {0} steps. A new request is added to it.': 'Seu fluxo já tem {0} passos. Um novo pedido é adicionado a ele.',
  'Sign in to FloFi': 'Entrar na FloFi',
  'You are not signed in to FloFi, so FloFi stopped this request. Sign in to continue; anything already sent stays tracked.':
    'Você não está conectado à FloFi, por isso a FloFi interrompeu este pedido. Entre para continuar; o que já foi enviado continua sendo acompanhado.',
  'Steps in this request:': 'Passos deste pedido:', 'This request has 1 call, for this step:': 'Este pedido tem 1 chamada, para este passo:',
  'This request has {0} calls, for these steps:': 'Este pedido tem {0} chamadas, para estes passos:',
  'Expiry check: the request is refused after its deadline': 'Verificação de prazo: o pedido é recusado depois do prazo',
};
