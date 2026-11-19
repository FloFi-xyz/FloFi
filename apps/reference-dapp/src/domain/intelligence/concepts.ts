// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: FloFi's DeFi concept explanations — one shared, deterministic, FloFi-authored catalog used by the web chat,
 * Channel Core (Telegram, WhatsApp) and the MCP server. It is general knowledge, never live data: no price, APY, balance, health factor, fee or
 * liquidation threshold of any real position is ever stated here (live values come only from FloFi's verified tools and Review). Every example
 * number is illustrative and labelled as such. Explaining a concept never proposes, changes, signs or authorizes anything.
 *
 *   matchConcept(text)                       which concept a message names (EN/PT aliases, accents and small typos tolerated)
 *   conceptQuestion(text)                    a clean conceptual question ("o que é slippage?") — answered locally, without the model
 *   conceptFollowUp(text)                    "não entendi", "me dá um exemplo", "e na Aave?", "e no meu workflow?", "mais detalhes"
 *   answerConcept(id, request)               the explanation at a level, optionally for a protocol, with follow-up options
 *   conceptInWorkflow(id, steps, language)   the concept in the user's own workflow, from FloFi's canonical steps only
 *   conceptsForSteps(steps)                  every concept that applies to a workflow's canonical steps (the reverse of `steps`)
 */
import type { CopilotLanguage } from '../copilot-messages';
import type { WorkflowStep } from '../workflow-steps';

export const CONCEPT_IDS = ['LIQUIDITY_POOL', 'COLLATERAL', 'LENDING_BORROWING', 'AAVE', 'UNISWAP', 'JUPITER', 'ORCA', 'LTV', 'HEALTH_FACTOR', 'LIQUIDATION',
  'APY_APR', 'SLIPPAGE', 'IMPERMANENT_LOSS', 'CONCENTRATED_LIQUIDITY', 'GAS_FEES', 'BRIDGE', 'WRAPPED_TOKEN', 'TOKEN_APPROVAL', 'WALLET_SECURITY',
  'AUTOMATION_DELEGATION'] as const;
export type ConceptId = (typeof CONCEPT_IDS)[number];
/** STANDARD: the default explanation. SIMPLE: after "não entendi". EXAMPLE: an illustrative example. ADVANCED: more detail. */
export const CONCEPT_LEVELS = ['STANDARD', 'SIMPLE', 'EXAMPLE', 'ADVANCED'] as const;
export type ConceptLevel = (typeof CONCEPT_LEVELS)[number];
export const CONCEPT_PROTOCOLS = ['AAVE', 'UNISWAP', 'JUPITER', 'ORCA', 'ACROSS'] as const;
export type ConceptProtocol = (typeof CONCEPT_PROTOCOLS)[number];
/** The concept the conversation last explained, kept so a follow-up has a grounded subject (JSON-safe: channels persist it). */
export type ConceptState = { readonly id: ConceptId; readonly level: ConceptLevel; readonly protocol: ConceptProtocol | null };

type Copy = { readonly name: string; readonly standard: string; readonly simple: string; readonly example: string; readonly advanced: string;
  /** How FloFi itself handles it (true of the product, never a live value). */ readonly flofi: string;
  readonly protocols: Partial<Record<ConceptProtocol, string>> };
type Concept = { readonly aliases: readonly string[]; readonly related: readonly ConceptId[]; readonly EN: Copy; readonly PT: Copy;
  /** Workflow step types this concept applies to (for "e no meu workflow?"). */ readonly steps: readonly WorkflowStep['detail']['type'][] };

const SWAPS = ['EVM_SWAP', 'SOLANA_SWAP', 'CATALOG_SWAP'] as const, BRIDGES = ['ROUTER', 'UNIVERSAL_BRIDGE'] as const;
const LENDING = ['AAVE', 'AAVE_WITHDRAW', 'LENDING_COMPOSITION'] as const, POSITIONS = ['UNISWAP_LIQUIDITY', 'CATALOG_LIQUIDITY', 'ORCA_LIQUIDITY'] as const;
/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: positions, and an existing position's management step (it needs no token approval, so not for TOKEN_APPROVAL). */
const HELD = [...POSITIONS, 'LIQUIDITY_POSITION'] as const;

const CONCEPTS: Readonly<Record<ConceptId, Concept>> = {
  LIQUIDITY_POOL: { aliases: ['liquidity pool', 'liquidity pools', 'pool de liquidez', 'pools de liquidez', 'pool', 'pools', 'piscina de liquidez', 'amm', 'liquidez', 'liquidity provider', 'provedor de liquidez', 'lp'],
    related: ['CONCENTRATED_LIQUIDITY', 'IMPERMANENT_LOSS', 'SLIPPAGE'], steps: [...HELD, ...SWAPS],
    EN: { name: 'liquidity pool',
      standard: 'A liquidity pool is a smart contract that holds two tokens so people can swap between them without an order book. Liquidity providers deposit both tokens; traders swap against the pool and pay a fee that goes to the providers. The pool\'s price moves as its balance of the two tokens changes.',
      simple: 'Think of a pool as a shared box with two kinds of tokens. You can put one kind in and take the other kind out. People who filled the box earn a small fee every time someone trades.',
      example: 'Illustrative example (not a quote): a pool holds USDC and WETH. You swap 100 USDC into it and receive WETH; the pool now has more USDC and less WETH, so WETH becomes slightly more expensive inside the pool. Part of your 100 USDC paid the pool fee, which goes to its providers.',
      advanced: 'Classic pools use a constant-product formula (x · y = k): each trade moves the price along that curve, so large trades relative to the pool move the price more (price impact). Fee tiers (for example 0.05%, 0.30%, 1%) trade off fee income against how attractive the pool is for traders. Providers own a share of the pool, not fixed token amounts.',
      flofi: 'In FloFi, swaps route through pools of verified protocols, and adding liquidity creates a position you review and sign; FloFi never moves funds without your wallet signature.',
      protocols: { UNISWAP: 'On Uniswap v3, each pool is a token pair with a fee tier, and liquidity is concentrated in price ranges.',
        ORCA: 'On Orca (Solana), Whirlpools are concentrated-liquidity pools similar to Uniswap v3.', JUPITER: 'Jupiter is not a pool: it is an aggregator that routes a Solana swap through many pools to find a good price.' } },
    PT: { name: 'pool de liquidez',
      standard: 'Um pool de liquidez é um contrato inteligente que guarda dois tokens para que as pessoas troquem um pelo outro sem livro de ofertas. Provedores de liquidez depositam os dois tokens; quem troca usa o pool e paga uma taxa que vai para esses provedores. O preço do pool muda conforme o saldo dos dois tokens muda.',
      simple: 'Pense no pool como uma caixa compartilhada com dois tipos de token. Você coloca um tipo e retira o outro. Quem encheu a caixa ganha uma pequena taxa a cada troca.',
      example: 'Exemplo ilustrativo (não é cotação): um pool tem USDC e WETH. Você troca 100 USDC nele e recebe WETH; o pool passa a ter mais USDC e menos WETH, então o WETH fica um pouco mais caro dentro do pool. Parte dos seus 100 USDC pagou a taxa do pool, que vai para os provedores.',
      advanced: 'Pools clássicos usam a fórmula de produto constante (x · y = k): cada troca move o preço nessa curva, então trocas grandes em relação ao pool movem mais o preço (impacto de preço). Faixas de taxa (por exemplo 0,05%, 0,30%, 1%) equilibram renda de taxa e atratividade para quem troca. O provedor tem uma fatia do pool, não quantidades fixas de tokens.',
      flofi: 'Na FloFi, swaps passam por pools de protocolos verificados, e adicionar liquidez cria uma posição que você revisa e assina; a FloFi nunca move fundos sem a assinatura da sua carteira.',
      protocols: { UNISWAP: 'Na Uniswap v3, cada pool é um par de tokens com uma faixa de taxa, e a liquidez fica concentrada em faixas de preço.',
        ORCA: 'Na Orca (Solana), os Whirlpools são pools de liquidez concentrada parecidos com a Uniswap v3.', JUPITER: 'A Jupiter não é um pool: é um agregador que roteia um swap na Solana por vários pools para achar um bom preço.' } } },

  COLLATERAL: { aliases: ['collateral', 'colateral', 'colaterais', 'garantia', 'garantias', 'collateralized', 'colateralizado'],
    related: ['LENDING_BORROWING', 'LTV', 'HEALTH_FACTOR', 'LIQUIDATION'], steps: LENDING,
    EN: { name: 'collateral',
      standard: 'Collateral is what you deposit to secure a loan. In DeFi lending you supply tokens to a protocol, and they back what you borrow. If the value of your collateral falls too far relative to your debt, part of it can be sold to repay the loan (liquidation).',
      simple: 'Collateral is a deposit that guarantees a loan, like leaving something valuable with a lender. You get it back when you repay. If its value drops too much, the lender can sell some of it.',
      example: 'Illustrative example (not a quote): you supply 1,000 USDC as collateral and borrow 400 USDC worth of another token. Your 1,000 USDC stays deposited and backs the 400 of debt; while the loan is open you cannot withdraw collateral that is still needed to back it.',
      advanced: 'Each collateral asset has risk parameters: a maximum loan-to-value (how much you may borrow against it) and a liquidation threshold (the point where the position becomes liquidatable). Volatile collateral, or borrowing a volatile asset, makes the position more sensitive to price moves. Interest accrues on the debt over time.',
      flofi: 'In FloFi, a supply on Aave V3 can act as collateral, and a borrow shows your health factor before and the estimated health factor after at Review; FloFi requires at least 2.0.',
      protocols: { AAVE: 'On Aave V3, supplied assets enabled as collateral back your borrows; each reserve has its own maximum LTV and liquidation threshold.' } },
    PT: { name: 'colateral',
      standard: 'Colateral é o que você deposita para garantir um empréstimo. Em empréstimos DeFi você deposita tokens em um protocolo, e eles garantem o que você pega emprestado. Se o valor do colateral cair demais em relação à dívida, parte dele pode ser vendida para pagar o empréstimo (liquidação).',
      simple: 'Colateral é um depósito que garante um empréstimo, como deixar algo de valor com quem empresta. Você recebe de volta quando paga. Se o valor cair demais, quem emprestou pode vender uma parte.',
      example: 'Exemplo ilustrativo (não é cotação): você deposita 1.000 USDC como colateral e pega emprestado o equivalente a 400 USDC em outro token. Os 1.000 USDC continuam depositados e garantem os 400 de dívida; enquanto o empréstimo estiver aberto, você não pode retirar o colateral que ainda garante a dívida.',
      advanced: 'Cada ativo de colateral tem parâmetros de risco: um LTV máximo (quanto você pode pegar emprestado contra ele) e um limite de liquidação (o ponto em que a posição pode ser liquidada). Colateral volátil, ou dívida em ativo volátil, deixa a posição mais sensível a variações de preço. Juros se acumulam sobre a dívida.',
      flofi: 'Na FloFi, um supply na Aave V3 pode servir de colateral, e um borrow mostra na Review o health factor antes e o estimado depois; a FloFi exige pelo menos 2,0.',
      protocols: { AAVE: 'Na Aave V3, ativos depositados e habilitados como colateral garantem seus empréstimos; cada reserva tem seu LTV máximo e seu limite de liquidação.' } } },

  LENDING_BORROWING: { aliases: ['lending', 'borrowing', 'lend', 'borrow', 'emprestimo', 'emprestimos', 'emprestar', 'pegar emprestado', 'tomar emprestado', 'credito defi', 'supply', 'fornecer', 'depositar na aave', 'divida'],
    related: ['COLLATERAL', 'HEALTH_FACTOR', 'APY_APR', 'AAVE'], steps: LENDING,
    EN: { name: 'lending and borrowing',
      standard: 'In DeFi lending, suppliers deposit tokens into a lending pool and earn interest; borrowers take tokens from that pool after depositing collateral, and pay interest. Rates move with how much of the pool is borrowed (utilization). Everything is enforced by smart contracts instead of a bank.',
      simple: 'Lending means putting your tokens in a shared pool so others can borrow them, and earning interest for it. Borrowing means taking tokens from that pool by first leaving collateral, and paying interest until you repay.',
      example: 'Illustrative example (not a quote): you supply 500 USDC and earn a variable interest rate. Someone else supplies ETH as collateral and borrows 200 USDC from the same pool; they pay interest, and that interest is what suppliers like you earn.',
      advanced: 'Variable rates follow an interest-rate curve: low utilization keeps rates low, and above an optimal utilization rates rise steeply to attract supply and encourage repayment. Supplied tokens are represented by interest-bearing tokens (aTokens on Aave). Debt grows with interest, so repaying the exact amount you borrowed may not clear it fully.',
      flofi: 'In FloFi you can author Aave V3 supply, borrow (variable rate), repay and withdraw steps; each is simulated and shown at Review before your wallet signs.',
      protocols: { AAVE: 'Aave V3 is the lending protocol FloFi integrates: supply, borrow at a variable rate, repay and withdraw.' } },
    PT: { name: 'empréstimo (lending e borrowing)',
      standard: 'Em empréstimos DeFi, quem fornece deposita tokens em um pool de empréstimo e ganha juros; quem pega emprestado retira tokens desse pool depois de depositar colateral, e paga juros. As taxas variam com o quanto do pool está emprestado (utilização). Tudo é garantido por contratos inteligentes, não por um banco.',
      simple: 'Fornecer (lending) é colocar seus tokens em um pool compartilhado para outros pegarem emprestado, ganhando juros. Pegar emprestado (borrowing) é retirar tokens desse pool deixando um colateral antes, e pagar juros até devolver.',
      example: 'Exemplo ilustrativo (não é cotação): você fornece 500 USDC e ganha uma taxa de juros variável. Outra pessoa deposita ETH como colateral e pega 200 USDC emprestados do mesmo pool; ela paga juros, e esses juros são o que fornecedores como você recebem.',
      advanced: 'Taxas variáveis seguem uma curva de juros: com utilização baixa as taxas ficam baixas, e acima de uma utilização ótima sobem rápido para atrair depósitos e estimular pagamentos. Tokens fornecidos são representados por tokens que rendem juros (aTokens na Aave). A dívida cresce com os juros, então devolver exatamente o valor emprestado pode não quitá-la.',
      flofi: 'Na FloFi você pode montar passos de supply, borrow (taxa variável), repay e withdraw na Aave V3; cada um é simulado e mostrado na Review antes da sua carteira assinar.',
      protocols: { AAVE: 'A Aave V3 é o protocolo de empréstimo que a FloFi integra: supply, borrow com taxa variável, repay e withdraw.' } } },

  AAVE: { aliases: ['aave', 'aave v3', 'aave protocol'], related: ['LENDING_BORROWING', 'COLLATERAL', 'HEALTH_FACTOR'], steps: LENDING,
    EN: { name: 'Aave',
      standard: 'Aave is a decentralized lending protocol. You can supply tokens to earn variable interest, use supplied tokens as collateral, and borrow other tokens against it. Your position\'s safety is measured by its health factor.',
      simple: 'Aave is like an automatic savings-and-loans service on the blockchain: deposit tokens to earn interest, or borrow by leaving a deposit as a guarantee.',
      example: 'Illustrative example (not a quote): you supply 1,000 USDC to Aave and receive aUSDC, which grows as interest accrues. Later you borrow a smaller amount of another asset against that USDC, and your health factor shows how safe the loan is.',
      advanced: 'Aave V3 reserves each have their own parameters (maximum LTV, liquidation threshold, liquidation bonus, reserve factor and an interest-rate strategy). Pools are upgraded by Aave governance; FloFi pins the deployments it has verified and refuses any other.',
      flofi: 'FloFi integrates Aave V3 for supply, borrow, repay and withdraw on the networks it lists for Aave, and requires a health factor of at least 2.0 for a borrow.',
      protocols: {} },
    PT: { name: 'Aave',
      standard: 'A Aave é um protocolo de empréstimo descentralizado. Você pode fornecer tokens para ganhar juros variáveis, usar o que forneceu como colateral e pegar outros tokens emprestados contra ele. A segurança da posição é medida pelo health factor.',
      simple: 'A Aave é como um serviço automático de poupança e empréstimo na blockchain: deposite tokens para ganhar juros, ou pegue emprestado deixando um depósito como garantia.',
      example: 'Exemplo ilustrativo (não é cotação): você fornece 1.000 USDC na Aave e recebe aUSDC, que cresce com os juros. Depois pega emprestado um valor menor em outro ativo contra esse USDC, e o health factor mostra o quão seguro está o empréstimo.',
      advanced: 'Cada reserva da Aave V3 tem seus parâmetros (LTV máximo, limite de liquidação, bônus de liquidação, reserve factor e uma estratégia de juros). Os Pools são atualizados pela governança da Aave; a FloFi fixa os deployments que verificou e recusa qualquer outro.',
      flofi: 'A FloFi integra a Aave V3 para supply, borrow, repay e withdraw nas redes que lista para a Aave, e exige health factor de pelo menos 2,0 para um borrow.',
      protocols: {} } },

  UNISWAP: { aliases: ['uniswap', 'uniswap v3', 'uni v3'], related: ['LIQUIDITY_POOL', 'CONCENTRATED_LIQUIDITY', 'SLIPPAGE'], steps: [...SWAPS, ...POSITIONS],
    EN: { name: 'Uniswap',
      standard: 'Uniswap is a decentralized exchange made of liquidity pools. You swap one token for another directly from your wallet, and liquidity providers earn the pool fees. Uniswap v3 lets providers concentrate liquidity in a chosen price range.',
      simple: 'Uniswap is a token exchange with no company in the middle: your wallet trades directly with a shared pool of tokens.',
      example: 'Illustrative example (not a quote): you swap 50 USDC for WETH on a USDC/WETH pool with a 0.05% fee tier. The pool sets the price, takes the fee, and sends WETH back to your wallet in the same transaction.',
      advanced: 'Uniswap v3 positions are NFTs that hold liquidity between two prices (ticks). Inside the range they earn fees and their token mix changes with the price; outside it they hold only one token and earn nothing. Fee tiers and tick spacing differ per pool.',
      flofi: 'FloFi authors Uniswap v3 swaps and concentrated-liquidity positions on the pools it has verified; Review shows the minimum you receive and each approval before you sign.',
      protocols: {} },
    PT: { name: 'Uniswap',
      standard: 'A Uniswap é uma exchange descentralizada feita de pools de liquidez. Você troca um token por outro direto da sua carteira, e os provedores de liquidez ganham as taxas do pool. A Uniswap v3 permite concentrar a liquidez em uma faixa de preço escolhida.',
      simple: 'A Uniswap é uma casa de troca de tokens sem empresa no meio: sua carteira troca direto com um pool compartilhado de tokens.',
      example: 'Exemplo ilustrativo (não é cotação): você troca 50 USDC por WETH em um pool USDC/WETH com taxa de 0,05%. O pool define o preço, cobra a taxa e envia o WETH para sua carteira na mesma transação.',
      advanced: 'Posições na Uniswap v3 são NFTs que guardam liquidez entre dois preços (ticks). Dentro da faixa elas ganham taxas e a mistura de tokens muda com o preço; fora dela ficam com um só token e não ganham nada. Faixas de taxa e espaçamento de ticks variam por pool.',
      flofi: 'A FloFi monta swaps e posições de liquidez concentrada da Uniswap v3 nos pools que verificou; a Review mostra o mínimo que você recebe e cada approval antes de você assinar.',
      protocols: {} } },

  JUPITER: { aliases: ['jupiter', 'jup', 'jupiter aggregator'], related: ['SLIPPAGE', 'LIQUIDITY_POOL'], steps: ['SOLANA_SWAP'],
    EN: { name: 'Jupiter',
      standard: 'Jupiter is a swap aggregator on Solana. Instead of using one pool, it searches many Solana pools and can split a trade across them to get a better price, then returns one transaction for your wallet to sign.',
      simple: 'Jupiter is a price-comparison tool for Solana swaps: it looks at many exchanges and picks a good route for your trade.',
      example: 'Illustrative example (not a quote): to swap 10 SOL for USDC, Jupiter might send part of the trade through one pool and the rest through another, because together they give more USDC than either alone.',
      advanced: 'An aggregator quote is valid for a short time; the transaction includes a minimum output computed from your slippage, so if prices move beyond it the swap fails instead of filling at a worse price. On Solana there are no ERC-20 style approvals: you sign the exact swap transaction.',
      flofi: 'FloFi uses Jupiter for Solana swaps; you review and sign the exact transaction, and FloFi reconciles the result.',
      protocols: {} },
    PT: { name: 'Jupiter',
      standard: 'A Jupiter é um agregador de swaps na Solana. Em vez de usar um só pool, ela procura vários pools da Solana e pode dividir a troca entre eles para conseguir um preço melhor, devolvendo uma única transação para sua carteira assinar.',
      simple: 'A Jupiter é um comparador de preços para swaps na Solana: ela olha várias exchanges e escolhe uma boa rota para sua troca.',
      example: 'Exemplo ilustrativo (não é cotação): para trocar 10 SOL por USDC, a Jupiter pode mandar parte da troca por um pool e o resto por outro, porque juntos rendem mais USDC do que cada um sozinho.',
      advanced: 'A cotação de um agregador vale por pouco tempo; a transação inclui um mínimo de saída calculado pelo seu slippage, então se o preço se mover além disso o swap falha em vez de sair pior. Na Solana não há approvals no estilo ERC-20: você assina a transação exata do swap.',
      flofi: 'A FloFi usa a Jupiter para swaps na Solana; você revisa e assina a transação exata, e a FloFi reconcilia o resultado.',
      protocols: {} } },

  ORCA: { aliases: ['orca', 'whirlpool', 'whirlpools', 'orca whirlpools'], related: ['CONCENTRATED_LIQUIDITY', 'LIQUIDITY_POOL', 'IMPERMANENT_LOSS'], steps: ['ORCA_LIQUIDITY', 'SOLANA_SWAP'],
    EN: { name: 'Orca',
      standard: 'Orca is a decentralized exchange on Solana. Its Whirlpools are concentrated-liquidity pools: you can swap through them, or provide liquidity in a price range and earn fees while the price stays inside it.',
      simple: 'Orca is a Solana token exchange where you can also lend your tokens to a pool for a chosen price range and earn trading fees.',
      example: 'Illustrative example (not a quote): you open a SOL/USDC Whirlpool position between two prices. While SOL trades inside that range your position earns fees; if the price leaves the range, the position holds only one of the two tokens and stops earning until the price returns.',
      advanced: 'Whirlpool positions are represented by a position NFT with lower and upper ticks; liquidity math is the same family as Uniswap v3. Opening, increasing, decreasing and closing a position are separate Solana transactions you sign.',
      flofi: 'FloFi authors Orca Whirlpools positions on the pool it has verified, and can prepare decreasing or exiting a FloFi-registered position; you review and sign each transaction.',
      protocols: {} },
    PT: { name: 'Orca',
      standard: 'A Orca é uma exchange descentralizada na Solana. Os Whirlpools dela são pools de liquidez concentrada: você pode fazer swaps por eles ou fornecer liquidez em uma faixa de preço e ganhar taxas enquanto o preço ficar dentro dela.',
      simple: 'A Orca é uma casa de troca da Solana onde você também pode colocar seus tokens num pool para uma faixa de preço escolhida e ganhar taxas de troca.',
      example: 'Exemplo ilustrativo (não é cotação): você abre uma posição no Whirlpool SOL/USDC entre dois preços. Enquanto o SOL negocia nessa faixa, a posição ganha taxas; se o preço sair da faixa, a posição fica com um só dos tokens e para de ganhar até o preço voltar.',
      advanced: 'Posições Whirlpool são representadas por um NFT de posição com ticks inferior e superior; a matemática é da mesma família da Uniswap v3. Abrir, aumentar, reduzir e fechar a posição são transações Solana separadas que você assina.',
      flofi: 'A FloFi monta posições Orca Whirlpools no pool que verificou e pode preparar a redução ou a saída de uma posição registrada pela FloFi; você revisa e assina cada transação.',
      protocols: {} } },

  LTV: { aliases: ['ltv', 'loan to value', 'loan-to-value', 'loan to value ratio', 'relacao emprestimo valor'], related: ['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION'], steps: LENDING,
    EN: { name: 'loan-to-value (LTV)',
      standard: 'Loan-to-value (LTV) is your debt divided by the value of your collateral. A protocol sets a maximum LTV per collateral asset: the most you may borrow against it. A higher LTV means a riskier position, closer to liquidation.',
      simple: 'LTV says how much of your guarantee you have borrowed. Borrowing half the value of your deposit is an LTV of 50%.',
      example: 'Illustrative example (not a quote): collateral worth 1,000 USD and debt of 300 USD is an LTV of 30%. If the maximum LTV for that collateral were 75%, you could borrow up to 750 USD against it, but borrowing that much would leave almost no safety margin.',
      advanced: 'Maximum LTV limits new borrowing; the liquidation threshold (higher than the maximum LTV) decides when a position can be liquidated. LTV changes continuously with prices and accrued interest, even if you do nothing.',
      flofi: 'FloFi shows the reserve\'s values read live at Review (available borrow capacity, liquidation threshold, health factor after); it never estimates them in chat.',
      protocols: { AAVE: 'On Aave V3, each reserve has its own maximum LTV and liquidation threshold, set by Aave governance; FloFi reads them live from the pool.' } },
    PT: { name: 'LTV (loan-to-value)',
      standard: 'LTV (loan-to-value) é a sua dívida dividida pelo valor do seu colateral. O protocolo define um LTV máximo por ativo de colateral: o máximo que você pode pegar emprestado contra ele. LTV mais alto significa posição mais arriscada, mais perto da liquidação.',
      simple: 'O LTV diz quanto da sua garantia você já pegou emprestado. Pegar metade do valor do depósito é um LTV de 50%.',
      example: 'Exemplo ilustrativo (não é cotação): colateral de 1.000 USD e dívida de 300 USD é um LTV de 30%. Se o LTV máximo desse colateral fosse 75%, você poderia pegar até 750 USD, mas pegar tudo isso deixaria quase nenhuma margem de segurança.',
      advanced: 'O LTV máximo limita novos empréstimos; o limite de liquidação (maior que o LTV máximo) decide quando a posição pode ser liquidada. O LTV muda o tempo todo com os preços e os juros acumulados, mesmo que você não faça nada.',
      flofi: 'A FloFi mostra na Review os valores da reserva lidos ao vivo (capacidade de empréstimo disponível, limite de liquidação, health factor depois); ela nunca os estima no chat.',
      protocols: { AAVE: 'Na Aave V3, cada reserva tem seu LTV máximo e seu limite de liquidação, definidos pela governança da Aave; a FloFi os lê ao vivo do pool.' } } },

  HEALTH_FACTOR: { aliases: ['health factor', 'healthfactor', 'hf', 'fator de saude', 'fator saude', 'saude da posicao'], related: ['LIQUIDATION', 'LTV', 'COLLATERAL'], steps: LENDING,
    EN: { name: 'health factor',
      standard: 'The health factor measures how safe a borrowing position is: roughly, your collateral (weighted by its liquidation threshold) divided by your debt. Above 1 the position is safe from liquidation; below 1 it can be liquidated. The higher it is, the more prices can move against you.',
      simple: 'The health factor is a safety score for a loan. Above 1 you are safe; at or below 1 part of your deposit can be sold to cover the loan. Higher is safer.',
      example: 'Illustrative example (not a quote): with a health factor of 2, your collateral could lose about half of its value (with the debt unchanged) before reaching 1. With a health factor of 1.2, a drop of roughly a sixth would already put it at risk.',
      advanced: 'Health factor = Σ(collateral value × liquidation threshold) ÷ total debt value. It falls when collateral prices fall, when the borrowed asset\'s price rises, and as interest accrues; it rises when you repay or add collateral.',
      flofi: 'FloFi shows your health factor before and the estimated health factor after a borrow at Review, read live, and requires at least 2.0; prices and interest can still change afterwards.',
      protocols: { AAVE: 'On Aave V3 the health factor is computed by the pool for your whole account (all collateral and all debt together), not per asset.' } },
    PT: { name: 'health factor (fator de saúde)',
      standard: 'O health factor mede o quão segura está uma posição de empréstimo: grosso modo, o colateral (ponderado pelo limite de liquidação) dividido pela dívida. Acima de 1 a posição está protegida de liquidação; abaixo de 1 ela pode ser liquidada. Quanto maior, mais os preços podem andar contra você.',
      simple: 'O health factor é uma nota de segurança do empréstimo. Acima de 1 você está seguro; em 1 ou abaixo, parte do depósito pode ser vendida para cobrir a dívida. Quanto maior, mais seguro.',
      example: 'Exemplo ilustrativo (não é cotação): com health factor 2, o colateral poderia perder cerca de metade do valor (com a dívida igual) antes de chegar a 1. Com health factor 1,2, uma queda de mais ou menos um sexto já colocaria a posição em risco.',
      advanced: 'Health factor = Σ(valor do colateral × limite de liquidação) ÷ valor total da dívida. Ele cai quando o preço do colateral cai, quando o preço do ativo emprestado sobe e com os juros acumulados; sobe quando você paga dívida ou adiciona colateral.',
      flofi: 'A FloFi mostra na Review o health factor antes e o estimado depois de um borrow, lidos ao vivo, e exige pelo menos 2,0; preços e juros ainda podem mudar depois.',
      protocols: { AAVE: 'Na Aave V3 o health factor é calculado pelo pool para a sua conta inteira (todo o colateral e toda a dívida juntos), não por ativo.' } } },

  LIQUIDATION: { aliases: ['liquidation', 'liquidated', 'liquidacao', 'liquidado', 'liquidar', 'risco de liquidacao', 'liquidation risk'], related: ['HEALTH_FACTOR', 'COLLATERAL', 'LTV'], steps: LENDING,
    EN: { name: 'liquidation',
      standard: 'Liquidation happens when a borrowing position\'s health factor falls below 1: other participants may repay part of your debt and receive part of your collateral, plus a bonus. You keep the borrowed tokens, but you lose that collateral, usually at a worse price than the market.',
      simple: 'If your loan becomes too risky, someone else can pay part of it and take part of your deposit as a reward. That is liquidation, and it costs you more than repaying yourself.',
      example: 'Illustrative example (not a quote): your collateral\'s price drops until your health factor reaches 0.95. A liquidator repays part of your debt and takes collateral worth that amount plus a bonus (for example 5%), which is your loss.',
      advanced: 'Protocols cap how much of a position one liquidation can close (a close factor), and the liquidation bonus differs per asset. Liquidations are triggered by oracle prices, so sudden moves can liquidate before you react; keeping a high health factor and monitoring it is the main protection.',
      flofi: 'FloFi requires a health factor of at least 2.0 for a borrow it prepares, but it does not watch or protect open positions for you: prices and interest keep changing after you sign.',
      protocols: { AAVE: 'On Aave V3, a position becomes liquidatable below a health factor of 1; liquidators repay debt and receive collateral plus that reserve\'s liquidation bonus.' } },
    PT: { name: 'liquidação',
      standard: 'A liquidação acontece quando o health factor de uma posição de empréstimo cai abaixo de 1: outros participantes podem pagar parte da sua dívida e receber parte do seu colateral, com um bônus. Você fica com os tokens emprestados, mas perde esse colateral, normalmente a um preço pior que o de mercado.',
      simple: 'Se o seu empréstimo ficar arriscado demais, outra pessoa pode pagar uma parte dele e levar parte do seu depósito como recompensa. Isso é liquidação, e custa mais caro do que você mesmo pagar.',
      example: 'Exemplo ilustrativo (não é cotação): o preço do seu colateral cai até o health factor chegar a 0,95. Um liquidante paga parte da sua dívida e leva colateral desse valor mais um bônus (por exemplo 5%), que é a sua perda.',
      advanced: 'Os protocolos limitam quanto de uma posição uma liquidação pode fechar (close factor), e o bônus de liquidação varia por ativo. Liquidações usam preços de oráculo, então movimentos bruscos podem liquidar antes de você reagir; manter um health factor alto e acompanhá-lo é a principal proteção.',
      flofi: 'A FloFi exige health factor de pelo menos 2,0 no borrow que prepara, mas não vigia nem protege posições abertas por você: preços e juros continuam mudando depois que você assina.',
      protocols: { AAVE: 'Na Aave V3, a posição pode ser liquidada com health factor abaixo de 1; liquidantes pagam dívida e recebem colateral mais o bônus de liquidação daquela reserva.' } } },

  APY_APR: { aliases: ['apy', 'apr', 'apy vs apr', 'apr vs apy', 'annual percentage yield', 'annual percentage rate', 'rendimento anual', 'taxa anual', 'juros compostos', 'rendimento', 'yield',
    'taxa de juros', 'taxas de juros', 'juros', 'interest rate', 'interest rates'],
    related: ['LENDING_BORROWING', 'LIQUIDITY_POOL'], steps: LENDING,
    EN: { name: 'APY and APR',
      standard: 'APR is a simple yearly rate without compounding. APY includes compounding, so for the same underlying rate APY is higher than APR. In DeFi both are usually variable: they describe the current rate, not a promise.',
      simple: 'APR is the yearly interest without reinvesting it. APY assumes the interest keeps earning interest, so it looks a bit bigger. Neither is guaranteed in DeFi.',
      example: 'Illustrative example (not a quote): a 10% APR compounded daily is about 10.5% APY. On 1,000 USDC that is roughly 100 USDC a year without compounding and about 105 USDC with it, if the rate stayed the same all year, which it usually does not.',
      advanced: 'APY = (1 + APR / n)^n − 1 for n compounding periods. Lending rates change with utilization block by block, so a displayed APY is a snapshot. Liquidity-provider "APR" usually comes from recent fees and says nothing about impermanent loss.',
      flofi: 'FloFi does not quote APY or APR in chat; live rates are only shown where a verified source provides them, and never as a promise.',
      protocols: { AAVE: 'On Aave V3, supply and borrow rates are variable and are usually shown as APY; they change with the pool\'s utilization.' } },
    PT: { name: 'APY e APR',
      standard: 'APR é uma taxa anual simples, sem juros compostos. APY inclui a capitalização, então para a mesma taxa base o APY é maior que o APR. Em DeFi os dois costumam ser variáveis: descrevem a taxa atual, não uma promessa.',
      simple: 'APR são os juros do ano sem reinvestir. APY supõe que os juros continuam rendendo juros, então parece um pouco maior. Nenhum dos dois é garantido em DeFi.',
      example: 'Exemplo ilustrativo (não é cotação): um APR de 10% capitalizado diariamente dá cerca de 10,5% de APY. Sobre 1.000 USDC isso seria uns 100 USDC no ano sem capitalizar e cerca de 105 USDC capitalizando, se a taxa ficasse igual o ano todo, o que normalmente não acontece.',
      advanced: 'APY = (1 + APR / n)^n − 1 para n períodos de capitalização. Taxas de empréstimo mudam com a utilização a cada bloco, então um APY exibido é uma foto do momento. O "APR" de provedores de liquidez costuma vir de taxas recentes e não diz nada sobre perda impermanente.',
      flofi: 'A FloFi não informa APY nem APR no chat; taxas ao vivo só aparecem onde uma fonte verificada as fornece, e nunca como promessa.',
      protocols: { AAVE: 'Na Aave V3, as taxas de supply e de borrow são variáveis e costumam aparecer como APY; elas mudam com a utilização do pool.' } } },

  SLIPPAGE: { aliases: ['slippage', 'slipage', 'slippagem', 'deslizamento', 'derrapagem', 'tolerancia de slippage', 'slippage tolerance', 'price impact', 'impacto de preco'],
    related: ['LIQUIDITY_POOL', 'GAS_FEES'], steps: [...SWAPS, ...BRIDGES, ...HELD],
    EN: { name: 'slippage',
      standard: 'Slippage is the difference between the price you expect when you prepare a trade and the price you actually get when it executes. Prices can move between quote and execution, and a large trade moves the pool price itself. A slippage limit sets the worst price you accept: if the trade would be worse, it fails instead of executing.',
      simple: 'Slippage is how much the price may change between when you ask for a trade and when it happens. Your limit says: "if it gets worse than this, cancel the trade".',
      example: 'Illustrative example (not a quote): you expect 100 USDC of output and set 0.5% slippage (50 bps). The trade then only executes if you receive at least 99.5 USDC; otherwise it reverts and you keep your tokens, paying only the network fee.',
      advanced: 'The limit is enforced on-chain as a minimum output (or maximum input). A tight limit protects price but fails more often in volatile markets; a loose limit fills more reliably but exposes you to worse prices and sandwich attacks. Price impact (your trade\'s own effect on the pool) is part of what the limit must cover.',
      flofi: 'In FloFi each swap, bridge and liquidity step carries its own maximum slippage in basis points (100 bps = 1%), and Review shows the guaranteed minimum you receive before you sign.',
      protocols: { UNISWAP: 'On Uniswap, slippage is enforced as a minimum amount out in the swap transaction itself.', JUPITER: 'On Jupiter, the route quote includes a minimum output derived from your slippage; the Solana transaction fails if it is not met.',
        ACROSS: 'On a bridge route such as Across, the provider order fixes the minimum you receive on the destination network.' } },
    PT: { name: 'slippage',
      standard: 'Slippage é a diferença entre o preço que você espera ao preparar uma troca e o preço que você realmente recebe na execução. Os preços podem mudar entre a cotação e a execução, e uma troca grande move o próprio preço do pool. O limite de slippage define o pior preço que você aceita: se a troca ficar pior, ela falha em vez de executar.',
      simple: 'Slippage é o quanto o preço pode mudar entre o momento em que você pede a troca e o momento em que ela acontece. O seu limite diz: "se ficar pior que isso, cancela a troca".',
      example: 'Exemplo ilustrativo (não é cotação): você espera receber 100 USDC e define slippage de 0,5% (50 bps). A troca só executa se você receber pelo menos 99,5 USDC; senão ela reverte e você fica com seus tokens, pagando só a taxa de rede.',
      advanced: 'O limite é aplicado on-chain como um mínimo de saída (ou máximo de entrada). Um limite apertado protege o preço mas falha mais em mercado volátil; um limite largo executa com mais facilidade, mas expõe você a preços piores e a ataques sanduíche. O impacto de preço (o efeito da sua própria troca no pool) também precisa caber no limite.',
      flofi: 'Na FloFi cada passo de swap, bridge e liquidez tem seu slippage máximo em basis points (100 bps = 1%), e a Review mostra o mínimo garantido que você recebe antes de assinar.',
      protocols: { UNISWAP: 'Na Uniswap, o slippage é aplicado como um valor mínimo de saída na própria transação do swap.', JUPITER: 'Na Jupiter, a cotação da rota inclui um mínimo de saída derivado do seu slippage; a transação Solana falha se ele não for atingido.',
        ACROSS: 'Numa rota de bridge como a Across, a ordem do provedor fixa o mínimo que você recebe na rede de destino.' } } },

  IMPERMANENT_LOSS: { aliases: ['impermanent loss', 'perda impermanente', 'divergence loss', 'il'], related: ['LIQUIDITY_POOL', 'CONCENTRATED_LIQUIDITY'], steps: HELD,
    EN: { name: 'impermanent loss',
      standard: 'Impermanent loss is the difference between keeping two tokens in your wallet and depositing them in a liquidity pool, when their relative price changes. The pool rebalances as people trade, so you end up with more of the token that fell and less of the one that rose. Fees can offset it, but not always.',
      simple: 'When you provide liquidity and prices move, the pool swaps part of your tokens automatically. Compared with just holding them, you can end up with less value. That gap is impermanent loss.',
      example: 'Illustrative example (not a quote): you deposit equal values of ETH and USDC. If ETH doubles in price, the pool sells part of your ETH as it rises; in a classic pool you would have about 5.7% less value than if you had simply held both tokens, before counting fees.',
      advanced: 'It is "impermanent" because it disappears if prices return to the starting ratio, and becomes permanent if you withdraw at a different ratio. Concentrated liquidity amplifies both fee income and impermanent loss inside the chosen range.',
      flofi: 'FloFi does not estimate impermanent loss for a position; it shows the range, the maximum deposits and each transaction at Review.',
      protocols: { UNISWAP: 'On Uniswap v3, a narrower range earns more fees per unit of liquidity but also concentrates impermanent loss.', ORCA: 'On Orca Whirlpools, the same applies: a narrow range is more sensitive to price moves.' } },
    PT: { name: 'perda impermanente',
      standard: 'Perda impermanente é a diferença entre manter dois tokens na carteira e depositá-los em um pool de liquidez, quando o preço relativo entre eles muda. O pool se rebalanceia com as trocas, então você termina com mais do token que caiu e menos do que subiu. As taxas podem compensar, mas nem sempre.',
      simple: 'Quando você fornece liquidez e os preços mudam, o pool troca parte dos seus tokens automaticamente. Comparado com só guardar os tokens, você pode terminar com menos valor. Essa diferença é a perda impermanente.',
      example: 'Exemplo ilustrativo (não é cotação): você deposita valores iguais de ETH e USDC. Se o ETH dobrar de preço, o pool vende parte do seu ETH enquanto ele sobe; num pool clássico você teria cerca de 5,7% menos valor do que se tivesse só guardado os dois tokens, antes de contar as taxas.',
      advanced: 'Ela é "impermanente" porque some se os preços voltarem à proporção inicial, e vira permanente se você sacar com outra proporção. A liquidez concentrada amplia tanto a renda de taxas quanto a perda impermanente dentro da faixa escolhida.',
      flofi: 'A FloFi não estima perda impermanente de uma posição; ela mostra a faixa, os depósitos máximos e cada transação na Review.',
      protocols: { UNISWAP: 'Na Uniswap v3, uma faixa mais estreita ganha mais taxas por unidade de liquidez, mas também concentra a perda impermanente.', ORCA: 'Nos Whirlpools da Orca vale o mesmo: uma faixa estreita é mais sensível a variações de preço.' } } },

  CONCENTRATED_LIQUIDITY: { aliases: ['concentrated liquidity', 'liquidez concentrada', 'price range', 'faixa de preco', 'range de preco', 'range', 'faixa', 'intervalo de preco', 'ticks', 'tick', 'full range', 'faixa completa'],
    related: ['LIQUIDITY_POOL', 'IMPERMANENT_LOSS', 'UNISWAP'], steps: HELD,
    EN: { name: 'concentrated liquidity (price range)',
      standard: 'With concentrated liquidity you choose a price range for your deposit. Your liquidity only works, and only earns fees, while the market price is inside that range. A narrower range earns more per unit of capital but stops earning more often; a full range always earns but less.',
      simple: 'You tell the pool: "use my tokens only when the price is between A and B". Inside that window you earn fees; outside it your money sits idle.',
      example: 'Illustrative example (not a quote): you provide USDC and WETH between 3,000 and 4,000 USDC per WETH. While WETH trades in that window you earn fees. If WETH goes above 4,000, your position becomes all USDC; below 3,000, all WETH.',
      advanced: 'Ranges are expressed in ticks; each tick is a 0.01% price step and pools only allow ticks that are multiples of their tick spacing. How much of each token you deposit depends on where the current price sits in your range. Repositioning means withdrawing and opening a new range, with new transactions and costs.',
      flofi: 'In FloFi you can set a price range, a percentage range or the full range for a liquidity step; Review shows the exact range and maximum deposits before you sign.',
      protocols: { UNISWAP: 'On Uniswap v3 the position is an NFT with a lower and upper tick.', ORCA: 'On Orca Whirlpools the position is a position NFT with lower and upper ticks, on Solana.' } },
    PT: { name: 'liquidez concentrada (faixa de preço)',
      standard: 'Com liquidez concentrada você escolhe uma faixa de preço para o seu depósito. Sua liquidez só trabalha, e só ganha taxas, enquanto o preço de mercado estiver dentro dessa faixa. Uma faixa mais estreita rende mais por unidade de capital mas para de render com mais frequência; a faixa completa sempre rende, mas menos.',
      simple: 'Você diz ao pool: "use meus tokens só quando o preço estiver entre A e B". Dentro dessa janela você ganha taxas; fora dela seu dinheiro fica parado.',
      example: 'Exemplo ilustrativo (não é cotação): você fornece USDC e WETH entre 3.000 e 4.000 USDC por WETH. Enquanto o WETH negociar nessa janela, você ganha taxas. Se o WETH passar de 4.000, sua posição vira toda USDC; abaixo de 3.000, toda WETH.',
      advanced: 'As faixas são expressas em ticks; cada tick é um passo de 0,01% no preço e os pools só aceitam ticks múltiplos do seu espaçamento. Quanto de cada token você deposita depende de onde o preço atual está dentro da faixa. Reposicionar significa sacar e abrir uma nova faixa, com novas transações e custos.',
      flofi: 'Na FloFi você pode definir uma faixa de preço, uma faixa percentual ou a faixa completa num passo de liquidez; a Review mostra a faixa exata e os depósitos máximos antes de você assinar.',
      protocols: { UNISWAP: 'Na Uniswap v3 a posição é um NFT com tick inferior e superior.', ORCA: 'Nos Whirlpools da Orca a posição é um NFT de posição com ticks inferior e superior, na Solana.' } } },

  GAS_FEES: { aliases: ['gas', 'gas fee', 'gas fees', 'taxa de rede', 'taxas de rede', 'taxa de gas', 'taxa de transacao', 'custo de rede', 'network fee', 'network fees', 'transaction fee',
    'transaction fees', 'gwei', 'priority fee'],
    related: ['SLIPPAGE', 'BRIDGE'], steps: [...SWAPS, ...BRIDGES, ...LENDING, ...HELD, 'TRANSFER'],
    EN: { name: 'gas and transaction fees',
      standard: 'Gas is the fee you pay a blockchain to process your transaction, paid in the network\'s native coin (ETH on Ethereum, Base and Arbitrum; SOL on Solana). It is separate from protocol fees, such as a pool\'s swap fee or a bridge provider\'s fee. Gas varies with network demand.',
      simple: 'Gas is the "postage" for a blockchain transaction. You pay it in the network\'s own coin, even if the transaction fails.',
      example: 'Illustrative example (not a quote): a swap on Ethereum mainnet usually costs much more gas than the same swap on Base or Arbitrum, because Ethereum block space is scarcer. A failed transaction still uses gas for the work done.',
      advanced: 'On EVM networks the fee is gas used × (base fee + priority fee); the base fee rises when blocks are full. Layer-2 networks also pay for posting data to Ethereum. On Solana, fees are a small base fee per signature plus an optional priority fee.',
      flofi: 'FloFi shows an estimated maximum network cost at Review before you sign; it never quotes live gas in chat. Keep some of the native coin in your wallet to pay it.',
      protocols: { ACROSS: 'A bridge route has its own provider fees in addition to gas on the source network; FloFi lists them at Review.' } },
    PT: { name: 'gas e taxas de transação',
      standard: 'Gas é a taxa que você paga a uma blockchain para processar sua transação, paga na moeda nativa da rede (ETH na Ethereum, Base e Arbitrum; SOL na Solana). Ela é separada das taxas de protocolo, como a taxa de swap de um pool ou a taxa de um provedor de bridge. O gas varia com a demanda da rede.',
      simple: 'Gas é o "selo do correio" de uma transação na blockchain. Você paga na moeda da própria rede, mesmo que a transação falhe.',
      example: 'Exemplo ilustrativo (não é cotação): um swap na Ethereum mainnet costuma custar muito mais gas que o mesmo swap na Base ou na Arbitrum, porque o espaço em bloco da Ethereum é mais escasso. Uma transação que falha ainda gasta gas pelo trabalho feito.',
      advanced: 'Em redes EVM a taxa é gas usado × (base fee + priority fee); a base fee sobe quando os blocos estão cheios. Redes de layer 2 também pagam para publicar dados na Ethereum. Na Solana, a taxa é uma pequena taxa base por assinatura mais uma priority fee opcional.',
      flofi: 'A FloFi mostra na Review um custo máximo estimado de rede antes de você assinar; ela nunca informa gas ao vivo no chat. Mantenha um pouco da moeda nativa na carteira para pagar.',
      protocols: { ACROSS: 'Uma rota de bridge tem taxas do provedor além do gas na rede de origem; a FloFi as lista na Review.' } } },

  BRIDGE: { aliases: ['bridge', 'bridges', 'bridging', 'ponte', 'pontes', 'cross chain', 'cross-chain', 'crosschain', 'entre redes', 'outra rede', 'relay', 'across'],
    related: ['WRAPPED_TOKEN', 'GAS_FEES', 'SLIPPAGE'], steps: BRIDGES,
    EN: { name: 'bridges and cross-chain transfers',
      standard: 'A bridge moves value from one blockchain to another. Usually you deposit tokens on the source network and a provider (a relayer or solver) delivers the equivalent on the destination network, sometimes as a different token. A plain transfer cannot cross networks: going from Base to Solana, for example, always needs a bridge.',
      simple: 'Blockchains are like separate countries. A bridge is the service that takes your tokens on one side and gives you tokens on the other side, for a fee.',
      example: 'Illustrative example (not a quote): you bridge 20 USDC from Base to Solana. You sign a deposit on Base; a provider then sends USDC to your Solana address. You need the destination address of the right kind (a Solana address, not a 0x one).',
      advanced: 'Intent-based bridges (such as Across or Relay) let a solver fill your order on the destination and settle later; you get a guaranteed minimum and a deadline, and if no one fills in time the deposit is refunded on the source. Other designs lock tokens and mint wrapped versions. Each route has its own fees, timing and trust assumptions.',
      flofi: 'FloFi discovers bridge routes live, shows the provider, the guaranteed minimum and the destination address at Review, and never sends to a different destination than the one you reviewed.',
      protocols: { ACROSS: 'On Across, a relayer fills your deposit on the destination network; if no relayer fills before the deadline, the deposit is refunded to you on the source network.' } },
    PT: { name: 'bridges e transferências entre redes',
      standard: 'Uma bridge leva valor de uma blockchain para outra. Normalmente você deposita tokens na rede de origem e um provedor (relayer ou solver) entrega o equivalente na rede de destino, às vezes como outro token. Um envio comum não atravessa redes: ir da Base para a Solana, por exemplo, sempre precisa de uma bridge.',
      simple: 'Blockchains são como países separados. Uma bridge é o serviço que recebe seus tokens de um lado e entrega tokens do outro lado, cobrando uma taxa.',
      example: 'Exemplo ilustrativo (não é cotação): você faz bridge de 20 USDC da Base para a Solana. Você assina um depósito na Base; depois um provedor envia USDC para o seu endereço Solana. Você precisa de um endereço de destino do tipo certo (um endereço Solana, não um 0x).',
      advanced: 'Bridges baseadas em intents (como Across ou Relay) deixam um solver preencher sua ordem no destino e liquidar depois; você tem um mínimo garantido e um prazo, e se ninguém preencher a tempo o depósito é devolvido na origem. Outros modelos travam tokens e emitem versões wrapped. Cada rota tem suas taxas, tempos e premissas de confiança.',
      flofi: 'A FloFi descobre rotas de bridge ao vivo, mostra na Review o provedor, o mínimo garantido e o endereço de destino, e nunca envia para um destino diferente do que você revisou.',
      protocols: { ACROSS: 'Na Across, um relayer preenche seu depósito na rede de destino; se nenhum relayer preencher antes do prazo, o depósito volta para você na rede de origem.' } } },

  WRAPPED_TOKEN: { aliases: ['wrapped token', 'wrapped tokens', 'token wrapped', 'tokens wrapped', 'weth', 'wsol', 'wrapped', 'embrulhado', 'token embrulhado', 'eth vs weth', 'weth vs eth', 'usdc.e', 'bridged usdc'],
    related: ['BRIDGE', 'TOKEN_APPROVAL'], steps: [...SWAPS, ...BRIDGES, ...LENDING],
    EN: { name: 'wrapped tokens',
      standard: 'A wrapped token is a token that represents another asset one-to-one. WETH is ETH wrapped as an ERC-20 so contracts can handle it like any other token; wrapped SOL plays the same role on Solana. Bridged versions (such as USDC.e) represent an asset that came from another network and are not the same token as the native one.',
      simple: 'Wrapping puts a coin in a standard "envelope" so apps can use it. 1 WETH is always backed by 1 ETH, but they are different tokens in your wallet.',
      example: 'Illustrative example (not a quote): you hold 1 ETH and want to use it where only ERC-20 tokens are accepted. Wrapping gives you 1 WETH; unwrapping turns it back into 1 ETH. USDC and USDC.e on the same network are two different tokens, even though both aim for 1 USD.',
      advanced: 'WETH is a contract that holds ETH and mints WETH 1:1, redeemable at any time. Bridged tokens depend on the bridge that issued them, so their risk differs from the native issuer\'s token. Always check the exact token (contract address) a step uses.',
      flofi: 'FloFi keeps ETH and WETH, and USDC and USDC.e, as different tokens and asks when your words could mean either; for example, on Aave the reserve is WETH, not native ETH.',
      protocols: { AAVE: 'On Aave V3 the ETH reserve is WETH: native ETH is wrapped first or not accepted as such.' } },
    PT: { name: 'tokens wrapped (embrulhados)',
      standard: 'Um token wrapped representa outro ativo na proporção de um para um. O WETH é o ETH embrulhado como ERC-20 para que contratos o tratem como qualquer outro token; o SOL wrapped faz o mesmo papel na Solana. Versões vindas por bridge (como o USDC.e) representam um ativo que veio de outra rede e não são o mesmo token que o nativo.',
      simple: 'Fazer wrap é colocar uma moeda num "envelope" padrão para os apps usarem. 1 WETH é sempre lastreado por 1 ETH, mas são tokens diferentes na sua carteira.',
      example: 'Exemplo ilustrativo (não é cotação): você tem 1 ETH e quer usar onde só aceitam tokens ERC-20. O wrap te dá 1 WETH; o unwrap volta para 1 ETH. USDC e USDC.e na mesma rede são dois tokens diferentes, mesmo que os dois busquem valer 1 USD.',
      advanced: 'O WETH é um contrato que guarda ETH e emite WETH 1:1, resgatável a qualquer momento. Tokens vindos por bridge dependem da bridge que os emitiu, então o risco é diferente do token do emissor nativo. Confira sempre o token exato (endereço do contrato) que um passo usa.',
      flofi: 'A FloFi trata ETH e WETH, e USDC e USDC.e, como tokens diferentes e pergunta quando suas palavras podem significar qualquer um; por exemplo, na Aave a reserva é WETH, não ETH nativo.',
      protocols: { AAVE: 'Na Aave V3 a reserva de ETH é WETH: o ETH nativo é embrulhado antes ou não é aceito como tal.' } } },

  TOKEN_APPROVAL: { aliases: ['approval', 'approvals', 'approve', 'token approval', 'allowance', 'aprovacao', 'aprovacoes', 'aprovar', 'permissao de token', 'autorizacao de token', 'revoke', 'revogar approval'],
    related: ['WALLET_SECURITY', 'GAS_FEES'], steps: [...SWAPS, ...BRIDGES, ...LENDING, ...POSITIONS],
    EN: { name: 'token approvals',
      standard: 'On EVM networks, a contract cannot move your ERC-20 tokens until you approve it to spend a specific amount (an allowance). An approval is its own transaction. Unlimited approvals are convenient but risky: if that contract is ever compromised, it could move all of that token you hold.',
      simple: 'An approval is you saying to an app: "you may take up to this many of my tokens". It is a separate signature before the action itself.',
      example: 'Illustrative example (not a quote): to supply 100 USDC to a lending pool, you first approve the pool to spend 100 USDC, then sign the supply. If you approve exactly 100, the pool can never take more than that.',
      advanced: 'Allowances persist until used or changed, so an old unlimited approval stays active. Some flows use signatures (permits) instead of approval transactions. Solana has no ERC-20 approvals: each transaction you sign states exactly what moves. Revoking means setting the allowance back to zero.',
      flofi: 'FloFi asks for exact approvals, never unlimited ones, and only when your current allowance is too low; each approval is listed at Review before your wallet signs.',
      protocols: { AAVE: 'An Aave supply or repay needs an approval of that asset to the Aave Pool first; borrow and withdraw need none.', UNISWAP: 'A Uniswap liquidity position needs an exact approval for each of its two tokens.',
        JUPITER: 'Jupiter swaps on Solana need no approval: you sign the exact swap transaction.', ORCA: 'Orca positions on Solana need no ERC-20 approval.' } },
    PT: { name: 'approvals de token',
      standard: 'Em redes EVM, um contrato não pode mover seus tokens ERC-20 até você aprovar que ele gaste um valor específico (allowance). O approval é uma transação própria. Approvals ilimitados são práticos mas arriscados: se aquele contrato for comprometido, ele poderia mover todo o saldo daquele token.',
      simple: 'Um approval é você dizendo para um app: "você pode pegar até tantos tokens meus". É uma assinatura separada antes da ação em si.',
      example: 'Exemplo ilustrativo (não é cotação): para fornecer 100 USDC num pool de empréstimo, você primeiro aprova o pool a gastar 100 USDC e depois assina o supply. Se aprovar exatamente 100, o pool nunca poderá pegar mais que isso.',
      advanced: 'Allowances continuam valendo até serem usadas ou alteradas, então um approval ilimitado antigo continua ativo. Alguns fluxos usam assinaturas (permits) em vez de transações de approval. A Solana não tem approvals ERC-20: cada transação que você assina diz exatamente o que se move. Revogar é voltar a allowance para zero.',
      flofi: 'A FloFi pede approvals exatos, nunca ilimitados, e só quando a sua allowance atual é menor que o necessário; cada approval aparece na Review antes da sua carteira assinar.',
      protocols: { AAVE: 'Um supply ou repay na Aave precisa antes de um approval daquele ativo para o Pool da Aave; borrow e withdraw não precisam.', UNISWAP: 'Uma posição de liquidez na Uniswap precisa de um approval exato para cada um dos dois tokens.',
        JUPITER: 'Swaps da Jupiter na Solana não precisam de approval: você assina a transação exata do swap.', ORCA: 'Posições da Orca na Solana não precisam de approval ERC-20.' } } },

  WALLET_SECURITY: { aliases: ['wallet security', 'seguranca da carteira', 'seguranca de carteira', 'seed phrase', 'frase semente', 'private key', 'chave privada', 'phishing', 'golpe', 'scam', 'carteira segura', 'self custody', 'autocustodia', 'hardware wallet'],
    related: ['TOKEN_APPROVAL', 'AUTOMATION_DELEGATION'], steps: [],
    EN: { name: 'wallet security',
      standard: 'Your wallet\'s secret (seed phrase or private key) controls your funds: anyone who has it can move them, and no one can undo it. Never type or share it anywhere, including in any chat. Read what you sign, check the network and the destination address, and remove approvals you no longer need.',
      simple: 'Your seed phrase is the master key to your money. Nobody legitimate will ever ask for it, not FloFi and not support. Only sign what you understand.',
      example: 'Illustrative example: a message says "verify your wallet" and asks for your 12 words. That is always a scam. A real app asks you to sign a transaction in your wallet, and your wallet shows exactly what it does.',
      advanced: 'Good practice: use a hardware wallet for larger amounts, separate wallets for daily use and storage, verify contract addresses and domains, simulate before signing, keep approvals exact and revoke stale ones, and be careful with blind-signing messages you cannot read.',
      flofi: 'FloFi never asks for or stores a seed phrase or private key, never signs for you, and shows every transaction at Review before your wallet signs it.',
      protocols: {} },
    PT: { name: 'segurança da carteira',
      standard: 'O segredo da sua carteira (frase semente ou chave privada) controla seus fundos: quem tiver esse segredo pode movê-los, e ninguém consegue desfazer. Nunca digite nem compartilhe esse segredo em lugar nenhum, inclusive em qualquer chat. Leia o que você assina, confira a rede e o endereço de destino, e remova approvals de que não precisa mais.',
      simple: 'Sua frase semente é a chave mestra do seu dinheiro. Ninguém legítimo vai pedir isso, nem a FloFi nem o suporte. Só assine o que você entende.',
      example: 'Exemplo ilustrativo: uma mensagem diz "verifique sua carteira" e pede suas 12 palavras. Isso é sempre golpe. Um app de verdade pede para você assinar uma transação na carteira, e a carteira mostra exatamente o que ela faz.',
      advanced: 'Boas práticas: use carteira de hardware para valores maiores, carteiras separadas para uso diário e para guardar, confira endereços de contrato e domínios, simule antes de assinar, mantenha approvals exatos e revogue os antigos, e cuidado com assinaturas "às cegas" de mensagens que você não consegue ler.',
      flofi: 'A FloFi nunca pede nem guarda frase semente ou chave privada, nunca assina por você e mostra cada transação na Review antes da sua carteira assinar.',
      protocols: {} } },

  AUTOMATION_DELEGATION: { aliases: ['automation', 'automations', 'automacao', 'automacoes', 'automatizar', 'dca', 'recurring', 'recorrente', 'delegation', 'delegated', 'delegacao', 'autorizacao delegada', 'delegated authorization', 'automatic within limits', 'automatico dentro de limites'],
    related: ['WALLET_SECURITY', 'TOKEN_APPROVAL', 'GAS_FEES'], steps: [],
    EN: { name: 'automations and delegated authorization',
      standard: 'An automation repeats an action on a schedule (for example a weekly DCA buy) or when a condition is met (such as a price threshold). Preparing and saving an automation does not move funds. Each occurrence still needs authorization: either you confirm it in your wallet each time, or, where it is supported, you grant a limited delegation in advance.',
      simple: 'An automation is a rule like "buy a little ETH every Monday". Saving the rule is not the same as letting it spend: you still decide how each purchase gets approved.',
      example: 'Illustrative example (not a quote): a rule buys 20 USDC of ETH every Friday at 10:00. With confirm-each-time, FloFi asks you on Friday and nothing happens until you sign. With a delegation limited to, say, 100 USDC a week, it could run without a new signature, but never beyond that limit or after the delegation expires.',
      advanced: 'A delegation should be bounded: which actions and assets, the maximum per occurrence and per period, the networks, an expiry date, and an easy revocation. If funds are insufficient or a limit would be exceeded, the occurrence fails closed instead of partly executing; nothing retries silently.',
      flofi: 'In FloFi, saving or activating an automation never authorizes spending. By default each occurrence asks for your wallet confirmation; delegated execution with signed limits exists only where this deployment enables it, and you can revoke it.',
      protocols: {} },
    PT: { name: 'automações e autorização delegada',
      standard: 'Uma automação repete uma ação em um horário (por exemplo uma compra semanal em DCA) ou quando uma condição acontece (como um preço-alvo). Preparar e salvar uma automação não move fundos. Cada ocorrência ainda precisa de autorização: ou você confirma na carteira toda vez, ou, onde houver suporte, concede antes uma delegação limitada.',
      simple: 'Uma automação é uma regra como "compre um pouco de ETH toda segunda". Salvar a regra não é o mesmo que deixar ela gastar: você ainda decide como cada compra é aprovada.',
      example: 'Exemplo ilustrativo (não é cotação): uma regra compra 20 USDC de ETH toda sexta às 10h. Com confirmação a cada vez, a FloFi te chama na sexta e nada acontece até você assinar. Com uma delegação limitada a, digamos, 100 USDC por semana, ela poderia rodar sem nova assinatura, mas nunca além desse limite nem depois que a delegação vencer.',
      advanced: 'Uma delegação deve ser limitada: quais ações e ativos, o máximo por ocorrência e por período, as redes, uma data de expiração e uma revogação fácil. Se faltar saldo ou um limite fosse ultrapassado, a ocorrência falha de forma segura em vez de executar pela metade; nada é tentado de novo em silêncio.',
      flofi: 'Na FloFi, salvar ou ativar uma automação nunca autoriza gastos. Por padrão cada ocorrência pede a confirmação da sua carteira; a execução delegada com limites assinados só existe onde esta instalação a habilita, e você pode revogá-la.',
      protocols: {} } },
};

// ── Matching ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Lower case, no accents, single spaces, letters/digits/dots kept (so "USDC.e" and "aave v3" survive). */
export const foldText = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ')
  .replace(/\.(?![a-z0-9])|(?<![a-z0-9])\./g, ' ').replace(/\s+/g, ' ').trim();
/** Optimal string alignment distance, bounded (returns limit + 1 as soon as it is exceeded). */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= a.length; i += 1) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value; best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
  }
  return rows[a.length]![b.length]!;
}
const tolerance = (word: string) => word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;
/** Everyday words one letter away from an alias that must never be read as it ("dúvida" is not "dívida", "field" is not "yield"). A typo also
 * keeps its first letter. */
