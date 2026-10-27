# Certificação hospedada e integração #127 / #128

27 de outubro de 2026. Consultas reais em Chromium, sem carteira conectada, assinatura ou submissão financeira. Nenhum merge, deploy,
migração ou alteração de dados em produção. Dois previews do projeto Vercel existente usam um único projeto Neon descartável vazio;
nenhuma credencial ou cópia de dados de produção foi compartilhada.

## Estimativas reais no navegador

Preview do código de produto `156281b250b4ee9a9c32a56ed2dabee4f95fb0d6`:
[abrir aplicativo](https://flofi-ji625jhl6-alrimarleskovars-projects.vercel.app/app), deployment `dpl_FRQmxs6vQTbg3eTV5RibjNdMs9d8`.
Os commits posteriores de #127 acrescentam somente testes/evidências; os fontes do produto testados permanecem iguais.

**27 casos passaram: 26 cotações disponíveis e uma recusa legítima.** As 20 direções entre Base, Arbitrum One, Ethereum, Robinhood Chain
e Solana retornaram cotações stablecoin → stablecoin (USDC; USDG em Robinhood). Base USDC → Arbitrum WETH também retornou cotação.
Cinco Swaps retornaram cotações, uma por mainnet. O número mostrado em cada card correspondeu exatamente a `estimate.expected` da
mesma resposta hospedada e ao seu header de correlação. Mínimos positivos, ordem esperado/mínimo, validade e slippage de 100 bps foram
verificados; nenhum resultado foi substituído por fixture. Valores em USD continuam opcionais.

| Swap | Entrada | Saída do backend = card |
| --- | --- | --- |
| Base | 0.01 WETH | 23.45123 USDC |
| Arbitrum One | 0.01 WETH | 23.457278 USDC |
| Ethereum | 0.01 WETH | 23.457298 USDC |
| Robinhood Chain | 0.01 WETH | 23.44662 USDG |
| Solana | 0.1 SOL | 10.101379 USDC |

São amostras no instante registrado, não preços fixos. Os registros completos, horários, valores, mínimos, estados de cada provedor e
correlações estão em [hosted-live-estimates.json](./hosted-live-estimates.json).

Das 21 Bridges com cotação, **13 ficaram `QUOTE_ONLY` e oito tinham builder verificado**, ainda exigindo simulação e Review. Em particular,
1 USDC Base → Arbitrum WETH exibiu `0.000422295886315409 WETH` e continuou `QUOTE_ONLY`.
Para 0.000000001 ETH Base → Ethereum USDC, o backend retornou `BRIDGE_SUPPORTED_BY_PROVIDER`: Across sem cotação, Mayan abaixo do mínimo,
Relay/LI.FI sem rota. O card manteve `—`, mostrou o motivo e os estados reais dos provedores. Não foi tratado como erro interno nem sucesso.

Capturas: [Bridge USDC/WETH](./hosted-20-bridge.png), [recusa de provedores](./hosted-21-bridge.png),
[Swap Base](./hosted-22-swap.png), [Swap Solana](./hosted-26-swap.png).

O roteiro usa os seletores existentes, sem interceptar/substituir respostas: Swap usa WETH nas redes EVM e SOL em Solana. ETH nativo não
é opção do Swap atual. Uma tentativa extra de micro-USDC no Router legado encontrou seus limites de authoring preexistentes e não foi
contada como recusa de provedor; o caso pequeno certificado usa a rota universal de ETH. Nenhum limite monetário foi introduzido ou alterado.
Em uma rota longa, o navegador encontrou o controle flutuante do Canvas sobre os detalhes do provedor; a abertura foi feita pelo teclado.
As capturas também preservam a quebra de números longos no card. Esses comportamentos de layout não foram redesenhados nem apresentados
como corrigidos neste fechamento.

## Migração e cold start hospedado

Projeto de teste `mute-bird-69509890`, branch `br-sparkling-silence-b5k6cg13`, criado vazio. O migrador real aplicou 1–15; depois, o migrador
do #128 aplicou exatamente 0016, hash `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f`. As 65 tabelas preexistentes
mantiveram os mesmos fingerprints de dados. A versão A aceita schema 16 como aplicação 15; B aceita como aplicação 16. Reexecutar os dois
migradores foi no-op. [Registro do ensaio](./migration0016-rehearsal.json).

Um novo deployment de A, commit `09eefd56e066a4497448eba0cbddc8d1fffa9fb3`, foi construído depois da migração:
[preview schema 16](https://flofi-qbzpcrpu9-alrimarleskovars-projects.vercel.app/app), `dpl_3wQciJqEENCSzfjukGSHBBxJvAjt`.
Bridge Base/Arbitrum e Swap Base tiveram novamente correspondência exata navegador/backend em cold start.
[Respostas](./hosted-schema16-cold-start.json).

SELECT final no banco isolado: schema 16; zero `execution_runs`, `execution_attempts`, `journal_entries`, `work_items` e `execution_purge_audit`.
As consultas não criaram execuções ou evidências financeiras. Esse banco de cotações não foi usado como substituto da certificação de exclusão.

## Integração e exclusão real

Main inspecionada: `01dbce43bfa4ab7279a95cc0ae24e5f1a94fa8e1`. Combinação de #127 `09eefd5` e #128 `a93f25f`, calculada por
`git merge-tree` e materializada em cópia local com Git próprio: árvore `ff27d840a4b820deb201af328530984de74d48b6`, **zero conflitos**.
Nenhuma branch existente recebeu merge. No snapshot combinado passaram:

- Types, lint, build de produção e 11 schemas.
- 5.324 testes unitários, dois pulados.
- 507 testes PostgreSQL, três pulados; 81 arquivos aprovados, um pulado.
- Nove jornadas Chromium de Bridge, incluindo recuperação do Review após aprovação USDC confirmada.
- Nove jornadas Chromium de histórico: exclusão de bytes no PostgreSQL real, ausência após refresh/nova sessão, carteira diferente,
  recusa de exclusão financeira, arquivamento preservando dados e confirmação PT em viewport estreito.

Os testes financeiros desses grupos usam redes/carteiras sintéticas em loopback; o PostgreSQL é real e descartável. A versão A também
passou em **490 testes PostgreSQL contra schema 16**, incluindo cold starts de API/worker/migrador/CLI, BFF, Developer e MCP.
Dois testes específicos comprovam rollback atômico de migração que falha e recusa de ressurgimento por escritor antigo. O modo de rollback
do #128 recusa DELETE/ARCHIVE, preservando leituras, máscaras, tombstones e observação financeira.
[Contagens, fontes e hashes dos logs](./RELEASE-VALIDATION.json).

## Publicação e limite financeiro

O [plano único de publicação](../../deploy/RELEASE-127-128.md) define compatibilidade A em todos os consumidores de banco → 0016 → backend B
em modo de histórico somente leitura → frontend B → ativação autorizada. Após qualquer exclusão/arquivamento, o rollback mantém leitores B,
máscaras e tombstones; não remove auditoria, não restaura identidades e não desfaz o schema. Os checks remotos são os checks do commit atual
de cada PR; o owner deve exigir os cinco contextos CircleCI verdes antes da autorização de publicação.

**Execução financeira pública da Bridge continua não certificada.** Aprovação USDC confirmada, builder verificado e LIVE_QUOTE não comprovam
depósito nem entrega. Um canário financeiro exige autorização específica e evidência real do depósito na origem e liquidação no destino.
