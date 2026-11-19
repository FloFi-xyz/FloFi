// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): a Review that expired (or no longer stood) before the next wallet request of a
 * liquidity run, refreshed in place with its confirmed steps kept. New keys only.
 */
export const portugueseLiquidityExecution: Readonly<Record<string, string>> = {
  'Your Review expired before FloFi asked your wallet for the next request, so nothing more was sent. The confirmed steps stay recorded and are not repeated. Simulate again to refresh the Review of the same run, then authorize it to continue.':
    'Sua revisão expirou antes de a FloFi pedir o próximo pedido à sua carteira, então nada mais foi enviado. As etapas confirmadas continuam registradas e não são repetidas. Simule de novo para atualizar a revisão da mesma execução e autorize-a para continuar.',
  'Your Review expired before FloFi asked your wallet, so nothing was sent. Simulate again to refresh the Review, then authorize it to continue.':
    'Sua revisão expirou antes de a FloFi pedir à sua carteira, então nada foi enviado. Simule de novo para atualizar a revisão e autorize-a para continuar.',
  'Your Review expired before FloFi asked your wallet, so nothing was sent. FloFi refreshed the simulation and Review of the same position; anything already confirmed is kept and not repeated. Check it and authorize again to continue.':
    'Sua revisão expirou antes de a FloFi pedir à sua carteira, então nada foi enviado. A FloFi atualizou a simulação e a revisão da mesma posição; o que já foi confirmado é mantido e não se repete. Confira e autorize de novo para continuar.',
  'The pool or the network fee changed after your Review, so nothing was sent. FloFi refreshed the simulation and Review of the same position; anything already confirmed is kept and not repeated. Check it and authorize again to continue.':
    'O pool ou a taxa de rede mudou depois da sua revisão, então nada foi enviado. A FloFi atualizou a simulação e a revisão da mesma posição; o que já foi confirmado é mantido e não se repete. Confira e autorize de novo para continuar.',
  'Your Review expired before FloFi asked your wallet, so nothing was sent. Simulate again to refresh the Review of the same run, then authorize it to continue. Anything already confirmed stays recorded and is not repeated.':
    'Sua revisão expirou antes de a FloFi pedir à sua carteira, então nada foi enviado. Simule de novo para atualizar a revisão da mesma execução e autorize-a para continuar. O que já foi confirmado continua registrado e não se repete.',
  'An earlier wallet request was not sent and the Review was refreshed. Check the updated Review and authorize it again.':
    'Um pedido anterior à carteira não foi enviado e a revisão foi atualizada. Confira a revisão atualizada e autorize-a de novo.',
  'The Review expired before the wallet request': 'A revisão expirou antes do pedido à carteira',
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: managing an existing position (collect, remove, close) — Review, panels, Dashboard and refusals.
  'Prepared from your position. Change it from the Dashboard or in chat; Simulate shows the exact Review.':
    'Preparado a partir da sua posição. Altere pelo Painel ou no chat; a simulação mostra a revisão exata.',
  'Liquidity remaining': 'Liquidez restante',
  'Minimum principal (enforced)': 'Capital mínimo (garantido na rede)',
  'Minimum principal': 'Capital mínimo',
  'Owed tokens and fees': 'Tokens devidos e taxas',
  'Owed tokens and fees (recorded)': 'Tokens devidos e taxas (registrados)',
  'Collected, at least': 'Coletado, no mínimo',
  'Fees collected, at least': 'Taxas coletadas, no mínimo',
  'Collected (owed tokens and fees included)': 'Coletado (tokens devidos e taxas incluídos)',
  'Collected (owed tokens and fees included) · Token 1': 'Coletado (tokens devidos e taxas incluídos) · Token 1',
  'Collected (owed tokens and fees included) · Token 2': 'Coletado (tokens devidos e taxas incluídos) · Token 2',
  'Principal returned · Token 1': 'Capital devolvido · Token 1',
  'Principal returned · Token 2': 'Capital devolvido · Token 2',
  'Tokens returned': 'Tokens devolvidos',
  'Position NFT': 'NFT da posição',
  'Position Manager': 'Gerenciador de posições (Position Manager)',
  'Burned (closed)': 'Queimado (posição fechada)',
  'Stays in your wallet': 'Continua na sua carteira',
  'None (collect only)': 'Nenhum (somente coleta)',
  'In range': 'Dentro da faixa',
  'Out of range (below)': 'Fora da faixa (abaixo)',
  'Out of range (above)': 'Fora da faixa (acima)',
  'Range state unavailable': 'Estado da faixa indisponível',
  'Collect fees (liquidity unchanged)': 'Coletar taxas (liquidez inalterada)',
  'Collect owed tokens and fees (liquidity unchanged)': 'Coletar tokens devidos e taxas (liquidez inalterada)',
  "Remove part of the position's liquidity and collect fees": 'Remover parte da liquidez da posição e coletar as taxas',
  "Remove part of the position's liquidity and collect": 'Remover parte da liquidez da posição e coletar',
  'Remove all liquidity, collect fees and close the position; the position NFT is closed and its account rent is refunded':
    'Remover toda a liquidez, coletar as taxas e fechar a posição; o NFT da posição é fechado e o aluguel (rent) da conta é devolvido',
  'Remove all liquidity, collect and close the position (burns the NFT)': 'Remover toda a liquidez, coletar e fechar a posição (queima o NFT)',
  'Remove all liquidity and collect (the position NFT stays in your wallet)': 'Remover toda a liquidez e coletar (o NFT da posição continua na sua carteira)',
  'Collect fees': 'Coletar taxas',
  'Close position': 'Fechar posição',
  'Remove all liquidity': 'Remover toda a liquidez',
  'Remove liquidity': 'Remover liquidez',
  'The collected amount is a lower bound: you receive at least the amount shown; fees accrued until execution are also collected.':
    'O valor coletado é um mínimo: você recebe pelo menos o valor mostrado; as taxas acumuladas até a execução também são coletadas.',
  'Owed tokens and fees can include principal withdrawn earlier and not collected; they are not only trading fees.':
    'Tokens devidos e taxas podem incluir capital retirado antes e ainda não coletado; não são apenas taxas de negociação.',
  "Tokens are returned to your wallet as the pool's own tokens; nothing is swapped or unwrapped.":
    'Os tokens voltam para a sua carteira como os próprios tokens do pool; nada é trocado nem convertido (unwrap).',
  "Tokens are returned to your wallet as the pool's own tokens; wrapped SOL is closed back to SOL in the same transaction.":
    'Os tokens voltam para a sua carteira como os próprios tokens do pool; o SOL embrulhado (wrapped) volta a ser SOL na mesma transação.',
  'The withdrawal reverts on chain if the principal returned is below the enforced minimum (your slippage limit).':
    'A retirada é revertida na rede se o capital devolvido ficar abaixo do mínimo garantido (seu limite de slippage).',
  'Closing burns the position NFT. This cannot be undone.': 'Fechar queima o NFT da posição. Isso não pode ser desfeito.',
  'The position is out of range: it earns no fees until the price returns to its range.': 'A posição está fora da faixa: ela não rende taxas até o preço voltar para a faixa.',
  'This uses real funds. One wallet request to the Uniswap Position Manager; FloFi never signs or sends.':
    'Isto usa fundos reais. Um único pedido à carteira para o Position Manager da Uniswap; a FloFi nunca assina nem envia.',
  'This uses real funds. One wallet request; FloFi never signs or sends.': 'Isto usa fundos reais. Um único pedido à carteira; a FloFi nunca assina nem envia.',
  'What happens': 'O que acontece',
  "At least the simulated amount; fees accrued until execution are also collected. Tokens return as the pool's own tokens.":
    'Pelo menos o valor simulado; as taxas acumuladas até a execução também são coletadas. Os tokens voltam como os próprios tokens do pool.',
  'collection': 'coleta',
  'Uniswap position': 'Posição Uniswap',
  'Simulate position operation': 'Simular operação da posição',
  'Review position operation': 'Revisar operação da posição',
  'Position operation review': 'Revisão da operação da posição',
  'Position operation notices': 'Avisos da operação da posição',
  'Execute in wallet': 'Executar na carteira',
  'Position transactions': 'Transações da posição',
  'Position result': 'Resultado da posição',
  'Empty (no liquidity)': 'Vazia (sem liquidez)',
  'Principal': 'Capital',
  'Collectable now': 'Coletável agora',
  'Last verified': 'Última verificação',
  'FloFi cannot verify this pool, so it cannot prepare actions for this position.': 'A FloFi não consegue verificar este pool, então não pode preparar ações para esta posição.',
  'This position token type is not managed by FloFi.': 'Este tipo de token de posição não é gerenciado pela FloFi.',
  'This position token is delegated, so FloFi does not manage it.': 'Este token de posição está delegado, então a FloFi não o gerencia.',
  'This pool emits rewards FloFi does not model yet, so it cannot prepare actions for this position.':
    'Este pool emite recompensas que a FloFi ainda não modela, então não pode preparar ações para esta posição.',
  'FloFi cannot prepare actions for this position.': 'A FloFi não pode preparar ações para esta posição.',
  'Position actions': 'Ações da posição',
  'Share of liquidity to remove': 'Parte da liquidez a remover',
  'Share to remove': 'Parte a remover',
  '100% (keep the position NFT)': '100% (manter o NFT da posição)',
  'Prepare removal': 'Preparar remoção',
  'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here.':
    'Estas ações apenas preparam o fluxo. Você o revisa e confirma na sua carteira; nada é executado aqui.',
  'These actions prepare the workflow only. You review it and confirm in your wallet; nothing is executed here. Closing an Orca position refunds its account rent.':
    'Estas ações apenas preparam o fluxo. Você o revisa e confirma na sua carteira; nada é executado aqui. Fechar uma posição Orca devolve o aluguel (rent) da conta.',
  'Your current workflow has other steps. Start a new workflow for this position; the current one stays in your history if you saved it.':
    'Seu fluxo atual tem outras etapas. Inicie um novo fluxo para esta posição; o atual continua no seu histórico se você o salvou.',
  'Start a new workflow': 'Iniciar um novo fluxo',
  'This position could not be prepared. Nothing was simulated or sent. Refresh the positions and try again.':
    'Não foi possível preparar esta posição. Nada foi simulado nem enviado. Atualize as posições e tente de novo.',
  'This position has nothing to collect right now, so nothing was simulated or sent.': 'Esta posição não tem nada para coletar agora, então nada foi simulado nem enviado.',
  'This position has no liquidity left to remove, so nothing was simulated or sent.': 'Esta posição não tem mais liquidez para remover, então nada foi simulado nem enviado.',
  'The connected wallet does not own this position (it may have moved), so nothing was simulated or sent. Refresh your positions.':
    'A carteira conectada não é dona desta posição (ela pode ter sido transferida), então nada foi simulado nem enviado. Atualize suas posições.',
  'Another operation on this position is still being executed or checked. Wait for it to finish; nothing was sent.':
    'Outra operação nesta posição ainda está sendo executada ou verificada. Aguarde a conclusão; nada foi enviado.',
  'This position operation already completed and is never repeated. Refresh your positions before preparing another.':
    'Esta operação da posição já foi concluída e nunca é repetida. Atualize suas posições antes de preparar outra.',
  'This position no longer exists on this network, so nothing was simulated or sent. Refresh your positions.':
    'Esta posição não existe mais nesta rede, então nada foi simulado nem enviado. Atualize suas posições.',
  'Choose the position operation again from your positions. Nothing was simulated or sent.': 'Escolha de novo a operação nas suas posições. Nada foi simulado nem enviado.',
};