const NEAR_MISS: ReadonlySet<string> = new Set(['duvida', 'duvidas', 'field', 'fields', 'delay', 'delays', 'relay', 'shield', 'dividir', 'pronto', 'ponto']);
/** Short aliases (il, lp, hf, gas, fee…) must match exactly as whole words; longer ones tolerate small typos per word. */
function aliasIn(alias: string, words: readonly string[], folded: string): boolean {
  if (` ${folded} `.includes(` ${alias} `)) return true;
  const parts = alias.split(' ');
  if (parts.some(part => tolerance(part) === 0) && parts.length === 1) return false;
  for (let start = 0; start + parts.length <= words.length; start += 1)
    if (parts.every((part, index) => { const word = words[start + index]!; return part === word || (tolerance(part) > 0 && word[0] === part[0] && !NEAR_MISS.has(word)
      && distance(part, word, tolerance(part)) <= tolerance(part)); })) return true;
  return false;
}
/** The concept a message names: the longest alias found (so "health factor" beats "factor", "concentrated liquidity" beats "liquidity"). */
export function matchConcept(text: string): ConceptId | null {
  const folded = foldText(text), words = folded.split(' ').filter(Boolean);
  if (!words.length) return null;
  let best: { id: ConceptId; length: number } | null = null;
  for (const id of CONCEPT_IDS) for (const alias of CONCEPTS[id].aliases)
    if (alias.length > (best?.length ?? 0) && aliasIn(alias, words, folded)) best = { id, length: alias.length };
  return best?.id ?? null;
}
/** Words of an action request: a message with one is a request for the interpreter, unless it opens with a question. */
const ACTION_WORDS = /(?:^|\s)(?:swap|swaps|trocar|troca|troque|supply|fornecer|fornece|depositar|deposita|deposit|borrow|emprestar|empresta|bridge|enviar|envia|envie|manda|mandar|send|transfer|transferir|transfere|comprar|compra|compre|buy|vender|vende|venda|sell|repay|pagar|paga|withdraw|sacar|saca|retirar|retira|add|adicionar|adiciona|remover|remove|create|criar|cria|faz|fazer|faca|quero|i want|pausa|pausar|pause|ativa|ativar|activate)(?:\s|$)/;
/** Tokens with digits that are names, not amounts. */
const withoutNamedDigits = (folded: string) => folded.replace(/(?:^|\s)(?:v\d|eli5|erc 20|erc20|l2|layer 2|web3)(?=\s|$)/g, ' ');
const QUESTION_CUE = /(?:^|\s)(?:o que (?:e|sao|significa|quer dizer)|oq e|oque e|que e|que sao|o que seria|me explica|explica|explique|explicar|como funciona|como funcionam|pra que serve|para que serve|qual a diferenca|diferenca entre|significa|significado|definicao|nao sei o que e|what s|whats|what is|what are|what does|explain|how does|how do|what is the difference|difference between|meaning of|define|definition|tell me about|me fala sobre|fala sobre|quero entender|quero aprender|teach me|me ensina)(?:\s|$)/;
/** A clean conceptual question ("o que é slippage?", "explain impermanent loss"), never an action request with amounts or addresses. */
/**
 * A question about a LIVE value ("what is the APY on Aave?", "qual o preço do ETH agora?", "my health factor") or about the user's own items ("minha
 * automação", "my position") is not a concept question: it goes to the interpreter, which answers it from FloFi's records or says live values are
 * only in Simulation and Review (MARKET_DATA). Concept answers never stand in for a live value.
 */
