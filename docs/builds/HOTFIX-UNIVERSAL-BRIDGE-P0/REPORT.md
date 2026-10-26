# HOTFIX P0 — Universal Bridge, todas as rotas

Base: `origin/main` após PR #125, `c47bb502`. Nenhuma alteração de produção, merge, deploy ou transação financeira pública faz parte desta entrega. O deploy automático da Vercel está desabilitado apenas para a branch deste PR.

## Correções estruturais

- BRIDGE V2 agora declara e valida `outputAsset` separadamente de `asset`. Intenções V1 continuam congeladas; gravações V2 anteriores sem a nova chave continuam válidas. A extração PT/EN também conserva o token explicitamente indicado em “para WETH na Arbitrum” / “to WETH on Arbitrum” se uma gravação antiga omitir a chave. Uma interpretação conflitante pede esclarecimento.
- Planejamento e roteamento comparam identidades dos ativos nos catálogos. As rotas certificadas conservam o adapter e a identidade canônica quando o par corresponde exatamente; os outros pares usam o Universal Router. Nenhuma regra de produto é específica a Base USDC → Arbitrum WETH.
- Edições, repetição e reconstrução a partir do IR preservam o ativo de destino. Editar `outputAsset` não altera `asset`. O Canvas conserva escolhas independentes e solicita uma nova seleção quando o ativo não existe na nova rede.
- O schema público MCP/Developer API usa o mesmo contrato de Bridge, incluindo Solana, os dois ativos, as políticas de provedor e os formatos EVM/Solana de destinatário. Referências canônicas `address@decimals` conservam a identidade de tokens já escolhidos. O catálogo SPL validado resolve símbolos e nomes exatos sem adivinhar entre duplicatas; a simulação revalida mint/programa/decimais na rede.
- Descoberta distingue `EXECUTABLE` (elegibilidade pelo verificador), `LIVE_QUOTE`, `NO_ROUTE`, `BELOW_MINIMUM`, `ABOVE_MAXIMUM`, `INSUFFICIENT_LIQUIDITY` e indisponibilidade de infraestrutura. HTTP 401/403/429/5xx não significa falta de rota. LI.FI, Mayan e Across não ganham elegibilidade de execução apenas por retornar uma cotação ou um nome de ferramenta.
- Falhas de simulação/serviço retornam códigos técnicos e correlation IDs. Logs contêm apenas códigos, operação e referência; não contêm corpos de provedores, URLs RPC, stacks, credenciais ou payloads de carteira. A interface apresenta mensagens específicas em PT/EN e referência de suporte. O código real da recusa de rota sobrevive até a interface.

## Matriz de cobertura

A matriz determinística contém 20 direções × quatro combinações de tipos de ativo × PT/EN: stablecoin → stablecoin, nativo → nativo, stablecoin → nativo e nativo → stablecoin. USDC é ERC-20 em EVM e SPL em Solana; Robinhood usa USDG. ETH e SOL são nativos. WETH e um SPL adicional de catálogo validado têm regressões próprias.

As asserções comparam IR completo e hash entre Copilot, comando exato, Canvas, motor MCP e adaptador canônico compartilhado por Telegram/WhatsApp. Um teste adicional chama `compose_strategy` pelo protocolo MCP público nas 20 direções. Os demais testes de canais cobrem seus webhooks e persistência usando infraestrutura simulada; nenhuma mensagem foi enviada a pessoas.

A matriz de serviço executa simulação verificada, Review, autorização explícita de teste e reconciliação nas 20 direções, para nativo → nativo e stablecoin → nativo. Esses 40 cenários usam exclusivamente redes e carteiras MOCKED.

| Direção | Combinações públicas consultadas | Cenários de serviço MOCKED | Resultado público agregado por combinação |
| --- | ---: | ---: | --- |
| solana → base | 4 | 2 | EXECUTABLE: 4 |
| solana → arbitrum-one | 4 | 2 | EXECUTABLE: 4 |
| solana → ethereum | 4 | 2 | EXECUTABLE: 4 |
| solana → robinhood | 4 | 2 | EXECUTABLE: 4 |
| base → solana | 4 | 2 | EXECUTABLE: 4 |
| base → arbitrum-one | 4 | 2 | EXECUTABLE: 4 |
| base → ethereum | 4 | 2 | EXECUTABLE: 4 |
| base → robinhood | 4 | 2 | EXECUTABLE: 4 |
| arbitrum-one → solana | 4 | 2 | EXECUTABLE: 4 |
| arbitrum-one → base | 4 | 2 | EXECUTABLE: 4 |
| arbitrum-one → ethereum | 4 | 2 | EXECUTABLE: 4 |
| arbitrum-one → robinhood | 4 | 2 | EXECUTABLE: 4 |
| ethereum → solana | 4 | 2 | EXECUTABLE: 2, LIVE_QUOTE: 2 |
| ethereum → base | 4 | 2 | LIVE_QUOTE: 4 |
| ethereum → arbitrum-one | 4 | 2 | LIVE_QUOTE: 4 |
| ethereum → robinhood | 4 | 2 | LIVE_QUOTE: 1, SUPPORTED_BY_PROVIDER: 3 |
| robinhood → solana | 4 | 2 | TEMPORARILY_UNAVAILABLE: 2, EXECUTABLE: 2 |
| robinhood → base | 4 | 2 | EXECUTABLE: 4 |
| robinhood → arbitrum-one | 4 | 2 | EXECUTABLE: 4 |
| robinhood → ethereum | 4 | 2 | EXECUTABLE: 4 |

