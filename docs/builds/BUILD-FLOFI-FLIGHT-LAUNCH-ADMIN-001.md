# BUILD-FLOFI-FLIGHT-LAUNCH-ADMIN-001

Base: `origin/main` `509b7ac67fb7006632b93dee4a0902a6e72b068f`, sincronizada em 10/11/2026.
Branch: `codex/flight-launch-admin-20261110`. Worktree independente em `/tmp/flofi-flight-launch-admin`.
A branch `qa/flight-20261110` e sua alteração local em `.gitignore` foram preservadas. Não foram lidas/reutilizadas credenciais QA.

## Recuperação da sessão em 10/11/2026

A worktree real encontrada foi `/tmp/flofi-flight-launch-admin`; o caminho `/home/asus/flofi-flight-launch-admin` do handoff não existia.
A branch esperada estava em `509b7ac6`, sem commits adicionais, sem staged changes e com a implementação abaixo ainda não commitada.
O diff completo e os arquivos novos foram preservados em backup local antes de qualquer edição. A consulta GitHub não encontrou PR anterior.
`git fetch origin main` confirmou a mesma base; não houve integração automática, reset, clean ou alteração na worktree QA.

| Frente recuperada | Estado na chegada | Conclusão desta retomada |
| --- | --- | --- |
| Admin Flight, API, filtros/CSV e testes | Implementado sem commit | Revisado; adicionados totais da lista aguardando/aptos, também para VIEWER |
| Login recorrente e isolamento de claims | Implementado com testes | Revisão independente de segurança/workflow e regressões confirmadas |
| Templates EN/PT e dispatch v1/v2 | Implementado com fonte extraída | Renderer v1 comparado byte a byte à main; regressões confirmadas |
| Menu, legal, navegação e estilos | Implementado | Unidades D/H/M do contador também brancas; verificação browser ampliada |
| Convites e emissão | Regras existentes preservadas | Nenhuma alteração de regras ou operação hospedada |
| Recebimento Gmail | Runbook pronto | Bloqueio externo: conta, alias, DNS e teste de recebimento |
| Preview | Banco isolado e valores exclusivos preparados localmente | Configuração Vercel limitada à branch; aplicação Privy exclusiva a configurar pelo proprietário |
| Entrega GitHub | Sem commit ou PR | Commit/PR e estados hospedados finais são vinculados no PR |

Revisões desta retomada: Admin, segurança, frontend, dados/privacidade/e-mails, infraestrutura/CI e workflow, em lotes de até três,
somente leitura. Achados resolvidos: total aguardando para VIEWER e cor das unidades do contador. Sem achados concretos de segurança ou
de autorização financeira. A consulta de métricas reutiliza `outbox.status()`, incluindo sua inicialização existente do registro de controle
quando ausente; não agenda nem envia mensagens e não modifica controles já existentes.

## Matriz de requisitos

