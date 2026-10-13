// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-SOLANA-MAINNET-001: Orca Whirlpools liquidity on Solana Mainnet (real funds) and the Canvas corrections. */
export const portugueseSolanaMainnet: Readonly<Record<string, string>> = {
  'Edit Solana liquidity position': 'Editar posição de liquidez Solana',
  'Create Solana liquidity position': 'Criar posição de liquidez Solana',
  'Orca Whirlpools · SOL / USDC · fee 0.30% · tick spacing 64. Maxima are limits, not amounts to spend.':
    'Orca Whirlpools · SOL / USDC · comissão de 0,30% · espaçamento de ticks 64. Os máximos são limites, não montantes a gastar.',
  'Maximum USDC': 'Máximo de USDC',
  'Use ±10% around the current pool price': 'Usar ±10% em torno do preço atual da pool',
  'USDC per SOL (tick': 'USDC por SOL (tick',
  'This position uses real funds on Solana mainnet. The position belongs to your connected wallet.':
    'Esta posição usa fundos reais na Solana mainnet. A posição pertence à sua carteira ligada.',
  'Solana liquidity': 'Liquidez em Solana',
  'Concentrated liquidity on Solana Mainnet via Orca Whirlpools: up to': 'Liquidez concentrada em Solana Mainnet via Orca Whirlpools: até',
  'SOL and': 'SOL e',
  'USDC between': 'USDC entre',
  'USDC per SOL.': 'USDC por SOL.',
  'This position uses real funds on Solana Mainnet.': 'Esta posição usa fundos reais na Solana Mainnet.',
  'Wallet connected · Solana Mainnet:': 'Carteira ligada · Solana Mainnet:',
  'Solana Mainnet (genesis': 'Solana Mainnet (gênese',
  '/ USDC': '/ USDC',
  'USDC per SOL · current tick': 'USDC por SOL · tick atual',
  'USDC per SOL · aligned ticks': 'USDC por SOL · ticks alinhados',
  'not deposited (stays in your wallet) · USDC balance after': 'não depositado (fica na sua carteira) · saldo de USDC depois',
  '· USDC': '· USDC',
  'USDC per SOL)': 'USDC por SOL)',
  'This position uses real funds on Solana Mainnet. Your wallet will ask you to sign one exact transaction; Flofi never signs for you.':
    'Esta posição usa fundos reais na Solana Mainnet. A sua carteira pedirá para assinar uma transação exata; a Flofi nunca assina por si.',
  'View on Solscan': 'Ver no Solscan',
  'SOL / USDC via': 'SOL / USDC via',
  '· real funds · simulate against the live pool. Changes require review.': '· fundos reais · simule contra a pool real. As alterações exigem revisão.',
  'Connect a Solana wallet for Solana Mainnet first.': 'Ligue primeiro uma carteira Solana para a Solana Mainnet.',
  'Your wallet needs more USDC for this position.': 'A sua carteira precisa de mais USDC para esta posição.',
  'Solana Mainnet liquidity storage is not configured on this server (GRYLOO_ORCA_MAINNET_JOURNAL).':
    'O armazenamento de liquidez da Solana Mainnet não está configurado neste servidor (GRYLOO_ORCA_MAINNET_JOURNAL).',
  'Solana Mainnet liquidity execution is not enabled on this server. Simulation and Review remain read-only.':
    'A execução de liquidez na Solana Mainnet não está ativada neste servidor. A simulação e a revisão continuam apenas de leitura.',
  'The Solana Mainnet simulation of this exact transaction failed. Nothing was signed.': 'A simulação na Solana Mainnet desta transação exata falhou. Nada foi assinado.',
  'The Orca pool does not match the verified Solana Mainnet profile. Nothing was simulated.': 'A pool Orca não corresponde ao perfil verificado da Solana Mainnet. Nada foi simulado.',
  'This Orca pool now emits rewards, which Flofi does not model yet. Nothing was simulated.': 'Esta pool Orca passou a emitir recompensas, que a Flofi ainda não modela. Nada foi simulado.',
  'The Solana network provider is not on Solana Mainnet. Nothing was simulated or sent.': 'O fornecedor de rede Solana não está na Solana Mainnet. Nada foi simulado nem enviado.',
  'This Solana wallet could not connect on Solana Mainnet.': 'Esta carteira Solana não conseguiu ligar-se à Solana Mainnet.',
  'This Solana wallet could not connect on Solana Devnet.': 'Esta carteira Solana não conseguiu ligar-se à Solana Devnet.',
  // Canvas corrections (PR B).
  'Switch From and To tokens': 'Inverter tokens de origem e destino',
  'Also removed 1 linked step that cannot run without the deleted one. Undo restores it.': 'Também foi removida 1 etapa ligada que não funciona sem a etapa excluída. Desfazer a restaura.',
  'Also removed the linked steps that cannot run without the deleted one. Undo restores them.': 'Também foram removidas as etapas ligadas que não funcionam sem a etapa excluída. Desfazer as restaura.',
};
