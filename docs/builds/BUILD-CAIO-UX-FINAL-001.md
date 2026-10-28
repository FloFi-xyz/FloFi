# BUILD-CAIO-UX-FINAL-001

Branch normal: `codex/build-caio-ux-final-001`, no checkout existente `/home/asus/projects/gryloo`. Base `origin/main` / `de7d5fb11a02b86b85155178dec4165be60abb17`, merge do PR #131. Fetch inicial não encontrou commits posteriores. Nenhum clone, worktree ou outro checkout foi criado. Alterações preexistentes de `next-env.d.ts` e `.gitignore` foram copiadas para preservação e excluídas dos commits.

## Implementação

A simulação apresenta valores de entrada e saída estimada com suas redes, mínimo recebido e validade. Taxas, slippage, riscos e indisponibilidades continuam visíveis. O orçamento de rede já fornecido pelo preflight de Swap aparece como limite da próxima transação revisada, sem inventar um custo total do workflow. A rota detalhada usa expansão nativa. O resumo ocupa a primeira posição visual e de leitura; o Canvas continua disponível e opcional.

Execute, histórico e assinatura conversacional compartilham `FinancialOutcome`: valores canônicos observados, custos conhecidos e allowance, sem substituir resultados por cotações. Na bridge dirigida, uma entrega segura ainda não reconciliada aparece como valor observado aguardando conferência, como já ocorria na bridge universal. Isso não altera a reconciliação. Contratos de USDC são resolvidos pelo catálogo oficial da rede/endereço: nativo e USDC.e não são renomeados globalmente por símbolo.

A timeline usa `projectBridgeProgress` e `BridgeTimeline` para separar autorização, envio, confirmação da origem, transferência, entrega e conferência final. Uma rota sem aprovação não inventa essa etapa. Hash, finality e bundle são fatos separados; hint do provedor, timeout ou RPC indisponível não concluem a operação. Provas e links permanecem expansíveis. Os estados e controles originais da execução continuam disponíveis.

O Canvas mantém pinch e pan por toque, pan por botão do meio/Space e controles explícitos de zoom, 100% e ajuste ao conteúdo. A roda rola a página por padrão; o botão acessível de navegação ativa zoom no cursor e Shift + roda para pan. Esc retorna à rolagem da página. Não se tenta adivinhar o dispositivo por deltas de wheel. Formulários e controles com `nowheel` conservam sua interação. Navegar só altera o viewport.

Os cards do histórico mostram tipo, estado, data/hora e valores disponíveis sem repetir hashes e marcadores técnicos. Para registros que só têm resumo no índice, expandir carrega o mesmo detalhe autorizado, uma vez por versão do card, sem N+1 na carga inicial. Respostas de outra carteira/versão são recusadas; atualizar o histórico invalida a projeção antiga. Paginação, tombstones, archive/delete, nonce e isolamento não foram alterados. Não há migração.

## Auditoria das 23 ocorrências

Fontes: handoff original em `/tmp/flofi-caio-handoff.txt`, 12 capturas originais E01–E12 em `/tmp/flofi-caio-originals`, relatório e manifesto do PR #131. As capturas originais com dados reais permanecem privadas. A coluna de evidência aponta para regressões de engenharia; a certificação completa do SHA final é publicada no PR, após os gates. Não se confunde cobertura de teste com uma nova transação real.

| ID | Sintoma original | Disposição | Evidência / regressão |
| --- | --- | --- | --- |
| BUG-001 | Cancelled bridge has no specific cause despite earlier approval | Preservado; validação pelos gates existentes | router-service rejection/revert/partial tests; execution-evidence; bridge-wallet-result; router PostgreSQL |
| UX-002 | Bridge arrow does not invert | Preservado; validação pelos gates existentes | bridge-inversion (including explicit token addresses); canvas-corrections browser journey |
| UX-003 | Simulation visual hierarchy | Implementado | simulation-summary; simulation-presentation; caio-ux-final browser: entrada/saída, redes, mínimo, validade, custos e alertas. |
| UX-004 | Expected destination amount unavailable or unclear | Preservado; validação pelos gates existentes | build-estimate and shared quote regressions; Bridge browser profiles; incident min=actual received |
| UX-005 | Technical sidebar too dense | Implementado | simulation-summary, review-workspace, signing-surface, execution-timeline: rota/contratos/identificadores em disclosures; allowance, custos e riscos visíveis. |
| BUG-006 | Simulation disabled with no actionable cause | Preservado; validação pelos gates existentes | simulation-unavailable; lifecycle; browser authoring and dashboard navigation |
| UX-007 | “Simulate workflow” purpose unclear | Preservado; validação pelos gates existentes | Catalog and authoring/lifecycle tests |
| UX-008 | Wheel pans instead of zoom | Implementado | canvas-navigation unit; canvas-navigator component/browser; caio-final-ux: zoom no cursor, pan explícito, scroll da página, teclado, toque/pinch, nodes preservados. |
| UX-009 | Final execution screen feels technical | Implementado | financial-outcome, execution-evidence/result, execute-workspace, run-detail-view: fonte/destino efetivos, valores observados separados dos finais, custos conhecidos. |
| BUG-010 | Dashboard/history loads slowly | Preservado; validação pelos gates existentes | Real PostgreSQL 75-record test; data-service 75-record test; dashboard-final-acceptance pagination/owner browser tests |
| BUG-011 | Terminal execution shown running | Preservado; validação pelos gates existentes | run-mapping; canonical lifecycle; Dashboard/Execute regressions |
| UX-012 | Oversized repetitive activity cards | Implementado | dashboard-view/workspace; dashboard-final-acceptance: cards compactos, leitura sob demanda por expansão, 25 registros/cursor e isolamento mantidos. |
| UX-013 | Internal/English strings in PT-BR | Preservado; validação pelos gates existentes | i18n/catalog extracted product strings and financial outcome matrix; bilingual browser profiles |
| UX-014 | History titles omit operation type | Preservado; validação pelos gates existentes | run-mapping and Dashboard rendering tests |
| BUG-015 | MetaMask cancellation blocks builder | Preservado; validação pelos gates existentes | wallet-request-lifecycle; wallet-review-continuity; execution-controls timeout; cloud report/persistence tests |
| UX-016 | Wallet feedback distant and untranslated | Preservado; validação pelos gates existentes | Wallet/Execute browser profiles; i18n financial message tests |
| BUG-017 | Recovery produces no understandable result | Preservado; validação pelos gates existentes | Two new tests fail on ab7815f and pass with fix; router PG restart; read-only incident copy RECONCILED |
| BUG-018 | Unclear source debit, credit, gas and allowance | Preservado; validação pelos gates existentes | execution-evidence, source receipt tests, isolated incident bundle |
| UX-019 | Technical record lacks explanation | Preservado; validação pelos gates existentes | financial-observation, execution-recovery, catalog, saved record projection |
| BUG-020 | PREPARED with zero attempts shown running | Preservado; validação pelos gates existentes | run-mapping; execution-lifecycle; prepared/no-attempt browser cases |
| UX-021 | Bridge timeline hierarchy | Implementado | bridge-progress unit; BridgeTimeline compartilhada em ExecutionTimeline e assinatura conversacional; confirmação exige evidência/finality, autorização somente quando presente. |
| UX-022 | Status refresh wording/feedback unreliable | Preservado; validação pelos gates existentes | execution-controls timeout/stale response tests; catalog; recovery browser profiles |
| UX-023 | Source confirmation confused with destination delivery | Preservado; validação pelos gates existentes | router-service delayed fill/finality/refund tests; router PG restart; actual incident local reobservation |