| Requisito | Já implementado | Corrigido / novo neste build | Pendente externo |
| --- | --- | --- | --- |
| Admin existente | SIWE EIP-4361, sessões, VIEWER/OPERATOR, auditoria, tenant PostgreSQL | Entrada Flight FloFi e `/admin/flight`; nenhuma autenticação paralela | Aceite do OPERATOR no Preview com banco próprio autorizado |
| Métricas reais | Ledger de emissão e estados da outbox | FIRST/NEXT,24h,dias/acumulado,PT/EN,grupos,embarques,lista aguardando/aptos,Founding/disponíveis,Passenger,convites e e-mails | Comparação operacional com dados Neon autorizados |
| Lista | `flight_list_entries` | Busca, filtros combináveis, datas UTC, ordenação estável, paginação servidor até100, atualização por consulta | Nenhuma fonte fictícia no runtime |
| PII e CSV | Guard/sessão/CSRF/audit existentes | Somente OPERATOR; POST com busca no corpo; exportação filtrada até10.000 ou recusa; CSV formula injection neutralizada; auditoria obrigatória sem endereços | Verificação operacional da política de logs do host |
| Proteções HTTP | Headers sensíveis de `/admin` | no-store/noindex/no-referrer/nosniff; nenhum código/token/credencial projetado; VIEWER recebe apenas agregados | Nenhuma lista no dashboard público |
| Motor de e-mails | Resend + Railway worker + CLI, quotas, leases, suppression, UNKNOWN/idempotência | Consulta reutiliza outbox; sem botões de envio, reenvio ou calendário | Limites reais da conta e entrega em caixas reais |
| Login recorrente | Privy verifica identidade; claims por tenant/conta no PostgreSQL | Board now persiste também vínculo via e-mail já verificado; carteira da mesma conta recupera sem e-mail; Email3 antes do login continua no Privy | Aceite com carteira/extensão e dispositivo reais |
| Segurança do vínculo | Tokens únicos/expiração/rate limits e provas server-side | Outra conta com mesmo e-mail verificado não usa claim alheio; locks protegem claim/emissão; cartão Admin respeita conta vinculada | Nenhuma nova autoridade financeira |
| Oito templates EN/PT | HTML/plain text, idioma, links/códigos | PT da fonte fornecida, rodapés por estágio, @, login carteira/recuperação, Email6 depois da primeira rota, idioma registrado na recuperação | Inspeção visual Gmail/Outlook com envio autorizado |
| Compatibilidade de e-mails | Cada outbox guarda template_version | v1 congelada byte a byte, dispatch pela versão persistida; novas mensagens v2; versão desconhecida recusa; SENT não é reenviado | Mensagens v1 já pendentes mantêm texto antigo; rollout coordenado do worker obrigatório |
| Cartões Email4a/4b | PNG servidor compartilhado com página pública,528px responsivo/download; emissão idempotente,100 assentos | Preservado; preheader não promete3convites a Founding convidado sem propagação | Renderização de imagem em cliente de e-mail real |
| Encaminhamento | Reply-To Gmail já configurado para saída | Auditoria DNS pública e runbook ImprovMX Free/Vercel separado | Conta/alias/confirmação Gmail/DNS e recebimento de teste; **não ativo** |
| Painéis aeroportuários | Componentes/identidade visual existentes | Letras e indicadores brancos, preservando animações/reduced motion | Auditoria completa de dispositivos/acessibilidade permanece externa |
| Idiomas | Preferência compartilhada cookie/storage; menu compacto já existente no site principal | Menu `··· → Language` em Flight/legal, teclado/Escape/foco/toque; uma língua visível | Default EN do produto existente preservado sem escolha salva |
| Legal | `/privacy` e divulgações detalhadas anteriores | `/terms` bilíngue, conteúdo da seção05, canonical/metadata/semântica; links Terms/Privacy no Flight, site e navegação do app | Fonte rotula texto como rascunho para revisão jurídica; divergências factuais abaixo |
| Convites | FLF-XXXX-XXXX criptográfico/único/uso único; três apenas Founding LIST; sem propagação | Regras preservadas e cobertas pelas suítes; convites emitidos não são tratados como acesso comprovado | Nenhuma emissão real realizada |
| Brief creators | URL antiga no Email6 | URL Notion fornecida aplicada às novas mensagens; acesso público confirmado sem sessão no Chromium | Documento externo ainda contém campos `[a confirmar]` e limite por rota divergente |
| Lançamento | FIRST11/11/202623h59BRT,embarque12/11/202609hBRT,100Founding,grupos existentes | Nenhum calendário, fila, quota, segredo ou configuração operacional alterado | Owner decide merge e rollout; nenhuma produção operada |
| Qualidade e entrega | Gates e ledger CircleCI existentes | Suítes direcionadas e inventário explícito adicionados; PR contra main | Estados finais e evidências abaixo |

## Fonte e decisões de conteúdo

