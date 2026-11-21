// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UX-01 · UX-02 · UX-03 · UX-05 (owner guidelines of 21-11-2026, pt-BR): the Simulate result's next action, the Execute Review's status, title and
 * decision rows (fee, token access, wallet confirmations) and the shortened recipient's disclosure. New keys only; shared words reuse the catalog.
 */
export const portugueseUxGuidelines: Readonly<Record<string, string>> = {
  // UX-05: the Simulate panel's next action (navigation to Execute only)
  'Continue to authorization': 'Continuar para autorização',
  // UX-03: the valid Review
  'Review ready · valid until {0}': 'Revisão pronta · válida até {0}', 'Check your operation': 'Confira sua operação',
  'At today\'s prices; your wallet sets the final fee.': 'Nos preços de agora; sua carteira define a taxa final.',
  'Paid by your wallet': 'Paga pela sua carteira', 'More information: {0}': 'Mais informações: {0}',
  'Access to {0}': 'Acesso ao {0}', '{0} can use it': '{0} pode usar', 'Other permissions': 'Outras permissões', 'Token access': 'Acesso a tokens',
  'Expected wallet confirmations': 'Confirmações previstas na carteira',
  // UX-01 / UX-03: a shortened recipient and its full address
  '{0}, show the full address {1}': '{0}, mostrar o endereço completo {1}', 'Full address': 'Endereço completo',
  'Paid by your wallet · at today\'s prices': 'Paga pela sua carteira · nos preços de agora', 'At today\'s prices': 'Nos preços de agora',
  // UX-05: the chat's hand-off names the panel's next action
  'This workflow runs as one workflow run: choose Simulate workflow, then Continue to authorization and Authorize workflow.': 'Este fluxo roda como uma única execução: escolha Simular fluxo, depois Continuar para autorização e Autorizar fluxo.',
};
