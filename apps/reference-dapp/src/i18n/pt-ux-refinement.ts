// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-REFINEMENT-HISTORY-001 (pt-BR): the approved Create / Simulate / Execute refinement (FloFi_Orientacao_Refinamento_Visual_UX_UI,
 * 19-11-2026) and the simplified execution receipt in workflow history. New keys only; shared words reuse the existing catalog.
 */
export const portugueseUxRefinement: Readonly<Record<string, string>> = {
  // Expired review: its title (approved copy) and why the fee and the permission need the refreshed review
  'Your review expired.': 'Sua revisão expirou.',
  'The network fee is calculated again when you refresh the review.': 'A taxa de rede é calculada novamente quando você atualiza a revisão.',
  'The token permission is confirmed again by the refreshed review.': 'A permissão de token é confirmada novamente pela revisão atualizada.',
  // Workflow history: the execution receipt
  'You sent': 'Você enviou', 'You supplied': 'Você depositou', 'You received': 'Você recebeu', 'You borrowed': 'Você pegou emprestado',
  'Recipient received': 'O destinatário recebeu', 'Delivered': 'Entregue', 'Configured amount': 'Valor configurado', 'Received amount': 'Valor recebido',
  'Not recorded in this history': 'Não registrado neste histórico', 'Steps completed': 'Etapas concluídas',
  'opens in a new tab': 'abre em uma nova aba',
  'Execution record': 'Registro da execução', 'Current execution · read-only': 'Execução atual · somente leitura',
  'Saved execution · read-only': 'Execução salva · somente leitura', 'Recorded result': 'Resultado registrado',
  'Mocked local execution': 'Execução local simulada', 'Local fork': 'Fork local',
};

/**
 * This build's NEW messages that are only ever called WITH parameters (keys that already existed elsewhere keep their earlier behaviour).
 * They are looked up exactly and never used as the catalog's fallback patterns: a broad key such as "{0} of {1}" must never rewrite an
 * unrelated string (or an owner's workflow name) that has no key of its own (flofi-frontend-ux review).
 */
export const portugueseUxRefinementParameterized: Readonly<Record<string, string>> = {
  'Swap {0} for {1} on {2}.': 'Trocar {0} por {1} na rede {2}.',
  'Send {0} on {1}.': 'Enviar {0} na rede {1}.',
  '{0} {1} from {2} to {3}.': '{0} {1} da rede {2} para a rede {3}.',
  '{0} {1} on {2}.': '{0} {1} na rede {2}.',
  '{0}: {1} on {2}.': '{0}: {1} na rede {2}.',
  'The previous review expired at {0}; its values are no longer current and are not shown.': 'A revisão anterior expirou às {0}; seus valores não estão mais atualizados e não são exibidos.',
  'Network fee · {0}': 'Taxa de rede · {0}',
  '{0} of {1}': '{0} de {1}',
  'Copy {0}': 'Copiar {0}',
};
