# P0 — estimativas compartilhadas de Swap e Bridge

Base: `main` após o merge #126, `01dbce43bfa4ab7279a95cc0ae24e5f1a94fa8e1`. PR independente. Nenhum merge, deploy, acesso de escrita a produção ou transação financeira pública foi realizado.

## Diagnóstico e correção

As quatro causas indicadas pelo owner foram confirmadas. Havia ainda um segundo filtro no Canvas, que nem incluía `estimateWorkflow` nas cards Bridge, e a conta Solana podia sobrepor a conta EVM na consulta de Swap. Alterações de rede em um rascunho também precisavam invalidar a consulta mesmo quando a quantidade não mudava.

`/api/build-estimate` é a fronteira de apresentação compartilhada. Swap continua usando os leitores/validadores existentes de Uniswap e Jupiter no preview do backend. Bridge usa `bridgeEstimateRequest` → `readBridgeDiscovery` → o método existente `crosschain-universal.discover`; o painel de descoberta usa o mesmo serviço e a mesma construção de pedido. Nenhum motor financeiro paralelo foi criado. A heurística antiga que inferia USDC/WETH pelo número de casas decimais da observação Base foi removida.

Cards Bridge novas e existentes consultam automaticamente o rascunho efetivamente exibido. Rede, ativos independentes, quantidade, slippage, destinatário e política de provedores vêm do IR selecionado por `nodeId`. A carteira de origem acompanha o ecossistema do nó; a carteira de destino também integra a identidade da consulta. Não há substituição por USDC. Uma seleção incompleta não produz quantidade.

Cancelamento, debounce, geração por consulta e cache por snapshot impedem que uma resposta antiga apareça após edições/troca de carteira. Expiração retira a quantidade e solicita nova estimativa. Respostas recebidas em HTTP de erro não são aceitas como sucesso. Backend e navegador validam identidade, casas decimais, quantidade positiva, mínimo, slippage, validade e correspondência com o nó; símbolos conhecidos de Swap também são confrontados com o catálogo/IR. USD permanece opcional.

O card mostra os estados individuais de Relay, LI.FI, Mayan e Across, respeitando a seleção de provedores. Cotações sem builder verificado recebem **“Live quote only · execution is not validated”**. Um builder verificado recebe **“Builder verified · simulation and Review still required”**. Mínimo do provedor, liquidez insuficiente, indisponibilidade temporária, ausência de rota e falha interna são estados distintos; não se inventam disponibilidades. Foram endurecidas também as identidades das cotações informativas Relay e Mayan: resultados incompatíveis não expõem uma quantidade utilizável.

`universalBridgeOfWorkflow(workflow, nodeId)` permite seleção inequívoca dentro de composições. Sem ID, múltiplas Bridges são ambíguas. O workflow original, dependências, revisão e identidade são preservados. A cotação isolada de uma quantidade declarada de Swap em composição é vinculada ao hash do workflow completo; referências de saída ainda não resolvidas recebem recusa. Essa projeção é exclusivamente de estimativa: não remove dependências para simular ou executar. Os validadores de execução isolada e os orquestradores registrados continuam obrigatórios.

## Autorização e operação

Estimativa não produz run durável, Review, autorização, calldata utilizável ou execução. Simular/revisar/autorizar/acompanhar continuam nos canais e fluxos existentes, inclusive chat-first e MCP; Canvas não se tornou obrigatório. A rota executada é novamente cotada, validada pelo builder, simulada e apresentada no Review antes da autorização explícita. Ownership, idempotência e reconciliação permanecem vigentes.

Mainnet-only no produto público; os caminhos de teste ficam em infraestrutura de engenharia. Slippage padrão de 100 bps, política existente de fee de 0,1% por workflow completo e a exceção `fast-uri@3.1.9` preservados. Não foi criado limite monetário ou bloqueio global de criação/simulação. As duas novas branches têm deploy automático Vercel desabilitado.

Correlação: UUID de consulta do navegador → header do endpoint → W3C trace do BFF → backend → evento por provedor → resposta/código de suporte. Novos logs registram somente IDs de correlação, redes, provedor, estado/código e duração; não incluem carteiras, quantidades, prompts, payloads, URLs, assinaturas ou credenciais. Consultas de Bridge possuem um único orçamento remoto de 30 s, dentro do prazo de 45 s do card.

