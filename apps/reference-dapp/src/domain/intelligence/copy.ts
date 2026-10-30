// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the replies the intelligence layer writes itself (EN/PT). Display copy only: nothing here decides support,
 * provenance or authority. Network, asset and route names come from the registries through the callers.
 */
import type { CopilotLanguage } from '../copilot-messages';
import type { FiatCurrency } from './asset-resolution';
import type { GoalAlternative, GoalField, GoalGap, GoalReason } from './goal-planner';
import type { ActionCapability, NetworkCapabilityProfile } from './capability-api';

const list = (items: readonly string[], language: CopilotLanguage) => items.length < 2 ? items.join('')
  : `${items.slice(0, -1).join(', ')} ${language === 'PT' ? 'e' : 'and'} ${items.at(-1)}`;
const ACTION_NAME: Readonly<Record<CopilotLanguage, Readonly<Record<string, string>>>> = {
  EN: { swap: 'swaps', bridge: 'bridges', transfer: 'transfers', supply: 'Aave V3 supply', borrow: 'Aave V3 borrow', repay: 'Aave V3 repay', withdraw: 'Aave V3 withdraw',
    add_liquidity: 'liquidity positions', lending_composition: 'the Supply → Borrow → Swap composition' },
  PT: { swap: 'swaps', bridge: 'bridges', transfer: 'transferências', supply: 'supply na Aave V3', borrow: 'borrow na Aave V3', repay: 'repay na Aave V3',
    withdraw: 'withdraw na Aave V3', add_liquidity: 'posições de liquidez', lending_composition: 'a composição Supply → Borrow → Swap' },
};
function actionLine(action: ActionCapability, language: CopilotLanguage): string {
  const name = ACTION_NAME[language][action.action] ?? action.action, pt = language === 'PT';
  const assets = action.assets.kind === 'OFFICIAL_CATALOG'
    ? (pt ? `qualquer token do catálogo oficial${action.assets.loaded ? '' : ' (catálogo ainda não carregado: verificado antes da Review)'}` : `any official catalog token${action.assets.loaded ? '' : ' (catalog not loaded yet: verified before Review)'}`)
    : action.assets.symbols.length ? list(action.assets.symbols, language) : '';
  const routes = action.routes.length ? (pt ? `; rotas certificadas para ${list([...new Set(action.routes.map(route => `${route.destination} (${route.asset})`))], language)}`
    : `; certified routes to ${list([...new Set(action.routes.map(route => `${route.destination} (${route.asset})`))], language)}`) : '';
  const code = action.eligibility.execute ? '' : pt ? ' — execução pela carteira do dono não implementada para este caminho' : ' — owner-wallet execution not implemented for this path';
  return `${name}${assets ? `: ${assets}` : ''}${routes}${code}`;
}
export const intelligenceCopy = (language: CopilotLanguage) => language === 'PT' ? PT : EN;
const EN = {
  fiatAmbiguous: (written: string, currency: FiatCurrency, network: string | null, candidates: readonly string[]) => candidates.length
    ? `“${written}” is a currency (${currency}), not a token${network ? ` on ${network}` : ''}. FloFi never swaps a currency for a token on its own: which ${currency} stablecoin do you mean?`
    : `“${written}” is a currency (${currency}), not a token${network ? `, and ${network} has no ${currency} stablecoin FloFi can use` : ''}. Name the token you mean.`,
  amountAmbiguous: (written: string, readings: readonly string[]) => `“${written}” can be read as ${list(readings, 'EN')}. Which amount do you mean? Reply with the number.`,
  unchanged: (label: string) => `${label} already has that value: nothing changed.`,
  capabilitiesOf: (profile: NetworkCapabilityProfile) => `On ${profile.name} (${profile.realFunds ? 'mainnet, real funds' : 'test network'}), FloFi can author ${list(profile.actions.map(action => actionLine(action, 'EN')), 'EN')}` +
    `${profile.universalBridge ? '; universal bridges to and from the other universal-router networks (the route is chosen live and shown at Review)' : ''}.`,
  capabilityScopeNote: 'Registered functionality from FloFi\'s registries. Whether this deployment runs a path is decided at Review; every step still needs a fresh simulation, your Review and your wallet signature.',
  capabilitiesTestNetwork: (network: string) => `${network} is a test network. FloFi's public product runs on mainnets only, so nothing can be authored there.`,
  capabilitiesUnknown: (network: string) => `FloFi has no registered capabilities on ${network}.`,
  goalIntro: (count: number) => count === 1 ? 'Here is the step that reaches your goal:' : `Here are the ${count} steps that reach your goal, in order:`,
  goalStep: (index: number, sentence: string) => `${index}. ${sentence}`,
  goalReasons: { SAME_NETWORK_SWAP: 'Same network: a swap is enough.', CERTIFIED_ROUTE: 'A certified Cross-chain Router route exists for this asset and pair.',
    UNIVERSAL_ROUTE: 'The universal Cross-chain Router asks every provider and picks, at Review, the executable route with the highest guaranteed amount received.',
    CONVERTS_IN_ROUTE: 'The route converts the asset itself, so no separate swap step is needed.',
    LOWEST_COST_AT_REVIEW: 'Lowest total cost: the live quotes (fees, gas and the guaranteed amount) are compared at Review, not guessed now.',
    FASTEST_NOT_SELECTABLE: 'FloFi selects routes by the guaranteed amount received, not by speed; each route\'s estimated duration is shown at Review.',
    FUNDED_BY_PREVIOUS_STEP: 'The later step spends what the earlier step actually delivers, up to its cap, and runs only after the earlier step settled.',
    CAP_IS_YOUR_AMOUNT: 'Its cap is your own amount: a bridge delivers at most what it sends.',
    EACH_STEP_REVIEWED: 'Each step gets its own fresh simulation, your Review and your wallet signature, in order.',
    REAL_FUNDS: 'Real funds: nothing moves until you review and sign in your wallet.' } as Record<GoalReason, string>,
  goalAlternatives: { UNIVERSAL_BEST: 'Alternative: say "cheapest route" to compare every provider (LI.FI, Across, Relay, Mayan) at Review.',
    CERTIFIED_ROUTE: 'Alternative: say "certified route" to use the certified Cross-chain Router route instead.',
    SWAP_ONLY: 'You can swap first as its own step.', SEPARATE_LIQUIDITY: 'After the swap settles, add the liquidity position as a separate workflow with the tokens you then hold.' } as Record<GoalAlternative['code'], string>,
  goalNeeds: { sourceAsset: 'Which token do you have (or want to use)?', sourceNetwork: 'Which network is that token on?', amount: 'How much do you want to use? Write it in digits.',
    targetNetwork: 'On which network do you want to end up?', targetAsset: 'Which token do you want to end up with?',
    cap: 'What is the most the later step may use? Write it in digits.', deposits: 'Which two pool tokens and maximum deposit for each should the position use?',
    range: 'What price or tick range should the position use? You can choose full range on Uniswap.' } as Record<GoalField, string>,
  goalCap: (step: number, asset: string) => `Step ${step + 1} supplies ${asset}, which the earlier step delivers in an amount only known after it settles. What is the most ${asset} it may supply? Write it in digits.`,
  goalGaps: { TEST_NETWORK_NOT_AVAILABLE: (network: string | null) => `${network ?? 'That network'} is a test network. FloFi runs on mainnets only: name the mainnet you want to use.`,
    NETWORK_UNKNOWN: () => 'FloFi does not support that network.', NO_SWAP_ON_NETWORK: (network: string | null) => `FloFi has no swap on ${network ?? 'that network'}.`,
    NO_ROUTE_BETWEEN_NETWORKS: (network: string | null) => `FloFi has no registered route to ${network ?? 'that network'} from there.`,
    LENDING_ASSET_NOT_SUPPORTED: () => 'Aave V3 in FloFi does not list that asset.', LENDING_NOT_ON_NETWORK: (network: string | null) => `FloFi has no Aave V3 market for that asset on ${network ?? 'that network'}.`,
    LIQUIDITY_NOT_ON_NETWORK: (network: string | null) => `FloFi has no registered liquidity protocol on ${network ?? 'that network'}.`,
    LIQUIDITY_ASSET_NOT_IN_PAIR: () => 'The conversion must deliver one of the two tokens in your position. Which pool token should it deliver?',
    FIAT_NOT_AN_ASSET: () => 'A currency is not a token: name the stablecoin you mean (for example one your network lists).',
    SAME_NETWORK_BRIDGE: () => 'Both sides are the same network: no bridge is needed.' } as Record<GoalGap, (network: string | null) => string>,
  goalOptionsNote: (options: readonly string[]) => `Available: ${list(options, 'EN')}.`,
  goalNothing: (network: string, asset: string) => `You already have ${asset} on ${network}: no step is needed.`,
  sequenceInterpreted: 'Review the proposed workflow below: nothing changes until you apply it.',
  explanation: (text: string) => `AI explanation (from FloFi's verified data): ${text}`,
};
const PT: typeof EN = {
  fiatAmbiguous: (written, currency, network, candidates) => candidates.length
    ? `“${written}” é uma moeda (${currency}), não um token${network ? ` na ${network}` : ''}. O FloFi nunca troca uma moeda por um token por conta própria: qual stablecoin de ${currency} você quer?`
    : `“${written}” é uma moeda (${currency}), não um token${network ? `, e a ${network} não tem stablecoin de ${currency} que o FloFi possa usar` : ''}. Diga o token que você quer.`,
  amountAmbiguous: (written, readings) => `“${written}” pode ser lido como ${list(readings, 'PT')}. Qual valor você quer? Responda com o número.`,
  unchanged: label => `${label} já tem esse valor: nada mudou.`,
  capabilitiesOf: profile => `Na ${profile.name} (${profile.realFunds ? 'mainnet, fundos reais' : 'rede de teste'}), o FloFi pode criar ${list(profile.actions.map(action => actionLine(action, 'PT')), 'PT')}` +
    `${profile.universalBridge ? '; bridges universais de e para as outras redes do roteador universal (a rota é escolhida em tempo real e mostrada na Review)' : ''}.`,
  capabilityScopeNote: 'Funcionalidade registrada nos registros do FloFi. Se este ambiente executa um caminho é decidido na Review; cada passo ainda precisa de uma simulação nova, da sua Review e da assinatura da sua carteira.',
  capabilitiesTestNetwork: network => `${network} é uma rede de teste. O produto público do FloFi roda só em mainnets, então nada pode ser criado lá.`,
  capabilitiesUnknown: network => `O FloFi não tem capacidades registradas na ${network}.`,
  goalIntro: count => count === 1 ? 'Este é o passo que alcança o seu objetivo:' : `Estes são os ${count} passos que alcançam o seu objetivo, em ordem:`,
  goalStep: (index, sentence) => `${index}. ${sentence}`,
  goalReasons: { SAME_NETWORK_SWAP: 'Mesma rede: um swap basta.', CERTIFIED_ROUTE: 'Existe uma rota certificada do Cross-chain Router para este ativo e par.',
    UNIVERSAL_ROUTE: 'O Cross-chain Router universal consulta todos os provedores e escolhe, na Review, a rota executável com o maior valor garantido recebido.',
    CONVERTS_IN_ROUTE: 'A própria rota converte o ativo, então não é preciso um swap separado.',
    LOWEST_COST_AT_REVIEW: 'Menor custo total: as cotações em tempo real (taxas, gas e o valor garantido) são comparadas na Review, não estimadas agora.',
    FASTEST_NOT_SELECTABLE: 'O FloFi escolhe rotas pelo valor garantido recebido, não pela velocidade; a duração estimada de cada rota aparece na Review.',
    FUNDED_BY_PREVIOUS_STEP: 'O passo seguinte gasta o que o anterior realmente entregou, até o seu limite, e só roda depois que o anterior foi concluído.',
    CAP_IS_YOUR_AMOUNT: 'O limite é o seu próprio valor: uma bridge entrega no máximo o que envia.',
    EACH_STEP_REVIEWED: 'Cada passo tem sua simulação nova, a sua Review e a assinatura da sua carteira, em ordem.',
    REAL_FUNDS: 'Fundos reais: nada se move até você revisar e assinar na sua carteira.' },
  goalAlternatives: { UNIVERSAL_BEST: 'Alternativa: diga "rota mais barata" para comparar todos os provedores (LI.FI, Across, Relay, Mayan) na Review.',
    CERTIFIED_ROUTE: 'Alternativa: diga "rota certificada" para usar a rota certificada do Cross-chain Router.',
    SWAP_ONLY: 'Você pode fazer o swap primeiro, como um passo próprio.', SEPARATE_LIQUIDITY: 'Depois que o swap for concluído, crie a posição de liquidez em um fluxo separado com os tokens que você tiver.' },
  goalNeeds: { sourceAsset: 'Qual token você tem (ou quer usar)?', sourceNetwork: 'Em qual rede está esse token?', amount: 'Quanto você quer usar? Escreva em algarismos.',
    targetNetwork: 'Em qual rede você quer terminar?', targetAsset: 'Com qual token você quer terminar?', cap: 'Qual o máximo que o passo seguinte pode usar? Escreva em algarismos.',
    deposits: 'Quais são os dois tokens da pool e o depósito máximo de cada um para a posição?', range: 'Qual faixa de preços ou ticks a posição deve usar? Na Uniswap, você pode escolher a faixa completa.' },
  goalCap: (step, asset) => `O passo ${step + 1} faz supply de ${asset}, que o passo anterior entrega em um valor só conhecido depois que ele for concluído. Qual o máximo de ${asset} que ele pode usar? Escreva em algarismos.`,
  goalGaps: { TEST_NETWORK_NOT_AVAILABLE: network => `${network ?? 'Essa rede'} é uma rede de teste. O FloFi roda só em mainnets: diga a mainnet que você quer usar.`,
    NETWORK_UNKNOWN: () => 'O FloFi não suporta essa rede.', NO_SWAP_ON_NETWORK: network => `O FloFi não tem swap na ${network ?? 'rede'}.`,
    NO_ROUTE_BETWEEN_NETWORKS: network => `O FloFi não tem rota registrada para a ${network ?? 'rede'} a partir daí.`,
    LENDING_ASSET_NOT_SUPPORTED: () => 'A Aave V3 no FloFi não lista esse ativo.', LENDING_NOT_ON_NETWORK: network => `O FloFi não tem mercado Aave V3 para esse ativo na ${network ?? 'rede'}.`,
    LIQUIDITY_NOT_ON_NETWORK: network => `O FloFi não tem protocolo de liquidez registrado na ${network ?? 'rede'}.`,
    LIQUIDITY_ASSET_NOT_IN_PAIR: () => 'A conversão deve entregar um dos dois tokens da sua posição. Qual token da pool ela deve entregar?',
    FIAT_NOT_AN_ASSET: () => 'Uma moeda não é um token: diga a stablecoin que você quer (por exemplo, uma que a sua rede lista).',
    SAME_NETWORK_BRIDGE: () => 'Os dois lados são a mesma rede: não é preciso bridge.' },
  goalOptionsNote: options => `Disponível: ${list(options, 'PT')}.`,
  goalNothing: (network, asset) => `Você já tem ${asset} na ${network}: nenhum passo é necessário.`,
  sequenceInterpreted: 'Revise o fluxo proposto abaixo: nada muda até você aplicá-lo.',
  explanation: text => `Explicação da IA (a partir dos dados verificados do FloFi): ${text}`,
};