const LIVE_OR_OWN = /(?:^|\s)(?:what s the|whats the|what is the|what are the|qual (?:e )?(?:o|a)|quanto|quantos|how much|how many|current|currently|atual|atualmente|agora|hoje|now|today|right now|live|ao vivo|meu|minha|meus|minhas|my|mine|nosso|nossa)(?:\s|$)/;
export function conceptQuestion(text: string): ConceptId | null {
  const folded = foldText(text);
  if (!folded || folded.length > 160 || /\d/.test(withoutNamedDigits(folded)) || /0x[0-9a-f]{6}/i.test(text)) return null;
  const id = matchConcept(text);
  if (!id || LIVE_OR_OWN.test(folded)) return null;
  const opening = QUESTION_CUE.exec(` ${folded}`)?.index ?? -1;
  // "faz um swap e me explica slippage" is a request: an action word before the question goes to the interpreter.
  if (ACTION_WORDS.test(folded) && !(opening >= 0 && opening <= 2)) return null;
  // A bare concept name as a question ("slippage?", "o health factor?") is a question about it; nothing else without a question cue.
  const rest = ` ${folded} `.replace(new RegExp(` (?:${CONCEPTS[id].aliases.map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) `), ' ')
    .replace(/ (?:o|a|os|as|the|um|uma|an?) /g, ' ').trim();
  const bare = rest === '' && /\?\s*$/.test(text.trim());
  return opening >= 0 || bare ? id : null;
}
export type ConceptFollowUp = { readonly kind: 'LEVEL'; readonly level: ConceptLevel } | { readonly kind: 'PROTOCOL'; readonly protocol: ConceptProtocol } | { readonly kind: 'WORKFLOW' };
const SIMPLER = /(?:^|\s)(?:nao entendi|nao entendo|nao ficou claro|nao compreendi|mais simples|simplifica|simplifique|explica melhor|explique melhor|de novo mais facil|mais facil|como se eu fosse|para leigos|pra leigos|didn t get it|did not get it|i don t understand|dont understand|don t understand|not clear|simpler|in simple terms|eli5|explain like|explain again|say it simpler|confused|confuso)(?:\s|$)/;
const EXAMPLE = /(?:^|\s)(?:exemplo|exemplos|exemplifica|example|examples|for instance|show me an example|da um exemplo|me da um exemplo|um caso pratico|na pratica|in practice)(?:\s|$)/;
const ADVANCED = /(?:^|\s)(?:mais detalhes|mais detalhe|aprofunda|aprofundar|detalha|detalhar|mais tecnico|tecnicamente|more detail|more details|go deeper|deeper|advanced|technical|in depth|em detalhe|a fundo)(?:\s|$)/;
const WORKFLOW = /(?:^|\s)(?:meu workflow|meu fluxo|minha estrategia|meu swap|minha bridge|minha operacao|meu pedido|minha posicao|meus passos|no meu|na minha|my workflow|my flow|my strategy|my swap|my bridge|my position|in my|my steps|my case|meu caso|no meu caso)(?:\s|$)/;
const PROTOCOL_WORDS: Readonly<Record<ConceptProtocol, RegExp>> = { AAVE: /(?:^|\s)aave(?:\s|$)/, UNISWAP: /(?:^|\s)uniswap(?:\s|$)/, JUPITER: /(?:^|\s)jupiter(?:\s|$)/,
  ORCA: /(?:^|\s)(?:orca|whirlpools?)(?:\s|$)/, ACROSS: /(?:^|\s)across(?:\s|$)/ };
