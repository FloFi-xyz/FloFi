// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the platform guide — what a FloFi user can see and configure, where, and what the Copilot may do about it. One
 * shared, permission-aware registry for the web chat, Channel Core and the MCP server. Paths come from the app's own route constants (never hand-
 * typed); every entry says how the Copilot may act on it:
 *
 *   EXPLAIN         say how it works                       READ            show the owner's own state (only where the surface has a verified owner)
 *   NAVIGATE        point to the FloFi screen              PREPARE_CHANGE  prepare a change for the owner to review (existing draft paths only)
 *   APPLY_CHANGE    the owner applies it on that screen, with their own click (the Copilot never applies a change; it only navigates there)
 *
 * Nothing here reads data, changes a setting, signs or grants authority. Admin settings, provider keys and security-critical controls are not
 * user features and are never listed.
 */
import { ACCOUNT_WORKSPACES, SECONDARY_WORKSPACES } from '../secondary-workspaces';
import { COPILOT_NETWORK_IDS, networkOfCopilot } from '../network-registry';
import type { CopilotLanguage } from '../copilot-messages';
import { positionNetworksText } from '../copilot-positions';
import { foldText } from './concepts';

export const PLATFORM_MODES = ['EXPLAIN', 'NAVIGATE', 'READ', 'PREPARE_CHANGE', 'APPLY_CHANGE'] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];
export const PLATFORM_SURFACES = ['WEB', 'TELEGRAM', 'WHATSAPP', 'MCP'] as const;
export type PlatformSurface = (typeof PLATFORM_SURFACES)[number];
/** What the owner needs for the action on that screen. */
export type PlatformRequirement = 'NONE' | 'ACCOUNT_SESSION' | 'WALLET_PROOF' | 'OWNER_SIGNATURE';
// BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: LIQUIDITY_POSITIONS is matched first, so "can I collect my fees from Telegram / MCP?" is answered plainly.
export const PLATFORM_TOPICS = ['LIQUIDITY_POSITIONS', 'CONNECT_WALLET', 'SUPPORTED_NETWORKS', 'SAVED_WALLETS', 'SAVED_RECIPIENTS', 'AUTOMATIONS', 'AUTHORIZATIONS',
  'NOTIFICATIONS', 'ACCOUNT_SETTINGS', 'PRIVACY_SECURITY', 'HISTORY', 'EXECUTION_STATUS', 'WORKFLOW_SAVING', 'DELETE_ACCOUNT', 'AI_AGENTS'] as const;
export type PlatformTopic = (typeof PLATFORM_TOPICS)[number];

const route = (id: string): string => [...SECONDARY_WORKSPACES, ...ACCOUNT_WORKSPACES].find(item => item.id === id)!.href;
/** The FloFi pages the guide may point to (relative paths; a surface builds the full URL from its trusted origin). */
export const PLATFORM_PATHS = Object.freeze({ app: '/app', dashboard: '/app/dashboard', workflows: route('workflows'), automations: route('automations'),
  credentials: route('credentials'), agents: route('agents'), passkeys: route('passkeys'), privacy: route('privacy'), connections: '/connections' });
const mainnets = () => COPILOT_NETWORK_IDS.filter(id => networkOfCopilot(id).environment === 'MAINNET').map(id => networkOfCopilot(id).name);

type Entry = { readonly modes: readonly PlatformMode[]; readonly path: keyof typeof PLATFORM_PATHS | null; readonly requires: PlatformRequirement;
  readonly surfaces: readonly PlatformSurface[]; readonly keywords: readonly RegExp[];
  /** Words that make the same question about the user's own workflow rather than FloFi (answered from the workflow's canonical facts instead). */
  readonly unless?: RegExp;
  readonly copy: Readonly<Record<CopilotLanguage, { readonly label: string; readonly text: string }>> };
