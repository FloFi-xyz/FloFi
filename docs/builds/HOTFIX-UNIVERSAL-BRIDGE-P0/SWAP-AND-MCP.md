# P0 — Cotações de Swap em produção e investigação MCP

## Causa e correção

`readBuildEstimate` dependia de `localCatalogNetworkMode`, que permite leituras live somente no desenvolvimento. Em produção o leitor desligava as redes de catálogo; o observador de referência Base também não oferecia uma cotação live nesse ambiente. A interface perdia o diagnóstico e mostrava `Quote unavailable`. A construção da fonte opcional de USD podia lançar erro e descartar uma cotação válida.

O Build agora consulta primeiro `cloudPreview`, selecionando o runtime remoto ou o backend embedded existente. EVM usa o mesmo `prepare` do backend, em storage descartável e transporte observe-only. Jupiter recebe `purpose: QUOTE` no endpoint de preview existente: valida o workflow e a resposta com o parser econômico/de build existente e devolve somente a projeção de cotação, sem saldo, simulação de transação, Review, bytes não assinados ou persistência. O modo padrão de preview continua `SIMULATION`, compatível com os clientes anteriores. Nenhum runtime local live foi habilitado em produção.

Antes de publicar um número, o BFF confere hash, node, rede, endereços/mints, decimais, quantidade, slippage, mínimo e validade da resposta contra o IR. Um erro do runtime configurado não aciona um fallback local ou troca de token. O backend continua selecionando a melhor pool canônica com liquidez real, no mesmo bloco verificado, conservando os pins de contratos e a validação dos catálogos.

A fonte de USD é opcional, inclusive sua inicialização: erro, falta ou lentidão deixam `usd: null` sem invalidar o token quote. Não há peg presumido de stablecoin. Falhas retornam código técnico seguro, motivo público e correlation ID; logs do BFF registram apenas código e referência. A interface mostra uma mensagem específica e oferece código/referência no detalhe do elemento, em PT/EN. Nenhum corpo privado de provedor, URL RPC, stack ou credencial é exposto.

O preview de Build tem orçamento total de 30 segundos e uma tentativa. A leitura do Canvas passou de 15 para 45 segundos, acomodando cold starts, o preview e até 2,5 segundos da fonte USD. Edições/unmount continuam abortando o fetch e descartando qualquer resposta atrasada. O orçamento do wrapper embedded limita a espera do chamador; uma leitura subjacente que ignore cancelamento pode terminar depois, sempre observe-only e sem autoridade/persistência. A política geral de retries MCP não foi alterada.

## Matriz separada de leituras públicas

[Artefato público](live-swap-quotes.json), observado em 26/10/2026, usando `backend.previewFlow` isolado com os transportes públicos live e a projeção real de `readBuildEstimate`. Catálogos foram buscados e validados no momento. Não foram usadas fixtures, API keys, contas financiadas ou variáveis de produção. USD foi desligado somente nessa observação para medir a cotação do token. O artefato inclui hashes dos módulos usados e identidades dos ativos, pools, tiers e blocos verificados quando disponíveis.

| Rede | Pares consultados | Observação pública |
| --- | --- | --- |
| Base | 1 USDC → WETH; 1 WETH → USDC | Duas cotações verificadas; aproximadamente 12,7 e 12,2 s |
| Arbitrum One | 1 USDC → WETH; 1 WETH → USDC | Duas cotações verificadas; aproximadamente 12,6 e 11,6 s |
| Ethereum Mainnet | 1 USDC → WETH; 1 WETH → USDC | Duas cotações verificadas; aproximadamente 14,7 e 11,5 s |
| Robinhood Chain | 1 USDG → WETH; 1 WETH → USDG | Duas cotações verificadas; aproximadamente 12,7 e 11,6 s |
| Solana Mainnet | SOL ⇄ USDC; SOL ⇄ USDT | Quatro cotações verificadas pelo parser Jupiter |
| Solana Mainnet | USDC → USDT | `JUPITER_LOOKUP_TABLE_INVALID`: a resposta do builder excedeu/não satisfez o contrato de lookup tables do verificador existente; nenhuma cotação executável foi afirmada |
| Solana Mainnet | USDT → USDC | `JUPITER_RATE_LIMITED`: indisponibilidade temporária do provedor |

