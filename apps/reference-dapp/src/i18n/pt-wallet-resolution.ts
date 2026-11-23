// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: a bridge's receiving wallet (missing, a choice pending, still loading, invalid), wallet sessions,
 * wallet networks and quote-only providers, each named for what it is instead of "connect the wallet that will sign".
 */
export const portugueseWalletResolution: Readonly<Record<string, string>> = {
  // simulationError
  'Choose the wallet that receives the funds on the destination network, or enter its public address, then simulate again. Your source wallet does not need to change. Nothing was signed or sent.':
    'Escolha a carteira que recebe os fundos na rede de destino ou informe o endereço público dela, e simule de novo. A sua carteira de origem não precisa mudar. Nada foi assinado ou enviado.',
  'More than one of your wallets can receive on the destination network. Choose one on the Bridge card, or enter its public address, then simulate again. Nothing was signed or sent.':
    'Mais de uma das suas carteiras pode receber na rede de destino. Escolha uma no card de Bridge, ou informe o endereço público dela, e simule de novo. Nada foi assinado ou enviado.',
  'FloFi is still reading your wallets for the destination network. Try again in a moment. Nothing was signed or sent.':
    'A FloFi ainda está verificando as suas carteiras para a rede de destino. Tente de novo em instantes. Nada foi assinado ou enviado.',
  'The destination wallet is not a valid address on the destination network. Check it on the Bridge card, then simulate again. Nothing was signed or sent.':
    'A carteira de destino não é um endereço válido na rede de destino. Confira no card de Bridge e simule de novo. Nada foi assinado ou enviado.',
  'Your wallet sign-in expired. Simulate again and sign the sign-in message; it moves no funds and authorizes no transaction. Nothing was signed or sent.':
    'O acesso com a sua carteira expirou. Simule de novo e assine a mensagem de acesso; ela não move fundos nem autoriza transações. Nada foi assinado ou enviado.',
  'Your wallet is on another network than this step\'s source network. Switch your wallet to the source network, then try again. Nothing was signed or sent.':
    'A sua carteira está em uma rede diferente da rede de origem desta etapa. Troque a carteira para a rede de origem e tente de novo. Nada foi assinado ou enviado.',
  'The selected bridge provider is shown for comparison only: FloFi cannot verify and execute its route yet. Choose Automatic routing, then simulate again. Nothing was signed or sent.':
    'O provedor de bridge selecionado aparece apenas para comparação: a FloFi ainda não consegue verificar e executar a rota dele. Escolha o roteamento Automático e simule de novo. Nada foi assinado ou enviado.',
  // Shared gate (Simulate, Canvas and chat), with the destination network.
  'You have more than one wallet on {0}. Choose the one that receives the funds, or enter its public address. Nothing was signed or sent.':
    'Você tem mais de uma carteira em {0}. Escolha a que recebe os fundos ou informe o endereço público dela. Nada foi assinado ou enviado.',
  'FloFi is still reading your wallets for {0}. Try again in a moment, or enter the destination\'s public address. Nothing was signed or sent.':
    'A FloFi ainda está verificando as suas carteiras para {0}. Tente de novo em instantes ou informe o endereço público de destino. Nada foi assinado ou enviado.',
  'Across runs through FloFi\'s certified Router bridge for its own supported pairs, not through this bridge. Choose Automatic routing, then simulate again. Nothing was signed or sent.':
    'A Across é executada pela bridge certificada do Router da FloFi nos pares que ela atende, não por esta bridge. Escolha o roteamento Automático e simule de novo. Nada foi assinado ou enviado.',
  // Destination wallet field.
  'Required: a wallet that can receive on {0} ({1} address). Connect one or enter its public address.':
    'Obrigatório: uma carteira que receba em {0} (endereço {1}). Conecte uma ou informe o endereço público dela.',
  'No wallet was connected. You can enter its public address instead.': 'Nenhuma carteira foi conectada. Você pode informar o endereço público dela.',
  'No {1} wallet can receive on {0} yet. Connect one on the Bridge card or enter its public address. Nothing was signed or sent.':
    'Ainda não há uma carteira {1} para receber em {0}. Conecte uma no card de Bridge ou informe o endereço público dela. Nada foi assinado ou enviado.',
  'Choose which of your {1} wallets receives on {0}, or enter its public address.':
    'Escolha qual das suas carteiras {1} recebe em {0} ou informe o endereço público dela.',
  'Checking your wallets for {0}…': 'Verificando as suas carteiras para {0}…',
  'Connect a Solana wallet': 'Conectar uma carteira Solana',
  'Destination wallet needed': 'Carteira de destino necessária',
  'Connect an EVM wallet': 'Conectar uma carteira EVM',
  // BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: the account's wallets could not be read (after FloFi's own retry), never "you have none".
  'FloFi could not read your account’s wallets for the destination network. Try again, or enter the destination’s public address, then simulate again. Nothing was signed or sent.':
    'A FloFi não conseguiu ler as carteiras da sua conta para a rede de destino. Tente novamente ou informe o endereço público de destino, e simule de novo. Nada foi assinado ou enviado.',
  'FloFi could not read which {1} wallets your account has for {0}. Choose one of your wallets or Try again on the Bridge card, or enter the destination’s public address. Nothing was signed or sent.':
    'A FloFi não conseguiu ler quais carteiras {1} a sua conta tem para {0}. Escolha uma das suas carteiras ou Tentar novamente no card de Bridge, ou informe o endereço público de destino. Nada foi assinado nem enviado.',
  'FloFi could not read which {1} wallets your account has for {0}. Try again, connect one, or enter its public address.':
    'A FloFi não conseguiu ler quais carteiras {1} a sua conta tem para {0}. Tente novamente, conecte uma ou informe o endereço público dela.',
  'FloFi could not read which {1} wallets your account has for {0}. Choose one of your wallets, try again, or enter its public address.':
    'A FloFi não conseguiu ler quais carteiras {1} a sua conta tem para {0}. Escolha uma das suas carteiras, tente novamente ou informe o endereço público dela.',
  // /approve (no Bridge card here): one message per reason, with what can be done on this page. `{2}`: the wallet to connect, with its article.
  'a Solana wallet': 'uma carteira Solana', 'an EVM wallet': 'uma carteira EVM',
  'To receive the tokens on {0}, connect {2} here, or open the Canvas to enter its public address. Nothing was signed or sent.':
    'Para receber os tokens em {0}, conecte {2} aqui ou abra o Canvas para informar o endereço público dela. Nada foi assinado nem enviado.',
  'You have more than one {1} wallet that can receive on {0}. Connect the one that receives the tokens here, or open the Canvas to choose it or to enter its public address. Nothing was signed or sent.':
    'Você tem mais de uma carteira {1} que pode receber em {0}. Conecte aqui a que recebe os tokens ou abra o Canvas para escolhê-la ou informar o endereço público dela. Nada foi assinado nem enviado.',
  'FloFi is reading your wallets for {0}. This page continues by itself when they are read. Nothing was signed or sent.':
    'A FloFi está lendo as suas carteiras para {0}. Esta página continua sozinha quando elas forem lidas. Nada foi assinado nem enviado.',
  'FloFi could not read which {1} wallets your account has for {0}. Try again, connect {2} here, or open the Canvas to choose one or to enter its public address. Nothing was signed or sent.':
    'A FloFi não conseguiu ler quais carteiras {1} a sua conta tem para {0}. Tente novamente, conecte {2} aqui ou abra o Canvas para escolher uma ou informar o endereço público dela. Nada foi assinado nem enviado.',
  // The embedded MCP approval: no Canvas to open.
  'To receive the tokens on {0}, connect {2} here. Nothing was signed or sent.': 'Para receber os tokens em {0}, conecte {2} aqui. Nada foi assinado nem enviado.',
  'You have more than one {1} wallet that can receive on {0}. Connect the one that receives the tokens here. Nothing was signed or sent.':
    'Você tem mais de uma carteira {1} que pode receber em {0}. Conecte aqui a que recebe os tokens. Nada foi assinado nem enviado.',
  'FloFi could not read which {1} wallets your account has for {0}. Try again, or connect the one that receives the tokens here. Nothing was signed or sent.':
    'A FloFi não conseguiu ler quais carteiras {1} a sua conta tem para {0}. Tente novamente ou conecte aqui a que recebe os tokens. Nada foi assinado nem enviado.',
  'No wallet was connected.': 'Nenhuma carteira foi conectada.',
  'Checking your wallets': 'Verificando suas carteiras',
  'No wallet was connected. You can still open the Canvas to enter its public address.':
    'Nenhuma carteira foi conectada. Você ainda pode abrir o Canvas para informar o endereço público dela.',
};