/** A follow-up about the concept just explained. Short messages only; anything with amounts or addresses is a request, not a follow-up. */
export function conceptFollowUp(text: string): ConceptFollowUp | null {
  const folded = foldText(text);
  if (!folded || folded.length > 120 || /\d/.test(withoutNamedDigits(folded))) return null;
  if (WORKFLOW.test(folded) && !ACTION_WORDS.test(folded)) return { kind: 'WORKFLOW' };
  const protocol = CONCEPT_PROTOCOLS.find(item => PROTOCOL_WORDS[item].test(folded));
  // "e na Aave?" / "how about Uniswap" is a follow-up; "quero fazer supply na Aave" is a request.
  if (protocol && folded.split(' ').length <= 10 && !ACTION_WORDS.test(folded)) return { kind: 'PROTOCOL', protocol };
  if (EXAMPLE.test(folded)) return { kind: 'LEVEL', level: 'EXAMPLE' };
  if (SIMPLER.test(folded)) return { kind: 'LEVEL', level: 'SIMPLE' };
  if (ADVANCED.test(folded)) return { kind: 'LEVEL', level: 'ADVANCED' };
  return null;
}

// ── Answers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ConceptAnswer = { readonly text: string; readonly notes: readonly string[]; readonly options: readonly string[]; readonly state: ConceptState };
/** Protocol names (proper nouns, the same in every language). */
const PROTOCOL_LABEL = Object.freeze({ AAVE: 'Aave', UNISWAP: 'Uniswap', JUPITER: 'Jupiter', ORCA: 'Orca', ACROSS: 'Across' }) satisfies Readonly<Record<ConceptProtocol, string>>;
const FOLLOW = {
  EN: { simpler: 'Explain it more simply', example: 'Give me an example', advanced: 'More detail', workflow: 'And in my workflow?', protocol: (name: string) => `How does it work on ${name}?`,
    general: 'General knowledge, not live data: no price, rate or position of yours is stated here.', example_label: 'Illustrative numbers only, not a quote.',
    unknownProtocol: (name: string, concept: string) => `I have no ${name}-specific note about ${concept}. In general: ` },
  PT: { simpler: 'Explica mais simples', example: 'Me dá um exemplo', advanced: 'Mais detalhes', workflow: 'E no meu workflow?', protocol: (name: string) => `Como funciona na ${name}?`,
    general: 'Conhecimento geral, não dados ao vivo: nenhum preço, taxa ou posição sua é informado aqui.', example_label: 'Números apenas ilustrativos, não são cotação.',
    unknownProtocol: (name: string, concept: string) => `Não tenho uma observação específica da ${name} sobre ${concept}. Em geral: ` },
} as const;
export const conceptName = (id: ConceptId, language: CopilotLanguage): string => CONCEPTS[id][language].name;
/** The protocols a concept has a specific note for (for follow-up options). */
export const conceptProtocols = (id: ConceptId): ConceptProtocol[] => CONCEPT_PROTOCOLS.filter(protocol => CONCEPTS[id].EN.protocols[protocol]);

