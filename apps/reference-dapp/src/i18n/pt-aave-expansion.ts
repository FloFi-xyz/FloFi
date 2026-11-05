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
});