const ALL: readonly PlatformSurface[] = PLATFORM_SURFACES;
/** Words about the owner's liquidity positions, and the surfaces that cannot manage them in this build. */
const POSITION_WORDS = '(?:posic|posit|pool|liquidez|liquidity|lp\\b|taxas|fees|rendimentos|nft da posic|position nft)';
const OTHER_SURFACES = '(?:telegram|whatsapp|mcp|api|developer api|api (?:de|para) desenvolvedores|agente|agent|chatgpt|claude)';
const GUIDE: Readonly<Record<PlatformTopic, Entry>> = {
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: where the owner's liquidity positions are managed, and where they are NOT (said plainly on every surface).
  LIQUIDITY_POSITIONS: { modes: ['EXPLAIN', 'NAVIGATE'], path: 'dashboard', requires: 'WALLET_PROOF', surfaces: ALL,
    keywords: [new RegExp(`${POSITION_WORDS}\\w*.{0,60}?\\b${OTHER_SURFACES}\\b`), new RegExp(`\\b${OTHER_SURFACES}\\b.{0,60}?${POSITION_WORDS}`),
      /(?:onde|where|como|how)\b.{0,30}?\b(?:gerenci|manage|administr)\w*\s+(?:as\s+|os\s+|my\s+|minhas\s+|meus\s+)?(?:posic|position|pool|liquidez|liquidity)/],
    copy: { EN: { label: 'Dashboard', text: `Your liquidity positions on ${positionNetworksText('EN')} are managed in the FloFi web app: Dashboard → My DeFi Positions, or ask ` +
      'in the web chat ("collect my fees", "remove half of my liquidity", "close my Orca position"). Each operation is prepared for Simulate and authorized on Execute, and your ' +
      'wallet signs it. Telegram, WhatsApp, MCP and the Developer API cannot manage liquidity positions in this build.' },
      PT: { label: 'Painel', text: `Suas posições de liquidez na ${positionNetworksText('PT')} são gerenciadas no app web do FloFi: Painel → Minhas posições DeFi, ou peça ` +
      'no chat web ("coleta minhas taxas", "retira metade da minha liquidez", "fecha minha posição na Orca"). Cada operação é preparada para o Simular e autorizada em Executar, e ' +
      'sua carteira assina. Telegram, WhatsApp, MCP e a API para desenvolvedores não gerenciam posições de liquidez nesta versão.' } } },
  CONNECT_WALLET: { modes: ['EXPLAIN', 'NAVIGATE'], path: 'credentials', requires: 'NONE', surfaces: ALL,
    keywords: [/(?:conect|connect|ligar|vincul|link|usar|use|adicionar|add|trocar de|switch)\w*\s+(?:a\s+|o\s+|my\s+|minha\s+|meu\s+)?(?:phantom|metamask|meta mask|rabby|coinbase wallet|backpack|solflare|carteira|wallet)/, /(?:como|how)\s+(?:eu\s+)?(?:conecto|connect)/],
    copy: { EN: { label: 'Credentials', text: 'Use Connect wallet in FloFi and choose your wallet: Phantom (Solana or EVM), MetaMask, Rabby, Coinbase Wallet, Backpack or Solflare. FloFi only reads your public address; your wallet asks you to approve every signature, and FloFi never asks for a seed phrase. Connected and saved wallets are listed in Credentials.' },
      PT: { label: 'Credentials', text: 'Use Conectar carteira na FloFi e escolha sua carteira: Phantom (Solana ou EVM), MetaMask, Rabby, Coinbase Wallet, Backpack ou Solflare. A FloFi só lê seu endereço público; sua carteira pede sua aprovação para cada assinatura, e a FloFi nunca pede frase semente. Carteiras conectadas e salvas aparecem em Credentials.' } } },
  SUPPORTED_NETWORKS: { modes: ['EXPLAIN'], path: null, requires: 'NONE', surfaces: ALL,
    keywords: [/(?:quais|which|what)\s+(?:redes|networks|chains|blockchains)/, /(?:redes|networks|chains)\s+(?:suportad|support|disponive|available)/],
    unless: /(?:^|\s)(?:this|it|isso|esse|este|essa|esta|meu|minha|my|workflow|fluxo|estrategia|strategy)(?:\s|$)/,
    copy: { EN: { label: 'Networks', text: `FloFi works with real funds on ${mainnets().join(', ')}. Which actions each network supports is checked when you ask for one; test networks are not offered in the public product.` },
      PT: { label: 'Redes', text: `A FloFi opera com fundos reais na ${mainnets().join(', ')}. Quais ações cada rede suporta é verificado quando você pede uma; redes de teste não são oferecidas no produto público.` } } },
  SAVED_WALLETS: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'credentials', requires: 'ACCOUNT_SESSION', surfaces: ALL,
    keywords: [/(?:salvar|save|guardar|favorit)\w*\s+(?:a\s+|uma\s+|my\s+|minha\s+)?(?:carteira|wallet)/, /(?:carteiras|wallets)\s+(?:salvas|saved)/, /(?:renomear|rename|remover|remove)\s+(?:a\s+|uma\s+)?(?:carteira|wallet)/],
    copy: { EN: { label: 'Credentials', text: 'Your own wallets are in Credentials → Wallets: wallets on your FloFi account, and wallets saved on this device. You can rename or remove them there. To keep an address you send to (someone else\'s, or your own on another network), save it as a recipient instead: Credentials → Saved recipients.' },
      PT: { label: 'Credentials', text: 'Suas carteiras ficam em Credentials → Carteiras: as da sua conta FloFi e as salvas neste dispositivo. Lá você pode renomear ou remover. Para guardar um endereço para onde você envia (de outra pessoa, ou seu em outra rede), salve-o como destinatário: Credentials → Destinatários salvos.' } } },
  SAVED_RECIPIENTS: { modes: ['EXPLAIN', 'NAVIGATE', 'READ', 'PREPARE_CHANGE', 'APPLY_CHANGE'], path: 'credentials', requires: 'ACCOUNT_SESSION', surfaces: ['WEB'],
    keywords: [/(?:destinatari|recipient|address book|agenda de enderecos|enderecos salvos|saved addresses|contatos)/],
    copy: { EN: { label: 'Credentials', text: 'Saved recipients are names for public addresses you send to, kept on your FloFi account (Credentials → Saved recipients). After you send to a new address, FloFi can offer to save it; then you can say "send 10 USDC to <name>". A saved name is not proof the wallet is yours and authorizes nothing: every transaction is still reviewed and signed by you.' },
      PT: { label: 'Credentials', text: 'Destinatários salvos são nomes para endereços públicos para onde você envia, guardados na sua conta FloFi (Credentials → Destinatários salvos). Depois de enviar para um endereço novo, a FloFi pode oferecer salvá-lo; aí você pode dizer "envia 10 USDC para <nome>". Um nome salvo não prova que a carteira é sua e não autoriza nada: toda transação continua sendo revisada e assinada por você.' } } },
  AUTOMATIONS: { modes: ['EXPLAIN', 'NAVIGATE', 'READ', 'PREPARE_CHANGE', 'APPLY_CHANGE'], path: 'automations', requires: 'WALLET_PROOF', surfaces: ALL,
    keywords: [/(?:onde|where)\b.{0,30}?\b(?:automac|automation)/, /(?:configurac|settings?|config)\w*\s+(?:da|de|of|dessa|desta|the)\s+(?:automac|automation)/],
    copy: { EN: { label: 'Automations', text: 'Your automations are on the Automations page: their state, next run, history and occurrences waiting for you, with Pause, Resume and Archive (delete). You can also ask here ("which automations do I have?", "pause it", "change it to Friday"); any change is prepared for you to confirm.' },
      PT: { label: 'Automações', text: 'Suas automações ficam na página Automações: estado, próxima execução, histórico e ocorrências esperando por você, com Pausar, Retomar e Arquivar (excluir). Você também pode pedir aqui ("quais automações eu tenho?", "pausa essa", "muda para sexta"); toda mudança é preparada para você confirmar.' } } },
  AUTHORIZATIONS: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'credentials', requires: 'OWNER_SIGNATURE', surfaces: ALL,
    keywords: [/(?:revog|revok|cancel|remov|tirar)\w*\s+(?:a\s+|uma\s+|an?\s+|o\s+|my\s+|minha\s+)?(?:autoriza|authoriz|permiss|permission|approval|aprova|delega|delegation|allowance)/, /(?:autorizac|authoriz|delegac|delegat)\w*\s+(?:ativas|active|existentes|existing)/],
    copy: { EN: { label: 'Credentials', text: 'FloFi asks for exact token approvals, never unlimited ones; an approval you gave stays until you change it in your wallet or with a revoke tool. Execution credentials (delegated authority, where enabled) are revoked in Credentials → Execution credentials, followed by the on-chain revocation your wallet signs. AI-agent connections are ended on the Connections page, and passkeys in Passkeys.' },
      PT: { label: 'Credentials', text: 'A FloFi pede approvals de token exatos, nunca ilimitados; um approval que você deu continua até você mudá-lo na sua carteira ou com uma ferramenta de revoke. Credenciais de execução (autoridade delegada, onde habilitada) são revogadas em Credentials → Credenciais de execução, seguidas da revogação on-chain que sua carteira assina. Conexões com agentes de IA terminam na página Conexões, e passkeys em Passkeys.' } } },
  NOTIFICATIONS: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'automations', requires: 'WALLET_PROOF', surfaces: ALL,
    keywords: [/(?:notifica|notification|alerta|alert|aviso|mensagens? da flofi)/],
    copy: { EN: { label: 'Automations', text: 'Notifications come from your automations. In FloFi they are always shown on the Automations page. Telegram notifications can be unlinked there (Notification settings), or stopped from Telegram by sending STOP. There is no e-mail notification.' },
      PT: { label: 'Automações', text: 'As notificações vêm das suas automações. Na FloFi elas sempre aparecem na página Automações. As notificações no Telegram podem ser desvinculadas lá (Configurações de notificação), ou paradas pelo Telegram enviando STOP. Não há notificação por e-mail.' } } },
  ACCOUNT_SETTINGS: { modes: ['EXPLAIN'], path: null, requires: 'NONE', surfaces: ALL,
    keywords: [/(?:configurac|settings|preferenc|idioma|language|tema|theme|dark mode|modo escuro)/],
    copy: { EN: { label: 'Settings', text: 'Settings is the menu in FloFi\'s top bar: language, light or dark theme, your account (which opens Credentials), Privacy & memory, and Disconnect.' },
      PT: { label: 'Configurações', text: 'As configurações ficam no menu da barra superior da FloFi: idioma, tema claro ou escuro, sua conta (que abre Credentials), Privacidade e memória, e Desconectar.' } } },
  PRIVACY_SECURITY: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'privacy', requires: 'ACCOUNT_SESSION', surfaces: ALL,
    keywords: [/(?:privacidade|privacy|memoria|memory|meus dados|my data|seguranca da conta|account security)/],
    copy: { EN: { label: 'Privacy & memory', text: 'Privacy & memory (from the settings menu) controls what the Copilot may remember about how you write, and lets you erase it. FloFi never stores a seed phrase or private key and never signs for you.' },
      PT: { label: 'Privacidade e memória', text: 'Privacidade e memória (no menu de configurações) controla o que o Copilot pode lembrar sobre como você escreve, e permite apagar. A FloFi nunca guarda frase semente nem chave privada e nunca assina por você.' } } },
  HISTORY: { modes: ['EXPLAIN', 'NAVIGATE', 'READ'], path: 'workflows', requires: 'WALLET_PROOF', surfaces: ALL,
    keywords: [/(?:historico|history|transac\w*\s+anterior|previous transactions|past transactions|execucoes anteriores|past runs|o que eu ja fiz|what i did)/],
    copy: { EN: { label: 'Your workflows', text: 'Past executions are in Your workflows (each run with its steps, transactions and receipts) and on the Dashboard. They are read for the wallet you connected and proved.' },
      PT: { label: 'Seus fluxos', text: 'Execuções anteriores ficam em Seus fluxos (cada execução com passos, transações e recibos) e no Dashboard. Elas são lidas para a carteira que você conectou e comprovou.' } } },
  EXECUTION_STATUS: { modes: ['EXPLAIN', 'NAVIGATE', 'READ'], path: 'dashboard', requires: 'WALLET_PROOF', surfaces: ALL,
    keywords: [/(?:status|andamento|progress)\s+(?:da|de|of|do)\s+(?:execuc|execution|transac|transaction|run)/, /(?:por que|why)\s+(?:minha|my)\s+(?:transac|transaction|execuc|execution)\s+(?:falhou|failed)/],
    copy: { EN: { label: 'Dashboard', text: 'The current run of your workflow shows its status in Execute and on the Dashboard, step by step, with each error explained. FloFi never retries a transaction on its own.' },
      PT: { label: 'Dashboard', text: 'A execução atual do seu fluxo mostra o status em Executar e no Dashboard, passo a passo, com cada erro explicado. A FloFi nunca tenta uma transação de novo por conta própria.' } } },
  WORKFLOW_SAVING: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'workflows', requires: 'WALLET_PROOF', surfaces: ['WEB'],
    keywords: [/(?:salvar|save|guardar)\s+(?:o\s+|meu\s+|my\s+|this\s+|esse\s+)?(?:fluxo|workflow|estrategia|strategy)/, /(?:fluxos|workflows)\s+(?:salvos|saved)/],
    copy: { EN: { label: 'Your workflows', text: 'Save the workflow on the canvas with Save; saved workflows are listed in Your workflows, where you can open them again.' },
      PT: { label: 'Seus fluxos', text: 'Salve o fluxo no canvas com Salvar; os fluxos salvos ficam em Seus fluxos, onde você pode abri-los de novo.' } } },
  DELETE_ACCOUNT: { modes: ['EXPLAIN', 'NAVIGATE', 'APPLY_CHANGE'], path: 'credentials', requires: 'ACCOUNT_SESSION', surfaces: ALL,
    keywords: [/(?:excluir|apagar|deletar|delete|close|encerrar)\s+(?:a\s+|minha\s+|my\s+)?(?:conta|account)/],
    copy: { EN: { label: 'Credentials', text: 'You can delete your FloFi account at the end of Credentials (Danger zone), after a recent sign-in. It removes your account, its sign-in identities, sessions, the wallet addresses saved to the account and its saved recipients (wallets saved only on this device stay in this browser until you remove them). It never touches funds in your wallets.' },
      PT: { label: 'Credentials', text: 'Você pode excluir sua conta FloFi no fim de Credentials (Zona de perigo), depois de entrar de novo. Isso remove sua conta, identidades de login, sessões, os endereços de carteira salvos na conta e seus destinatários salvos (carteiras salvas só neste dispositivo ficam neste navegador até você removê-las). Nunca mexe nos fundos das suas carteiras.' } } },
  AI_AGENTS: { modes: ['EXPLAIN', 'NAVIGATE'], path: 'agents', requires: 'NONE', surfaces: ALL,
    keywords: [/(?:chatgpt|claude|mcp|agente|agent|assistente de ia|ai assistant)\w*/],
    copy: { EN: { label: 'Agents', text: 'AI assistants such as Claude or ChatGPT can use FloFi through its MCP connection (see Agents). They can plan, validate and preview strategies; anything that moves funds still comes back to you here for review and your wallet signature.' },
      PT: { label: 'Agentes', text: 'Assistentes de IA como Claude ou ChatGPT podem usar a FloFi pela conexão MCP (veja Agentes). Eles podem planejar, validar e pré-visualizar estratégias; tudo que move fundos volta para você revisar aqui e assinar na sua carteira.' } } },
};