Canvas: https://claude.ai/artifact/9swYNgCuDz4pmW93fbBWMD#page-dcb81aee8d83.
A ferramenta web não expôs o conteúdo. O proprietário forneceu `Flight FloFi.html`, SHA-256
`897ac24d2d48fd5054445112c4d47a3cdb319f725fb3f126c50af6947f9e30d1`; a implementação usou os documentos embutidos desse HTML.
Referências internas: Terms `a46b08d2-16af-425e-a879-4e59edd96432`, Privacy `b1f05392-3fb9-45dd-a63a-ef397b2540ad`,
e-mails PT `c3a9afcb-8e23-421f-a0a8-e9bfa61bfad5`, e-mails EN `c35c343c-b352-4ce5-a7f3-123040f78b31`/`57710738-e11b-4a6c-afdc-33064cf0c086`.
O HTML completo não foi incorporado ao repositório.

Não foram copiadas afirmações incompatíveis com o runtime:

- Terms4: removida somente a promessa de valor máximo por rota inexistente. Nenhum limite monetário foi criado.
- Privacy2: não se promete rota guardada na lista, rastreamento de abertura/clique de e-mail ou armazenamento de IP bruto.
  A proteção Flight usa digest com chave do cliente e retenção de um dia.
- Privacy8: substituída promessa genérica de seis meses de logs pelos prazos reais por serviço, preservando as divulgações detalhadas anteriores.
- Privacy10: sessão de conta até12h, não30dias; preferências e demais cookies continuam descritos.
- Privacy11: hash refere-se aos tokens/códigos de acesso; códigos de convite continuam persistidos com associação e uso, como o código implementa.
- ACCESS_REQUESTED é o oitavo template técnico; usa a redação pertinente do Email3 com o prazo real de15min do código solicitado.
  Email0 existente na fonte não foi adicionado ao motor.
- A fonte deixa painéis/cartão em inglês; o briefing pede PT completo. Indicadores externos dos e-mails são PT,
  mas o PNG canônico real do cartão é preservado, igual na página e no e-mail.

Estas decisões não constituem aprovação jurídica. O proprietário deve revisar os textos e os ajustes factuais antes do lançamento.
Não foram adicionadas promessas novas de conformidade, custódia, compensação ou execução automática.

O brief público foi aberto no Chromium sem cookies de conta: título `Flight FloFi · Brief do criador` e conteúdo legível.
Ele mantém placeholders de redes/protocolos e referência a limite não implementado. A atualização desse documento externo é do proprietário.

## Arquivos e responsabilidade

| Arquivos | Motivo |
| --- | --- |
| `src/admin/flight.ts`, `flight-http.ts` | Projeções reais, filtros/CSV e boundary de autorização/auditoria |
| `src/app/admin/api/flight/**/route.ts`, `src/app/admin/flight/page.tsx` | Rotas no Admin existente |
| `src/components/admin/flight-console.tsx`, `admin-shell.tsx`, `src/app/admin/admin.css` | Consulta/exportação responsivas e navegação |
| `src/flight/store.ts`, `access-store.ts`, `http.ts` | Claim explícito, isolamento de conta, idioma da inscrição e serialização |
| `src/components/flight/board-experience.tsx` | Continuidade Email3 antes do login |
| `src/flight/email/templates.ts`, `templates-v1.ts`, `delivery.ts` | Conteúdo aprovado/v2, v1 imutável, brief e seleção segura por versão |
| `src/components/flight/language-switch.tsx`, `flight.module.css`, `flight-copy.ts`, `board-page.tsx` | Menu, brancos, @ e links legais |
| `src/app/terms/page.tsx`, `src/app/privacy/page.tsx` | Legal bilíngue em um idioma por vez e divulgações preservadas |
| `src/components/site/site-shell.tsx`, `src/components/navigation-drawer.tsx` | Links Terms/Privacy no site e app |
| `src/admin/flight.test.ts`, `flight.pg.test.ts`, `src/flight/identity-http.test.ts`, `launch.pg.test.ts`, `launch.test.ts`, `email/templates.test.ts`, `src/app/privacy/page.test.tsx`, `src/components/navigation-drawer.test.tsx` | Regressões comportamentais, não dados funcionais fictícios |
| `e2e/admin-console.spec.ts`, `board.spec.ts`, `site.spec.ts` | Browser Admin/roles/CSV, identidade, menu, legal, cores e links |
| `docs/engineering/coverage.json`, `COVERAGE.md` | Ownership/suites/gaps explícitos, sem reduzir gates |
| Este relatório e `docs/deploy/FLIGHT-INBOUND-IMPROVMX.md`, `FLIGHT-EMAIL-RESEND.md` | Evidência, checklist e operação de recebimento separados |
| `.gitignore` | Ignorar apenas os metadados locais de vínculo Vercel; regras existentes de `.env` preservadas |

