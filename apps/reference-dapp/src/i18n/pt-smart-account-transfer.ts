// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-7702-TRANSFER-001: transfers from MetaMask Smart Accounts (EIP-7702), sent directly or relayed by MetaMask. */
export const portugueseSmartAccountTransfer: Readonly<Record<string, string>> = {
  'This address is a smart contract wallet (for example a Safe), so it cannot send this transfer itself. Use a standard account or a MetaMask Smart Account. Nothing was simulated or sent.':
    'Este endereço é uma carteira de contrato inteligente (por exemplo, uma Safe), então ele não pode enviar esta transferência sozinho. Use uma conta normal ou uma MetaMask Smart Account. Nada foi simulado nem enviado.',
  'This wallet\'s account type changed since your Review (for example it was upgraded to a MetaMask Smart Account, or that upgrade was removed), so nothing was sent. Simulate and review again.':
    'O tipo de conta desta carteira mudou desde a sua Revisão (por exemplo, ela foi atualizada para uma MetaMask Smart Account ou essa atualização foi removida), então nada foi enviado. Simule e revise novamente.',
  'This address is a smart contract wallet (for example a Safe), so it cannot send this transfer itself. Use a standard account or a MetaMask Smart Account.':
    'Este endereço é uma carteira de contrato inteligente (por exemplo, uma Safe), então ele não pode enviar esta transferência sozinho. Use uma conta normal ou uma MetaMask Smart Account.',
  'This account is upgraded to a smart account (EIP-7702) whose code FloFi has not verified. Use a standard account or a MetaMask Smart Account. Nothing was sent.':
    'Esta conta foi atualizada para uma conta inteligente (EIP-7702) cujo código a FloFi não verificou. Use uma conta normal ou uma MetaMask Smart Account. Nada foi enviado.',
  'This wallet\'s account type changed since Review. Simulate and review again. Nothing was sent.':
    'O tipo de conta desta carteira mudou desde a Revisão. Simule e revise novamente. Nada foi enviado.',
  'The account\'s smart-account code was not the reviewed one when this transfer landed, so FloFi cannot confirm the result. It is recorded for review; nothing will be sent again.':
    'O código de conta inteligente desta conta não era o revisado quando esta transferência foi incluída em um bloco, então a FloFi não consegue confirmar o resultado. Ela foi registrada para análise; nada será enviado novamente.',
  'MetaMask may have relayed this transfer. FloFi is still checking the network for it and will never send it again.':
    'A MetaMask pode ter retransmitido esta transferência. A FloFi ainda está procurando por ela na rede e nunca vai enviá-la novamente.',
  'This transfer was executed more than once on the network. It is recorded for review; FloFi will not send anything again.':
    'Esta transferência foi executada mais de uma vez na rede. Ela foi registrada para análise; a FloFi não vai enviar mais nada.',
  'MetaMask relayed this transfer in a form FloFi cannot verify (for example together with a fee payment). It is recorded for review; nothing will be sent again.':
    'A MetaMask retransmitiu esta transferência em um formato que a FloFi não consegue verificar (por exemplo, junto com um pagamento de taxa). Ela foi registrada para análise; nada será enviado novamente.',
  'MetaMask relayed this ETH transfer, which FloFi cannot verify. It is recorded for review; nothing will be sent again.':
    'A MetaMask retransmitiu esta transferência de ETH, que a FloFi não consegue verificar. Ela foi registrada para análise; nada será enviado novamente.',
  'The relayed transfer failed on the network, and its authorization may still be used by the relayer. Check your wallet activity before trying again. It is recorded for review; FloFi will not send it again.':
    'A transferência retransmitida falhou na rede, e a autorização dela ainda pode ser usada pelo retransmissor. Confira a atividade da sua carteira antes de tentar novamente. Ela foi registrada para análise; a FloFi não vai enviá-la novamente.',
  'MetaMask Smart Accounts can send transfers on supported mainnets. This test network does not support them; use a standard account here. Nothing was sent.':
    'As MetaMask Smart Accounts podem enviar transferências nas mainnets compatíveis. Esta rede de teste não é compatível com elas; aqui, use uma conta normal. Nada foi enviado.',
  'MetaMask Smart Accounts can send transfers on supported mainnets. This test network does not support them; use a standard account here. Nothing was simulated or sent.':
    'As MetaMask Smart Accounts podem enviar transferências nas mainnets compatíveis. Esta rede de teste não é compatível com elas; aqui, use uma conta normal. Nada foi simulado nem enviado.',
  'Your wallet used this transfer\'s transaction slot (nonce) for a different transaction, and no relayed execution of this transfer was found. A relayed transfer can still appear: check your wallet activity before trying again.':
    'Sua carteira usou a posição de transação (nonce) desta transferência em outra transação, e nenhuma execução retransmitida desta transferência foi encontrada. Uma transferência retransmitida ainda pode aparecer: confira a atividade da sua carteira antes de tentar novamente.',
  'Transfer reconciled. MetaMask relayed it for your Smart Account: the relayer {0} paid the network fee ({1} ETH); you paid no network fee and this transfer did not use your nonce.':
    'Transferência reconciliada. A MetaMask a retransmitiu pela sua Smart Account: o retransmissor {0} pagou a taxa de rede ({1} ETH); você não pagou nenhuma taxa de rede e esta transferência não usou o seu nonce.',
  'The relayed transfer used an authorization that could be used again, which FloFi does not accept. It is recorded for review; nothing will be sent again.':
    'A transferência retransmitida usou uma autorização que poderia ser usada de novo, o que a FloFi não aceita. Ela foi registrada para análise; nada será enviado novamente.',
  'This network transaction already belongs to another FloFi transfer. It is recorded for review; nothing will be sent again.':
    'Esta transação da rede já pertence a outra transferência da FloFi. Ela foi registrada para análise; nada será enviado novamente.',
  'The wallet submitted this transfer in a form FloFi cannot verify. It is recorded for review; nothing will be sent again.':
    'A carteira enviou esta transferência em um formato que a FloFi não consegue verificar. Ela foi registrada para análise; nada será enviado novamente.',
  'The wallet reported this transfer as declined, but it was executed on the network. It is recorded for review; FloFi will not send it again.':
    'A carteira informou que esta transferência foi recusada, mas ela foi executada na rede. Ela foi registrada para análise; a FloFi não vai enviá-la novamente.',
};
