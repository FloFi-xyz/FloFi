// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §4): Pimlico Kora on Solana — the network fee paid in USDC/USDT by the owner when the
 * wallet's SOL cannot pay it. PT-BR: "taxa de rede", "paga em USDC"; never "grátis", "sem taxas" or "patrocinado" (the owner pays).
 */
export const portugueseGasKora: Readonly<Record<string, string>> = {
  // Review fee line (note) and the swap/transfer panels.
  'Paid from your {0} to Pimlico.': 'Paga com os seus {0} à Pimlico.',
  'Paid from your USDC to Pimlico.': 'Paga com os seus USDC à Pimlico.',
  'Paid from your USDT to Pimlico.': 'Paga com os seus USDT à Pimlico.',
  // Technical details (protocol facts, collapsed).
  'Network fee payer (Pimlico)': 'Pagador da taxa de rede (Pimlico)',
  'Network fee payment address': 'Endereço de pagamento da taxa de rede',
  // Execution boundary (simulationError).
  'How the network fee is paid changed since your Review, so nothing was sent. Review it again.':
    'A forma de pagar a taxa de rede mudou desde a sua revisão, então nada foi enviado. Revise de novo.',
  'Your wallet has too little SOL for the network fee and too little USDC or USDT to pay it instead. Add SOL, USDC or USDT, then simulate again.':
    'A sua carteira tem pouco SOL para a taxa de rede e pouco USDC ou USDT para pagá-la em token. Adicione SOL, USDC ou USDT e simule de novo.',
  'The network fee in USDC or USDT rose before your transaction was sent, so nothing was sent. Simulate again to review the new fee.':
    'A taxa de rede em USDC ou USDT subiu antes do envio da transação, então nada foi enviado. Simule de novo para revisar a nova taxa.',
  'This step cannot pay its network fee in USDC or USDT. Add SOL for the network fee, then simulate again.':
    'Esta etapa não pode pagar a taxa de rede em USDC ou USDT. Adicione SOL para a taxa de rede e simule de novo.',
  'Paying the network fee in USDC or USDT is unavailable right now, so nothing was sent. Try again later, or add SOL for the network fee.':
    'O pagamento da taxa de rede em USDC ou USDT está indisponível agora, então nada foi enviado. Tente de novo mais tarde ou adicione SOL para a taxa de rede.',
  'Paying the network fee in USDC or USDT is not available right now, so nothing was sent. Add SOL for the network fee, then simulate again.':
    'O pagamento da taxa de rede em USDC ou USDT não está disponível agora, então nada foi enviado. Adicione SOL para a taxa de rede e simule de novo.',
  'The network fee could not be paid in USDC or USDT for this step, so nothing was sent. Add SOL for the network fee, then simulate again.':
    'Não foi possível pagar a taxa de rede em USDC ou USDT nesta etapa, então nada foi enviado. Adicione SOL para a taxa de rede e simule de novo.',
};
