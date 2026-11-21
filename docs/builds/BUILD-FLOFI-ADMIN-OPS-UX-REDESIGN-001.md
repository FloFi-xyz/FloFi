# BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001

Base auditada em 20–21 de novembro de 2026. O HEAD inicial era `a13f824ab0a09f8b4cd0afa4e6f64f1ad7e3270e`. A auditoria de produção leu projeções, tentativas, filas, evidências e o ledger de migrações por `SELECT`. As consultas on-chain foram somente leitura. Os testes de execução usaram dados de loopback e carteiras descartáveis.

## Correções e regressões

| Área | Causa | Correção e cobertura |
| --- | --- | --- |
| Seus fluxos | O diálogo deixava o erro no estado do botão. Ao fechar, a mesma mensagem voltava como um alerta absoluto fora do menu. Os ouvintes de Escape e clique externo só cuidavam do menu. | Cancelar e Escape limpam a recusa e devolvem o foco. A recusa fica no diálogo enquanto ele está aberto. Uma falha de arquivo recebida após fechar o menu é anunciada e sinalizada no botão desse registro, com a mensagem disponível ao reabrir. `owner-history.spec.ts` cobre duas linhas, teclado, clique fora, arquivo e respostas tardias. |
| Exclusão | O estado atual do fluxo omitia autorizações antigas. Todos os bloqueios retornavam o mesmo código. Rascunhos removidos também podiam voltar por uma gravação com versão zero. | A autorização continua a depender do predicado SQL integral. Após a recusa, a resposta pode explicar autorização persistida, atividade ou dependência demonstrável no escopo do proprietário. Um resultado inconclusivo usa a orientação para arquivar. A gravação nova e a exclusão de um rascunho usam o mesmo lock por tenant, proprietário e ID. Um replay de gravação para um ID excluído retorna `WORKFLOW_NOT_FOUND`. Cobertura em `owner-history.pg.test.ts`, `saved-workflow-store.pg.test.ts`, `owner-history-compatibility.pg.test.ts` e `uniswap-position-purge.pg.test.ts`. |
| Admin Ops | O resumo misturava a saúde dos serviços com contagens operacionais e apresentava métricas secundárias antes dos destinos de ação. | Navegação por finalidade com menu móvel de teclado, saúde e incidentes primeiro, três números principais de execução e resumo financeiro com qualidade explícita. Gráficos e detalhes continuam na página. `admin-console.spec.ts` verifica a navegação, os resultados, a tabela numérica e o seletor móvel. |
| FinOps | Um documento longo colocava importação atrás de duas expansões. Falha de leitura da configuração podia parecer falta de ativação. | Quatro áreas com período preservado. A ação CSV abre diretamente o formulário para operadores. A tabela mantém moeda original, fonte FX e a qualidade do registro. O estado do provedor diferencia esquema ausente e leitura indisponível. O cálculo contábil, a precedência, a política de taxas, o CSV para investidores e a impressão preservam os contratos existentes. Cobertura em `admin-console.spec.ts`, `finops-views.test.tsx` e `finops.pg.test.ts`. |
| Incidentes | A triagem consultava divergências sem flag apenas no recorte de falhas recentes. Uma atualização de registro também podia parecer uma verificação de rede. | As quatro telas usam o mesmo ciclo persistido. Mainnet e ambientes não identificados têm prioridade na triagem. A auditoria de Testnet/Devnet/MOCKED permanece acessível. O centro separa aberto, em investigação, aguardando evidência, histórico e resolução verificada. Exibe fonte indisponível, incerteza financeira, evidência e ação segura. Cobertura em `lifecycle.test.ts`, `support-http.pg.test.ts` e `admin-console.spec.ts`. |

## Incidentes verificados em produção

Os identificadores abaixo abrem o diagnóstico para operadores autenticados. Verificação consultada em 20–21 de novembro de 2026 UTC.