## Evidência financeira real, somente leitura

Em 2026-10-28, foram reconsultados os recibos mainnet Base → Arbitrum do incidente do PR #131 e o status LI.FI. Ambos os recibos retornaram status 1, abaixo do head finalized; o provedor retornou DONE/COMPLETED e o mesmo hash de destino. A transação histórica foi simulada por `eth_call` no bloco anterior à inclusão, com sucesso, sem transmissão ou alteração de estado. O manifesto registra o digest do retorno.

Os valores 1 USDC debitado / 0,988966 USDC recebido vêm da evidência block-pinned já publicada no PR #131; esta rodada não reconsultou esses saldos. [Manifesto desta rodada](BUILD-CAIO-UX-FINAL-001-EVIDENCE.json). Nenhuma carteira foi solicitada e nenhum banco/ambiente de produção foi alterado.

## Comparativo visual

As capturas abaixo usam apenas fixtures determinísticas isoladas. Não são telas de produção nem dados apresentados a usuários. O bundle anterior lê os módulos de `origin/main` por `git show`, em memória; o posterior lê os arquivos atuais, com os mesmos componentes, fontes locais e dados de teste. O build público não importa os harnesses. A evidência visual não substitui os testes financeiros.

| Área | Antes | Depois |
| --- | --- | --- |
| UX-003 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-simulation.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-simulation.png) |
| UX-005 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-technical.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-technical.png) |
| UX-008 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-canvas.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-canvas.png) |
| UX-009 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-execution.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-execution.png) |
| UX-012 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-history.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-history.png) |
| UX-021 | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/before-bridge.png) | [Captura](../../apps/reference-dapp/e2e/visual-evidence/build-caio-ux-final-001/after-bridge.png) |

## Testes e certificação

Foram acrescentados testes de projeção financeira/bridge, identidade de USDC, navegação, componentes, traduções e navegador EN/PT-BR, desktop/mobile, teclado e toque. O perfil obrigatório `caio-final-ux` foi adicionado ao runner existente e ao ledger, preservando todos os 49 perfis anteriores: são agora 50 perfis. Os autotestes de orquestração foram elevados para exigir os 50. Nenhum gate foi removido, nenhum teste foi pulado e nenhuma política financeira foi flexibilizada.

Comandos centrais: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm schemas:check`, `pnpm test`; PostgreSQL, Anvil/forks, segurança, auditoria de dependências, integridade/licenças/idade, SBOM, governance e todos os perfis de browser seguem a configuração CircleCI existente. As falhas intermediárias permanecem nos logs de diagnóstico. O resultado definitivo e os links por job/SHA ficam no relatório de certificação do PR; uma rodada parcial nunca é apresentada como certificação verde.

## Riscos residuais e rollback

Disponibilidade do RPC/provedor permanece uma condição real. Valores sem prova continuam desconhecidos. Um registro histórico reduzido pode não conter tokens ou valores; o card permite consultar o detalhe sem fabricar os dados ausentes. Os testes de touch/mobile usam Chromium com emulação; não constituem aceite em hardware de todas as carteiras ou navegadores.

A política FloFi de 0,1% por workflow, slippage, autorizações, assinaturas, execução duplicada, nonces, reconciliação e guardas mainnet-only não foram alteradas. Chat/MCP/canais usam o fluxo completo existente; Canvas permanece opcional.

Rollback: reverter os commits deste PR pelo processo normal de revisão/release, sem tocar nos dados. Não apagar tentativas, evidências, ponteiros incertos, histórico nem tombstones. Manter o PR #131 e as proteções de recuperação. Não existe migração a reverter. Branch com deploy Git desabilitado pelo mecanismo existente; nenhuma merge ou publicação é automática.