Caminhos `src/`/`e2e/` acima são relativos a `apps/reference-dapp/`.

## Infraestrutura e rollout preparado

**Nenhuma migração nova.** Schema continua0024; não foi aplicado DDL em Neon de produção ou QA. Nenhum segredo, variável, quota ou calendário de produção ou QA mudou.
O painel usa o mesmo host/tenant PostgreSQL e a mesma configuração `FLOFI_ADMIN` já existentes.

Para o Preview foi criada a branch Neon `codex-flight-launch-admin-20261110` (`br-lingering-sound-bdt56k74`) no projeto já exclusivo de Preview
`flofi-preview-flight-0020` (`frosty-grass-75768827`), com inicialização **parent-schema**, sem copiar dados.
Nela foi criado o banco vazio `flofi_flight_admin`, com proprietário próprio e usuário de aplicação limitado a leitura/escrita,
que não pertence a `neon_superuser`. Foram aplicadas nele as migrations existentes1–24 pela CLI normal, com guard de Preview dedicado.
A carteira informada pelo proprietário recebeu OPERATOR somente no tenant desta branch. Verificação real com o usuário limitado:
zero inscrições, zero mensagens, um OPERATOR ativo. Nenhum dado de teste ou inscrito real foi inserido no Preview.
Compute mínimo0,25CU, suspensão após300s (o plano recusou60s sem criar recurso).
Segredos novos são exclusivos desta branch; a configuração hospedada final e a URL constam no PR.
Uma aplicação Privy Development própria para esta branch ainda precisa ser configurada pelo proprietário; não reutilizar a da QA nem a de produção.

Antes de qualquer rollout, o proprietário deve assegurar Preview com banco próprio e configuração administrativa autorizada;
não usar a base QA deste workspace nem credenciais de produção em QA. Não testar inscrições/envios/embarques no Preview contra banco compartilhado.
O tenant derivado para esta branch é `pv-codex-flight-launch-admin-20261110-5c43e903`; `TENANT_ID` é ignorado no Preview.
Os grants de Admin precisam existir nesse tenant do banco de Preview autorizado; um grant de produção não é herdado.

**Ordem importante de e-mails, após aprovação do proprietário:** o worker antigo ignora `template_version`. Portanto, parar/drainar os
senders/schedulers antigos e colocar o worker com seleção versionada antes de novos produtores web/API/CLI/schedulers criarem mensagens v2.
Não manter workers antigos e novos concorrentes. Preservar leases, estados e horários; não reenviar SENT nem resolver UNKNOWN por suposição.
Depois de existirem linhas v2, não reverter o sender para a implementação antiga que ignora versões. Uma reversão de web que produza v1
é compatível com o novo worker que entende ambas. Nenhuma dessas ações foi executada por este build.

Recebimento de `hello@` é uma operação independente: seguir [runbook ImprovMX](../deploy/FLIGHT-INBOUND-IMPROVMX.md).
O envio continua Resend/Railway e CLI existente. Recebimento Gmail, autenticação de domínio e entrega real não são comprovados por fixtures.

## Evidências e limites