| Caso | Classificação atual e evidência | Próxima ação |
| --- | --- | --- |
| [Universal](https://flofi.xyz/admin/support/incident?id=run%3Axuni-379461c2e3f1807a0dc0455342a51d21) | **Aguardando evidência externa. Resultado financeiro UNKNOWN.** Uma tentativa de `APPROVAL` permanece sem hash e sem evidência financeira. Duas tarefas anteriores encerraram com 500 entregas cada. Na releitura, a tarefa atual estava `READY` com 222 entregas. O diagnóstico persistido registrou `RPC_UNAVAILABLE`, 633 investigações e nenhuma verificação independente bem-sucedida na primeira consulta. O RPC público confirmou a transação conflitante no bloco canônico Base 53.204.924, já finalizado. Era uma transação tipo `0x2` de uma conta com delegação EIP-7702. O calldata aprovava outro spender e o recibo não continha a aprovação revisada. A busca de logs da aprovação para o spender revisado, a partir do bloco preparado 53.176.562, foi recusada pelo RPC inclusive para um único bloco. Nenhuma tentativa posterior está registrada. | Verificar no RPC da Base a leitura dos recibos finalizados e de logs históricos com os filtros de endereço, proprietário e spender revisado. Completar a busca por nonce alternativo e registrar os achados. [Transação conflitante](https://basescan.org/tx/0x236d2c4fcb9ac8e5c49c31bdf0a14d0a35ee9474cb9f4f0657b7e49e04b139d4) |
| [Router](https://flofi.xyz/admin/support/incident?id=run%3Axroute-a09617c2bb8ac5469cab1fc955a3fd32) | **Estável, requer investigação do operador. Resultado financeiro UNKNOWN.** A tentativa de `APPROVAL` do nonce 29 está sem hash e sem evidência financeira. A transação conflitante finalizada em Arbitrum One no bloco 521.333.809 tem calldata, spender e valor de aprovação diferentes. O diagnóstico registrou conta delegada EIP-7702, efeito revisado ausente no recibo e vínculo por hash exato com uma aprovação confirmada de outro workflow. A busca por nonce alternativo chegou ao bloco finalizado 524.925.107 sem candidato e não havia tentativa posterior. O diagnóstico teve 65 observações estáveis. Após o esgotamento inicial de 500 entregas, tarefas de 145, 1 e 2 entregas pararam com `NONCE_CONFLICT_STABLE_OPERATOR_REVIEW`. A última verificação independente foi em 17 de novembro às 03:24 UTC. | Registrar a revisão do recibo e do intervalo verificado. Uma nova verificação somente leitura é elegível conforme a política de recuperação, quando houver evidência nova. [Transação conflitante](https://arbiscan.io/tx/0xd7c93de487dd07550f119597b94f94e27c7303cbce547bb6939c829597fea223) |
| [Jupiter](https://flofi.xyz/admin/support/incident?id=run%3Ajupiter-afb4e4129e0bcbaa279b6249de2393f3) | **Resolução verificada do incidente de arquivo. Execução RECONCILED.** A tentativa de swap contém assinatura, está confirmada e reconciliada. A tarefa `evidence.archive` parou após 500 entregas em 22 de outubro. O registro durável do arquivo, de 25 de outubro, tem hash de conteúdo, 69.063 bytes e veredito `RECONCILED` de mainnet. `JUPITER_SEMANTIC_EDIT_REQUIRES_REVIEW` exige nova revisão do proprietário em uma execução futura. | Consultar a trilha caso necessário. A evidência de resolução é o registro do objeto arquivado e a projeção da tentativa. |
| [Uniswap](https://flofi.xyz/admin/support/incident?id=run%3Aunilp-65747007eabefc56a9ba99fa1a0e0305) | **Divergência antiga de Base Sepolia, disponível na auditoria de testnet.** Projeção `DIVERGENT`, código `UNISWAP_TRANSACTION_MISMATCH`, tentativa `APPROVE_TOKEN0` com hash e `RECONCILIATION_REQUIRED`. Sem evidência arquivada, observação ou tarefa de recuperação. A condição técnica permanece registrada. | Comparar o recibo ao que foi revisado caso a divergência de teste precise ser investigada. |

Uma aprovação conflitante finalizada, mesmo com outro spender, não prova que a tentativa original nunca chegou sob outro nonce. O worker já encerra operacionalmente uma investigação completa, estável por pelo menos quatro observações e com pelo menos 24 horas de idade. Um erro de leitura repetido pode aumentar a contagem de observações estáveis sem representar avanço na evidência. O Universal está nesse último caso. Encerrá-lo antes do limite normal impediria a observação automática caso o acesso aos logs voltasse. O build mantém o ritmo e o limite do worker. Foi reproduzida, com fixture, a perda do progresso de uma janela quando a próxima leitura falha dentro da mesma tentativa. Preservar esse progresso é uma correção separável e não resolveria a recusa da primeira consulta observada no RPC público.

## Registros “Não iniciado”

A consulta de leitura aplicou os bloqueios da migração 0016 e avaliou cada snapshot com a função instalada, em produção no schema certificado 30. A extensão 0031, certificada no código, amplia formatos de simulações de posição e preserva todas as verificações de autorização. Estas são as condições verificadas naquele momento. Uma solicitação real voltaria a validá-las sob lock.

| Execução | Resultado do predicado |
| --- | --- |
| `ars-35c52dc8d0fb18902d1fa47f` | `SIMULATED`. Um snapshot descartável, integridade confirmada e nenhum bloqueio encontrado. |
| `ars-c14cdbf355678f1e542d1e58` | `SIMULATED`. Um de três snapshots registra `reviewedManifestHash`. Preservar ou arquivar. |
| `xroute-20939022dcc719b40afd30dc56554c1b` | `PREPARED`. Um de três snapshots tem fase `AUTHORIZED` e autorização preenchida. Preservar ou arquivar. |
| `xroute-bc7b656a3a3b86f8481fdb98fb8b2178` | `PREPARED`. Um de três snapshots tem fase `AUTHORIZED` e autorização preenchida. Preservar ou arquivar. |
| `xroute-dd59a6a6508807f6ee5e599bee48f9aa` | `PREPARED`. Um snapshot descartável, integridade confirmada e nenhum bloqueio encontrado. |

O histórico de exclusão guarda o identificador mínimo e impede a recriação do registro. Respostas legadas de gravação de rascunho podem permanecer armazenadas internamente até a expiração da idempotência, ainda que o endpoint recuse devolver o documento excluído. A proteção no caminho de gravação exige que os processos que aceitam gravações executem a versão revisada.

## Evidência de navegador

As capturas foram geradas com fixtures e um PostgreSQL de loopback. Os perfis de certificação `admin-console` e `owner-history` armazenam as capturas posteriores em `playwright-results/admin-console` (shard 1) e `playwright-results/owner-history` (shard 5).

| Tela | Antes | Depois |
| --- | --- | --- |
| Overview desktop | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-overview-desktop.png) | [Resumo operacional](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-overview-desktop.png) |
| Overview móvel | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-overview-mobile.png) | [Resumo](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-overview-mobile.png) · [Menu](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-navigation-mobile.png) |
| FinOps desktop | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-finops-desktop.png) | [Áreas financeiras](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-finops-desktop.png) |
| FinOps móvel | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-finops-mobile.png) | [Visão financeira](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-finops-mobile.png) · [Importar CSV](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-finops-import-mobile.png) |
| Incidentes desktop | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-support-desktop.png) | [Triagem de produção](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-support-desktop.png) |
| Incidentes móvel | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-support-mobile.png) | [Auditoria de testnet](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-support-mobile.png) |
| Seus fluxos após clicar fora | [Alerta flutuante](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-history-mobile.png) | [Alerta limpo](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-history-mobile.png) |
| Recusa com diálogo aberto | [HEAD](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/before-history-dialog-mobile.png) | [Desktop](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-history-dialog-desktop.png) · [Móvel](BUILD-FLOFI-ADMIN-OPS-UX-REDESIGN-001/after-history-dialog-mobile.png) |

## Validação local

- `pnpm check` passou. Foram verificados build, lint, typecheck, 11 exportações de schema e 9.787 testes unitários, com dois skips previstos pelas suítes.
- PostgreSQL 18 UTF-8 passou com 946 testes. A repetição focada passou com 75.
- Chromium passou com 12 testes de Admin e 16 de histórico e dashboard. O teste focado de Suporte também passou no build final.
- O guard estrutural, os testes de CI e a governança local passaram. A certificação hospedada é a autoridade para a revisão.
- O Anvil fixado passou quatro testes de compatibilidade, com dez skips. A suíte local de forks parou na inicialização de loopback, onde a checagem de porta livre expirou também no HEAD auditado. O perfil local do Admin usou o servidor de produção e PostgreSQL de loopback sem inicializar o fork, pois suas telas e seus testes exercitam registros e sessões, sem acesso a RPC.