`EXECUTABLE` nesta tabela significa que a cotação passou pelo verificador de formato/transação implementado. Não comprova execução, saldo, gas, simulação pública, entrega ou certificação da rota. Nenhuma das 80 consultas públicas simulou com fundos reais ou enviou transações.

## Caso obrigatório

“quero uma bridge de 1 USDC na Base para WETH na Arbitrum”, e a frase equivalente em inglês, produzem:

- origem `eip155:8453`, USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, 6 decimais, quantidade `1000000`;
- destino `eip155:42161`, WETH `0x82af49447d8a07e3bd95bd0d56f35241523fbab1`, 18 decimais;
- slippage padrão de 100 bps e destinatário conectado, vinculado no Review;
- a mesma identidade canônica entre os canais para a mesma intenção;
- simulação/Review e reconciliação aprovadas no serviço MOCKED; navegador PT/EN e Canvas aprovados sem submissões financeiras.

Na consulta pública registrada, Relay retornou `LIVE_QUOTE` com `RELAY_ORDER_REFUND_RECIPIENT_UNEXPECTED`; Across retornou `LIVE_QUOTE` exigindo validação pelo Router certificado; Mayan retornou `LIVE_QUOTE` sem builder de transações verificado; LI.FI respondeu rate limit. A operação continua representável. Essa cotação pública não é evidência de execução.

## Limitações por provedor

| Provedor | Descoberta e cotação | Execução, simulação e Review |
| --- | --- | --- |
| Relay | As 20 direções são consultadas. A resposta deve coincidir com redes, ativos, quantidades, destinatário, ordem, calldata e limites. Rate limit permanece indisponibilidade temporária. | Universal Router aceita apenas os formatos de depósito que reconstrói e verifica independentemente. Refunds, swaps ou chamadas de destino fora desse contrato permanecem cotação com motivo técnico. Exige simulação fresca, Review e assinatura do dono. |
| LI.FI | Identidades das redes, tokens, decimais, entrada e mínimos da resposta são verificadas. Houve rate limit nas consultas finais. | Cotações gerais não têm verificador de execução universal. As rotas legadas certificadas LI.FI → Across continuam no fluxo certificado e validam a transação antes do Review. |
| Mayan | Identidades de origem/destino incluem rede, endereço e decimais. Robinhood é informado como rede não suportada pelo provedor. | Builder de transações ainda não verificado; sem execução universal. A preferência Mayan permanece representável em todos os canais e retorna a limitação real. |
| Across | Identidades e mínimos são verificados. Pares com Solana não são suportados. Nativos são informados como não cotados por este adaptador. | Execução pelo Router legado exige seus pares e verificação completa da transação. Uma cotação de swap ou o nome `across` não concede elegibilidade de execução. |

## Invariantes e evidências

Autorização explícita da carteira, ownership, idempotência, nonce/order claims, proteção contra duplicação, recuperação e reconciliação foram preservados. A política de 0,1% por workflow completo continua como obrigação registrada após reconciliação, sem cobrança on-chain adicional introduzida por este PR. Slippage padrão: 100 bps. A exceção `fast-uri@3.1.9` da política release-age está intacta.

- [Consultas públicas e pins verificados](live-route-matrix.json): 80 combinações, mais o caso obrigatório; todos os pins EVM/Solana coincidiram. O artefato registra SHA da base, working tree modificada e hashes dos módulos de descoberta usados.
- [Review PT](review-pt.png) e [Review EN](review-en.png): evidência MOCKED, sem envios EVM/Solana nestes cenários.
- PostgreSQL completo: **485 aprovados, 3 ignorados**, em uma instância descartável em loopback.
- Playwright `universal-bridge`: **8 aprovados**, com rede externa bloqueada no navegador.
- Contratos de governança/CI: **19 + 56 aprovados**.
- `pnpm check` (tipos, lint, build, schemas e unitários): a rodada final e a certificação CircleCI são acompanhadas nos checks do PR. OpenAPI foi regenerado e sua checagem focada passou após ampliar o schema público.

Testes principais: `bridge-universal-parity.test.ts`, `copilot-universal-bridge.test.ts`, `mcp/mainnet-only.test.ts`, `universal-router/discovery.test.ts`, `universal-router/service.test.ts`, `universal-router/failure.test.ts`, `backend/crosschain-universal-cloud.pg.test.ts` e `e2e/universal-bridge.spec.ts`.

Reprodução pública somente de leitura: `node scripts/universal-route-matrix.mjs <arquivo.json>`. Disponibilidade e liquidez variam; um resultado temporário não remove tokens ou redes do contrato de intenção.
