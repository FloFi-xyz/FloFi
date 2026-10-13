// SPDX-License-Identifier: AGPL-3.0-only
/** Solana Devnet Swap → Orca liquidity composition (panel, statuses, preflight checks and refusals). */
export const portugueseSolanaComposition: Readonly<Record<string, string>> = {
  'Solana Devnet swap and liquidity': 'Swap e liquidez na Solana Devnet',
  'Simulate swap and liquidity': 'Simular swap e liquidez',
  'Swap and liquidity': 'Swap e liquidez',
  'Two separate transactions, each reviewed and signed in your wallet: the swap, then a position funded by the swap’s actual reconciled output. If the position is not opened, the swapped tokens stay in your wallet; the swap is never repeated.':
    'Duas transações separadas, cada uma revisada e assinada na sua carteira: o swap e depois uma posição financiada pelo resultado real e reconciliado do swap. Se a posição não for aberta, os tokens do swap ficam na sua carteira; o swap nunca é repetido.',
  'The workflow changed. Simulate the current workflow again.': 'O fluxo mudou. Simule o fluxo atual novamente.',
  'The workflow changed after authorization. The position uses exactly the authorized workflow: restore it, or end the run and keep the swapped tokens.':
    'O fluxo mudou depois da autorização. A posição usa exatamente o fluxo autorizado: restaure-o ou encerre a execução e mantenha os tokens do swap.',
  'Composition plan': 'Plano da composição',
  'Status': 'Status',
  '1. Swap': '1. Swap',
  '{0} → expected {1}, at least {2} ({3} bps)': '{0} → esperado {1}, no mínimo {2} ({3} bps)',
  '2. Position': '2. Posição',
  '{0} at most, plus {1} · range {2}–{3} devUSDC per SOL (ticks {4} to {5}) · {6} bps': 'no máximo {0}, mais {1} · faixa {2}–{3} devUSDC por SOL (ticks {4} a {5}) · {6} bps',
  '100% of the swap’s reconciled output': '100% do resultado reconciliado do swap',
  'the swap’s reconciled output up to {0}': 'o resultado reconciliado do swap até {0}',
  'Projected position': 'Posição projetada',
  '{0} + {1} with the expected swap output; {2} + {3} with the minimum. Projection only: the position is simulated and reviewed again after the swap.':
    '{0} + {1} com o resultado esperado do swap; {2} + {3} com o mínimo. Apenas projeção: a posição é simulada e revisada novamente depois do swap.',
  'Pool price': 'Preço do pool',
  '{0} devUSDC per SOL now; {1} after the simulated swap (slot {2})': '{0} devUSDC por SOL agora; {1} depois do swap simulado (slot {2})',
  'Preflight': 'Verificação prévia',
  'Risk reduction only: it does not guarantee that the position transaction succeeds.': 'Apenas reduz o risco: não garante que a transação da posição será bem-sucedida.',
  'Swap transaction': 'Transação do swap',
  'not started': 'não iniciada',
  'Received and bound': 'Recebido e vinculado',
  '{0} received (reconciled); the position may use {1}': '{0} recebido (reconciliado); a posição pode usar {1}',
  'Position transaction': 'Transação da posição',
  'review accepted': 'revisão aceita',
  'review prepared': 'revisão preparada',
  'preparation {0}': 'preparação {0}',
  'Position review': 'Revisão da posição',
  'Deposit at most': 'Depositar no máximo',
  'Expected deposit': 'Depósito esperado',
  '(fresh simulation)': '(simulação nova)',
  'Range state': 'Estado da faixa',
  'your wallet, then a one-time position-mint key created in this browser': 'sua carteira e depois uma chave única de mint da posição criada neste navegador',
  'Prepare position with the received amount': 'Preparar a posição com o valor recebido',
  'Accept position review': 'Aceitar revisão da posição',
  'Accept composed review': 'Aceitar revisão da composição',
  'Execute swap': 'Executar swap',
  'Execute position': 'Executar posição',
  'End and keep the swapped tokens': 'Encerrar e manter os tokens do swap',
  // Statuses (rendered from the run phase).
  'Simulated — accept the Review to authorize the plan': 'Simulado — aceite a revisão para autorizar o plano',
  'Authorized — execute the swap': 'Autorizado — execute o swap',
  'Swap in progress': 'Swap em andamento',
  'Swap reconciled — prepare the position with the received amount': 'Swap reconciliado — prepare a posição com o valor recebido',
  'Position step in progress': 'Etapa da posição em andamento',
  'Completed and reconciled': 'Concluído e reconciliado',
  'Ended after the swap — the swapped tokens stayed in your wallet': 'Encerrado depois do swap — os tokens do swap ficaram na sua carteira',
  'Not executed — nothing was swapped': 'Não executado — nenhum swap foi feito',
  'The swap did not execute — no position was attempted': 'O swap não foi executado — nenhuma posição foi tentada',
  'Needs attention — observing only; nothing is retried': 'Requer atenção — apenas observando; nada é repetido',
  'Review expired or replaced — simulate again': 'Revisão expirada ou substituída — simule novamente',
  // Preflight checks.
  'Pool verified': 'Pool verificado', 'Tick arrays initialized': 'Tick arrays inicializados', 'Position would open': 'A posição seria aberta',
  'Swap output deposited': 'Resultado do swap depositado', 'Enough SOL after the swap': 'SOL suficiente depois do swap', 'Enough devUSDC after the swap': 'devUSDC suficiente depois do swap',
  // Refusals and recovery messages.
  'An earlier composition swapped tokens and still owes its position. Continue it, or end it to keep the tokens, before starting another.':
    'Uma composição anterior fez o swap e ainda deve a posição. Continue-a, ou encerre-a mantendo os tokens, antes de iniciar outra.',
  'You already have a Flofi position on this pool. Nothing was swapped; manage that position first.': 'Você já tem uma posição Flofi neste pool. Nenhum swap foi feito; gerencie essa posição primeiro.',
  'This range needs tick arrays that are not initialized on the pool. Nothing was swapped; choose a range closer to the price.':
    'Esta faixa precisa de tick arrays que não estão inicializados no pool. Nenhum swap foi feito; escolha uma faixa mais próxima do preço.',
  'After the swap there would not be enough SOL for the position and its refundable deposits. Nothing was swapped.':
    'Depois do swap não haveria SOL suficiente para a posição e seus depósitos reembolsáveis. Nenhum swap foi feito.',
  'After the swap there would not be enough devUSDC for the position. Nothing was swapped.': 'Depois do swap não haveria devUSDC suficiente para a posição. Nenhum swap foi feito.',
  'This range and maxima would not open a position. Nothing was swapped.': 'Esta faixa e estes máximos não abririam uma posição. Nenhum swap foi feito.',
  'A transaction for this step already exists. Observe it; it is never sent again.': 'Já existe uma transação para esta etapa. Observe-a; ela nunca é enviada novamente.',
  'The position was prepared the maximum number of times. End the run to keep the swapped tokens.': 'A posição foi preparada o número máximo de vezes. Encerre a execução para manter os tokens do swap.',
  'This tab no longer holds the one-time position key (for example after a reload). Prepare the position again; nothing was sent.':
    'Esta aba não guarda mais a chave única da posição (por exemplo, após recarregar). Prepare a posição novamente; nada foi enviado.',
  'Execution is not enabled on this server. Simulation and Review remain available.': 'A execução não está habilitada neste servidor. Simulação e revisão continuam disponíveis.',
  'These steps cannot execute together. Only a Solana Devnet swap linked to an Orca position can; other Solana steps run one at a time.':
    'Estes passos não podem executar juntos. Só um swap na Solana Devnet ligado a uma posição Orca pode; os outros passos Solana executam um de cada vez.',
};