Jupiter mantém o contrato `purpose: QUOTE` já introduzido no #126; `SIMULATION` continua sendo o padrão dos clientes antigos. Nenhuma mudança nova no formato desse contrato ou migração de banco é necessária neste PR. Para um backend anterior ao #126, continua valendo backend-first; um backend antigo recusa `QUOTE` e o BFF falha fechado. Bridge reutiliza o método `discover` que já existe no backend de `01dbce43`.

## Evidência e limites de aceitação

- Determinísticos **MOCKED**: matriz de 20 direções × quatro combinações token/nativo, seleção por `nodeId` em composição, payload incompatível, recusas distintas e ausência de autoridade. Testes de hook cobrem respostas fora de ordem, pequena quantidade, mudança de destinatário/provedor/carteiras e expiração com renovação automática. Os testes existentes cobrem as edições repetidas de redes/ativos e os contratos dos leitores Swap.
- Chromium real, infraestrutura **MOCKED em loopback**: oito jornadas Bridge passaram, incluindo chat PT/EN, seleção independente no Canvas, quantidade exibida exatamente igual à do endpoint, correlação, simulação, Review, autorização diagnóstica e acompanhamento/reconciliação. Transações desses testes pertencem somente aos simuladores. Não constituem execução financeira pública.
- Primeira verificação completa: types, lint, build de produção, 11 schemas e **5.311 testes unitários passaram; dois foram pulados**. Verificação final: **5.313 testes unitários passaram, dois pulados**, além de types, lint, build e 11 schemas. As duas recusas adicionais de símbolo estão incluídas.
- Provedores **reais, PUBLIC_READ_ONLY**: [matriz Bridge](live-bridge-estimates.json) e [matriz Swap](live-swap-estimates.json). Sem carteira, assinatura, banco de produção ou submissão. A matriz Bridge observa as 20 direções com stable/nativo; um estado `EXECUTABLE` de descoberta significa verificação do builder, nunca simulação/Review ou execução concluída. Recusas, rate limits e provedores sem suporte ficam registrados por candidato.

**Base USDC → Arbitrum WETH apresentou `LIVE_QUOTE` na evidência anterior preservada do #126, não execução certificada. Este PR não converte esse fato em certificação financeira.** A nova matriz usa as combinações stable/nativo que seus registros identificam; ETH nativo não é apresentado como WETH.

**Aceitação hospedada ainda pendente.** Não houve deploy autorizado da alteração, portanto a comparação navegador/backend acima é local e não certifica o build em um ambiente hospedado. Antes da aceitação pelo owner, um preview isolado deste commit precisa comprovar estimativas e recusas no navegador contra o backend efetivamente hospedado. CI verde, testes MOCKED e cotações públicas de leitura não substituem essa etapa. Não se declara GO de aceitação final nem execução financeira pública certificada.

Fechamento das consultas públicas no código final: **70/80 estimativas Bridge disponíveis**, seis estados `SUPPORTED_BY_PROVIDER` sem cotação e quatro indisponibilidades temporárias; **13/14 estimativas Swap disponíveis**, uma recusa `JUPITER_RATE_LIMITED`. Uma primeira observação havia obtido 80/80: a disponibilidade variou durante a sessão, e a evidência final preserva as recusas observadas, sem substituir respostas por MOCKED. As 94 observações finalizaram e passaram nas verificações de integridade do payload; isso não significa que as 94 tinham cotação disponível. [Fingerprints dos fontes](SOURCE-FINGERPRINTS.json).

Evidência visual do build final (infraestrutura MOCKED, idioma da interface EN; prompts PT e EN): [Build/prompt PT](build-estimate-pt.png), [Build/prompt EN](build-estimate-en.png), [Review/prompt PT](review-pt.png), [Review/prompt EN](review-en.png). O Review de engenharia MOCKED não habilita a autorização do produto público; não é certificado financeiro. O perfil final de oito jornadas passou novamente após a captura.
