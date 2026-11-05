// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD AAVE-V3-EXPANSION-001: Portuguese for the multi-reserve Aave V3 catalog, reserve status and Swap → Supply sequences. */
export const portugueseAaveExpansion: Readonly<Record<string, string>> = Object.freeze({
  'At least one supplied asset must be enabled as collateral in Aave before Borrow. Flofi will not enable it automatically.':
    'Pelo menos um ativo depositado precisa estar habilitado como colateral na Aave antes do Borrow. O Flofi não o habilita automaticamente.',
  'Your Aave account is in isolation mode. Flofi does not borrow against isolated collateral yet.':
    'Sua conta Aave está em modo de isolamento. O Flofi ainda não faz empréstimos contra colateral isolado.',
  'This reserve uses siloed borrowing and cannot be combined with your other Aave debt.':
    'Esta reserva usa empréstimo isolado (siloed) e não pode ser combinada com suas outras dívidas na Aave.',
  'This Aave account state is not supported (for example E-Mode). No transaction was prepared.':
    'Este estado da conta Aave não é suportado (por exemplo, E-Mode). Nenhuma transação foi preparada.',
  'One of your Aave positions could not be verified against the registered market. No transaction was prepared.':
    'Uma das suas posições na Aave não pôde ser verificada no mercado registrado. Nenhuma transação foi preparada.',
  'This reserve has reached its borrow cap. No transaction was prepared.': 'Esta reserva atingiu o limite de empréstimo. Nenhuma transação foi preparada.',
  'This token refuses to change a non-zero allowance directly. Reset its allowance for the Aave Pool to zero in your wallet first; no transaction was prepared.':
    'Este token não permite alterar diretamente uma permissão diferente de zero. Primeiro zere na sua carteira a permissão para o Pool da Aave; nenhuma transação foi preparada.',
  // Live reserve status (lending-reserve-status.tsx).
  'Reading the live Aave reserve…': 'Lendo a reserva Aave ao vivo…',
  'Live reserve status is unavailable right now; Simulate checks it on chain.': 'O status ao vivo da reserva está indisponível agora; o Simulate o verifica na rede.',
  'Wallet: {0} · Supplied: {1} · Debt: {2}': 'Carteira: {0} · Depositado: {1} · Dívida: {2}',
  'Can be used as collateral (LTV {0}%).': 'Pode ser usado como colateral (LTV {0}%).',
  'Not usable as collateral.': 'Não pode ser usado como colateral.',
  'Variable supply APY {0}% (informational, changes with the market).': 'APY variável de depósito {0}% (informativo, muda com o mercado).',
  'Variable borrow APY {0}% (informational, changes with the market).': 'APY variável de empréstimo {0}% (informativo, muda com o mercado).',
  'Borrowing capacity {0} · Health factor {1}': 'Capacidade de empréstimo {0} · Fator de saúde {1}',
  'This reserve is not active.': 'Esta reserva não está ativa.',
  'This reserve is paused.': 'Esta reserva está pausada.',
  'This reserve is frozen: new Supply and Borrow are closed; Repay and Withdraw stay open.': 'Esta reserva está congelada: novos depósitos e empréstimos estão fechados; Repay e Withdraw continuam abertos.',
  'This reserve has reached its supply cap.': 'Esta reserva atingiu o limite de depósito.',
  'Borrowing is disabled for this reserve.': 'O empréstimo está desativado para esta reserva.',
  'This reserve has reached its borrow cap.': 'Esta reserva atingiu o limite de empréstimo.',
  'No liquidity is available to borrow from this reserve.': 'Não há liquidez disponível para empréstimo nesta reserva.',
  'The price oracle did not answer for this reserve.': 'O oráculo de preço não respondeu para esta reserva.',
  'Flofi does not borrow isolated reserves yet.': 'O Flofi ainda não faz empréstimo de reservas isoladas.',
  'This reserve does not match its verified registration.': 'Esta reserva não corresponde ao seu registro verificado.',
  'This reserve is not listed by the market.': 'Esta reserva não está listada pelo mercado.',
  'Your Aave account uses E-Mode, which Flofi does not support yet.': 'Sua conta Aave usa E-Mode, que o Flofi ainda não suporta.',
  'Your Aave account state could not be read right now; Simulate checks it on chain.': 'O estado da sua conta Aave não pôde ser lido agora; o Simulate o verifica na rede.',
  'Test fixture data (MOCKED): not a live market read.': 'Dados de teste (MOCKED): não é uma leitura do mercado ao vivo.',
  'account state unknown': 'estado da conta desconhecido',
  'inactive': 'inativa', 'paused': 'pausada', 'frozen': 'congelada', 'supply cap reached': 'limite de depósito atingido', 'borrowing disabled': 'empréstimo desativado',
  'borrow cap reached': 'limite de empréstimo atingido', 'no liquidity': 'sem liquidez', 'no oracle price': 'sem preço do oráculo', 'isolated': 'isolada',
  'unverified': 'não verificada', 'not listed': 'não listada', 'E-Mode account': 'conta em E-Mode',
});
