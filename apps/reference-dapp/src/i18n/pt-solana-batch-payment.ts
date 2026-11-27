// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20): a Solana Batch Payment run in the Editor and on /approve, pt-BR — its wallet request, network
 * fee and token-account deposits, the fee-shortfall rows, the Solana wallet it needs, and its refusals (the core's families and the earlier request of
 * C.4). New keys only (the card's authoring copy is in `pt-batch-payment.ts`).
 */
export const portugueseSolanaBatchPayment: Readonly<Record<string, string>> = {
  // How the group is authorized, and its network fee (Editor Review, Editor run and /approve).
  'One Solana signing request for one atomic transaction': 'Um pedido de assinatura Solana para uma única transação atômica',
  'about {0} in network fees, plus up to {1} in deposits for recipients who need a token account; your wallet pays both in SOL':
    'cerca de {0} em taxas de rede, mais até {1} em depósitos para destinatários que precisam de uma conta de token; sua carteira paga ambos em SOL',
  'about {0} in network fees; your wallet pays it in SOL': 'cerca de {0} em taxas de rede; sua carteira paga em SOL',
  'up to {0} in network fees and account deposits; your wallet pays it in SOL': 'até {0} em taxas de rede e depósitos de contas; sua carteira paga em SOL',
  'Includes up to {0} in deposits for recipients who need a token account.': 'Inclui até {0} em depósitos para destinatários que precisam de uma conta de token.',
  // The fee-shortfall panel's Solana rows (the fee row already includes the deposits), and the assistant's explanation of that shortfall.
  'Includes token-account deposits, at most': 'Inclui depósitos de contas de token, no máximo',
  'Kept as Solana\'s minimum balance': 'Mantido como saldo mínimo da Solana',
  'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this Batch Payment\'s fee can reach {4} {1}, including up to {6} {1} in deposits for recipients who need a token account, and Solana keeps {7} {1} in your wallet as its minimum balance, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.':
    'Toda transação na {0} paga uma taxa de rede em {1}. Sua carteira {2} tem {3} {1}; a taxa deste pagamento em lote pode chegar a {4} {1}, incluindo até {6} {1} em depósitos para destinatários que precisam de uma conta de token, e a Solana mantém {7} {1} na sua carteira como saldo mínimo, então faltam pelo menos {5} {1}. Envie um pouco de {1} na rede {0} para {2} e depois escolha Simular novamente. Nada foi enviado.',
  'Every transaction on {0} pays a network fee in {1}. Your wallet {2} has {3} {1}; this Batch Payment sends {6} {1}, its fee can reach {4} {1} and Solana keeps {7} {1} in your wallet as its minimum balance, so at least {5} {1} is missing. Send a little {1} on the {0} network to {2}, then choose Simulate again. Nothing was sent.':
    'Toda transação na {0} paga uma taxa de rede em {1}. Sua carteira {2} tem {3} {1}; este pagamento em lote envia {6} {1}, a taxa pode chegar a {4} {1} e a Solana mantém {7} {1} na sua carteira como saldo mínimo, então faltam pelo menos {5} {1}. Envie um pouco de {1} na rede {0} para {2} e depois escolha Simular novamente. Nada foi enviado.',
  // The Solana wallet the Editor's in-place run needs, and its scope.
  'Connect your Solana wallet (Phantom or Solflare) on Solana mainnet to review this workflow.':
    'Conecte sua carteira Solana (Phantom ou Solflare) na mainnet da Solana para revisar este fluxo.',
  'Sign in with your Solana wallet to follow this workflow. The sign-in authorizes no transaction.':
    'Entre com sua carteira Solana para acompanhar este fluxo. O login não autoriza nenhuma transação.',
  'Connect the Solana wallet that started this workflow, then try again. Nothing was signed.':
    'Conecte a carteira Solana que iniciou este fluxo e tente de novo. Nada foi assinado.',
  'Your Solana wallet changed before it signed. Nothing was signed or sent. Connect the wallet of this workflow and try again.':
    'Sua carteira Solana mudou antes de assinar. Nada foi assinado nem enviado. Conecte a carteira deste fluxo e tente de novo.',
  'Only a Solana workflow with a Batch Payment runs here with your Solana wallet. Nothing was signed or sent.':
    'Aqui, só um fluxo Solana com pagamento em lote é executado com a sua carteira Solana. Nada foi assinado nem enviado.',
  'FloFi Wallet cannot sign a Solana Batch Payment yet. Connect Phantom or Solflare to sign it. Nothing was signed or sent.':
    'A FloFi Wallet ainda não assina um pagamento em lote na Solana. Conecte a Phantom ou a Solflare para assinar. Nada foi assinado nem enviado.',
  'FloFi Wallet cannot sign a Solana Batch Payment yet; Phantom or Solflare signs it as one transaction.':
    'A FloFi Wallet ainda não assina um pagamento em lote na Solana; a Phantom ou a Solflare o assina como uma única transação.',
  // The core's refusal families (Editor EXECUTION_REFUSAL and /approve CLAIM_TEXT).
  'FloFi could not prepare this Solana Batch Payment ({0}). Nothing was signed or sent.':
    'A FloFi não conseguiu preparar este pagamento em lote na Solana ({0}). Nada foi assinado nem enviado.',
  'This Batch Payment does not fit in one Solana transaction, so FloFi does not split it. Nothing was signed or sent. Pay fewer recipients.':
    'Este pagamento em lote não cabe em uma única transação Solana, então a FloFi não o divide. Nada foi assinado nem enviado. Pague menos destinatários.',
  'A recipient of this Batch Payment is not an ordinary Solana wallet (a program, a token account or a program address). Nothing was signed or sent. Use the recipient\'s wallet address.':
    'Um destinatário deste pagamento em lote não é uma carteira Solana comum (um programa, uma conta de token ou um endereço de programa). Nada foi assinado nem enviado. Use o endereço da carteira do destinatário.',
  'A recipient of this Batch Payment is the wallet that pays it. Nothing was signed or sent.':
    'Um destinatário deste pagamento em lote é a carteira que o paga. Nada foi assinado nem enviado.',
  'Your wallet does not hold enough SOL for this Batch Payment: SOL pays the network fee and a deposit for each recipient who needs a token account (and the payments themselves when they are in SOL). Nothing was signed or sent. Add SOL and review again.':
    'Sua carteira não tem SOL suficiente para este pagamento em lote: o SOL paga a taxa de rede e um depósito para cada destinatário que precisa de uma conta de token (e os próprios pagamentos, quando são em SOL). Nada foi assinado nem enviado. Adicione SOL e revise de novo.',
  'Your wallet does not hold the whole total of this Batch Payment in one token account. Nothing was signed or sent.':
    'Sua carteira não tem o total inteiro deste pagamento em lote em uma única conta de token. Nada foi assinado nem enviado.',
  'A SOL payment to a wallet that does not exist on Solana yet must be at least the minimum balance Solana requires for a new account. Nothing was signed or sent.':
    'Um pagamento em SOL para uma carteira que ainda não existe na Solana precisa ser de pelo menos o saldo mínimo que a Solana exige para uma conta nova. Nada foi assinado nem enviado.',
  'The transaction your wallet signed is not exactly the one FloFi reviewed, so nothing was sent. Review again.':
    'A transação que a sua carteira assinou não é exatamente a que a FloFi revisou, então nada foi enviado. Revise de novo.',
  // C.4: the earlier request of this Batch Payment (still able to land for a short time; landed outside FloFi).
  'Nothing was sent. The request FloFi prepared earlier for this Batch Payment can still land on Solana for a short time; FloFi asks your wallet again only once it can no longer land. Try again in a minute.':
    'Nada foi enviado. O pedido que a FloFi preparou antes para este pagamento em lote ainda pode ser executado na Solana por pouco tempo; a FloFi só pede de novo à sua carteira quando ele não puder mais ser executado. Tente de novo em um minuto.',
  'A transaction you signed earlier for this Batch Payment landed on Solana outside FloFi, so FloFi will not ask your wallet again (that would pay every recipient twice). Check your wallet\'s activity, then end the run.':
    'Uma transação que você assinou antes para este pagamento em lote foi executada na Solana fora da FloFi, então a FloFi não vai pedir de novo à sua carteira (isso pagaria cada destinatário duas vezes). Confira a atividade da sua carteira e depois encerre a execução.',
};
