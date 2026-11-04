// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SITE-001: the documentation of the owner-approved site (Claude Artifact "FloFi — site aprovado", version 1793715580-4561), PT and EN,
 * converted from its 26 documentation boards (Docs-*.dc.html / EN-Docs-*.dc.html) into structured data. Text is the approved copy; the boards' links
 * are mapped to FloFi's real routes (/docs/<slug>, /docs, /how-it-works, /developers, /app). Corrected where the boards contradict the product (see
 * docs/builds/BUILD-FLOFI-SITE-001.md): mainnet ids in the SDK examples, the sandbox key's real reach on a hosted deployment, the OpenAPI link served
 * by this deployment, and each MCP surface's availability (WhatsApp is not live). Nothing here is fetched or executed.
 */
import type { SiteLanguage } from './site-language';

export type DocInline = string | { readonly code: string } | { readonly strong: string } | { readonly em: string } | { readonly link: string; readonly href: string };
export type DocBlock =
  | { readonly kind: 'p'; readonly text: readonly DocInline[] }
  | { readonly kind: 'note'; readonly tone: 'info' | 'warning'; readonly title: string; readonly text: readonly DocInline[] }
  | { readonly kind: 'code'; readonly label: string; readonly code: string }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly (readonly (readonly DocInline[])[])[] }
  | { readonly kind: 'steps'; readonly items: readonly (readonly DocInline[])[] }
  | { readonly kind: 'cards'; readonly cards: readonly { readonly title: string; readonly rows: readonly { readonly term: string; readonly text: readonly DocInline[] }[] }[] };
export type DocSection = { readonly id: string; readonly title: string; readonly blocks: readonly DocBlock[] };
export type DocLink = { readonly href: string; readonly title: string };
export type DocPage = { readonly slug: string; readonly group: string; readonly title: string; readonly status: string; readonly lead: string;
  readonly sections: readonly DocSection[]; readonly sources: string; readonly prev: DocLink | null; readonly next: DocLink | null };
export type DocsChrome = { readonly nav: readonly { readonly group: string; readonly items: readonly DocLink[] }[]; readonly search: string; readonly home: string };