Guards de pré-implementação passaram; inventário final com170módulos e19domínios passou.
Revisões seletivas: Admin/analytics, segurança, frontend, dados/privacidade, workflow/carteiras e infraestrutura/CI.
Foram corrigidos o bypass de claim, o idioma de recuperação e a atribuição incorreta de cartão encontrada na revisão.
Revisões de IA são consultivas; o ledger CircleCI permanece a autoridade de certificação.

| Verificação local | Resultado |
| --- | --- |
| Typecheck / lint / build / schema drift | Passaram. Build final inclui Admin Flight e Terms. A primeira tentativa sandbox de build falhou na captura de subprocesso TypeScript; repetição fora do sandbox passou sem contornar checks. |
| Unitários completos | 6.937 passaram;2skips condicionais de fork já existentes. Uma expectativa de contagem de links da navegação falhou antes do ajuste para Terms/Privacy; a repetição completa passou. |
| PostgreSQL completo, somente loopback descartável | 656 passaram;3skips preexistentes de certificado futuro ausente. Foco inicial61/61 também passou. |
| Result verifier | 63suítes unitárias obrigatórias e36PostgreSQL obrigatórias: todas passaram, nenhum caso ignorado nelas. |
| Playwright Flight | 11/11, incluindo primeiro acesso, carteira recorrente em outro contexto, replay, idioma/legal e letras brancas. |
| Playwright Admin | 2/2, OPERATOR, VIEWER, filtros, paginação, CSV/download, auditoria e mobile sem overflow. |
| Playwright site | 20/20, incluindo preferência PT/EN e links legais; expectativas de rodapé atualizadas para os dois novos links. |
| Governança e infraestrutura | agent_guard check e diff check passaram;257selftestsCI e21governance-lite passaram; governance-lite passou. |
| Revisão consultiva | Seis domínios revisados em lotes. `agent_guard review` exige sessão/ledger Claude e não emite certificado nesta sessão Codex; as revisões reais constam no histórico desta tarefa. |
| Fork financeiro completo local | Não executado: nenhum adaptador/compiler/execução financeira foi alterado. Os dois skips unitários condicionais permanecem limites explícitos; CI mantém os gates existentes. |

As primeiras execuções browser identificaram expectativas de métricas/rodapés e nomes acessíveis dos filtros; foram corrigidas e os fluxos repetidos.
Fixtures, wallets injetadas, Privy simulado e loopback comprovam só os cenários locais descritos, não autenticação em provedor real ou execução pública.
PR, SHA final, CircleCI e Vercel Preview devem ser lidos no PR desta branch, vinculados ao commit, sem tratar resultados locais como certificação.

Na retomada, typecheck, ESLint, build, 11 exports de schema, guards e governança passaram novamente. O build e os testes PostgreSQL
precisaram da execução fora do sandbox, pois ele bloqueava subprocesso TypeScript/conexão loopback. As suítes PostgreSQL de Admin e launch
passaram **37/37** com os totais novos; os quatro arquivos unitários de Admin/identidade/templates/legal passaram **15/15**.
As revisões independentes ainda executaram 23 testes de segurança, 35 de frontend, 24 de dados/e-mails, 19 de integração workflow,
34 de infraestrutura e 64 selftests do guard; há sobreposição entre esses conjuntos, portanto não são somados como cobertura adicional.
Os relatórios completos recuperados foram novamente aceitos pelo verificador (63 suítes unitárias e 36 PostgreSQL obrigatórias).
Playwright guardado repetido após os ajustes: **Admin 2/2** e **Flight 11/11**, incluindo os totais novos e as unidades brancas do contador.
O perfil de site preserva a evidência anterior de20/20; nenhum arquivo desse fluxo foi alterado na retomada.

Nenhum merge, promote, deploy de produção, alteração operacional em Neon de produção/QA, DNS, Resend ou Railway,
envio de campanha ou transação real foi realizado. As únicas operações hospedadas deste build são a preparação isolada de Preview descrita acima e a entrega no GitHub.
