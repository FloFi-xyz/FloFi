// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router — Canvas form, route discovery, Review, execution, recovery and
 * evidence. Provider, protocol, network and asset names stay as they are.
 */
export const portugueseUniversalBridge: Readonly<Record<string, string>> = {
  'Provider estimates': 'Estimativas dos provedores',
  'Live quote only · execution is not validated': 'Somente cotação real · execução não validada',
  'Builder verified · simulation and Review still required': 'Builder verificado · simulação e Revisão ainda necessárias',
  'Internal quote error': 'Falha interna na cotação',
  'An internal quote error occurred. Try again or use the support reference.': 'Ocorreu uma falha interna na cotação. Tente novamente ou use a referência de suporte.',
  'This quote expired. Request a fresh estimate.': 'Esta cotação expirou. Solicite uma nova estimativa.',
  '{0} entries excluded because display metadata is incomplete.': '{0} entradas excluídas por metadados de apresentação incompletos.',
  'Jupiter verified tokens. Mint identity and decimals are checked on chain at Simulate. A match does not guarantee a route.': 'Tokens verificados pelo Jupiter. O mint e as casas decimais são verificados na rede em Simular. Uma correspondência não garante uma rota.',
  'Support reference': 'Referência de suporte',
  'Below provider minimum': 'Abaixo do mínimo do provedor', 'Above provider maximum': 'Acima do máximo do provedor', 'Insufficient liquidity': 'Liquidez insuficiente',
  'The amount is below the provider minimum. Choose a larger amount or another provider.': 'O montante está abaixo do mínimo do provedor. Escolha um montante maior ou outro provedor.',
  'The amount is above the provider maximum. Choose a smaller amount or another provider.': 'O montante está acima do máximo do provedor. Escolha um montante menor ou outro provedor.',
  'The provider has insufficient liquidity for these assets and this amount. Try another provider or try again later.': 'O provedor não tem liquidez suficiente para estes ativos e montante. Escolha outro provedor ou tente mais tarde.',
  'The provider has no route for the requested networks and assets right now.': 'O provedor não tem uma rota para as redes e ativos pedidos neste momento.',
  'The provider or network service is unavailable. Try again shortly.': 'O provedor ou serviço da rede está indisponível. Tente novamente dentro de instantes.',
  'This quote needs transaction validation through the certified Router before execution.': 'Esta cotação exige validação da transação pelo Router certificado antes da execução.',
  'The source token approval reverted during simulation. Nothing was signed.': 'A aprovação do token de origem reverteu na simulação. Nada foi assinado.',
  'The network returned an invalid simulation response. Nothing was signed. Try another network service.': 'A rede devolveu uma resposta de simulação inválida. Nada foi assinado. Tente outro serviço de rede.',
  'The provider quote does not match the requested bridge or its verified transaction. Nothing was signed.': 'A cotação não corresponde à bridge pedida ou à transação verificada. Nada foi assinado.',
  'A quote may be available, but FloFi cannot yet verify this provider transaction for execution.': 'Pode existir uma cotação, mas a FloFi ainda não consegue verificar esta transação do provedor para execução.',
  // Canvas form
  'through the universal Cross-chain Router · real funds · a fresh route, simulation and Review are required after changes.':
    'pelo Router cross-chain universal · fundos reais · após alterações são necessárias uma nova rota, simulação e Revisão.',
  'Edit universal bridge': 'Editar bridge universal', 'Create universal bridge': 'Criar bridge universal',
  'Universal Cross-chain Router · any FloFi mainnet to any other · real funds. Routes are discovered live; the one you authorize is shown at Review.':
    'Router cross-chain universal · de qualquer mainnet do FloFi para qualquer outra · fundos reais. As rotas são descobertas em tempo real; a que autorizar é mostrada na Revisão.',
  'Source network': 'Rede de origem', 'Universal bridge source network': 'Rede de origem da bridge universal',
  'Source asset': 'Ativo de origem', 'Universal bridge source asset': 'Ativo de origem da bridge universal',
  'Destination network': 'Rede de destino', 'Universal bridge destination network': 'Rede de destino da bridge universal',
  'Destination asset': 'Ativo de destino', 'Universal bridge destination asset': 'Ativo de destino da bridge universal',
  'Any asset by symbol, or a contract / mint written as address@decimals (verified on chain at Simulate).':
    'Qualquer ativo pelo símbolo, ou um contrato / mint escrito como endereço@decimais (verificado na rede ao Simular).',
  'Universal bridge amount': 'Montante da bridge universal', 'Universal bridge recipient': 'Destinatário da bridge universal',
  'Your connected destination wallet': 'A sua carteira de destino ligada', 'Universal bridge routing': 'Encaminhamento da bridge universal',
  'Universal bridge slippage (bps)': 'Desvio da bridge universal (bps)',
  'The guaranteed minimum you receive is fixed in the reviewed provider order. Provider fees are listed at Review. FloFi records a 0.1% fee obligation on each completed workflow; collection is not settled on-chain yet.':
    'O mínimo garantido que recebe fica fixado na ordem do fornecedor que reviu. As taxas do fornecedor são listadas na Revisão. O FloFi regista uma obrigação de taxa de 0,1% em cada workflow concluído; a cobrança ainda não é liquidada on-chain.',
  'Automatic: the executable route with the highest guaranteed minimum': 'Automático: a rota executável com o maior mínimo garantido',
  'Relay only': 'Só Relay', 'LI.FI only (quotes; execution not available yet)': 'Só LI.FI (cotações; execução ainda indisponível)',
  'Mayan only (quotes; execution not available yet)': 'Só Mayan (cotações; execução ainda indisponível)', 'Across only (certified Router pairs)': 'Só Across (pares certificados do Router)',
  // Route discovery
  'Routes found': 'Rotas encontradas', 'Find routes': 'Procurar rotas',
  'Every provider was asked about this pair. Executable routes are verified by FloFi; others are shown with the reason they cannot be executed.':
    'Todos os fornecedores foram consultados sobre este par. As rotas executáveis são verificadas pelo FloFi; as outras são mostradas com o motivo pelo qual não podem ser executadas.',
  'Indicative quotes for a public address. Simulate quotes again for your own wallet.': 'Cotações indicativas para um endereço público. Simular cota de novo para a sua própria carteira.',
  'Route options': 'Opções de rota', 'Note': 'Nota', '· recommended': '· recomendada',
  'Executes on the certified Router bridge for this pair.': 'Executa na bridge certificada do Router para este par.', 'Use this route': 'Usar esta rota',
  'Executable': 'Executável', 'Live quote only': 'Só cotação em tempo real', 'Supported, no quote': 'Suportado, sem cotação', 'Temporarily unavailable': 'Temporariamente indisponível',
  'No route': 'Sem rota',
  'FloFi cannot yet verify this bridge\'s transactions independently, so it is shown for comparison only.':
    'O FloFi ainda não consegue verificar de forma independente as transações desta bridge, por isso é mostrada só para comparação.',
  'Mayan transactions are built by its SDK; FloFi has no verified builder yet, so this quote is for comparison only.':
    'As transações da Mayan são construídas pelo seu SDK; o FloFi ainda não tem um construtor verificado, por isso esta cotação serve só para comparação.',
  'Across executes through the certified Router for its USDC/USDG pairs only.': 'A Across executa através do Router certificado apenas para os seus pares USDC/USDG.',
  'Across has no route for this network.': 'A Across não tem rota para esta rede.', 'Mayan does not serve this network.': 'A Mayan não serve esta rede.',
  'The provider has no route or liquidity for this pair right now.': 'O fornecedor não tem rota nem liquidez para este par neste momento.',
  'The amount is below the provider minimum.': 'O montante está abaixo do mínimo do fornecedor.', 'The amount is above the provider maximum.': 'O montante está acima do máximo do fornecedor.',
  'The provider could not be reached. Try again shortly.': 'Não foi possível contactar o fornecedor. Tente de novo dentro de momentos.',
  'The provider is rate limiting requests. Try again shortly.': 'O fornecedor está a limitar pedidos. Tente de novo dentro de momentos.',
  'LI.FI has no route for this pair right now.': 'A LI.FI não tem rota para este par neste momento.', 'Mayan has no route for this pair right now.': 'A Mayan não tem rota para este par neste momento.',
  // Panel, Review and execution
  'Universal cross-chain bridge': 'Bridge cross-chain universal', 'Simulate universal bridge': 'Simular bridge universal', 'Review universal bridge': 'Rever bridge universal',
  'from': 'de', ', receiving': ', recebendo',
  'Real funds. FloFi never signs: your source wallet signs every transaction after your Review. FloFi records a 0.1% fee obligation when the workflow completes; provider fees are shown below.':
    'Fundos reais. O FloFi nunca assina: a sua carteira de origem assina cada transação depois da sua Revisão. O FloFi regista uma obrigação de taxa de 0,1% quando o workflow conclui; as taxas do fornecedor são mostradas abaixo.',
  'Source wallet:': 'Carteira de origem:', 'destination wallet:': 'carteira de destino:', 'Connect wallets': 'Ligar carteiras',
  'Sign in with source wallet': 'Iniciar sessão com a carteira de origem', 'Switch wallet to the source network': 'Mudar a carteira para a rede de origem',
  'order': 'ordem', 'Selection': 'Seleção', 'selected': 'selecionada', 'available': 'disponível', 'not executable': 'não executável', 'refused': 'recusada',
  'You send': 'Envia', 'Expected to receive': 'Recebimento esperado', 'Guaranteed minimum': 'Mínimo garantido',
  '— fixed in the provider order; a smaller delivery is a mismatch': '— fixado na ordem do fornecedor; uma entrega menor é uma divergência',
  'Provider fees': 'Taxas do fornecedor', '(included in the quote)': '(incluída na cotação)', '(paid separately)': '(paga à parte)', 'none listed': 'nenhuma listada',
  'FloFi fee': 'Taxa do FloFi',
  '0.1% of the completed workflow input — obligation recorded at reconciliation; not collected on-chain yet.':
    '0,1% do input do workflow concluído — obrigação registada na reconciliação; ainda não cobrada on-chain.',
  'after the deposit confirms (provider estimate)': 'após a confirmação do depósito (estimativa do fornecedor)',
  'Signatures': 'Assinaturas', 'wallet signature on the source network': 'assinatura da carteira na rede de origem',
  'wallet signatures on the source network (an exact approval, then the deposit)': 'assinaturas da carteira na rede de origem (uma aprovação exata e depois o depósito)',
  '; nothing to sign on the destination network.': '; nada a assinar na rede de destino.',
  'Approval: exactly the amount, never unlimited, to the Relay Depository': 'Aprovação: exatamente o montante, nunca ilimitada, para o Relay Depository',
  'Existing allowance is sufficient; no approval': 'A autorização existente é suficiente; sem aprovação', '(your connected wallet)': '(a sua carteira ligada)',
  'Refunds': 'Reembolsos', 'If the order is not filled, the provider refunds to': 'Se a ordem não for executada, o fornecedor reembolsa para', 'debit': 'débito',
  '. Not simulated: the destination delivery and refunds.': '. Não simulado: a entrega no destino e os reembolsos.',
  'Review valid': 'Revisão válida',
  'Accepting authorizes only the wallet requests listed in this Review. Each request still needs your signature.':
    'Aceitar autoriza apenas os pedidos à carteira listados nesta Revisão. Cada pedido continua a precisar da sua assinatura.',
  'Execute with your wallet': 'Executar com a sua carteira', 'Source transactions': 'Transações de origem', 'Deposit confirmed on': 'Depósito confirmado em',
  '(final)': '(final)', 'Delivery observed on': 'Entrega observada em', 'arrived (guaranteed minimum': 'chegaram (mínimo garantido',
  '). Verified on both chains.': '). Verificado nas duas redes.', 'Your universal bridge runs': 'As suas execuções de bridge universal',
  // Route changes after Review
  'chain': 'rede', 'token': 'token', 'amount': 'montante', 'recipient': 'destinatário', 'depositor': 'depositante', 'refund address': 'endereço de reembolso',
  'provider': 'fornecedor', 'protocol': 'protocolo', 'route steps': 'passos da rota', 'fees': 'taxas', 'fee recipient': 'destinatário das taxas',
  'lower expected delivery': 'entrega esperada menor', 'slippage': 'desvio', 'approval': 'aprovação', 'transaction target': 'destino da transação',
  'transaction function': 'função da transação', 'value': 'valor', 'bridge contract': 'contrato da bridge', 'destination message': 'mensagem de destino', 'calldata': 'calldata',
  'quote': 'cotação', 'deadline': 'prazo',
  // Server outcomes
  'The universal Cross-chain Router is not enabled on this server.': 'O Router cross-chain universal não está ativado neste servidor.',
  'Execution storage is not configured on this server.': 'O armazenamento de execuções não está configurado neste servidor.',
  'Owner execution is not enabled on this server. Route discovery, quotes, simulation and Review remain read-only.':
    'A execução pelo dono não está ativada neste servidor. A descoberta de rotas, as cotações, a simulação e a Revisão continuam só de leitura.',
  'Connect your Solana wallet first.': 'Ligue primeiro a sua carteira Solana.',
  'Connect your wallet on the destination network, or enter a recipient address in the bridge.': 'Ligue a sua carteira na rede de destino, ou indique um endereço de destinatário na bridge.',
  'Switch your wallet to the source network.': 'Mude a sua carteira para a rede de origem.', 'Select the wallet account shown in Review.': 'Selecione a conta da carteira mostrada na Revisão.',
  'Accept the current Review first.': 'Aceite primeiro a Revisão atual.', 'This Review expired. Get a fresh route and review again.': 'Esta Revisão expirou. Obtenha uma nova rota e reveja de novo.',
  'The provider no longer offers the reviewed route. Your authorization was cleared and nothing was sent. Get a fresh route, then review it.':
    'O fornecedor já não oferece a rota revista. A sua autorização foi limpa e nada foi enviado. Obtenha uma nova rota e depois reveja-a.',
  'A fresh route and Review are required before you can authorize again.': 'São necessárias uma nova rota e uma nova Revisão antes de poder autorizar de novo.',
  'Chain state changed materially since Review. Your authorization was cleared and nothing was sent.':
    'O estado da rede mudou de forma relevante desde a Revisão. A sua autorização foi limpa e nada foi enviado.',
  'The provider could not confirm the reviewed route right now. Nothing was sent; try again shortly.': 'O fornecedor não conseguiu confirmar a rota revista neste momento. Nada foi enviado; tente de novo dentro de momentos.',
  'No provider returned a route FloFi can verify and execute for this bridge. See the routes found for the reasons.':
    'Nenhum fornecedor devolveu uma rota que o FloFi consiga verificar e executar para esta bridge. Veja os motivos nas rotas encontradas.',
  'Your wallet needs more of the source asset for this bridge.': 'A sua carteira precisa de mais do ativo de origem para esta bridge.',
  'Your wallet needs more native coin on the source network for network fees.': 'A sua carteira precisa de mais moeda nativa na rede de origem para as taxas de rede.',
  'Your Solana wallet needs more SOL for the network fee.': 'A sua carteira Solana precisa de mais SOL para a taxa de rede.',
  'The network provider cannot simulate this transaction right now. Nothing was signed.': 'O fornecedor da rede não consegue simular esta transação neste momento. Nada foi assinado.',
  'The simulation of the bridge deposit failed. Nothing was signed.': 'A simulação do depósito da bridge falhou. Nada foi assinado.',
  'A bridge contract does not match its verified deployment. Nothing was signed.': 'Um contrato da bridge não corresponde à sua implementação verificada. Nada foi assinado.',
  'An earlier request from this wallet is still open in your wallet and holds the next transaction slot. Confirm or reject it, then try again.':
    'Um pedido anterior desta carteira ainda está aberto na sua carteira e ocupa a próxima posição de transação. Confirme-o ou rejeite-o e tente de novo.',
  'This exact provider order is already handled by another FloFi run. Get a new route for a separate bridge.':
    'Esta mesma ordem do fornecedor já é tratada por outra execução do FloFi. Obtenha uma nova rota para uma bridge separada.',
  'A transaction is still being observed. Check it before continuing.': 'Uma transação ainda está a ser observada. Verifique-a antes de continuar.',
  'The wallet result is unknown. FloFi is observing the network and will not send another request.': 'O resultado da carteira é desconhecido. O FloFi está a observar a rede e não enviará outro pedido.',
  'You declined the request in your wallet. Nothing was sent.': 'Recusou o pedido na sua carteira. Nada foi enviado.',
  'Your wallet returned a different transaction than the reviewed one. It was not broadcast.': 'A sua carteira devolveu uma transação diferente da revista. Ela não foi transmitida.',
  'The transaction is pending on the source network.': 'A transação está pendente na rede de origem.',
  'No transaction is visible yet. Observe again; nothing will be resent.': 'Ainda não há nenhuma transação visível. Observe de novo; nada será reenviado.',
  'The deposit is waiting for finality on the source network.': 'O depósito aguarda finalidade na rede de origem.',
  'The deposit is confirmed. Waiting for the delivery on the destination network.': 'O depósito está confirmado. A aguardar a entrega na rede de destino.',
  'The delivery is taking longer than expected. FloFi keeps observing and will verify a late delivery or a refund.':
    'A entrega está a demorar mais do que o esperado. O FloFi continua a observar e verificará uma entrega tardia ou um reembolso.',
  'The provider reported a failure. A refund is expected; FloFi will verify it on chain.': 'O fornecedor reportou uma falha. É esperado um reembolso; o FloFi irá verificá-lo na rede.',
  'Waiting for the refund to be visible on chain.': 'A aguardar que o reembolso fique visível na rede.',
  'The delivery is observed. Waiting for finality before success.': 'A entrega foi observada. A aguardar finalidade antes do sucesso.',
  'The delivery is below the reviewed minimum. The run needs your attention.': 'A entrega está abaixo do mínimo revisto. A execução precisa da sua atenção.',
  'The referenced delivery did not credit the reviewed recipient. The run needs your attention.': 'A entrega referida não creditou o destinatário revisto. A execução precisa da sua atenção.',
  'The delivery could not be verified independently yet. FloFi keeps observing.': 'Ainda não foi possível verificar a entrega de forma independente. O FloFi continua a observar.',
  'The deposit reverted on the source network; nothing was bridged.': 'O depósito foi revertido na rede de origem; nada foi transferido pela bridge.',
  'The transaction expired without executing. Nothing was bridged. Get a fresh route to try again.': 'A transação expirou sem ser executada. Nada foi transferido pela bridge. Obtenha uma nova rota para tentar de novo.',
  'Sign in with your wallet first. Signing in moves no funds and authorizes no transaction.': 'Inicie primeiro sessão com a sua carteira. Iniciar sessão não move fundos nem autoriza nenhuma transação.',
  'This run belongs to another wallet. Only the wallet that created it can open or continue it.': 'Esta execução pertence a outra carteira. Só a carteira que a criou a pode abrir ou continuar.',
};
