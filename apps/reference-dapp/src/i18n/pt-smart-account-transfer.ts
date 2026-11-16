// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-7702-TRANSFER-001: transfers from MetaMask Smart Accounts (EIP-7702), sent directly or relayed by MetaMask. */
export const portugueseSmartAccountTransfer: Readonly<Record<string, string>> = {
  'This address is a smart contract wallet (for example a Safe), so it cannot send this transfer itself. Use a standard account or a MetaMask Smart Account. Nothing was simulated or sent.':
    'Este endereço é uma carteira de contrato inteligente (por exemplo, uma Safe), por isso não pode enviar esta transferência. Use uma conta normal ou uma MetaMask Smart Account. Nada foi simulado nem enviado.',
  'This wallet\'s account type changed since your Review (for example it was upgraded to a MetaMask Smart Account, or that upgrade was removed), so nothing was sent. Simulate and review again.':
    'O tipo de conta desta carteira mudou desde a sua revisão (por exemplo, foi atualizada para uma MetaMask Smart Account ou essa atualização foi removida), por isso nada foi enviado. Simule e revise novamente.',
  'This address is a smart contract wallet (for example a Safe), so it cannot send this transfer itself. Use a standard account or a MetaMask Smart Account.':
    'Este endereço é uma carteira de contrato inteligente (por exemplo, uma Safe), por isso não pode enviar esta transferência. Use uma conta normal ou uma MetaMask Smart Account.',
  'This account is upgraded to a smart account (EIP-7702) whose code FloFi has not verified. Use a standard account or a MetaMask Smart Account. Nothing was sent.':
    'Esta conta foi atualizada para uma conta inteligente (EIP-7702) cujo código a FloFi não verificou. Use uma conta normal ou uma MetaMask Smart Account. Nada foi enviado.',
  'This wallet\'s account type changed since Review. Simulate and review again. Nothing was sent.':
    'O tipo de conta desta carteira mudou desde a revisão. Simule e revise novamente. Nada foi enviado.',
  'The account\'s smart-account code was not the reviewed one when this transfer landed, so FloFi cannot confirm the result. It is recorded for review; nothing will be sent again.':
    'O código de conta inteligente da conta não era o revisto quando esta transferência foi incluída, por isso a FloFi não consegue confirmar o resultado. Ficou registada para análise; nada será enviado novamente.',
  'MetaMask may have relayed this transfer. FloFi is still checking the network for it and will never send it again.':
    'A MetaMask pode ter retransmitido esta transferência. A FloFi continua a procurá-la na rede e nunca a enviará novamente.',
  'This transfer was executed more than once on the network. It is recorded for review; FloFi will not send anything again.':
    'Esta transferência foi executada mais de uma vez na rede. Ficou registada para análise; a FloFi não enviará mais nada.',
  'MetaMask relayed this transfer in a form FloFi cannot verify (for example together with a fee payment). It is recorded for review; nothing will be sent again.':
    'A MetaMask retransmitiu esta transferência num formato que a FloFi não consegue verificar (por exemplo, junto com um pagamento de taxa). Ficou registada para análise; nada será enviado novamente.',
  'MetaMask relayed this ETH transfer, which FloFi cannot verify. It is recorded for review; nothing will be sent again.':
    'A MetaMask retransmitiu esta transferência de ETH, que a FloFi não consegue verificar. Ficou registada para análise; nada será enviado novamente.',
  'The relayed transfer failed on the network, and its authorization may still be used by the relayer. Check your wallet activity before trying again. It is recorded for review; FloFi will not send it again.':
    'A transferência retransmitida falhou na rede e a sua autorização ainda pode ser usada pelo retransmissor. Verifique a atividade da carteira antes de tentar novamente. Ficou registada para análise; a FloFi não a enviará novamente.',
  'MetaMask Smart Accounts can send transfers on supported mainnets. This test network does not support them; use a standard account here. Nothing was sent.':
    'As MetaMask Smart Accounts podem enviar transferências nas mainnets suportadas. Esta rede de teste não as suporta; use aqui uma conta normal. Nada foi enviado.',
  'MetaMask Smart Accounts can send transfers on supported mainnets. This test network does not support them; use a standard account here. Nothing was simulated or sent.':
    'As MetaMask Smart Accounts podem enviar transferências nas mainnets suportadas. Esta rede de teste não as suporta; use aqui uma conta normal. Nada foi simulado nem enviado.',
  'Your wallet used this transfer\'s transaction slot (nonce) for a different transaction, and no relayed execution of this transfer was found. A relayed transfer can still appear: check your wallet activity before trying again.':
    'A sua carteira usou a posição de transação (nonce) desta transferência para outra transação e não foi encontrada nenhuma execução retransmitida desta transferência. Uma transferência retransmitida ainda pode aparecer: verifique a atividade da carteira antes de tentar novamente.',
  'Transfer reconciled. MetaMask relayed it for your Smart Account: the relayer {0} paid the network fee ({1} ETH); you paid none and your nonce did not change.':
    'Transferência reconciliada. A MetaMask retransmitiu-a pela sua Smart Account: o retransmissor {0} pagou a taxa de rede ({1} ETH); não pagou nenhuma taxa e o seu nonce não mudou.',
  'The relayed transfer used an authorization that could be used again, which FloFi does not accept. It is recorded for review; nothing will be sent again.':
    'A transferência retransmitida usou uma autorização que podia ser usada novamente, o que a FloFi não aceita. Ficou registada para análise; nada será enviado novamente.',
  'This network transaction already belongs to another FloFi transfer. It is recorded for review; nothing will be sent again.':
    'Esta transação da rede já pertence a outra transferência da FloFi. Ficou registada para análise; nada será enviado novamente.',
  'The wallet submitted this transfer in a form FloFi cannot verify. It is recorded for review; nothing will be sent again.':
    'A carteira enviou esta transferência num formato que a FloFi não consegue verificar. Ficou registada para análise; nada será enviado novamente.',
  'The wallet reported this transfer as declined, but it was executed on the network. It is recorded for review; FloFi will not send it again.':
    'A carteira indicou esta transferência como recusada, mas ela foi executada na rede. Ficou registada para análise; a FloFi não a enviará novamente.',
};