/** A "how/where" question about FloFi itself (never an action request with amounts or addresses). */
const CUE = /(?:^|\s)(?:como|onde|where|how|qual|quais|which|what|o que|quero|nao quero|i want|i don t want|dont want|posso|can i|da pra|tem como|is there|existe|preciso|need to|stop|parar|desativar|turn off|disable)(?:\s|$)/;
export function matchPlatformTopic(text: string): PlatformTopic | null {
  const folded = foldText(text);
  if (!folded || folded.length > 160 || /\d/.test(folded) || /0x[0-9a-f]{6}/i.test(text) || !CUE.test(folded)) return null;
  return PLATFORM_TOPICS.find(topic => GUIDE[topic].keywords.some(keyword => keyword.test(folded)) && !GUIDE[topic].unless?.test(folded)) ?? null;
}
export type PlatformAnswer = { readonly topic: PlatformTopic; readonly text: string; readonly link: { readonly path: string; readonly label: string } | null;
  readonly modes: readonly PlatformMode[]; readonly requires: PlatformRequirement };
/** FloFi's answer for a topic on a surface: the guidance, and the page to open when the surface can link to it. */
export function platformAnswer(topic: PlatformTopic, language: CopilotLanguage, surface: PlatformSurface = 'WEB'): PlatformAnswer {
  const entry = GUIDE[topic], copy = entry.copy[language];
  const link = entry.path && entry.modes.includes('NAVIGATE') ? { path: PLATFORM_PATHS[entry.path], label: copy.label } : null;
  // A surface never applies a change: on chat channels and MCP, APPLY_CHANGE is only ever a link to the owner's own screen.
  const modes = surface === 'WEB' ? entry.modes : entry.modes.filter(mode => mode !== 'APPLY_CHANGE' && mode !== 'PREPARE_CHANGE');
  return { topic, text: copy.text, link, modes, requires: entry.requires };
}
/** The guide's public projection (MCP discovery): every topic with its modes, requirement, page and label. No user data. */
export const platformGuide = (language: CopilotLanguage, surface: PlatformSurface = 'MCP') =>
  PLATFORM_TOPICS.filter(topic => GUIDE[topic].surfaces.includes(surface)).map(topic => platformAnswer(topic, language, surface));
