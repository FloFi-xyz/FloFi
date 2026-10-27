# Exclusão segura do histórico de execuções

Branch independente `codex/build-safe-run-deletion`, baseada em `01dbce43` (merge #126). Nenhum merge, deploy, migração remota, limpeza de produção ou transação financeira foi realizado. O deploy automático desta branch fica desabilitado em `vercel.json`.

## Recuperação

O worktree `/tmp/flofi-safe-run-deletion` foi retomado com 19 arquivos modificados e sete novos, sem commit próprio. Todos os 26 arquivos originais foram preservados antes das edições em `/tmp/flofi-handoff-20261027-original-uncommitted.tar.gz`. Outros worktrees e alterações de terceiros permaneceram intactos; nenhum reset, clean, stash ou rebase foi executado nesta retomada.

Inventário inicial: `backend/app.ts`, `app/dashboard-action.ts`, `app/workflow-action.ts`, `components/app-shell.tsx`, `components/dashboard/{dashboard-view,dashboard-workspace,run-detail-view}.tsx`, `components/dashboard/run-detail-workspace.test.tsx`, `components/saved-workflows.tsx`, `components/history-actions.tsx`, `i18n/pt-product.ts`, `server/{flow-runtime,saved-workflow-store,owner-history,owner-history.test}.ts`, `state/saved-workflows.ts`, `workflow-runs/pg-store.ts`, `backend/owner-history.pg.test.ts` e `vercel.json` na aplicação; `src/{index,log-store,migrations,queries,owner-history}.ts`, `migrations/0016_owner_history_purge.sql` e `test/owner-history.pg.test.ts` em `packages/cloud-runtime`.

O teste integrado interrompido falhava com `RUN_NOT_FOUND`: o Swap Base usado pela fixture não registrava ownership na simulação. A correção usa o motor Arbitrum existente, cujo Review vincula a carteira; outro teste comprova que um histórico Base sem dono durável continua recusado. Não houve adoção retroativa de registros por uma carteira apresentada pelo navegador.

## Auditoria remota de leitura

As consultas foram exclusivamente `SELECT`, com projeto e branch de produção explícitos. Nenhum payload financeiro, endereço de carteira ou credencial foi copiado para estes documentos.

| Observação UTC em 2026-10-27 | Execuções | SIMULATED | Saved workflows |
| --- | ---: | ---: | ---: |
| 01:48:03 | 56 | 31 | 0 |
| 02:07:02 | 57 | 32 | 0 |

A segunda observação encontrou 36 candidatos **preliminares** usando ausência de tentativas, evidências projetadas, observação, atenção e recuperação. Todos têm segmentos; cinco têm journal; nenhum tem trabalho READY/LEASED diretamente associado. Apenas 12 têm dono durável; 24 não têm. Dois desses candidatos têm journal com estados financeiros (`AUTHORIZED`, `EXECUTING` ou `READY`). Portanto, nem 39 da auditoria histórica nem 36 desta consulta são uma lista aprovada para exclusão. Cada pedido é revalidado dentro da transação, incluindo todos os snapshots e referências indiretas. As contagens podem mudar com o uso normal da aplicação.

Foram inspecionadas as FKs de segmentos, runs, tentativas, journal, evidências e recuperação; os triggers append-only existentes; leases, fila, idempotência, handoffs MCP, passos compostos, automações e execução delegada. Reservas econômicas em logs `INTENT` também impedem exclusão, inclusive quando não há tentativa projetada.

## Comportamento e limites

O Dashboard e os detalhes oferecem **Delete** com confirmação e **Archive**, em EN/PT. A biblioteca usa o mesmo serviço para seus registros. A sessão verificada no servidor é a autoridade; a carteira enviada pelo browser é apenas uma verificação de consistência. O backend mantém a autenticação bearer existente e não aceita ownership pelo corpo do pedido.

`purge_unstarted_execution` verifica tenant, dono, estado, dependências e a integridade SHA-256/versão/sequência do log. Todos os snapshots históricos precisam passar pela classificação conservadora. Autorizações, tentativas, transações, evidências, pendências, recuperação, formatos desconhecidos ou campos financeiros ambíguos são preservados. Composições com lifecycle próprio não são declaradas seguras a partir do estado de um run convencional: permanecem arquiváveis, sem uma exceção genérica aos seus triggers.

Uma exclusão aprovada remove realmente `execution_runs`, `execution_logs`, todos os segmentos correspondentes, journal não financeiro e trabalhos terminais associados. Respostas idempotentes antigas são invalidadas. Permanecem apenas o tombstone/auditoria mínima (identidade, dono, hash e contagens), os eventos de histórico e a identidade compartilhada do workflow. Nenhum conteúdo do workflow, assinatura ou bytes do log ficam nessa auditoria.

Os triggers nunca são desabilitados. A exceção limitada de DELETE requer uma capability privada da mesma transação, criada somente pelo procedimento após as verificações. Os demais UPDATE/DELETE append-only continuam recusados. Funções privilegiadas têm `search_path` fixo com `pg_temp` por último e EXECUTE público revogado, conforme a [orientação oficial PostgreSQL](https://www.postgresql.org/docs/18/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY). A conta de aplicação é uma conta de servidor confiável; credenciais de banco nunca são entregues ao usuário final.

Escritores de logs e referências de fila/handoff/composição/delegação/lease/idempotência serializam com a exclusão. Um escritor anterior faz a exclusão reavaliar sua dependência; um escritor posterior encontra o tombstone e não pode recriar o run, seus bytes, sua reserva ou trabalho. Testes com duas transações controladas cobrem ambas as ordens para referências indiretas sem FK. Conflitos com novas dependências protegidas por FK revertem integralmente a exclusão.

Arquivar grava apenas a visibilidade do dono. Preserva logs, evidências, autorização, observação e reconciliação; os leitores operacionais por fluxo continuam incluindo arquivados. A biblioteca permite arquivar entradas de workflows executados mesmo sem rascunho salvo. Refresh, troca de carteira e respostas atrasadas respeitam o escopo do dono. Respostas incompletas, incompatíveis ou recebidas em erro HTTP não confirmam exclusão.

Criação e simulação não foram bloqueadas. Mainnet-only público, slippage padrão de 100 bps, fee de 0,1% por workflow e a exceção `fast-uri@3.1.9` permanecem. O lockfile não foi alterado. Dados sintéticos pertencem somente aos testes; nenhum MOCKED foi introduzido no produto público.

## Verificação

- Suíte PostgreSQL completa final, bancos descartáveis em loopback: **505 testes passaram, três pulados; 80 arquivos passaram, um pulado**. Log `/tmp/flofi-recovery-build2-postgres-final.log`. A rodada anterior tinha 504 aprovações; o caso adicional protege trabalho terminal compartilhado.
- Focados PostgreSQL: **19 testes passaram**, incluindo o motor financeiro real com RPC sintético, exclusão autenticada, nova instância, checksum, append-only, ownership, intents e duas ordens de concorrência. Log `/tmp/flofi-recovery-owner-focused-final.log`.
- `pnpm check`: types, lint, build de produção e 11 schemas passaram; **5.221 testes unitários passaram, dois pulados**. Log `/tmp/flofi-recovery-build2-check4.log`.
- O primeiro teste Chromium de exclusão passou com remoção de bytes, refresh, nova sessão e carteira diferente. A primeira configuração regenerava o nome do banco no worker e foi corrigida para herdar o banco preparado pelo global setup. O caso de arquivamento exigiu aguardar a verificação após trocar de carteira. Nenhuma proteção de produção foi relaxada para corrigir essas fixtures.
- Rodada final no build com a identidade definitiva de `0016`: **nove casos Chromium passaram** (três jornadas com servidor/ações/backend/PostgreSQL reais e seis regressões de apresentação do Dashboard em fixtures isoladas). Log `/tmp/flofi-recovery-history-browser-sealed.log`. A confirmação PT em largura de 390 px foi inspecionada visualmente: [captura](delete-confirmation-pt.png).
- Recompilação final de produção: **nove tarefas passaram**, incluindo TypeScript do Next.js. Validação adicional dos componentes/servidor/manifesto: **15 testes passaram**; o manifesto final também passou em dois testes após o ajuste de hash. Governance-lite e seus **19 self-tests** passaram.

A revisão final acrescentou a preservação de trabalhos terminais pertencentes a outro run que referenciem o run selecionado: somente trabalho terminal diretamente associado pode ser removido. O teste novo também fixa `completed_at`, obrigatório no schema para trabalho DONE. A primeira repetição PostgreSQL começou antes da recompilação e alguns processos carregaram o manifesto anterior; a recusa `MIGRATION_HISTORY_MISMATCH` ficou preservada em `/tmp/flofi-recovery-build2-postgres-before-sealed-build.log`. A rodada final, iniciada depois da compilação, é registrada separadamente.

Essa rodada final concluiu com sucesso: **505 passed / 3 skipped**, sem alteração do código durante sua execução. Os [fingerprints dos fontes](SOURCE-FINGERPRINTS.json) e os [registros de validação](VALIDATION.json) vinculam os arquivos e logs finais. A implementação continua sem aceitação de implantação em produção.

As dependências herdadas apontavam para outro worktree e eram recusadas pelo Turbopack. Foram reinstaladas nas versões exatas do lockfile em `node_modules/.pnpm-isolated`; nenhum pacote/versionamento foi mudado. O pnpm local usa `pnpm_config_verify_deps_before_run=false` para evitar que seu instalador automático substitua esse layout de engenharia; os gates de dependências e o lockfile do projeto são preservados.

## Implantação ainda não autorizada

A migração `0016` não foi aplicada ao Neon. Um processo anterior sem certificado não aceita automaticamente um schema mais novo. Esta alteração exige uma estratégia explícita de compatibilidade/coordenação entre API, worker e BFF, validada num banco isolado antes de qualquer rollout. Não se deve aplicar a migração pela console, promover este PR ou confiar num rollback de aplicação antiga contra o schema novo sem essa validação. A publicação de um PR não autoriza migração nem deploy.

O PR #127 de estimativas continua independente; este build não incorpora seus commits. A aceitação hospedada do #127 também continua pendente de autorização de preview. Os testes locais não certificam produção nem execução financeira pública.

Consulta read-only à Railway confirmou API e worker ainda vinculados a `codex/hotfix-universal-bridge-e2e` no commit `67064ac4e3c0eedb3709f2d4c085570b9fcda3a4`, sem alterações staged. Publicar esta branch não altera essa configuração.

## Integração com o ledger de CI

O primeiro governance do PR #128 recusou a versão inicial. A reprodução do comando do job identificou expectativas fixas de 48 perfis nos self-tests de orquestração, enquanto o novo perfil `owner-history` torna o total 49 (produto + composição). Outro self-test de duplicidade procurava a antiga última linha do plano. As expectativas foram atualizadas para 49 e a mutação adversarial passou a duplicar um perfil pela declaração estável de `critical`. A recusa de perfis ausentes/repetidos e todos os gates permanecem ativos.

`python3 -m unittest discover -s scripts -p 'test_ci_*.py'`: **56 testes passaram**. Esta correção altera apenas os self-tests de CI e os registros; o código da aplicação, a migração e o build aprovado pelas nove jornadas Chromium permanecem iguais. A rodada remota do novo commit deve ser acompanhada separadamente; uma reprodução local não é apresentada como aprovação remota.

## Fechamento técnico: rollback e integração com #127

Todos os cinco contextos CircleCI de `b3abf1185291b0597307278d8b4c135384726965` concluíram com sucesso no workflow
`d264c846-1502-48cc-879f-84e39eb1283f`. Os commits finais aditivos exigem nova verificação remota.

`FLOFI_OWNER_HISTORY=read-only` suspende somente as mutações DELETE/ARCHIVE e devolve `HISTORY_READ_ONLY`, com mensagem PT/EN.
Consultas de disposição, máscaras de arquivamento, tombstones, observação financeira, criação e simulação continuam disponíveis.
O teste real de backend/PostgreSQL comprova a recusa das duas mutações, preservação do registro e leitura normal; o backend ativo depois
exclui realmente o mesmo registro. Os **dez testes focados de backend PostgreSQL e BFF passaram**, assim como TypeScript completo e lint.

A migração 0016 permanece byte a byte igual, SHA-256 `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f`.
O #127 acrescenta o certificado de schema 16 ao backend de schema 15, com fixture exata e testes reais de compatibilidade, cold start,
rollback atômico e recusa de ressurgimento. A sequência backend A → 0016 → backend B em read-only → frontend B e os limites de rollback
estão no [plano único de publicação](https://github.com/alrimarleskovar/FloFi/blob/codex/p0-shared-estimates/docs/deploy/RELEASE-127-128.md).
Após exclusão ou arquivamento, preservar os leitores B e os tombstones; não remover a migração nem restaurar identidades excluídas.

Após reinício do ambiente, o worktree temporário foi recomposto do commit existente, as seis alterações finais foram reaplicadas e
verificadas, e a mesma branch foi transferida para `/home/asus/projects/flofi-safe-run-deletion` com `git worktree repair`.
Nenhum branch/commit foi descartado. Não houve merge, deploy/migração em produção ou transação financeira pública.