As oito cotações EVM e quatro Solana são evidência de leitura, não de simulação financiada ou execução. A observação local usa o backend corrigido isolado; a alteração ainda não foi implantada no endpoint de produção. As demais combinações continuam sujeitas aos catálogos, pools e liquidez realmente disponíveis, sem exceções novas para estes pares.

Reprodução somente de leitura: `FLOFI_SWAP_QUOTE_LIVE=READ_ONLY FLOFI_SWAP_QUOTE_REPORT=/tmp/swap-quotes.json pnpm exec vitest run apps/reference-dapp/src/server/build-estimate.live.test.ts --maxWorkers=1`. Este teste fica fora de `pnpm test` e `pnpm check`; seus resultados são observações e não certificação financeira.

## Fixtures e autoridade financeira

`build-estimate-production.test.ts` exercita o chamador de produção com o port cloud mockado e o leitor de cotação real em chains/catalogs MOCKED: oito pares EVM, seis pares Solana, falta real de pool no mock, falha opcional de USD e recusa de hash/token/amount/slippage/minimum/expiry adulterados. Em cada par EVM, duas contas independentes fazem uma nova simulação vinculada ao dono, Review, aprovação exata e swap, seguidos de reconciliação MOCKED. A cotação Build não concede autoridade; outro dono e chamadas repetidas após conclusão são recusados.

Os testes de deadline cobrem resposta de 12 s, timeout total de 30 s, abort/cancelamento e descarte tardio. Os testes de wire recusam `purpose` desconhecido, `QUOTE` em outros flows e campos extras. Os testes existentes de Base/Arbitrum/Ethereum/Robinhood/Jupiter continuam verificando pins, liquidez, saldos, fees de rede, assinatura, nonces, ownership, Review fresco, reinício e duplicação.

Playwright verifica Build → Simulate → Review e troca de carteira/idioma no perfil `swap-read-acceptance`; `approve-authorize-journeys` verifica MCP → aprovação → carteira simulada → recibo, incluindo a superfície mínima fora do Canvas. Todos usam somente PostgreSQL descartável, loopback e carteiras de teste. Contagens finais e CircleCI ficam nos checks do PR e no relatório de validação.

Slippage padrão de 100 bps, política de fee de 0,1% por workflow completo, autorização explícita da carteira, idempotência, reconciliação e exceção release-age de `fast-uri@3.1.9` foram preservados. Não há assinatura ou execução financeira pública certificada por esta entrega.

## MCP: evidência e limite da conclusão

[Resumo sanitizado dos logs de produção](mcp-timeouts-observation.json): 59 requests recuperados, sendo 20 HTTP 504 com a mensagem exata de timeout após 300 segundos (18 POST e 2 GET). Os registros recuperados não têm eventos internos de tool/stage. Portanto, não permitem atribuir os 20 casos à cotação de Swap nem comprovar uma única causa para todos eles.

O código mostra riscos concretos de orçamento: `/api/mcp` permite 300 s; `deploymentRuntime.preview` usa o preview padrão, com até três tentativas de 240 s cada. Métodos cloud gerais têm até quatro tentativas de 240 s, e preparação de catálogo/enablement pode preceder a simulação. O budget de dependências pode exceder a função. O gateway também autentica OAuth/consulta PostgreSQL antes do SDK, inclusive GET; os dois GET 504 precisam ser investigados nesse caminho, pois o SDK stateless deve responder 405 depois da autenticação. O gateway reconstrói o Request sem propagar o signal, e lê o corpo inteiro da resposta antes de fechar o handler. Esses são pontos de investigação, não causas comprovadas pelos logs disponíveis.

Uma correção global de deadlines, cancelamento, autenticação e resposta MCP altera mais fluxos que a cotação de Swap. Foi mantida fora do hotfix financeiro. Próxima investigação deve medir etapas com códigos/correlation IDs, reproduzir GET autenticado e cold start, estabelecer um deadline total menor que 300 s e testar cancelamento e reconciliação antes de mudar retries de operações duráveis. Nenhum timeout foi mascarado por aumento de `maxDuration` ou por alteração de variáveis de produção.

## Compatibilidade de implantação para revisão

EVM reutiliza o contrato de preview já existente. O novo `purpose: QUOTE` de Jupiter exige o backend desta revisão antes de seu uso pelo frontend; um backend antigo recusa o argumento, com diagnóstico seguro. A escolha de ordem de implantação fica para a revisão e autorização do dono. Nenhum deploy, merge, mudança de ambiente ou transação real foi feito.
