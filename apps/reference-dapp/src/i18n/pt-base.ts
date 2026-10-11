// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-BASE-001: Base as a catalog network — the shared asset search of every official-catalog network and Base real-funds copy. */
export const portugueseBase: Readonly<Record<string, string>> = {
  'Search {0} tokens': 'Pesquisar tokens na {0}', 'Search by symbol or name…': 'Pesquise por símbolo ou nome…', 'Loading {0} tokens…': 'Carregando os tokens da {0}…',
  '{0} tokens are unavailable right now.': 'Os tokens da {0} estão indisponíveis no momento.', 'No token matches this search.': 'Nenhum token corresponde a esta pesquisa.',
  '{0} token results': 'Resultados de tokens na {0}', '{0} tokens · type to search': '{0} tokens · digite para pesquisar',
  'Real funds on {0}. Simulate checks both tokens against the network\'s official catalog and the chain, and that the pool is live.':
    'Fundos reais na {0}. A simulação confere os dois tokens no catálogo oficial da rede e na chain, e se o pool está ativo.',
  '{0} transfer': 'Transferência na {0}', 'Base mainnet is not enabled on this app instance.': 'A Base mainnet não está habilitada nesta instância do app.',
  'The Base token list is unavailable. Try again later.': 'A lista de tokens da Base está indisponível. Tente novamente mais tarde.',
  'The network\'s official asset catalog is unavailable. Try again later.': 'O catálogo oficial de ativos da rede está indisponível. Tente novamente mais tarde.',
  'A token\'s decimals on chain differ from its catalog entry. Nothing was prepared.': 'As casas decimais de um token na chain diferem do catálogo. Nada foi preparado.',
  'A token\'s deployment could not be verified. Nothing was prepared.': 'Não foi possível verificar o contrato de um token. Nada foi preparado.',
};