/** FloFi's explanation of `id`. `workflowSteps` (optional) offers the "in my workflow" follow-up only when a relevant step exists. */
export function answerConcept(id: ConceptId, request: { readonly level?: ConceptLevel; readonly protocol?: ConceptProtocol | null; readonly language: CopilotLanguage;
  readonly workflowSteps?: readonly WorkflowStep[] }): ConceptAnswer {
  const level = request.level ?? 'STANDARD', protocol = request.protocol ?? null, copy = CONCEPTS[id][request.language], f = FOLLOW[request.language];
  let text: string;
  if (protocol) {
    const line = copy.protocols[protocol];
    text = line ? `${line} ${copy.standard}` : f.unknownProtocol(PROTOCOL_LABEL[protocol], copy.name) + copy.standard;
  } else text = level === 'SIMPLE' ? copy.simple : level === 'EXAMPLE' ? copy.example : level === 'ADVANCED' ? copy.advanced : copy.standard;
  const notes = [copy.flofi, level === 'EXAMPLE' ? f.example_label : f.general];
  const relevant = (request.workflowSteps ?? []).some(step => CONCEPTS[id].steps.includes(step.detail.type));
  const protocols = conceptProtocols(id).filter(item => item !== protocol);
  const options = [...level !== 'SIMPLE' ? [f.simpler] : [], ...level !== 'EXAMPLE' ? [f.example] : [], ...protocols.length ? [f.protocol(PROTOCOL_LABEL[protocols[0]!])] : [],
    ...relevant ? [f.workflow] : level === 'STANDARD' ? [f.advanced] : []].slice(0, 4);
  return { text, notes, options, state: { id, level, protocol } };
}