export const DOCS: Readonly<Record<SiteLanguage, { readonly pages: readonly DocPage[]; readonly chrome: DocsChrome }>> = {
 "PT": {
  "pages": [
   {
    "slug": "getting-started",
    "group": "Comece aqui",
    "title": "Primeiros passos",
    "status": "Disponível",
    "lead": "De uma ideia a um fluxo que você pode inspecionar. Conheça o ciclo do FloFi e prepare sua primeira sessão.",
    "sections": [
     {
      "id": "the-lifecycle",
      "title": "Intenção que vira execução",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O FloFi liga a criação do fluxo à simulação, à revisão explícita, à autorização na carteira e a resultados verificáveis. O chat e o construtor visual descrevem o mesmo fluxo; nenhum dos dois consegue mover fundos sozinho."
        ]
       },
       {
        "kind": "steps",
        "items": [
         [
          "Monte um fluxo suportado ",
          {
           "link": "no app",
           "href": "/app"
          },
          "."
         ],
         [
          "Simule o fluxo atual e confira as premissas."
         ],
         [
          "Revise o ",
          {
           "link": "Strategy Manifest",
           "href": "/docs/strategy-manifest"
          },
          "."
         ],
         [
          "Autorize com a sua própria carteira e acompanhe a execução e as evidências."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Comece sem carteira",
        "text": [
         "Você pode explorar a criação de fluxos antes de conectar uma carteira. Simulações que dependem de provedores e caminhos financeiros exigem a configuração documentada da implantação."
        ]
       }
      ]
     },
     {
      "id": "local-setup",
      "title": "Rode o FloFi localmente",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Use as versões fixadas no repositório: Node 24.21.0 e pnpm 11.22.0. Mantenha as variáveis GRYLOO_* existentes: a mudança de nome do produto não alterou os identificadores de execução."
        ]
       },
       {
        "kind": "code",
        "label": "Terminal · bash",
        "code": "git clone https://github.com/alrimarleskovar/gryloo.git\ncd gryloo\npnpm install --frozen-lockfile --ignore-scripts\npnpm build\npnpm --filter @defi-workflow-engine/reference-dapp dev"
       },
       {
        "kind": "p",
        "text": [
         "Abra http://127.0.0.1:3000 para a landing, /docs para estes guias ou /app para o construtor. A instalação inicia a interface local; ela não ativa integrações nem execução."
        ]
       }
      ]
     },
     {
      "id": "choose-your-path",
      "title": "Escolha por onde começar",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Siga ",
         {
          "link": "Seu primeiro fluxo",
          "href": "/docs/your-first-workflow"
         },
         " para conhecer o produto. Vai integrar a partir de um servidor? Comece pela ",
         {
          "link": "API para desenvolvedores",
          "href": "/docs/developer-api"
         },
         " e pelo ",
         {
          "link": "SDK TypeScript",
          "href": "/docs/typescript-sdk"
         },
         ". Para um cliente de agente, leia ",
         {
          "link": "Integrações MCP",
          "href": "/docs/mcp-integrations"
         },
         "."
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "A disponibilidade é específica",
        "text": [
         "O suporte é definido por ação × rede × ambiente. Implementação, ativação na implantação, política e evidência demonstrada são fatos separados. Leia ",
         {
          "link": "Redes suportadas",
          "href": "/docs/supported-networks"
         },
         " antes de escolher um caminho financeiro."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: README.md · docs/STATUS.md · docs/deploy/ENVIRONMENT.md",
    "prev": {
     "href": "/docs",
     "title": "Documentação"
    },
    "next": {
     "href": "/docs/your-first-workflow",
     "title": "Seu primeiro fluxo"
    }
   },
   {
    "slug": "your-first-workflow",
    "group": "Comece aqui",
    "title": "Seu primeiro fluxo",
    "status": "Tutorial guiado",
    "lead": "Monte, simule e revise um fluxo pequeno, mantendo todas as decisões financeiras nas suas mãos.",
    "sections": [
     {
      "id": "build",
      "title": "1. Descreva uma ação suportada",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Abra o ",
         {
          "link": "FloFi",
          "href": "/app"
         },
         ". Escolha uma rede e uma ação suportada no construtor ou descreva o que quer no chat. Use os ativos, valores e ambiente mostrados naquela implantação. Aplique a proposta só depois de conferir os detalhes."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Um ponto de partida concreto",
        "text": [
         "O FloFi roda só em mainnets, com fundos reais: comece com um valor pequeno numa rede que você já usa, por exemplo uma troca de USDC por WETH na Base. Cada implantação mostra quais ações de mainnet ativa, e nada é executado antes de uma simulação nova, da sua revisão e da assinatura na sua carteira."
        ]
       }
      ]
     },
     {
      "id": "simulate",
      "title": "2. Simule a versão atual",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Rode a simulação e confira cotações, saldos, permissões, taxas, limites de saída e restrições, quando o adaptador escolhido mostrar esses dados. Resolva os bloqueios antes de seguir. Um resultado simulado não é uma transação executada."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Se você mudar o valor, o ativo, a rede ou outro dado importante, simule de novo. ",
         {
          "link": "Simulação",
          "href": "/docs/simulation"
         },
         " e as ",
         {
          "link": "regras de invalidação",
          "href": "/docs/strategy-manifest#invalidation"
         },
         " explicam por que os resultados anteriores não podem autorizar o fluxo editado."
        ]
       }
      ]
     },
     {
      "id": "review",
      "title": "3. Revise antes de autorizar",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Leia o Strategy Manifest, incluindo destinatário, limites de gasto, provedores e validade."
         ],
         [
          "Conecte a carteira certa e prove que ela é sua, quando for pedido."
         ],
         [
          "Aprove a revisão nova de forma explícita."
         ],
         [
          "Confira cada pedido da carteira antes de assinar. Você pode recusar."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "Sua assinatura é uma decisão separada",
        "text": [
         "Aplicar uma proposta do chat, conectar uma carteira e provar que ela é sua não autorizam uma transação."
        ]
       }
      ]
     },
     {
      "id": "verify",
      "title": "4. Acompanhe o resultado",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Acompanhe o status da execução e a reconciliação. O hash da transação sozinho não prova o resultado esperado. Confira o Evidence Bundle e o ambiente dele. Um envio de status desconhecido precisa ser investigado antes de qualquer substituição; não tente de novo às cegas."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Continue em ",
         {
          "link": "Execução e verificação",
          "href": "/docs/execution-verification"
         },
         " para entender recibos, recuperação e os limites das evidências."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: README.md · docs/STATUS.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/getting-started",
     "title": "Primeiros passos"
    },
    "next": {
     "href": "/docs/chat-visual-builder",
     "title": "Chat e construtor visual"
    }
   },
   {
    "slug": "chat-visual-builder",
    "group": "Monte um fluxo",
    "title": "Chat e construtor visual",
    "status": "Implementado · configuração varia",
    "lead": "Duas formas de criar o mesmo fluxo canônico, com propostas que você confere antes de aplicar.",
    "sections": [
     {
      "id": "one-workflow",
      "title": "Um fluxo, duas interfaces",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O chat transforma o que você quer em uma proposta. O construtor visual mostra os blocos suportados e a configuração de cada um. Os dois criam o mesmo Semantic Workflow IR canônico. Mover um card no Canvas muda a apresentação, não a parte financeira."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Confira e aplique a edição proposta antes que ela entre no seu fluxo. O Copilot pode pedir dados que faltam, revisar uma proposta e descrever o estado visível do fluxo; referências ambíguas exigem esclarecimento."
        ]
       }
      ]
     },
     {
      "id": "conversation",
      "title": "Mantenha a proposta explícita",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Diga a ação, a rede, o ativo e o valor."
         ],
         [
          "Responda às perguntas de esclarecimento em vez de depender de valores financeiros deduzidos."
         ],
         [
          "Leia a proposta gerada e escolha Aplicar proposta."
         ],
         [
          "Simule e revise a nova versão do fluxo."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Disponibilidade da IA",
        "text": [
         "O intérprete de conversa está implementado, com evidência de repetição determinística. A operação com modelo ao vivo é configurada à parte e não foi comprovada por esses testes. O chat não amplia o registro de capacidades nem ganha autoridade financeira."
        ]
       }
      ]
     },
     {
      "id": "compositions",
      "title": "Composição tem limites",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Uma lista de passos é aprovada uma vez e executada em ordem: cada passo tem sua própria simulação nova, revisão e assinatura na carteira, e só começa depois que o anterior foi reconciliado na rede. Um passo que não pode rodar (um fluxo desativado, uma rede ou ativo que o FloFi não suporta) para o fluxo antes de qualquer novo envio, e os passos já reconciliados continuam concluídos. A composição de empréstimo na Base Sepolia (depositar → tomar emprestado → trocar) tem uma implementação dedicada. Onde a implantação não roda fluxos, a lista é recusada com ",
         {
          "code": "WORKFLOW_RUNS_NOT_ENABLED"
         },
         "."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Continue em ",
         {
          "link": "Simulação",
          "href": "/docs/simulation"
         },
         " e ",
         {
          "link": "Autorização na carteira",
          "href": "/docs/wallet-authorization"
         },
         " para entender o limite da execução."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/STATUS.md · docs/builds/BUILD-COPILOT-002-REPORT.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/your-first-workflow",
     "title": "Seu primeiro fluxo"
    },
    "next": {
     "href": "/docs/supported-networks",
     "title": "Redes suportadas"
    }
   },
   {
    "slug": "supported-networks",
    "group": "Monte um fluxo",
    "title": "Redes suportadas",
    "status": "Ação × rede × ambiente",
    "lead": "Entenda a diferença entre redes reconhecidas, ações ativas e execução demonstrada.",
    "sections": [
     {
      "id": "capability-model",
      "title": "Descubra capacidades, não suposições",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O FloFi define uma capacidade para uma ação, rede e ambiente específicos. A resposta de capacidades para desenvolvedores separa ",
         {
          "code": "supportedByCode"
         },
         ", ",
         {
          "code": "enabledByDeployment"
         },
         ", ",
         {
          "code": "enabledByPolicy"
         },
         " e ",
         {
          "code": "demonstratedEvidence"
         },
         ". Uma rede reconhecida não significa que todas as ações estão disponíveis."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Uma integração ativada pelo operador pode consultar ",
         {
          "link": "GET /capabilities",
          "href": "/docs/developer-api#endpoints"
         },
         " para a implantação atual. A visão geral abaixo descreve o que está implementado e demonstrado no repositório, não uma promessa de disponibilidade ao vivo."
        ]
       }
      ]
     },
     {
      "id": "network-overview",
      "title": "Visão geral das redes",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Rede / ambiente",
         "Limite no repositório"
        ],
        "rows": [
         [
          [
           "Base"
          ],
          [
           "Trocas e liquidez na Uniswap v3 com a lista oficial de tokens, transferências, Aave V3 USDC e o Cross-chain Router. Fundos reais; a execução pelo dono está implementada, e nenhuma execução em mainnet foi demonstrada ainda."
          ]
         ],
         [
          [
           "Arbitrum One"
          ],
          [
           "Trocas e liquidez na Uniswap v3, transferências, Aave V3 USDC e o Cross-chain Router. Fundos reais; nenhuma execução em mainnet foi demonstrada ainda."
          ]
         ],
         [
          [
           "Ethereum"
          ],
          [
           "Trocas e liquidez na Uniswap v3, transferências, Aave V3 USDC e o Cross-chain Router. Fundos reais; nenhuma execução em mainnet foi demonstrada ainda."
          ]
         ],
         [
          [
           "Solana"
          ],
          [
           "Trocas na Jupiter, liquidez SOL/USDC na Orca e transferências de SOL/SPL. Fundos reais; nenhuma execução em mainnet foi demonstrada ainda."
          ]
         ],
         [
          [
           "Robinhood Chain"
          ],
          [
           "Trocas e liquidez na Uniswap v3 com o catálogo oficial (Stock Tokens, USDG, WETH), transferências e o Cross-chain Router. Fundos reais; nenhuma execução em mainnet foi demonstrada ainda."
          ]
         ],
         [
          [
           "Redes de teste"
          ],
          [
           "Indisponíveis: o FloFi roda só em mainnets. Execuções e evidências registradas na Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia, Robinhood Chain Testnet ou Solana Devnet continuam legíveis; as evidências TESTNET_EXECUTED e DEVNET_EXECUTED delas nunca certificam um caminho de mainnet."
          ]
         ],
         [
          [
           "Tempo"
          ],
          [
           "Em breve. Nenhuma integração está ativa nesta versão."
          ]
         ]
        ]
       }
      ]
     },
     {
      "id": "evidence",
      "title": "Leia o limite da evidência",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Uma prova não certifica outro caminho",
        "text": [
         "A evidência vale para o ativo, protocolo, rede, ambiente e operação documentados. Leia ",
         {
          "link": "Execução e verificação",
          "href": "/docs/execution-verification#evidence-levels"
         },
         " antes de interpretar um resultado reconciliado."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Chaves sandbox de desenvolvedor recusam estratégias que tocam a mainnet. O produto público do FloFi não tem redes de teste; ali, uma chave sandbox só consulta capacidades."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: README.md · docs/STATUS.md · docs/developer/API.md",
    "prev": {
     "href": "/docs/chat-visual-builder",
     "title": "Chat e construtor visual"
    },
    "next": {
     "href": "/docs/simulation",
     "title": "Simulação"
    }
   },
   {
    "slug": "simulation",
    "group": "Monte um fluxo",
    "title": "Simulação",
    "status": "Implementado · depende do adaptador",
    "lead": "Confira um fluxo antes de se comprometer e entenda o que uma prévia pode e não pode garantir.",
    "sections": [
     {
      "id": "artifacts",
      "title": "A simulação é presa a uma versão",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "A simulação usa as cotações e o estado observado do caminho escolhido. Os resultados dela, ligados por hash, alimentam a política, o Strategy Manifest e o plano de execução. Cotações e estado podem expirar; edições importantes no fluxo invalidam o que vem depois."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Uma previsão, não uma garantia",
        "text": [
         "A simulação não garante preço de execução, inclusão nem resultado. A simulação nova e a revisão feitas pelo dono continuam obrigatórias antes da autorização."
        ]
       }
      ]
     },
     {
      "id": "server-preview",
      "title": "Uma prévia somente leitura no servidor",
      "blocks": [
       {
        "kind": "code",
        "label": "SDK no servidor · typescript",
        "code": "const preview = await flofi.strategies.simulate(strategy.id, {\n  simulationSubject: userAddress,\n});\n// preview: true, persisted: false, authorizable: false\n// authority: \"NONE\""
       },
       {
        "kind": "p",
        "text": [
         "O endereço indicado é público e só serve para ler o estado. Ele não prova que a carteira é sua e não dá nenhuma autoridade. A prévia da API para desenvolvedores não expõe calldata nem assinaturas. Prévias de vários passos pela API são recusadas com ",
         {
          "code": "SIMULATE_ONE_STEP_AT_A_TIME"
         },
         "."
        ]
       }
      ]
     },
     {
      "id": "refresh",
      "title": "Atualize antes de revisar",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Confira origem, atualidade e restrições."
         ],
         [
          "Resolva os alertas que bloqueiam."
         ],
         [
          "Simule de novo depois de edições importantes ou quando a cotação expirar."
         ],
         [
          "Revise o novo ",
          {
           "link": "Strategy Manifest",
           "href": "/docs/strategy-manifest"
          },
          "."
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Prévias MOCKED mantêm a origem MOCKED. Uma prévia bem-sucedida não transforma a evidência em execução em testnet ou mainnet."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/developer/API.md · docs/developer/QUICKSTART.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/supported-networks",
     "title": "Redes suportadas"
    },
    "next": {
     "href": "/docs/strategy-manifest",
     "title": "Strategy Manifest"
    }
   },
   {
    "slug": "strategy-manifest",
    "group": "Revise e execute",
    "title": "Strategy Manifest",
    "status": "Contrato canônico",
    "lead": "O compromisso legível entre a sua intenção, o fluxo simulado e a autorização com limites.",
    "sections": [
     {
      "id": "review-commitment",
      "title": "Revise o compromisso exato",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O Manifest liga a versão e o hash do fluxo aos hashes dos resultados, da simulação e da política. Os campos canônicos incluem dono, executor, modo de autorização, validade, nonce, limites de gasto, slippage máximo, orçamentos de gás e taxas, provedores, recuperação e aplicação das regras."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Confira destinatário e quem pode gastar na revisão do caminho escolhido. Um hash liga os resultados; ele sozinho não aplica todas as condições na rede. A aplicação das regras deve ser lida conforme o adaptador e o modo de autorização realmente suportados."
        ]
       }
      ]
     },
     {
      "id": "invalidation",
      "title": "O que exige uma revisão nova?",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Mudança",
         "O que é invalidado"
        ],
        "rows": [
         [
          [
           "Edição no fluxo"
          ],
          [
           "Cotações e estado, conjunto de resultados, simulação, política, Manifest, plano de execução e autorização"
          ]
         ],
         [
          [
           "Cotação atualizada ou expirada"
          ],
          [
           "Do conjunto de resultados até a autorização"
          ]
         ],
         [
          [
           "Mudança na simulação"
          ],
          [
           "Da política até a autorização"
          ]
         ],
         [
          [
           "Edição na política"
          ],
          [
           "Manifest, plano de execução e autorização"
          ]
         ],
         [
          [
           "Edição no Manifest"
          ],
          [
           "Plano de execução e autorização"
          ]
         ],
         [
          [
           "Edição no plano de execução"
          ],
          [
           "Autorização"
          ]
         ],
         [
          [
           "Registro de diário ou evidência, ou edição só visual"
          ],
          [
           "Nada, pela matriz de dependências v1"
          ]
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "Invalidar não é revogar",
        "text": [
         "Essas dependências não revogam uma permissão já dada na rede. Quem usa compara versões e hashes e pede uma nova autorização humana quando necessário."
        ]
       }
      ]
     },
     {
      "id": "next-decision",
      "title": "Depois, a carteira decide",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "A aprovação explícita do Manifest e a assinatura na carteira são passos separados. Uma identidade diferente, um resultado vencido ou uma capacidade não suportada bloqueiam o fluxo. Leia ",
         {
          "link": "Autorização na carteira",
          "href": "/docs/wallet-authorization"
         },
         " para entender esses limites."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/contracts/CANONICALIZATION_V1.md · docs/contracts/INVALIDATION_V1.md · docs/AUTHORITY_MATRIX.md",
    "prev": {
     "href": "/docs/simulation",
     "title": "Simulação"
    },
    "next": {
     "href": "/docs/wallet-authorization",
     "title": "Autorização na carteira"
    }
   },
   {
    "slug": "wallet-authorization",
    "group": "Revise e execute",
    "title": "Autorização na carteira",
    "status": "Controlado pelo dono",
    "lead": "Conectar a carteira, provar que ela é sua, aprovar o Manifest e assinar a transação são decisões separadas.",
    "sections": [
     {
      "id": "separate-decisions",
      "title": "Quatro limites separados",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "A conexão escolhe um provedor de carteira e uma conta."
         ],
         [
          "EIP-4361 ou Sign-In With Solana prova que a carteira é sua, quando o fluxo pede; isso não autoriza uma transação."
         ],
         [
          "Uma simulação nova e a aprovação explícita do Strategy Manifest prendem o fluxo revisado."
         ],
         [
          "Sua carteira assina a transação ou o pedido de permissão suportado."
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "O FloFi não guarda a chave privada nem a frase-semente do usuário. Nunca digite essas informações em um chat, pedido de API ou link de aprovação."
        ]
       }
      ]
     },
     {
      "id": "integration-handoffs",
      "title": "Uma integração pode pedir, não autorizar",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Chaves de desenvolvedor e o OAuth do MCP autenticam integrações ou contas. Elas não provam que a carteira é sua. Links de aprovação levam um segredo de visualização na parte final da URL (fragmento); abrir ou resgatar um link não aprova o Manifest nem assina uma transação."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Compartilhar status é opcional",
        "text": [
         "O status da execução e as evidências só são compartilhados com um projeto da API para desenvolvedores quando o dono ativa isso. Vem desligado por padrão."
        ]
       }
      ]
     },
     {
      "id": "signing-window",
      "title": "Uma única jornada de assinatura",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "As passagens vindas de ChatGPT, Claude, WhatsApp e Telegram usam a mesma jornada /approve. O FloFi abre com as ações da proposta já no Canvas; provar que a carteira é sua (uma mensagem de login ou o seu login no FloFi) carrega essa proposta exata para a sua carteira. Depois, rode uma simulação nova, revise o Strategy Manifest e autorize com a sua carteira. Um painel de agente embutido não pode assinar por você."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Se uma passagem interrompida já tinha sido aplicada, a recuperação só restaura a proposta de quem provou ser o dono. Ela não restaura simulação, revisão nem permissão de gasto. Outro link de aprovação não herda o estado de recuperação da proposta anterior."
        ]
       }
      ]
     },
     {
      "id": "permissions",
      "title": "Entenda a aplicação real das regras",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Assinatura direta e permissões limitadas com Safe/Zodiac Roles aplicam regras de formas diferentes. As demonstrações limitadas com Safe/Roles são perfis controlados em fork local; elas não comprovam automação geral em produção. Um compromisso de revisão não substitui limites aplicados por contrato."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Troca de conta, hashes vencidos e caminhos não suportados invalidam a autoridade não usada. Para envios de status desconhecido, siga ",
         {
          "link": "Execução e verificação",
          "href": "/docs/execution-verification#recovery"
         },
         "."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/AUTHORITY_MATRIX.md · docs/SECURITY_MODEL.md · docs/developer/QUICKSTART.md · docs/deploy/UNIVERSAL-SIGNING.md",
    "prev": {
     "href": "/docs/strategy-manifest",
     "title": "Strategy Manifest"
    },
    "next": {
     "href": "/docs/execution-verification",
     "title": "Execução e verificação"
    }
   },
   {
    "slug": "execution-verification",
    "group": "Revise e execute",
    "title": "Execução e verificação",
    "status": "A evidência mantém a origem",
    "lead": "Acompanhe o status da execução, lide com incertezas e confira as evidências do resultado exato.",
    "sections": [
     {
      "id": "reconciliation",
      "title": "Do envio à reconciliação",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Os adaptadores suportados registram tentativas e recibos, recuperam o status salvo e comparam os efeitos observados com o fluxo pretendido. Um recibo bem-sucedido e um hash de transação são entradas da verificação; as checagens exigidas pelo adaptador ainda precisam bater."
        ]
       },
       {
        "kind": "p",
        "text": [
         "O Evidence Bundle canônico liga fluxo, resultados, simulação, política, Manifest, plano e diário a observações, diferenças e reconciliação. Quem usa a API só consegue ler execuções que o dono compartilhou."
        ]
       }
      ]
     },
     {
      "id": "recovery",
      "title": "Incerteza é um estado real",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Não reenvie às cegas um envio desconhecido",
        "text": [
         "Um envio ambíguo exige investigar recibo, nonce, uso de permissão e saldos antes de qualquer substituição. A recuperação não dá nova autoridade de execução."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Use os controles de recuperação e o status salvo do próprio fluxo. Um fluxo salvo que foi restaurado precisa de simulação e revisão novas. A reconciliação pode continuar inconclusiva ou divergente quando as observações exigidas não batem."
        ]
       }
      ]
     },
     {
      "id": "evidence-levels",
      "title": "Níveis de evidência",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Nível",
         "O que comprova"
        ],
        "rows": [
         [
          [
           "MOCKED"
          ],
          [
           "Execução sintética ou controlada e determinística; nenhum resultado financeiro público"
          ]
         ],
         [
          [
           "FORK_REPRODUCED"
          ],
          [
           "A operação documentada em fork local controlado"
          ]
         ],
         [
          [
           "PUBLIC_READ_ONLY"
          ],
          [
           "Observações de rede pública; não é uma transação executada"
          ]
         ],
         [
          [
           "TESTNET_EXECUTED / DEVNET_EXECUTED"
          ],
          [
           "A operação exata assinada pelo dono na rede de fundos de teste"
          ]
         ],
         [
          [
           "MAINNET_EXECUTED"
          ],
          [
           "Exige evidência própria de execução real em mainnet; não é deduzida do código nem de prévias"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Alguns esquemas antigos de bundle registram a Solana Devnet como TESTNET_EXECUTED, embora a classe documentada seja DEVNET_EXECUTED. Mantenha essa distinção. Um resultado MOCKED reconciliado continua MOCKED."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: README.md · docs/EVIDENCE_LEVELS.md · docs/STATUS.md · docs/developer/API.md",
    "prev": {
     "href": "/docs/wallet-authorization",
     "title": "Autorização na carteira"
    },
    "next": {
     "href": "/docs/developer-api",
     "title": "API para desenvolvedores"
    }
   },
   {
    "slug": "developer-api",
    "group": "Integre o FloFi",
    "title": "API para desenvolvedores",
    "status": "Sandbox · ativado pelo operador",
    "lead": "Monte e pré-visualize estratégias a partir do seu servidor e passe a decisão financeira para o usuário no FloFi.",
    "sections": [
     {
      "id": "availability",
      "title": "Disponibilidade e autenticação",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Integração sandbox no servidor",
        "text": [
         "A API está implementada, com evidência de integração local/MOCKED controlada. Um operador precisa ativar a implantação e emitir uma chave sandbox. Chaves live e estratégias de mainnet são recusadas, e uma implantação hospedada não tem redes de teste; ali, uma chave sandbox só consulta capacidades: criar estratégias e aprovações exige chaves de produção, que esta versão não emite. Chaves de API não têm nenhuma autoridade financeira."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Caminho base: ",
         {
          "code": "https://<deployment>/api/developer/v1"
         },
         ". Envie ",
         {
          "code": "Authorization: Bearer <sandbox key>"
         },
         " a partir de um cofre de segredos no servidor. Pedidos com Origin ou Sec-Fetch-Site são recusados; não há credenciais de API no navegador nem atalhos de CORS."
        ]
       },
       {
        "kind": "code",
        "label": "Descoberta de capacidades · bash",
        "code": "curl \"https://<deployment>/api/developer/v1/capabilities\" \\\n  -H \"Authorization: Bearer $FLOFI_API_KEY\""
       }
      ]
     },
     {
      "id": "endpoints",
      "title": "Endpoints implementados",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Método",
         "Caminho",
         "Para que serve"
        ],
        "rows": [
         [
          [
           "GET"
          ],
          [
           "/capabilities"
          ],
          [
           "Descobrir a disponibilidade por ação × rede"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies"
          ],
          [
           "Criar uma StrategySpec imutável"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies/{id}/validate"
          ],
          [
           "Checar de novo o motor e a implantação"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies/{id}/simulate"
          ],
          [
           "Prévia somente leitura para um endereço público"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/approvals"
          ],
          [
           "Criar uma passagem de aprovação para o dono"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/approvals/{id}"
          ],
          [
           "Aprovação atual e status de execução compartilhado"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/executions/{id}"
          ],
          [
           "Status de execução compartilhado pelo dono"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/executions/{id}/evidence"
          ],
          [
           "Evidência canônica de uma execução compartilhada"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/webhook-endpoints"
          ],
          [
           "Registrar notificações assinadas"
          ]
         ],
         [
          [
           "DELETE"
          ],
          [
           "/webhook-endpoints/{id}"
          ],
          [
           "Desativar um endpoint de webhook"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Os caminhos desta tabela são relativos ao caminho base. Baixe o ",
         {
          "link": "contrato OpenAPI verificado",
          "href": "/docs/api-reference.json"
         },
         ". Não existe endpoint de execução, assinatura, envio ou aprovação de Manifest."
        ]
       }
      ]
     },
     {
      "id": "strategy-to-handoff",
      "title": "Crie, valide e passe adiante",
      "blocks": [
       {
        "kind": "code",
        "label": "TypeScript no servidor · typescript",
        "code": "const strategy = await flofi.strategies.create({\n  strategy: {\n    action: \"bridge\",\n    sourceNetwork: \"base\",\n    destinationNetwork: \"arbitrum-one\",\n    asset: \"USDC\", amount: \"5\",\n  },\n});\nconst check = await flofi.strategies.validate(strategy.id);\nif (!check.availability.approvable) {\n  throw new Error(check.availability.reason ?? \"NOT_APPROVABLE\");\n}\nconst approval = await flofi.approvals.create({ strategy });\n// Give approval.approvalUrl to the user."
       },
       {
        "kind": "p",
        "text": [
         "Este é um exemplo documentado, não uma afirmação de que a aprovação para levar ativos a outra rede está ativa em todas as implantações. O usuário prova que a carteira é dele, simula de novo, revisa e assina no FloFi. Leia ",
         {
          "link": "Autorização na carteira",
          "href": "/docs/wallet-authorization"
         },
         "."
        ]
       }
      ]
     },
     {
      "id": "errors-and-retries",
      "title": "Erros, idempotência e limites",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Valores são strings decimais. Estratégias são imutáveis; crie uma nova se a intenção mudar. POSTs de criação usam uma Idempotency-Key válida por projeto, ambiente e operação durante 24 horas. A mesma chave com um corpo diferente gera IDEMPOTENCY_CONFLICT."
        ]
       },
       {
        "kind": "code",
        "label": "Formato de erro · json",
        "code": "{\n  \"error\": {\n    \"code\": \"STRATEGY_CHANGED\",\n    \"reason\": \"WORKFLOW_HASH_MISMATCH\",\n    \"message\": \"…\",\n    \"requestId\": \"req_…\"\n  }\n}"
       },
       {
        "kind": "p",
        "text": [
         "O plano gratuito documentado permite 300 pedidos/minuto, 30 simulações/hora, 60 aprovações criadas/hora, 100 aprovações abertas e cinco endpoints de webhook ativos. Respeite o Retry-After. Listar estratégias, GET /me, chaves live e execução genérica de vários passos não fazem parte da v1."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/developer/API.md · docs/developer/QUICKSTART.md · docs/deploy/DEVELOPER.md · docs/developer/openapi.json",
    "prev": {
     "href": "/docs/execution-verification",
     "title": "Execução e verificação"
    },
    "next": {
     "href": "/docs/typescript-sdk",
     "title": "SDK TypeScript"
    }
   },
   {
    "slug": "typescript-sdk",
    "group": "Integre o FloFi",
    "title": "SDK TypeScript",
    "status": "Pacote privado do workspace",
    "lead": "Um cliente de servidor pequeno e sem dependências para a API para desenvolvedores e os webhooks assinados.",
    "sections": [
     {
      "id": "setup",
      "title": "Use o SDK do workspace",
      "blocks": [
       {
        "kind": "note",
        "tone": "info",
        "title": "Disponibilidade do pacote",
        "text": [
         "O SDK é privado neste repositório. A publicação no npm não está autorizada. Use o pacote existente do workspace; não há comando público de instalação no npm."
        ]
       },
       {
        "kind": "p",
        "text": [
         "O guia da API suporta Node 20+ ou um ambiente com fetch e Web Crypto. Para desenvolver neste repositório, use as versões fixadas Node 24.21.0 e pnpm 11.22.0."
        ]
       },
       {
        "kind": "code",
        "label": "Inicialização no servidor · typescript",
        "code": "import { FloFi, FloFiError, verifyWebhook }\n  from \"@defi-workflow-engine/developer-sdk\";\n\nconst flofi = new FloFi({\n  apiKey: process.env.FLOFI_API_KEY!,\n  baseUrl: \"https://<your FloFi deployment>\",\n});"
       }
      ]
     },
     {
      "id": "discover",
      "title": "Descubra a implantação primeiro",
      "blocks": [
       {
        "kind": "code",
        "label": "Capacidades · typescript",
        "code": "const { data } = await flofi.capabilities.list({\n  network: \"base\", action: \"bridge\",\n});\nconst available = data.filter(row => row.operations.approve.available);"
       },
       {
        "kind": "p",
        "text": [
         "Use o exampleStrategy de uma linha disponível e guarde a estratégia canônica e o hash retornados. Continue no ",
         {
          "link": "tutorial da API para desenvolvedores",
          "href": "/docs/developer-api#strategy-to-handoff"
         },
         ". Quem decide as capacidades é o FloFi; o SDK não tem um motor de fluxo alternativo."
        ]
       }
      ]
     },
     {
      "id": "webhooks",
      "title": "Verifique notificações assinadas",
      "blocks": [
       {
        "kind": "code",
        "label": "Verificação do corpo bruto · typescript",
        "code": "const event = await verifyWebhook({\n  payload: rawBody,\n  headers: request.headers,\n  secret: process.env.FLOFI_WEBHOOK_SECRET!,\n});\n// Deduplicate event.id before handling.\n// Fetch the resource again for its current state."
       },
       {
        "kind": "p",
        "text": [
         "Verifique o corpo bruto do pedido antes de interpretar ou reserializar. A ordem de entrega não é garantida. Notificações execution.* só são emitidas enquanto o usuário compartilha o status. Notificações não autorizam um fluxo nem mudam o estado financeiro dele."
        ]
       }
      ]
     },
     {
      "id": "retries",
      "title": "Trate falhas de forma deliberada",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "FloFiError traz status, code, reason, requestId, issues e retryAfter. O cliente repete GETs seguros e POSTs com chave depois de erros de rede, 429, 502, 503 e 504, respeitando o Retry-After. Chamadas de criação reaproveitam a chave de idempotência nessas repetições."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Uma incerteza na execução não é motivo para repetir a chamada à API. Siga o ",
         {
          "link": "limite de recuperação",
          "href": "/docs/execution-verification#recovery"
         },
         " do fluxo financeiro."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: packages/developer-sdk/README.md · packages/developer-sdk/src/client.ts · docs/developer/WEBHOOKS.md",
    "prev": {
     "href": "/docs/developer-api",
     "title": "API para desenvolvedores"
    },
    "next": {
     "href": "/docs/mcp-integrations",
     "title": "Integrações MCP"
    }
   },
   {
    "slug": "mcp-integrations",
    "group": "Integre o FloFi",
    "title": "Integrações MCP",
    "status": "Ativado pelo operador · evidência local",
    "lead": "Dê a um agente ferramentas estruturadas de descoberta e composição, mantendo a autorização no FloFi.",
    "sections": [
     {
      "id": "connect",
      "title": "Conecte uma implantação configurada",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O gateway é POST /api/mcp na implantação web do FloFi, usando Streamable HTTP. O operador ativa FLOFI_MCP e, para clientes de consumo, o OAuth do FloFi com estado persistente em PostgreSQL e um FLOFI_PUBLIC_ORIGIN exato. Essas são configurações do servidor."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Implementado não é aprovado ao vivo",
        "text": [
         "A integração tem evidência MOCKED/loopback. Isso não comprova aceitação ao vivo no ChatGPT ou no Claude, nem execução de transações públicas. A configuração do operador e a aceitação pelo cliente continuam separadas."
        ]
       }
      ]
     },
     {
      "id": "tools",
      "title": "As ferramentas seguem escopos explícitos",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Escopo",
         "Ferramentas"
        ],
        "rows": [
         [
          [
           "flofi.strategy"
          ],
          [
           "get_supported_networks, get_supported_assets, get_capabilities, plan_strategy, compose_strategy, validate_strategy, review_strategy, simulate_strategy"
          ]
         ],
         [
          [
           "flofi.approval"
          ],
          [
           "request_user_approval, get_approval_status; as ferramentas de sessão de aprovação são só do app"
          ]
         ],
         [
          [
           "flofi.runs"
          ],
          [
           "get_execution_status, get_evidence para carteiras vinculadas no FloFi"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "As entradas usam JSON Schemas fechados. A mesma StrategySpec e o mesmo hash do fluxo são usados pelo app, pela API e pelo MCP. Sequências suportadas usam o executor sequencial existente quando a implantação ativa execuções de fluxo; cada passo espera a reconciliação do anterior."
        ]
       }
      ]
     },
     {
      "id": "handoff",
      "title": "Mantenha a aprovação no FloFi",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Descubra as capacidades atuais e monte uma estratégia suportada."
         ],
         [
          "Valide e, se quiser, obtenha uma prévia de simulação somente leitura."
         ],
         [
          "Peça uma passagem de aprovação para o hash exato da estratégia."
         ],
         [
          "O dono usa a tela de assinatura dentro do MCP Apps quando o app e a carteira suportam, prova que a carteira é dele, revisa a simulação nova e confirma na carteira. Abrir a página de assinatura do FloFi é uma alternativa externa opcional; o Canvas é opcional."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "O modelo não tem autoridade financeira",
        "text": [
         "OAuth, uma conta MCP e um link de aprovação não conseguem assinar, enviar nem aprovar um Manifest. Passagens para mainnet vêm desativadas por padrão e exigem uma política própria do operador."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Veja o guia principal do operador, linkado abaixo, para as variáveis da implantação e o passo a passo completo de conexão do cliente."
        ]
       }
      ]
     },
     {
      "id": "in-chat",
      "title": "O que acontece dentro de cada chat",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O MCP App pode embutir a tela de assinatura existente na conversa. Isso exige que o app permita o quadro do FloFi e que a carteira ofereça um provedor compatível ali. Uma mensagem do modelo nunca dá autoridade financeira. O suporte real do app e da carteira precisa ser verificado; uma alternativa externa não é conclusão dentro do chat."
        ]
       },
       {
        "kind": "cards",
        "cards": [
         {
          "title": "ChatGPT (MCP)",
          "rows": [
           {
            "term": "Montagem no chat",
            "text": [
             "Sim. Seu assistente interpreta o pedido; compose_strategy, validate_strategy e review_strategy montam e checam o fluxo canônico."
            ]
           },
           {
            "term": "Simulação no chat",
            "text": [
             "Sim. simulate_strategy roda a prévia somente leitura do fluxo para um endereço público que você indicar: nada é salvo e não dá nenhuma autoridade."
            ]
           },
           {
            "term": "Acompanhamento no chat",
            "text": [
             "Sim. O painel do FloFi acompanha a aprovação e as execuções e informa status e evidências na conversa; sem MCP Apps, peça get_approval_status."
            ]
           },
           {
            "term": "Onde assina",
            "text": [
             "Sua própria carteira, pela tela de assinatura do FloFi, embutida no MCP Apps quando o app permite o quadro do FloFi e a carteira oferece um provedor compatível ali. Abrir o FloFi é uma alternativa externa opcional; o Canvas é opcional. O suporte real do app e da carteira precisa ser verificado."
            ]
           },
           {
            "term": "Redes e ações",
            "text": [
             "Consultado ao vivo com get_supported_networks e get_capabilities; envios para mainnet só nas redes que o operador listar."
            ]
           },
           {
            "term": "Disponibilidade",
            "text": [
             "Um conector personalizado no modo Desenvolvedor, com OAuth do FloFi."
            ]
           }
          ]
         },
         {
          "title": "Claude (MCP)",
          "rows": [
           {
            "term": "Montagem no chat",
            "text": [
             "Sim. Seu assistente interpreta o pedido; compose_strategy, validate_strategy e review_strategy montam e checam o fluxo canônico."
            ]
           },
           {
            "term": "Simulação no chat",
            "text": [
             "Sim. simulate_strategy roda a prévia somente leitura do fluxo para um endereço público que você indicar: nada é salvo e não dá nenhuma autoridade."
            ]
           },
           {
            "term": "Acompanhamento no chat",
            "text": [
             "Sim. O painel do FloFi acompanha a aprovação e as execuções e informa status e evidências na conversa; sem MCP Apps, peça get_approval_status."
            ]
           },
           {
            "term": "Onde assina",
            "text": [
             "Sua própria carteira, pela tela de assinatura do FloFi, embutida no MCP Apps quando o app permite o quadro do FloFi e a carteira oferece um provedor compatível ali. Abrir o FloFi é uma alternativa externa opcional; o Canvas é opcional. O suporte real do app e da carteira precisa ser verificado."
            ]
           },
           {
            "term": "Redes e ações",
            "text": [
             "Consultado ao vivo com get_supported_networks e get_capabilities; envios para mainnet só nas redes que o operador listar."
            ]
           },
           {
            "term": "Disponibilidade",
            "text": [
             "Um conector personalizado, com OAuth do FloFi."
            ]
           }
          ]
         },
         {
          "title": "Telegram",
          "rows": [
           {
            "term": "Montagem no chat",
            "text": [
             "Sim. Comandos exatos sempre; linguagem natural quando o intérprete Copilot da implantação está ativo (FLOFI_CHANNEL_COPILOT)."
            ]
           },
           {
            "term": "Simulação no chat",
            "text": [
             "Sim, quando ativo (FLOFI_CHANNEL_SIMULATION): uma prévia somente leitura antes do link, se não precisar de conta ou se a estratégia indicar qual ler."
            ]
           },
           {
            "term": "Acompanhamento no chat",
            "text": [
             "STATUS a qualquer momento; avisos de “carregado”, “iniciado” e “reconciliado” depois que você compartilha o status no FloFi (desligado por padrão)."
            ]
           },
           {
            "term": "Onde assina",
            "text": [
             "Sua carteira, no FloFi. Abrir o FloFi mostra o fluxo no Canvas; o Telegram não tem assinador de carteira, e nenhuma mensagem (“sim”, “confirmo”) autoriza nada."
            ]
           },
           {
            "term": "Redes e ações",
            "text": [
             "A mesma gramática de estratégias; a política do canal decide fundos de teste e mainnets (nenhuma, a menos que o operador liste)."
            ]
           },
           {
            "term": "Disponibilidade",
            "text": [
             "O bot do FloFi, com o webhook verificado da implantação."
            ]
           }
          ]
         },
         {
          "title": "WhatsApp",
          "rows": [
           {
            "term": "Montagem no chat",
            "text": [
             "Sim. Comandos exatos sempre; linguagem natural quando o intérprete Copilot da implantação está ativo (FLOFI_CHANNEL_COPILOT)."
            ]
           },
           {
            "term": "Simulação no chat",
            "text": [
             "Sim, quando ativo (FLOFI_CHANNEL_SIMULATION): uma prévia somente leitura antes do link, se não precisar de conta ou se a estratégia indicar qual ler."
            ]
           },
           {
            "term": "Acompanhamento no chat",
            "text": [
             "STATUS a qualquer momento; avisos de “carregado”, “iniciado” e “reconciliado” depois que você compartilha o status no FloFi (desligado por padrão)."
            ]
           },
           {
            "term": "Onde assina",
            "text": [
             "Sua carteira, no FloFi. Abrir o FloFi mostra o fluxo no Canvas; o WhatsApp não tem assinador de carteira, e nenhuma mensagem (“sim”, “confirmo”) autoriza nada."
            ]
           },
           {
            "term": "Redes e ações",
            "text": [
             "A mesma gramática de estratégias; a política do canal decide fundos de teste e mainnets (nenhuma, a menos que o operador liste)."
            ]
           },
           {
            "term": "Disponibilidade",
            "text": [
             "Ainda não está no ar: bloqueado até o dono registrar a liberação da política do provedor (WHATSAPP_POLICY_CLEARANCE)."
            ]
           }
          ]
         }
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Execução sem abrir o FloFi",
        "text": [
         "A tela embutida reaproveita carteira, simulação, revisão, execução e reconciliação. A Phantom não funciona dentro de iframes; outras carteiras e as políticas de sandbox de cada app exigem aceitação ao vivo. Não há retransmissão remota de carteira nem nova delegação permanente."
        ]
       }
      ]
     },
     {
      "id": "private-handoffs",
      "title": "Capacidades privadas e recuperação",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "URLs privadas de aprovação chegam à interface do cliente nos metadados da ferramenta, em _meta[\"flofi/approval\"]. O texto para o modelo e os resultados estruturados recebem só uma referência não secreta /approve#apr_…, que funciona apenas na sessão logada do navegador da conta OAuth que a criou. Não copie uma capacidade privada para um prompt ou log do servidor."
        ]
       },
       {
        "kind": "p",
        "text": [
         "A janela de assinatura oferece alternativas privadas e ações para carteiras de celular. A recuperação de uma sessão já usada só restaura a criação do fluxo e ainda exige simulação nova, revisão explícita do Manifest e autorização do dono. Veja ",
         {
          "link": "Autorização na carteira",
          "href": "/docs/wallet-authorization#signing-window"
         },
         " para a jornada compartilhada."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/deploy/MCP.md · docs/deploy/UNIVERSAL-SIGNING.md · docs/STATUS.md · apps/reference-dapp/src/app/api/mcp/route.ts · apps/reference-dapp/src/platform/channel-capabilities.ts",
    "prev": {
     "href": "/docs/typescript-sdk",
     "title": "SDK TypeScript"
    },
    "next": {
     "href": "/docs/security",
     "title": "Segurança"
    }
   },
   {
    "slug": "security",
    "group": "Entenda o FloFi",
    "title": "Segurança",
    "status": "Limites que bloqueiam por padrão",
    "lead": "Entenda quem tem autoridade, como os dados são limitados e o que as evidências não afirmam.",
    "sections": [
     {
      "id": "authority",
      "title": "A autoridade financeira fica com o dono",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Propostas da IA e credenciais de integração não autorizam fundos. O FloFi não guarda chaves privadas nem frases-semente. A execução financeira exige resultados novos do caminho suportado, revisão explícita e a autorização do dono na carteira."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Provar a carteira, autenticar uma integração e assinar uma transação servem a propósitos diferentes. Leia ",
         {
          "link": "Autorização na carteira",
          "href": "/docs/wallet-authorization"
         },
         " antes de conectar uma integração."
        ]
       }
      ]
     },
     {
      "id": "data-and-identity",
      "title": "Leituras e passagens com escopo",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Chaves de desenvolvedor autenticam projetos de servidor e são guardadas como digests. Chaves live e estratégias de mainnet são recusadas na versão sandbox. Pedidos à API para desenvolvedores vindos do navegador são rejeitados. Os segredos das passagens de aprovação viajam no fragmento da URL, e o compartilhamento de status vem desligado por padrão."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Execuções inexistentes, não compartilhadas ou de outro projeto recebem a mesma resposta de “não encontrado”. Troca de conta, resultados vencidos, hashes que não batem e capacidades indisponíveis bloqueiam o fluxo."
        ]
       }
      ]
     },
     {
      "id": "evidence-boundaries",
      "title": "Evidência não é certificação geral",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Leia o escopo",
        "text": [
         "Código disponível, testes locais e um resultado MOCKED reconciliado não são uma auditoria de segurança independente nem uma declaração de prontidão para produção. Simulações não garantem resultados."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Forks controlados, checagens públicas somente leitura e execuções exatas do dono em testnet comprovam fatos diferentes. Mantenha a classe de evidência original e a rede, o ativo e a operação documentados. O histórico de engenharia e os registros de certificação ficam nos documentos principais do repositório."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: docs/SECURITY_MODEL.md · docs/AUTHORITY_MATRIX.md · docs/EVIDENCE_LEVELS.md",
    "prev": {
     "href": "/docs/mcp-integrations",
     "title": "Integrações MCP"
    },
    "next": {
     "href": "/docs/architecture",
     "title": "Arquitetura"
    }
   },
   {
    "slug": "architecture",
    "group": "Entenda o FloFi",
    "title": "Arquitetura",
    "status": "Plataforma compartilhada",
    "lead": "Um único motor de fluxos semânticos conecta as interfaces do produto, as integrações e os adaptadores de execução com limites.",
    "sections": [
     {
      "id": "shared-engine",
      "title": "As interfaces convergem para um motor",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Chat, construtor visual, API para desenvolvedores, SDK, MCP e canais de conversa alimentam a mesma plataforma FloFi. O Semantic Workflow IR canônico é checado no registro de capacidades e validado antes de gerar resultados."
        ]
       },
       {
        "kind": "code",
        "label": "Ciclo · bash",
        "code": "Chat / Builder / API / MCP\n            ↓\nCanonical Semantic Workflow IR\n            ↓\nCapabilities → Validation → Simulation\n            ↓\nStrategy Manifest → Owner wallet authorization\n            ↓\nExecution → Reconciliation → Evidence Bundle"
       }
      ]
     },
     {
      "id": "packages",
      "title": "Responsabilidades no repositório",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Local",
         "Responsabilidade"
        ],
        "rows": [
         [
          [
           "apps/reference-dapp"
          ],
          [
           "Produto em Next.js, site público, docs e rotas de integração"
          ]
         ],
         [
          [
           "packages/workflow-contracts"
          ],
          [
           "Esquemas canônicos, hashes e contratos do ciclo"
          ]
         ],
         [
          [
           "packages/action-registry"
          ],
          [
           "Definições de ações e capacidades"
          ]
         ],
         [
          [
           "packages/reference-linter / reference-compiler"
          ],
          [
           "Validação e planejamento de execução com limites"
          ]
         ],
         [
          [
           "packages/reference-executor / reference-reconciler"
          ],
          [
           "Acompanhamento da execução e verificação do resultado"
          ]
         ],
         [
          [
           "packages/cloud-runtime"
          ],
          [
           "Infraestrutura persistente da plataforma"
          ]
         ],
         [
          [
           "packages/developer-sdk"
          ],
          [
           "Cliente fino de API e webhooks para servidor"
          ]
         ]
        ]
       }
      ]
     },
     {
      "id": "durability",
      "title": "Estado persistente, ambientes específicos",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "O runtime de nuvem usa PostgreSQL para o estado da plataforma. Os ambientes de cada fluxo financeiro são configurados à parte. A disponibilidade numa implantação não é deduzida só porque existe uma rota ou um adaptador."
        ]
       },
       {
        "kind": "p",
        "text": [
         "A recuperação preserva o histórico de tentativas e a origem das evidências. Uma edição no fluxo invalida os compromissos seguintes; uma edição só visual, não. Leia os guias ",
         {
          "link": "Strategy Manifest",
          "href": "/docs/strategy-manifest#invalidation"
         },
         " e ",
         {
          "link": "Segurança",
          "href": "/docs/security"
         },
         " para entender os limites de confiança."
        ]
       }
      ]
     }
    ],
    "sources": "Fontes: README.md · docs/contracts/CANONICALIZATION_V1.md · docs/deploy/CLOUD.md · docs/AUTHORITY_MATRIX.md",
    "prev": {
     "href": "/docs/security",
     "title": "Segurança"
    },
    "next": null
   }
  ],
  "chrome": {
   "nav": [
    {
     "group": "Comece aqui",
     "items": [
      {
       "href": "/docs/getting-started",
       "title": "Primeiros passos"
      },
      {
       "href": "/docs/your-first-workflow",
       "title": "Seu primeiro fluxo"
      }
     ]
    },
    {
     "group": "Monte um fluxo",
     "items": [
      {
       "href": "/docs/chat-visual-builder",
       "title": "Chat e construtor visual"
      },
      {
       "href": "/docs/supported-networks",
       "title": "Redes suportadas"
      },
      {
       "href": "/docs/simulation",
       "title": "Simulação"
      }
     ]
    },
    {
     "group": "Revise e execute",
     "items": [
      {
       "href": "/docs/strategy-manifest",
       "title": "Strategy Manifest"
      },
      {
       "href": "/docs/wallet-authorization",
       "title": "Autorização na carteira"
      },
      {
       "href": "/docs/execution-verification",
       "title": "Execução e verificação"
      }
     ]
    },
    {
     "group": "Integre o FloFi",
     "items": [
      {
       "href": "/docs/developer-api",
       "title": "API para desenvolvedores"
      },
      {
       "href": "/docs/typescript-sdk",
       "title": "SDK TypeScript"
      },
      {
       "href": "/docs/mcp-integrations",
       "title": "Integrações MCP"
      }
     ]
    },
    {
     "group": "Entenda o FloFi",
     "items": [
      {
       "href": "/docs/security",
       "title": "Segurança"
      },
      {
       "href": "/docs/architecture",
       "title": "Arquitetura"
      }
     ]
    }
   ],
   "search": "Buscar na documentação",
   "home": "Documentação"
  }
 },
 "EN": {
  "pages": [
   {
    "slug": "getting-started",
    "group": "Start here",
    "title": "Getting Started",
    "status": "Available",
    "lead": "From an idea to a workflow you can inspect. Meet the FloFi lifecycle and set up your first session.",
    "sections": [
     {
      "id": "the-lifecycle",
      "title": "Intent, made executable",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "FloFi connects workflow authoring to simulation, explicit review, wallet authorization and verifiable outcomes. Chat and the visual builder describe the same workflow; neither can move funds by itself."
        ]
       },
       {
        "kind": "steps",
        "items": [
         [
          "Build a supported workflow in ",
          {
           "link": "the app",
           "href": "/app"
          },
          "."
         ],
         [
          "Simulate the current workflow and inspect its assumptions."
         ],
         [
          "Review the ",
          {
           "link": "Strategy Manifest",
           "href": "/docs/strategy-manifest"
          },
          "."
         ],
         [
          "Authorize with your own wallet, then follow execution and evidence."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Start without a wallet",
        "text": [
         "You can explore authoring before connecting a wallet. Provider-dependent simulation and financial paths require the deployment’s documented configuration."
        ]
       }
      ]
     },
     {
      "id": "local-setup",
      "title": "Run FloFi locally",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Use the repository’s pinned Node 24.21.0 and pnpm 11.22.0. Keep existing GRYLOO_* environment settings: the product rename did not change runtime identifiers."
        ]
       },
       {
        "kind": "code",
        "label": "Terminal · bash",
        "code": "git clone https://github.com/alrimarleskovar/gryloo.git\ncd gryloo\npnpm install --frozen-lockfile --ignore-scripts\npnpm build\npnpm --filter @defi-workflow-engine/reference-dapp dev"
       },
       {
        "kind": "p",
        "text": [
         "Open http://127.0.0.1:3000 for the landing, /docs for these guides, or /app for the builder. Installation starts the local shell; it does not enable integrations or execution."
        ]
       }
      ]
     },
     {
      "id": "choose-your-path",
      "title": "Choose your starting point",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Follow ",
         {
          "link": "Your First Workflow",
          "href": "/docs/your-first-workflow"
         },
         " for the product journey. Integrating from a server? Start with the ",
         {
          "link": "Developer API",
          "href": "/docs/developer-api"
         },
         " and ",
         {
          "link": "TypeScript SDK",
          "href": "/docs/typescript-sdk"
         },
         ". For an agent client, read ",
         {
          "link": "MCP Integrations",
          "href": "/docs/mcp-integrations"
         },
         "."
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "Availability is specific",
        "text": [
         "Support is resolved by action × network × environment. Implementation, deployment enablement, policy and demonstrated evidence are separate facts. Read ",
         {
          "link": "Supported Networks",
          "href": "/docs/supported-networks"
         },
         " before selecting a financial path."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: README.md · docs/STATUS.md · docs/deploy/ENVIRONMENT.md",
    "prev": {
     "href": "/docs",
     "title": "Documentation"
    },
    "next": {
     "href": "/docs/your-first-workflow",
     "title": "Your First Workflow"
    }
   },
   {
    "slug": "your-first-workflow",
    "group": "Start here",
    "title": "Your First Workflow",
    "status": "Guided tutorial",
    "lead": "Build, simulate and review a small workflow while keeping every financial decision in your hands.",
    "sections": [
     {
      "id": "build",
      "title": "1. Describe a supported action",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Open ",
         {
          "link": "Launch FloFi",
          "href": "/app"
         },
         ". Choose a network and a supported action in the builder, or describe the intent in chat. Use the assets, amounts and environment shown by that deployment. Apply the proposal only after checking its details."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "A concrete starting point",
        "text": [
         "FloFi runs on mainnets only, with real funds: start with a small amount on a network you already use, for example a USDC → WETH swap on Base. Each deployment shows which mainnet actions it enables, and nothing executes before a fresh simulation, your Review and your wallet signature."
        ]
       }
      ]
     },
     {
      "id": "simulate",
      "title": "2. Simulate the current revision",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Run simulation and inspect quotes, balances, allowances, fees, output bounds and limitations where the selected adapter exposes them. Resolve blockers before proceeding. A simulated result is not an executed transaction."
        ]
       },
       {
        "kind": "p",
        "text": [
         "If you edit the amount, asset, network or another material value, simulate again. ",
         {
          "link": "Simulation",
          "href": "/docs/simulation"
         },
         " and the ",
         {
          "link": "invalidation rules",
          "href": "/docs/strategy-manifest#invalidation"
         },
         " explain why the previous artifacts cannot authorize the edited workflow."
        ]
       }
      ]
     },
     {
      "id": "review",
      "title": "3. Review before authorizing",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Read the Strategy Manifest, including recipient, spend limits, providers and expiry."
         ],
         [
          "Connect the intended wallet and prove ownership where required."
         ],
         [
          "Approve the fresh review explicitly."
         ],
         [
          "Inspect each wallet request before signing. You may decline."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "Your signature is a separate decision",
        "text": [
         "Applying a chat proposal, connecting a wallet and proving ownership do not authorize a transaction."
        ]
       }
      ]
     },
     {
      "id": "verify",
      "title": "4. Follow the outcome",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Watch execution status and reconciliation. A transaction hash alone is not sufficient proof of the intended result. Inspect the Evidence Bundle and its environment. An unknown submission must be investigated before any replacement; do not blindly retry."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Continue with ",
         {
          "link": "Execution & Verification",
          "href": "/docs/execution-verification"
         },
         " to understand receipts, recovery and evidence boundaries."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: README.md · docs/STATUS.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/getting-started",
     "title": "Getting Started"
    },
    "next": {
     "href": "/docs/chat-visual-builder",
     "title": "Chat and Visual Builder"
    }
   },
   {
    "slug": "chat-visual-builder",
    "group": "Build a workflow",
    "title": "Chat and Visual Builder",
    "status": "Implemented · configuration varies",
    "lead": "Two ways to author one canonical workflow, with proposals you can inspect before applying.",
    "sections": [
     {
      "id": "one-workflow",
      "title": "One workflow, two interfaces",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Chat interprets intent into a proposal. The visual builder exposes supported nodes and their configuration. Both author the canonical Semantic Workflow IR. Moving a card on the canvas changes presentation, not financial semantics."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Inspect and apply the proposed edit before it enters your workflow. The conversational Copilot can ask for missing facts, revise a proposal and describe visible workflow state; ambiguous references require clarification."
        ]
       }
      ]
     },
     {
      "id": "conversation",
      "title": "Keep the proposal explicit",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "State the action, network, asset and amount."
         ],
         [
          "Answer clarification questions rather than relying on inferred financial values."
         ],
         [
          "Read the resulting proposal and select Apply proposal."
         ],
         [
          "Simulate and review the resulting workflow revision."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "AI availability",
        "text": [
         "The conversational interpreter is implemented with deterministic replay evidence. Live-model operation is separately configured and was not established by those tests. Chat does not expand the capability registry or gain financial authority."
        ]
       }
      ]
     },
     {
      "id": "compositions",
      "title": "Composition has boundaries",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "A list of steps is approved once and executed in order: each step gets its own fresh simulation, Review and wallet signature, and starts only after the previous step reconciled on chain. A step that cannot run (a disabled flow, a network or asset FloFi does not support) stops the workflow before anything new is submitted, and steps already reconciled stay done. The existing Base Sepolia supply → borrow → swap lending composition has a dedicated implementation. Where a deployment does not run workflows, a list is refused with ",
         {
          "code": "WORKFLOW_RUNS_NOT_ENABLED"
         },
         "."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Continue with ",
         {
          "link": "Simulation",
          "href": "/docs/simulation"
         },
         " and ",
         {
          "link": "Wallet Authorization",
          "href": "/docs/wallet-authorization"
         },
         " for the execution boundary."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/STATUS.md · docs/builds/BUILD-COPILOT-002-REPORT.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/your-first-workflow",
     "title": "Your First Workflow"
    },
    "next": {
     "href": "/docs/supported-networks",
     "title": "Supported Networks"
    }
   },
   {
    "slug": "supported-networks",
    "group": "Build a workflow",
    "title": "Supported Networks",
    "status": "Action × network × environment",
    "lead": "Understand the difference between recognized networks, enabled actions and demonstrated execution.",
    "sections": [
     {
      "id": "capability-model",
      "title": "Discover capabilities, not assumptions",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "FloFi resolves a capability for a specific action, network and environment. The developer capability response separates ",
         {
          "code": "supportedByCode"
         },
         ", ",
         {
          "code": "enabledByDeployment"
         },
         ", ",
         {
          "code": "enabledByPolicy"
         },
         " and ",
         {
          "code": "demonstratedEvidence"
         },
         ". A recognized chain does not imply every action is available."
        ]
       },
       {
        "kind": "p",
        "text": [
         "An operator-enabled integration can query ",
         {
          "link": "GET /capabilities",
          "href": "/docs/developer-api#endpoints"
         },
         " for the current deployment. The static overview below describes repository implementation and evidence, not a live availability promise."
        ]
       }
      ]
     },
     {
      "id": "network-overview",
      "title": "Network overview",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Network / environment",
         "Repository boundary"
        ],
        "rows": [
         [
          [
           "Base"
          ],
          [
           "Uniswap v3 swaps and liquidity over the official token list, transfers, Aave V3 USDC and the Cross-chain Router. Real funds; owner execution is implemented, and no mainnet execution is demonstrated yet."
          ]
         ],
         [
          [
           "Arbitrum One"
          ],
          [
           "Uniswap v3 swaps and liquidity, transfers, Aave V3 USDC and the Cross-chain Router. Real funds; no mainnet execution is demonstrated yet."
          ]
         ],
         [
          [
           "Ethereum"
          ],
          [
           "Uniswap v3 swaps and liquidity, transfers, Aave V3 USDC and the Cross-chain Router. Real funds; no mainnet execution is demonstrated yet."
          ]
         ],
         [
          [
           "Solana"
          ],
          [
           "Jupiter swaps, Orca SOL/USDC liquidity and SOL/SPL transfers. Real funds; no mainnet execution is demonstrated yet."
          ]
         ],
         [
          [
           "Robinhood Chain"
          ],
          [
           "Uniswap v3 swaps and liquidity over the official catalog (Stock Tokens, USDG, WETH), transfers and the Cross-chain Router. Real funds; no mainnet execution is demonstrated yet."
          ]
         ],
         [
          [
           "Test networks"
          ],
          [
           "Not available: FloFi runs on mainnets only. Runs and evidence recorded on Base Sepolia, Ethereum Sepolia, Arbitrum Sepolia, Robinhood Chain Testnet or Solana Devnet stay readable; their TESTNET_EXECUTED and DEVNET_EXECUTED evidence never certifies a mainnet path."
          ]
         ],
         [
          [
           "Tempo"
          ],
          [
           "Upcoming. No runtime integration is enabled by this branch."
          ]
         ]
        ]
       }
      ]
     },
     {
      "id": "evidence",
      "title": "Read the evidence boundary",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "One proof does not certify another path",
        "text": [
         "Evidence applies to the documented asset, protocol, chain, environment and operation. Read ",
         {
          "link": "Execution & Verification",
          "href": "/docs/execution-verification#evidence-levels"
         },
         " before interpreting a reconciled result."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Developer sandbox keys refuse strategies touching mainnet. FloFi’s public product has no test networks, so there a sandbox key can only discover capabilities."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: README.md · docs/STATUS.md · docs/developer/API.md",
    "prev": {
     "href": "/docs/chat-visual-builder",
     "title": "Chat and Visual Builder"
    },
    "next": {
     "href": "/docs/simulation",
     "title": "Simulation"
    }
   },
   {
    "slug": "simulation",
    "group": "Build a workflow",
    "title": "Simulation",
    "status": "Implemented · adapter dependent",
    "lead": "Inspect a workflow before committing, and understand what a preview can and cannot establish.",
    "sections": [
     {
      "id": "artifacts",
      "title": "Simulation is bound to a revision",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Simulation consumes the selected path’s quotes and observed state. Its hash-linked artifacts feed policy, the Strategy Manifest and the execution plan. Quotes and state can expire; material workflow edits invalidate downstream references."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "A forecast, not a guarantee",
        "text": [
         "Simulation cannot guarantee execution prices, inclusion or outcomes. The owner’s fresh simulation and review remain required before authorization."
        ]
       }
      ]
     },
     {
      "id": "server-preview",
      "title": "A read-only server preview",
      "blocks": [
       {
        "kind": "code",
        "label": "Server-side SDK · typescript",
        "code": "const preview = await flofi.strategies.simulate(strategy.id, {\n  simulationSubject: userAddress,\n});\n// preview: true, persisted: false, authorizable: false\n// authority: \"NONE\""
       },
       {
        "kind": "p",
        "text": [
         "The subject is a public address whose state the preview reads. It is not authenticated wallet ownership and grants no authority. The Developer API preview does not expose calldata or signatures. Multi-step API previews are refused with ",
         {
          "code": "SIMULATE_ONE_STEP_AT_A_TIME"
         },
         "."
        ]
       }
      ]
     },
     {
      "id": "refresh",
      "title": "Refresh before review",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Check provenance, freshness and any limitations."
         ],
         [
          "Resolve blocking findings."
         ],
         [
          "Re-simulate after material edits or quote expiration."
         ],
         [
          "Review the new ",
          {
           "link": "Strategy Manifest",
           "href": "/docs/strategy-manifest"
          },
          "."
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "MOCKED previews retain MOCKED provenance. A successful preview cannot upgrade evidence to testnet or mainnet execution."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/developer/API.md · docs/developer/QUICKSTART.md · docs/contracts/INVALIDATION_V1.md",
    "prev": {
     "href": "/docs/supported-networks",
     "title": "Supported Networks"
    },
    "next": {
     "href": "/docs/strategy-manifest",
     "title": "Strategy Manifest"
    }
   },
   {
    "slug": "strategy-manifest",
    "group": "Review and execute",
    "title": "Strategy Manifest",
    "status": "Canonical contract",
    "lead": "The readable commitment between your intent, the simulated workflow and its bounded authorization.",
    "sections": [
     {
      "id": "review-commitment",
      "title": "Review the exact commitment",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "The Manifest binds semantic revision and workflow hash to the artifact set, simulation and policy hashes. Its canonical fields include owner, executor, authorization mode, expiry, nonce, spend limits, maximum slippage, gas and fee budgets, providers, recovery and enforcement."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Read recipient and spender information in the selected path’s review. A hash links artifacts; it does not itself enforce every condition onchain. Enforcement must be interpreted against the actual supported adapter and authorization mode."
        ]
       }
      ]
     },
     {
      "id": "invalidation",
      "title": "What requires a fresh review?",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Change",
         "Invalidated references"
        ],
        "rows": [
         [
          [
           "Semantic edit"
          ],
          [
           "Quotes/state, artifact set, simulation, policy, Manifest, execution plan and authorization"
          ]
         ],
         [
          [
           "Quote refresh or expiration"
          ],
          [
           "Artifact set through authorization"
          ]
         ],
         [
          [
           "Simulation change"
          ],
          [
           "Policy through authorization"
          ]
         ],
         [
          [
           "Policy edit"
          ],
          [
           "Manifest, execution plan and authorization"
          ]
         ],
         [
          [
           "Manifest edit"
          ],
          [
           "Execution plan and authorization"
          ]
         ],
         [
          [
           "Execution plan edit"
          ],
          [
           "Authorization"
          ]
         ],
         [
          [
           "Journal/evidence append or presentation edit"
          ],
          [
           "None under the v1 dependency matrix"
          ]
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "Invalidation is not revocation",
        "text": [
         "These dependency declarations do not revoke an onchain permission. Consumers compare revisions and hashes and obtain fresh human authorization when required."
        ]
       }
      ]
     },
     {
      "id": "next-decision",
      "title": "Then the wallet decides",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Explicit Manifest approval and the applicable wallet signature are separate steps. A changed identity, stale artifact or unsupported capability fails closed. Read ",
         {
          "link": "Wallet Authorization",
          "href": "/docs/wallet-authorization"
         },
         " for those boundaries."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/contracts/CANONICALIZATION_V1.md · docs/contracts/INVALIDATION_V1.md · docs/AUTHORITY_MATRIX.md",
    "prev": {
     "href": "/docs/simulation",
     "title": "Simulation"
    },
    "next": {
     "href": "/docs/wallet-authorization",
     "title": "Wallet Authorization"
    }
   },
   {
    "slug": "wallet-authorization",
    "group": "Review and execute",
    "title": "Wallet Authorization",
    "status": "Owner controlled",
    "lead": "Wallet connection, ownership proof, Manifest approval and transaction signing are separate decisions.",
    "sections": [
     {
      "id": "separate-decisions",
      "title": "Four separate boundaries",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Connection selects a wallet provider and account."
         ],
         [
          "EIP-4361 or Sign-In With Solana proves ownership where the flow requires it; this is not a transaction authorization."
         ],
         [
          "Fresh simulation and explicit Strategy Manifest approval bind the reviewed workflow."
         ],
         [
          "Your wallet signs the applicable transaction or supported permission request."
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "FloFi does not hold the user’s private key or seed phrase. Never enter them into a chat, API request or approval link."
        ]
       }
      ]
     },
     {
      "id": "integration-handoffs",
      "title": "An integration can ask, not authorize",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Developer keys and MCP OAuth authenticate integrations or accounts. They do not prove wallet ownership. Approval links carry a view/claim handoff secret in the URL fragment; opening or claiming a link does not approve the Manifest or sign a transaction."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Status sharing is optional",
        "text": [
         "Execution status and evidence are shared with a Developer API project only when the owner enables sharing. It is off by default."
        ]
       }
      ]
     },
     {
      "id": "signing-window",
      "title": "One owner signing journey",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "ChatGPT, Claude, WhatsApp and Telegram handoffs use the same /approve journey. FloFi opens with the proposal’s actions already on the Canvas; proving wallet ownership (a sign-in message, or your existing FloFi sign-in) loads that exact proposal for your wallet. Then run a fresh simulation, review the Strategy Manifest and authorize with your own wallet. An embedded agent panel cannot sign for you."
        ]
       },
       {
        "kind": "p",
        "text": [
         "If an interrupted handoff was already applied, recovery can restore only the proven claimant’s authoring proposal. It does not restore simulation, review or spending authority. A different approval link cannot inherit the previous proposal’s recovery state."
        ]
       }
      ]
     },
     {
      "id": "permissions",
      "title": "Understand the actual enforcement",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Direct signing and finite Safe/Zodiac Roles permissions have different enforcement models. The bounded Safe/Roles demonstrations are controlled local-fork profiles; they do not establish general production automation. A review commitment is not a substitute for contract-enforced limits."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Account changes, stale hashes and unsupported paths invalidate unused authority. For unknown submissions, follow ",
         {
          "link": "Execution & Verification",
          "href": "/docs/execution-verification#recovery"
         },
         "."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/AUTHORITY_MATRIX.md · docs/SECURITY_MODEL.md · docs/developer/QUICKSTART.md · docs/deploy/UNIVERSAL-SIGNING.md",
    "prev": {
     "href": "/docs/strategy-manifest",
     "title": "Strategy Manifest"
    },
    "next": {
     "href": "/docs/execution-verification",
     "title": "Execution and Verification"
    }
   },
   {
    "slug": "execution-verification",
    "group": "Review and execute",
    "title": "Execution and Verification",
    "status": "Evidence retains provenance",
    "lead": "Follow durable execution state, handle uncertainty and inspect evidence for the exact outcome.",
    "sections": [
     {
      "id": "reconciliation",
      "title": "From submission to reconciliation",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Supported adapters track attempts and receipts, recover durable status and reconcile the observed effects against the intended workflow. A successful receipt and a transaction hash are inputs to verification; the adapter’s required checks still need to agree."
        ]
       },
       {
        "kind": "p",
        "text": [
         "The canonical Evidence Bundle binds workflow, artifact, simulation, policy, Manifest, plan and journal references with observations, differences and reconciliation. API consumers can read only executions the owner shares."
        ]
       }
      ]
     },
     {
      "id": "recovery",
      "title": "Uncertainty is a real state",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Do not blindly retry an unknown send",
        "text": [
         "An ambiguous submission requires receipt, nonce, permission-consumption and balance investigation before replacement. Recovery does not grant new execution authority."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Use the existing flow’s recovery controls and durable status. A restored saved workflow needs fresh simulation and review. Reconciliation can remain inconclusive or divergent when required observations disagree."
        ]
       }
      ]
     },
     {
      "id": "evidence-levels",
      "title": "Evidence levels",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Level",
         "What it establishes"
        ],
        "rows": [
         [
          [
           "MOCKED"
          ],
          [
           "Synthetic or deterministic controlled execution; no public financial result"
          ]
         ],
         [
          [
           "FORK_REPRODUCED"
          ],
          [
           "The documented controlled local-fork operation"
          ]
         ],
         [
          [
           "PUBLIC_READ_ONLY"
          ],
          [
           "Public-chain observations; not an executed transaction"
          ]
         ],
         [
          [
           "TESTNET_EXECUTED / DEVNET_EXECUTED"
          ],
          [
           "The exact owner-signed operation on its test-funds network"
          ]
         ],
         [
          [
           "MAINNET_EXECUTED"
          ],
          [
           "Requires separate actual mainnet execution evidence; not inferred from code or previews"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Some frozen bundle schemas encode Solana Devnet as TESTNET_EXECUTED while its documented evidence class is DEVNET_EXECUTED. Preserve that distinction. A reconciled MOCKED result remains MOCKED."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: README.md · docs/EVIDENCE_LEVELS.md · docs/STATUS.md · docs/developer/API.md",
    "prev": {
     "href": "/docs/wallet-authorization",
     "title": "Wallet Authorization"
    },
    "next": {
     "href": "/docs/developer-api",
     "title": "Developer API"
    }
   },
   {
    "slug": "developer-api",
    "group": "Integrate FloFi",
    "title": "Developer API",
    "status": "Sandbox · operator enabled",
    "lead": "Compose and preview strategies from your server, then hand the financial decision to the user in FloFi.",
    "sections": [
     {
      "id": "availability",
      "title": "Availability and authentication",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Server-side sandbox integration",
        "text": [
         "The API is implemented with controlled local/MOCKED integration evidence. An operator must enable the deployment and issue a sandbox key. Live keys and mainnet strategies are refused, and a hosted deployment has no test networks, so a sandbox key can only discover capabilities there: creating strategies and approvals needs production keys, which this release does not issue. API keys have zero financial authority."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Base path: ",
         {
          "code": "https://<deployment>/api/developer/v1"
         },
         ". Send ",
         {
          "code": "Authorization: Bearer <sandbox key>"
         },
         " from a server secret store. Requests carrying Origin or Sec-Fetch-Site are refused; there are no browser API credentials or CORS shortcuts."
        ]
       },
       {
        "kind": "code",
        "label": "Capability discovery · bash",
        "code": "curl \"https://<deployment>/api/developer/v1/capabilities\" \\\n  -H \"Authorization: Bearer $FLOFI_API_KEY\""
       }
      ]
     },
     {
      "id": "endpoints",
      "title": "Implemented endpoints",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Method",
         "Path",
         "Purpose"
        ],
        "rows": [
         [
          [
           "GET"
          ],
          [
           "/capabilities"
          ],
          [
           "Discover action × network availability"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies"
          ],
          [
           "Create an immutable StrategySpec"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies/{id}/validate"
          ],
          [
           "Re-check the engine and deployment"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/strategies/{id}/simulate"
          ],
          [
           "Read-only preview for a public subject"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/approvals"
          ],
          [
           "Create an owner approval handoff"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/approvals/{id}"
          ],
          [
           "Current approval and shared execution status"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/executions/{id}"
          ],
          [
           "Owner-shared execution status"
          ]
         ],
         [
          [
           "GET"
          ],
          [
           "/executions/{id}/evidence"
          ],
          [
           "Canonical evidence of a shared run"
          ]
         ],
         [
          [
           "POST"
          ],
          [
           "/webhook-endpoints"
          ],
          [
           "Register signed notifications"
          ]
         ],
         [
          [
           "DELETE"
          ],
          [
           "/webhook-endpoints/{id}"
          ],
          [
           "Retire a webhook endpoint"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Paths in this table are relative to the base path. Download the ",
         {
          "link": "verified OpenAPI contract",
          "href": "/docs/api-reference.json"
         },
         ". No execution, signing, submission or Manifest-approval endpoint exists."
        ]
       }
      ]
     },
     {
      "id": "strategy-to-handoff",
      "title": "Create, validate, hand off",
      "blocks": [
       {
        "kind": "code",
        "label": "Server-side TypeScript · typescript",
        "code": "const strategy = await flofi.strategies.create({\n  strategy: {\n    action: \"bridge\",\n    sourceNetwork: \"base\",\n    destinationNetwork: \"arbitrum-one\",\n    asset: \"USDC\", amount: \"5\",\n  },\n});\nconst check = await flofi.strategies.validate(strategy.id);\nif (!check.availability.approvable) {\n  throw new Error(check.availability.reason ?? \"NOT_APPROVABLE\");\n}\nconst approval = await flofi.approvals.create({ strategy });\n// Give approval.approvalUrl to the user."
       },
       {
        "kind": "p",
        "text": [
         "This is a documented example, not a claim that bridge approval is enabled on every deployment. The user proves wallet ownership, re-simulates, reviews and signs in FloFi. Read ",
         {
          "link": "Wallet Authorization",
          "href": "/docs/wallet-authorization"
         },
         "."
        ]
       }
      ]
     },
     {
      "id": "errors-and-retries",
      "title": "Errors, idempotency and limits",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Amounts are decimal strings. Strategies are immutable; create a new one for a changed intent. Creating POSTs use an Idempotency-Key scoped to project, environment and operation for 24 hours. Same key with a changed body yields IDEMPOTENCY_CONFLICT."
        ]
       },
       {
        "kind": "code",
        "label": "Error envelope · json",
        "code": "{\n  \"error\": {\n    \"code\": \"STRATEGY_CHANGED\",\n    \"reason\": \"WORKFLOW_HASH_MISMATCH\",\n    \"message\": \"…\",\n    \"requestId\": \"req_…\"\n  }\n}"
       },
       {
        "kind": "p",
        "text": [
         "The documented free plan permits 300 requests/minute, 30 simulations/hour, 60 approval creations/hour, 100 open approvals and five active webhook endpoints. Respect Retry-After. Listing strategies, GET /me, live keys and general arbitrary multi-step execution are not part of v1."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/developer/API.md · docs/developer/QUICKSTART.md · docs/deploy/DEVELOPER.md · docs/developer/openapi.json",
    "prev": {
     "href": "/docs/execution-verification",
     "title": "Execution and Verification"
    },
    "next": {
     "href": "/docs/typescript-sdk",
     "title": "TypeScript SDK"
    }
   },
   {
    "slug": "typescript-sdk",
    "group": "Integrate FloFi",
    "title": "TypeScript SDK",
    "status": "Private workspace package",
    "lead": "A small, dependency-free server client for the implemented Developer API and signed webhooks.",
    "sections": [
     {
      "id": "setup",
      "title": "Use the workspace SDK",
      "blocks": [
       {
        "kind": "note",
        "tone": "info",
        "title": "Package availability",
        "text": [
         "The SDK is private in this repository. npm publication is not authorized. Use the existing workspace package; there is no public npm installation command to follow."
        ]
       },
       {
        "kind": "p",
        "text": [
         "The API guide supports Node 20+ or a runtime with fetch and Web Crypto. Developing this repository uses its separately pinned Node 24.21.0 and pnpm 11.22.0."
        ]
       },
       {
        "kind": "code",
        "label": "Server initialization · typescript",
        "code": "import { FloFi, FloFiError, verifyWebhook }\n  from \"@defi-workflow-engine/developer-sdk\";\n\nconst flofi = new FloFi({\n  apiKey: process.env.FLOFI_API_KEY!,\n  baseUrl: \"https://<your FloFi deployment>\",\n});"
       }
      ]
     },
     {
      "id": "discover",
      "title": "Discover the deployment first",
      "blocks": [
       {
        "kind": "code",
        "label": "Capabilities · typescript",
        "code": "const { data } = await flofi.capabilities.list({\n  network: \"base\", action: \"bridge\",\n});\nconst available = data.filter(row => row.operations.approve.available);"
       },
       {
        "kind": "p",
        "text": [
         "Use an available row’s exampleStrategy and retain the returned canonical strategy and hash. Continue with the ",
         {
          "link": "Developer API tutorial",
          "href": "/docs/developer-api#strategy-to-handoff"
         },
         ". FloFi makes capability decisions; the SDK contains no alternate workflow engine."
        ]
       }
      ]
     },
     {
      "id": "webhooks",
      "title": "Verify signed notifications",
      "blocks": [
       {
        "kind": "code",
        "label": "Raw-body verification · typescript",
        "code": "const event = await verifyWebhook({\n  payload: rawBody,\n  headers: request.headers,\n  secret: process.env.FLOFI_WEBHOOK_SECRET!,\n});\n// Deduplicate event.id before handling.\n// Fetch the resource again for its current state."
       },
       {
        "kind": "p",
        "text": [
         "Verify the raw request body before parsing or re-serialization. Delivery ordering is not guaranteed. execution.* notifications are emitted only while the user shares status. Notifications do not authorize a workflow or change its financial state."
        ]
       }
      ]
     },
     {
      "id": "retries",
      "title": "Handle failures deliberately",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "FloFiError carries status, code, reason, requestId, issues and retryAfter. The client retries safe GETs and keyed POSTs after network errors, 429, 502, 503 and 504, honoring Retry-After. Creating calls reuse their idempotency key across those retries."
        ]
       },
       {
        "kind": "p",
        "text": [
         "An execution uncertainty is not an API retry opportunity. Follow the financial flow’s ",
         {
          "link": "recovery boundary",
          "href": "/docs/execution-verification#recovery"
         },
         "."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: packages/developer-sdk/README.md · packages/developer-sdk/src/client.ts · docs/developer/WEBHOOKS.md",
    "prev": {
     "href": "/docs/developer-api",
     "title": "Developer API"
    },
    "next": {
     "href": "/docs/mcp-integrations",
     "title": "MCP Integrations"
    }
   },
   {
    "slug": "mcp-integrations",
    "group": "Integrate FloFi",
    "title": "MCP Integrations",
    "status": "Operator enabled · local evidence",
    "lead": "Give an agent structured discovery and composition tools while keeping authorization in FloFi.",
    "sections": [
     {
      "id": "connect",
      "title": "Connect a configured deployment",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "The gateway is POST /api/mcp on the FloFi web deployment, using Streamable HTTP. The operator enables FLOFI_MCP and, for consumer clients, FloFi OAuth with durable PostgreSQL state and an exact FLOFI_PUBLIC_ORIGIN. These are server-side settings."
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Implemented is not live acceptance",
        "text": [
         "The integration has MOCKED/loopback evidence. That does not establish live ChatGPT or Claude acceptance, nor public transaction execution. Operator configuration and client acceptance remain separate."
        ]
       }
      ]
     },
     {
      "id": "tools",
      "title": "Tools follow explicit scopes",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Scope",
         "Tools"
        ],
        "rows": [
         [
          [
           "flofi.strategy"
          ],
          [
           "get_supported_networks, get_supported_assets, get_capabilities, plan_strategy, compose_strategy, validate_strategy, review_strategy, simulate_strategy"
          ]
         ],
         [
          [
           "flofi.approval"
          ],
          [
           "request_user_approval, get_approval_status; approval-session tools are app-only"
          ]
         ],
         [
          [
           "flofi.runs"
          ],
          [
           "get_execution_status, get_evidence for wallets linked on FloFi"
          ]
         ]
        ]
       },
       {
        "kind": "p",
        "text": [
         "Inputs use closed JSON Schemas. The same StrategySpec and workflow hash are used by the app, API and MCP. Supported sequences use the existing sequential runner when the deployment enables workflow runs; each step waits for reconciliation of the preceding step."
        ]
       }
      ]
     },
     {
      "id": "handoff",
      "title": "Keep the approval in FloFi",
      "blocks": [
       {
        "kind": "steps",
        "items": [
         [
          "Discover current capabilities and compose a supported strategy."
         ],
         [
          "Validate and optionally obtain a read-only simulation preview."
         ],
         [
          "Request an approval handoff for the exact strategy hash."
         ],
         [
          "The owner uses the signing surface inside MCP Apps when their host and wallet support it, proves their wallet, reviews the fresh simulation and confirms in their wallet. Opening the FloFi signing page is an optional external fallback; Canvas is optional."
         ]
        ]
       },
       {
        "kind": "note",
        "tone": "warning",
        "title": "The model has no financial authority",
        "text": [
         "OAuth, an MCP account and an approval link cannot sign, submit or approve a Manifest. Mainnet handoffs are disabled by default and require separate operator policy."
        ]
       },
       {
        "kind": "p",
        "text": [
         "See the primary operator guide linked below for deployment variables and the full client connection procedure."
        ]
       }
      ]
     },
     {
      "id": "in-chat",
      "title": "What happens inside each chat",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "The MCP App can embed the existing signing surface in the conversation. This requires the host to allow its FloFi frame and the wallet to expose a compatible provider there. A model message never grants financial authority. Actual host and wallet support must be verified; an external fallback is not completion inside chat."
        ]
       },
       {
        "kind": "cards",
        "cards": [
         {
          "title": "ChatGPT (MCP)",
          "rows": [
           {
            "term": "In-chat composition",
            "text": [
             "Yes. Your assistant interprets the request; compose_strategy, validate_strategy and review_strategy build and check the canonical workflow."
            ]
           },
           {
            "term": "In-chat simulation",
            "text": [
             "Yes. simulate_strategy runs the flow’s read-only preview for a public address you name: nothing is stored and it grants no authority."
            ]
           },
           {
            "term": "In-chat progress",
            "text": [
             "Yes. The FloFi panel follows the approval and its runs and reports status and evidence to the conversation; without MCP Apps, ask for get_approval_status."
            ]
           },
           {
            "term": "Signing path",
            "text": [
             "Your own wallet through the existing signing surface, embedded in MCP Apps when the host allows the FloFi frame and the wallet exposes a compatible provider there. Open FloFi is an optional external fallback; Canvas is optional. Live host/wallet acceptance must be verified."
            ]
           },
           {
            "term": "Networks and actions",
            "text": [
             "Asked live with get_supported_networks and get_capabilities; mainnet handoffs only for networks the operator lists."
            ]
           },
           {
            "term": "Availability",
            "text": [
             "A custom connector in Developer mode, with FloFi OAuth."
            ]
           }
          ]
         },
         {
          "title": "Claude (MCP)",
          "rows": [
           {
            "term": "In-chat composition",
            "text": [
             "Yes. Your assistant interprets the request; compose_strategy, validate_strategy and review_strategy build and check the canonical workflow."
            ]
           },
           {
            "term": "In-chat simulation",
            "text": [
             "Yes. simulate_strategy runs the flow’s read-only preview for a public address you name: nothing is stored and it grants no authority."
            ]
           },
           {
            "term": "In-chat progress",
            "text": [
             "Yes. The FloFi panel follows the approval and its runs and reports status and evidence to the conversation; without MCP Apps, ask for get_approval_status."
            ]
           },
           {
            "term": "Signing path",
            "text": [
             "Your own wallet through the existing signing surface, embedded in MCP Apps when the host allows the FloFi frame and the wallet exposes a compatible provider there. Open FloFi is an optional external fallback; Canvas is optional. Live host/wallet acceptance must be verified."
            ]
           },
           {
            "term": "Networks and actions",
            "text": [
             "Asked live with get_supported_networks and get_capabilities; mainnet handoffs only for networks the operator lists."
            ]
           },
           {
            "term": "Availability",
            "text": [
             "A custom connector, with FloFi OAuth."
            ]
           }
          ]
         },
         {
          "title": "Telegram",
          "rows": [
           {
            "term": "In-chat composition",
            "text": [
             "Yes. Exact commands always; natural language when the deployment’s Copilot interpreter is enabled (FLOFI_CHANNEL_COPILOT)."
            ]
           },
           {
            "term": "In-chat simulation",
            "text": [
             "Yes, when enabled (FLOFI_CHANNEL_SIMULATION): a read-only preview before the link if it needs no account or the strategy names the one to read."
            ]
           },
           {
            "term": "In-chat progress",
            "text": [
             "STATUS at any time; “loaded”, “started” and “reconciled” notices after you share run status in FloFi (off by default)."
            ]
           },
           {
            "term": "Signing path",
            "text": [
             "Your wallet, in FloFi. Open FloFi shows the workflow on the Canvas; Telegram has no wallet signer, and no message (“yes”, “confirm”) authorizes anything."
            ]
           },
           {
            "term": "Networks and actions",
            "text": [
             "The shared strategy grammar; channel policy decides test funds and mainnets (none unless the operator lists them)."
            ]
           },
           {
            "term": "Availability",
            "text": [
             "FloFi’s bot, with the deployment’s verified webhook."
            ]
           }
          ]
         },
         {
          "title": "WhatsApp",
          "rows": [
           {
            "term": "In-chat composition",
            "text": [
             "Yes. Exact commands always; natural language when the deployment’s Copilot interpreter is enabled (FLOFI_CHANNEL_COPILOT)."
            ]
           },
           {
            "term": "In-chat simulation",
            "text": [
             "Yes, when enabled (FLOFI_CHANNEL_SIMULATION): a read-only preview before the link if it needs no account or the strategy names the one to read."
            ]
           },
           {
            "term": "In-chat progress",
            "text": [
             "STATUS at any time; “loaded”, “started” and “reconciled” notices after you share run status in FloFi (off by default)."
            ]
           },
           {
            "term": "Signing path",
            "text": [
             "Your wallet, in FloFi. Open FloFi shows the workflow on the Canvas; WhatsApp has no wallet signer, and no message (“yes”, “confirm”) authorizes anything."
            ]
           },
           {
            "term": "Networks and actions",
            "text": [
             "The shared strategy grammar; channel policy decides test funds and mainnets (none unless the operator lists them)."
            ]
           },
           {
            "term": "Availability",
            "text": [
             "Not live: blocked until the owner records provider policy clearance (WHATSAPP_POLICY_CLEARANCE)."
            ]
           }
          ]
         }
        ]
       },
       {
        "kind": "note",
        "tone": "info",
        "title": "Execution without opening FloFi",
        "text": [
         "The embedded surface reuses the wallet, simulation, review, execution and reconciliation runtime. Phantom does not inject into iframes; other wallets and host sandbox policies require live acceptance. No remote wallet relay or new standing delegation is assumed."
        ]
       }
      ]
     },
     {
      "id": "private-handoffs",
      "title": "Private capabilities and recovery",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Private approval URLs are delivered to the client UI in tool metadata under _meta[\"flofi/approval\"]. Model-facing text and structured results receive a nonsecret /approve#apr_… reference, usable only with the creating OAuth account’s authenticated browser session. Do not copy a private capability into a prompt or server log."
        ]
       },
       {
        "kind": "p",
        "text": [
         "The signing window provides private fallback and mobile wallet actions. A consumed-session recovery restores authoring only and still requires fresh simulation, explicit Manifest review and owner authorization. See ",
         {
          "link": "Wallet Authorization",
          "href": "/docs/wallet-authorization#signing-window"
         },
         " for the shared journey."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/deploy/MCP.md · docs/deploy/UNIVERSAL-SIGNING.md · docs/STATUS.md · apps/reference-dapp/src/app/api/mcp/route.ts · apps/reference-dapp/src/platform/channel-capabilities.ts",
    "prev": {
     "href": "/docs/typescript-sdk",
     "title": "TypeScript SDK"
    },
    "next": {
     "href": "/docs/security",
     "title": "Security"
    }
   },
   {
    "slug": "security",
    "group": "Understand FloFi",
    "title": "Security",
    "status": "Fail-closed boundaries",
    "lead": "Understand who holds authority, how data is scoped and what evidence does not claim.",
    "sections": [
     {
      "id": "authority",
      "title": "Financial authority stays with the owner",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "AI proposals and integration credentials cannot authorize funds. FloFi does not custody private keys or seed phrases. Financial execution requires the supported path’s fresh artifacts, explicit review and applicable owner wallet authorization."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Wallet proof, integration authentication and a transaction signature serve different purposes. Read ",
         {
          "link": "Wallet Authorization",
          "href": "/docs/wallet-authorization"
         },
         " before connecting an integration."
        ]
       }
      ]
     },
     {
      "id": "data-and-identity",
      "title": "Scope reads and handoffs",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Developer keys authenticate server projects and are stored as digests. Live keys and mainnet strategies are refused in the sandbox release. Browser-origin Developer API requests are rejected. Approval handoff secrets travel in URL fragments, and execution status sharing is off by default."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Absent, unshared and another project’s execution resources return the same not-found response. Account changes, expired artifacts, mismatched hashes and unavailable capability paths fail closed."
        ]
       }
      ]
     },
     {
      "id": "evidence-boundaries",
      "title": "Evidence is not a blanket certification",
      "blocks": [
       {
        "kind": "note",
        "tone": "warning",
        "title": "Read the scope",
        "text": [
         "Source availability, local tests and a reconciled MOCKED result are not an independent security audit or production readiness claim. Simulations cannot guarantee outcomes."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Controlled forks, public read-only checks and exact owner testnet runs establish different facts. Preserve the original evidence class and the documented network, asset and operation. Engineering history and certification records remain in their primary repository documents."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: docs/SECURITY_MODEL.md · docs/AUTHORITY_MATRIX.md · docs/EVIDENCE_LEVELS.md",
    "prev": {
     "href": "/docs/mcp-integrations",
     "title": "MCP Integrations"
    },
    "next": {
     "href": "/docs/architecture",
     "title": "Architecture"
    }
   },
   {
    "slug": "architecture",
    "group": "Understand FloFi",
    "title": "Architecture",
    "status": "Shared platform",
    "lead": "One semantic workflow engine connects product interfaces, integrations and bounded execution adapters.",
    "sections": [
     {
      "id": "shared-engine",
      "title": "Interfaces converge on one engine",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "Chat, the visual builder, the Developer API, SDK, MCP and conversational channels feed the shared FloFi platform. Canonical Semantic Workflow IR is checked against the capability registry and validated before producing artifacts."
        ]
       },
       {
        "kind": "code",
        "label": "Lifecycle · bash",
        "code": "Chat / Builder / API / MCP\n            ↓\nCanonical Semantic Workflow IR\n            ↓\nCapabilities → Validation → Simulation\n            ↓\nStrategy Manifest → Owner wallet authorization\n            ↓\nExecution → Reconciliation → Evidence Bundle"
       }
      ]
     },
     {
      "id": "packages",
      "title": "Repository responsibilities",
      "blocks": [
       {
        "kind": "table",
        "head": [
         "Location",
         "Responsibility"
        ],
        "rows": [
         [
          [
           "apps/reference-dapp"
          ],
          [
           "Next.js product, public site, docs and integration routes"
          ]
         ],
         [
          [
           "packages/workflow-contracts"
          ],
          [
           "Canonical schemas, hashes and lifecycle contracts"
          ]
         ],
         [
          [
           "packages/action-registry"
          ],
          [
           "Action and capability definitions"
          ]
         ],
         [
          [
           "packages/reference-linter / reference-compiler"
          ],
          [
           "Validation and bounded execution planning"
          ]
         ],
         [
          [
           "packages/reference-executor / reference-reconciler"
          ],
          [
           "Execution tracking and outcome verification"
          ]
         ],
         [
          [
           "packages/cloud-runtime"
          ],
          [
           "Durable platform / runtime infrastructure"
          ]
         ],
         [
          [
           "packages/developer-sdk"
          ],
          [
           "Thin server-side API and webhook client"
          ]
         ]
        ]
       }
      ]
     },
     {
      "id": "durability",
      "title": "Durable state, specific runtimes",
      "blocks": [
       {
        "kind": "p",
        "text": [
         "The embedded cloud runtime uses PostgreSQL for platform state. Specific financial flow runtimes remain separately configured. Deployment availability is not inferred from the presence of a route or adapter."
        ]
       },
       {
        "kind": "p",
        "text": [
         "Recovery preserves attempt history and evidence provenance. A semantic edit invalidates downstream commitments; a presentation edit does not. Read the ",
         {
          "link": "Strategy Manifest",
          "href": "/docs/strategy-manifest#invalidation"
         },
         " and ",
         {
          "link": "Security",
          "href": "/docs/security"
         },
         " guides for the trust boundaries."
        ]
       }
      ]
     }
    ],
    "sources": "Sources: README.md · docs/contracts/CANONICALIZATION_V1.md · docs/deploy/CLOUD.md · docs/AUTHORITY_MATRIX.md",
    "prev": {
     "href": "/docs/security",
     "title": "Security"
    },
    "next": null
   }
  ],
  "chrome": {
   "nav": [
    {
     "group": "Start here",
     "items": [
      {
       "href": "/docs/getting-started",
       "title": "Getting Started"
      },
      {
       "href": "/docs/your-first-workflow",
       "title": "Your First Workflow"
      }
     ]
    },
    {
     "group": "Build a workflow",
     "items": [
      {
       "href": "/docs/chat-visual-builder",
       "title": "Chat and Visual Builder"
      },
      {
       "href": "/docs/supported-networks",
       "title": "Supported Networks"
      },
      {
       "href": "/docs/simulation",
       "title": "Simulation"
      }
     ]
    },
    {
     "group": "Review and execute",
     "items": [
      {
       "href": "/docs/strategy-manifest",
       "title": "Strategy Manifest"
      },
      {
       "href": "/docs/wallet-authorization",
       "title": "Wallet Authorization"
      },
      {
       "href": "/docs/execution-verification",
       "title": "Execution and Verification"
      }
     ]
    },
    {
     "group": "Integrate FloFi",
     "items": [
      {
       "href": "/docs/developer-api",
       "title": "Developer API"
      },
      {
       "href": "/docs/typescript-sdk",
       "title": "TypeScript SDK"
      },
      {
       "href": "/docs/mcp-integrations",
       "title": "MCP Integrations"
      }
     ]
    },
    {
     "group": "Understand FloFi",
     "items": [
      {
       "href": "/docs/security",
       "title": "Security"
      },
      {
       "href": "/docs/architecture",
       "title": "Architecture"
      }
     ]
    }
   ],
   "search": "Search the docs",
   "home": "Documentation"
  }
 }
};

export const DOC_SLUGS: readonly string[] = DOCS.EN.pages.map(page => page.slug);
export function docPage(language: SiteLanguage, slug: string): DocPage | undefined { return DOCS[language].pages.find(page => page.slug === slug); }
