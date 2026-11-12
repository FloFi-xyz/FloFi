// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 approved UX (board 16 §4): Brazilian Portuguese for the shell, lifecycle, Review, blocker and execution copy, and the approved
 * terminology (workflow → fluxo). Spread LAST in `pt.ts`, so these entries also replace older European Portuguese forms of touched strings.
 */
export const portugueseApprovedUx: Readonly<Record<string, string>> = {
  // P0 Track A: bridge and liquidity refusals at Simulate (simulation-presentation.ts).
  "The provider does not have enough liquidity for this amount right now, so nothing was simulated or sent. Try a smaller amount or try again later.":
    "O provedor não tem liquidez suficiente para este valor agora, por isso nada foi simulado nem enviado. Tente um valor menor ou tente novamente mais tarde.",
  "The amount is below the bridge provider’s minimum for this route, so nothing was simulated or sent. Choose a larger amount, then simulate again.":
    "O valor está abaixo do mínimo do provedor da ponte para esta rota, por isso nada foi simulado nem enviado. Escolha um valor maior e simule novamente.",
  "No bridge route that FloFi can verify and execute is available for this amount right now, so nothing was simulated or sent. Try again later or change the amount.":
    "Nenhuma rota de ponte que a FloFi consiga verificar e executar está disponível para este valor agora, por isso nada foi simulado nem enviado. Tente novamente mais tarde ou altere o valor.",
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
  "This wallet is not linked to your FloFi account for Flight access, so FloFi stopped this request before quoting, simulating or sending anything. Save it in Credentials (you sign a message, never a transaction), then choose Board now on the Board page to add it to your access — or switch to a wallet you already linked.":
    "Esta carteira não está vinculada à sua conta FloFi para o acesso ao Flight, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. Salve-a em Credenciais (você assina uma mensagem, nunca uma transação) e depois toque em Embarcar agora na página do Board para adicioná-la ao seu acesso — ou troque para uma carteira que você já vinculou.",
  "Your FloFi account has no wallet linked for Flight access yet, so FloFi stopped this request before quoting, simulating or sending anything. Link the wallet you will sign with in Credentials, then choose Board now on the Board page.":
    "Sua conta FloFi ainda não tem uma carteira vinculada para o acesso ao Flight, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. Vincule em Credenciais a carteira com que você vai assinar e depois toque em Embarcar agora na página do Board.",
  "Your FloFi session ended, so FloFi stopped this request. Sign in again to continue; anything already sent stays tracked.":
    "Sua sessão na FloFi terminou, por isso a FloFi interrompeu este pedido. Entre novamente para continuar; o que já foi enviado continua sendo acompanhado.",
  "This FloFi account does not have active Flight access, so FloFi stopped this request before quoting, simulating or sending anything. Open the Board page to check your access.":
    "Esta conta FloFi não tem acesso ativo ao Flight, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. Abra a página do Board para verificar seu acesso.",
  "Flight access for this account has ended, so FloFi stopped this request before quoting, simulating or sending anything. Anything already sent stays tracked.":
    "O acesso ao Flight desta conta foi encerrado, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. O que já foi enviado continua sendo acompanhado.",
  "Boarding has not opened yet, so FloFi stopped this request before quoting, simulating or sending anything. Open the Board page to see when it opens.":
    "O embarque ainda não abriu, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. Abra a página do Board para ver quando ele abre.",
  "FloFi is not accepting new activity right now, so FloFi stopped this request before quoting, simulating or sending anything. Anything already sent stays tracked.":
    "A FloFi não está aceitando novas operações agora, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. O que já foi enviado continua sendo acompanhado.",
  "FloFi could not check your Flight access right now, so FloFi stopped this request before quoting, simulating or sending anything. Try again in a moment.":
    "A FloFi não conseguiu verificar seu acesso ao Flight agora, por isso a FloFi interrompeu este pedido antes de cotar, simular ou enviar qualquer coisa. Tente novamente em instantes.",
};