/** The concept in the user's own workflow: only FloFi's canonical step facts (`stepSentence`), never a live value. */
export function conceptInWorkflow(id: ConceptId, steps: readonly WorkflowStep[], language: CopilotLanguage, describe: (step: WorkflowStep) => string):
  { readonly text: string; readonly notes: readonly string[] } {
  const pt = language === 'PT', copy = CONCEPTS[id][language];
  const relevant = steps.filter(step => CONCEPTS[id].steps.includes(step.detail.type));
  if (!relevant.length) return { text: pt ? `Seu workflow atual não tem nenhum passo em que ${copy.name} se aplique. ${copy.flofi}`
    : `Your current workflow has no step where ${copy.name} applies. ${copy.flofi}`, notes: [] };
  const lines = relevant.slice(0, 6).map((step, index) => `${index + 1}. ${describe(step)}`);
  return { text: (pt ? `No seu workflow, ${copy.name} aparece aqui:\n` : `In your workflow, ${copy.name} shows up here:\n`) + lines.join('\n'),
    notes: [copy.flofi, pt ? 'Valores ao vivo (preços, health factor, taxas) só aparecem na Simulação e na Review.' : 'Live values (prices, health factor, fees) only appear in Simulation and Review.'] };
}

/**
 * The concepts that apply to these canonical workflow steps — the reverse of each concept's `steps` — in catalog order. Read from the steps'
 * types only (`workflow-steps.ts`), never from a live value; used by surfaces that explain a whole workflow (MCP `explain_strategy`).
 */
export function conceptsForSteps(steps: readonly Pick<WorkflowStep, 'detail'>[]): ConceptId[] {
  const types = new Set(steps.map(step => step.detail.type));
  return CONCEPT_IDS.filter(id => CONCEPTS[id].steps.some(type => types.has(type)));
}

/** Every number that appears in FloFi's own copy of a concept (illustrative values), for the eval's grounded-number invariant. */
export function conceptNumbers(id: ConceptId): readonly string[] {
  const text = (['EN', 'PT'] as const).flatMap(language => { const copy = CONCEPTS[id][language]; return [copy.standard, copy.simple, copy.example, copy.advanced, copy.flofi, ...Object.values(copy.protocols)]; }).join(' ');
  return [...new Set([...text.matchAll(/\d+(?:[.,]\d+)*/g)].map(match => match[0]))];
}
/** A catalog entry for discovery surfaces (MCP, the model tool): the id, its names and whether protocol notes exist. */
export const conceptCatalog = (language: CopilotLanguage) => CONCEPT_IDS.map(id => ({ id, name: CONCEPTS[id][language].name, protocols: conceptProtocols(id), related: CONCEPTS[id].related }));
