// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import Image from 'next/image';
import { LanguageSwitch } from '../../components/flight/language-switch';
import { legalLanguage } from '../../components/flight/legal-language';
import styles from './privacy.module.css';

// The page is public and lives outside the authenticated product workspace.
// Its contact information comes from the Telegram channel's server configuration.
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const language = await legalLanguage();
  return { title: `${language === 'PT' ? 'Política de Privacidade' : 'Privacy Policy'} | FloFi`,
    alternates: { canonical: 'https://flofi.xyz/privacy' } };
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
function getContact(): { label: string; href: string } | null {
  const raw = (process.env.FLOFI_CHANNEL_SUPPORT_CONTACT ?? '').trim();
  if (EMAIL.test(raw)) return { label: raw, href: 'mailto:' + raw };
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.username && !u.password && raw.length <= 256)
      return { label: u.host + u.pathname, href: u.toString() };
  } catch { /* invalid / not configured */ }
  return { label: 'flofi.xyz@gmail.com', href: 'mailto:flofi.xyz@gmail.com' };
}

type Paragraphs = { title: string; paragraphs: readonly string[]; id?: string };
const sectionsPT: readonly Paragraphs[] = [
  { title: 'Dados e finalidades', paragraphs: [
    'Quando envia uma mensagem privada a @FloFiAppBot, a FloFi recebe do Telegram o identificador da conta, identificador da atualização, hora e conteúdo enviado. Utilizamos estes dados para responder, compor uma proposta DeFi, evitar mensagens duplicadas, aplicar limites de utilização e manter temporariamente o contexto da conversa. Os identificadores de fornecedor armazenados são protegidos com resumos criptográficos e os dados temporários são cifrados.',
    'Se abrir a FloFi, poderá ligar uma carteira pública e comprovar o seu controlo através de uma assinatura. Os dados de estratégia, simulação, execução e evidências são tratados para apresentar e acompanhar as operações. As transações em blockchain pública podem permanecer visíveis para qualquer pessoa e não podem ser apagadas pela FloFi.',
    'O site pode tratar preferências de interface e dados técnicos de sessão e segurança. Nunca envie chaves privadas nem frases de recuperação ao bot.'
  ] },
  { title: 'Fundamentos jurídicos', paragraphs: [
    'Os dados necessários à resposta e à prestação das funcionalidades solicitadas são tratados para execução do serviço ou de diligências pedidas pelo utilizador, quando aplicável. Identificadores técnicos e registos de segurança são tratados para prevenir abuso, fraude e falhas com base nos interesses legítimos de proteção do serviço, sujeitos aos direitos dos titulares. Notificações opcionais exigem adesão voluntária.'
  ] },
  { title: 'Prazo de conservação no canal Telegram', paragraphs: [
    'Mensagem recebida e respostas pendentes de envio: até 15 minutos em armazenamento temporário da FloFi. Estado temporário da conversa: eliminado após 30 minutos de inatividade. Endereço cifrado para responder: em regra até 48 horas após a última mensagem; uma ligação voluntária a notificações pode prolongar este prazo.',
    'Registos técnicos de eventos sem conteúdo de mensagens: até 8 dias; auditoria sem conteúdo: até 30 dias. Registos de conversas inativas: em regra até 7 dias, com exceções para registos de desistência e retenção técnica aplicável.',
    'Estes prazos dizem respeito ao canal da FloFi. Não abrangem os dados conservados pelo Telegram, os registos públicos de blockchain ou todos os dados de conta, segurança e execução mantidos noutras partes da plataforma.'
  ] },
  { title: 'Terceiros e transferências de dados', paragraphs: [
    'O funcionamento pode envolver o Telegram (mensagens), Vercel (site e funções), Railway (API), infraestrutura PostgreSQL/Neon (dados da aplicação) e prestadores de serviços blockchain. Apenas se a interpretação de mensagens por IA estiver ativada, poderá ser utilizado um fornecedor de modelos como a OpenAI. O Telegram trata as mensagens de acordo com as suas próprias políticas.',
    'As contas FloFi usam a Privy como fornecedora do início de sessão e das carteiras incorporadas, ao serviço da FloFi: a Privy trata os identificadores de início de sessão (email, conta Google, endereço de carteira externa) e guarda as chaves das carteiras incorporadas no seu próprio ambiente seguro. Uma chave privada que importe é escrita na página da FloFi e entregue, no seu navegador, diretamente à Privy; nunca é enviada aos servidores da FloFi, guardada nem registada. A FloFi guarda o identificador público do seu utilizador na Privy, os identificadores que a Privy verificou, os endereços públicos e identificadores das suas carteiras na Privy, e as sessões. Eliminar a conta FloFi apaga esses dados na FloFi, mas não o seu utilizador nem as suas carteiras na Privy: para os apagar também, exporte primeiro as carteiras que quiser manter e peça-o através do contacto desta página.',
    'Dependendo dos fornecedores e regiões de alojamento, podem existir transferências internacionais de dados, sujeitas às garantias legais aplicáveis.'
  ] },
  { title: 'Os seus direitos', paragraphs: [
    'Sujeito à legislação aplicável, pode pedir acesso, retificação, eliminação, limitação, portabilidade ou opor-se ao tratamento. Para exercer os direitos, utilize o contacto indicado nesta página. Pode reclamar junto da Comissão Nacional de Proteção de Dados (CNPD), em www.cnpd.pt, ou da autoridade competente.',
    'Para deixar de receber mensagens da FloFi no Telegram, envie STOP. O estado da conversa e o endereço para resposta são apagados, mas certos registos técnicos sem conteúdo podem permanecer até ao fim do prazo indicado.'
  ] },
  { title: 'Campanha Flight FloFi (/board)', id: 'campanha-flight-flofi', paragraphs: [
    'Lista beta: quando entra na lista em flofi.xyz/board, a FloFi guarda o email que indicou (em minúsculas), o idioma da página e a versão do aviso apresentado, para o beta da FloFi e só para isso: avisar quando o seu grupo embarca e comprovar o seu direito ao beta antes de vinculá-lo à conta autenticada. Base legal: o seu consentimento, dado ao enviar o formulário, que pode retirar a qualquer momento. A FloFi avisa por email quando o seu grupo embarca (ver emails da campanha abaixo). Para limitar abusos do formulário, é guardado durante um dia um resumo com chave (HMAC) da rede do pedido (o endereço IPv4, ou o prefixo /64 de um endereço IPv6) — nunca o próprio endereço.',
    'Cartão de embarque: quando conclui uma simulação com a sua conta FloFi durante a campanha, a FloFi guarda durante duas horas a prova dessa simulação (identificador da conta, da execução, do fluxo e do fluxo de trabalho, e a rota simulada: redes e passos, nunca valores) e, ao emitir o cartão, guarda a rota (redes e passos, nunca valores), o número de embarque e, se o indicar, o seu @ do X. O seu @ e a sua rota só aparecem no painel público de partidas se o escolher; pode retirar essa escolha a qualquer momento. Os convites guardam qual conta usou cada código. Base legal: a execução da campanha que pediu e, para o painel público, o seu consentimento.',
    'Emails da campanha (a partir de 9 de novembro de 2026): a FloFi envia os emails da campanha a partir de hello@flofi.xyz, através da Resend (serviço de email que atua como subcontratante da FloFi; as respostas vão para a caixa da equipa): a confirmação quando entra na lista, o lembrete na véspera do embarque, o link e o código de embarque do seu grupo, o seu cartão de embarque, a confirmação do próximo voo e os convites da equipa. Para cada email, a FloFi guarda o seu endereço, o idioma, o tipo de email e o estado de entrega até 90 dias depois do envio ou da retirada; um email ainda não enviado é guardado até ser enviado, retirado ou até o fim do beta. Cada email da campanha tem cancelamento com um clique: a FloFi deixa de lhe enviar emails da campanha e regista um resumo pseudonimizado (SHA-256) do seu endereço para nunca mais lhe escrever (o mesmo resumo faz parte do link de cancelamento de cada email), e só envia o link de embarque que você mesmo pedir. Esse resumo é guardado para respeitar a sua oposição, também depois da eliminação e do fim do beta (base legal: a sua oposição, que a FloFi tem de respeitar). A sua entrada na lista fica até ao fim do beta ou até pedir a eliminação.',
    'Acesso ao embarque: o email do seu grupo traz um link (válido por 72 horas) e um código de seis dígitos (válido por 15 minutos), cada um de uso único; a FloFi guarda só resumos deles, nunca o link nem o código. Usar um deles prova que lê esse endereço e associa essa entrada da lista à conta FloFi com que entrou (ou, antes de entrar, a um cookie desse navegador durante um dia, associado só quando toca em Embarcar agora com sessão iniciada). Nunca inicia sessão por si, nunca cria conta e nunca associa uma carteira. As tentativas são limitadas (um resumo com chave da sua rede e do endereço, guardado um dia).',
    'Cartão público: o seu cartão de embarque tem uma página pública própria em flofi.xyz/card/… (um link impossível de adivinhar, não indexado por motores de busca) que mostra só o cartão: rota, passos, assento, data e, se o indicou, o seu @ do X, assinalado como digitado por si e não verificado. Nunca mostra o seu email, carteira ou convites. Pode pedir a retirada da página a qualquer momento.',
    'Conservação e eliminação: as entradas das listas, com os seus links e códigos de acesso, sessões e emails pendentes, são apagadas no fim do beta ou antes, a seu pedido; o cartão, a prova da simulação e o uso de convites são apagados com a sua conta FloFi. A FloFi guarda ainda contadores diários sem conteúdo (eventos da campanha com códigos fechados, sem identidade, endereço, pedido ou rota) durante 13 meses. Durante o beta fechado, a conta autenticada precisa de acesso Flight ativo, por lote aberto ou convite válido. O acesso é validado no servidor e não autoriza transações: cada operação continua exigindo a autorização aplicável da sua carteira.'

  ] },
  { title: 'Memória e aprendizado do Copilot', id: 'memoria-copilot', paragraphs: [
    'O Copilot aprende de três formas separadas. (1) Dentro da conversa: quando você responde a uma pergunta do FloFi ou corrige como ele entendeu uma rede, um token ou uma ação, o restante da conversa usa esse entendimento. Isso fica só no estado temporário da conversa (no navegador ou, nos canais, no estado cifrado apagado após 30 minutos) e não é guardado.',
    '(2) Memória individual: quando o operador ativa esta funcionalidade e a base legal aplicável o permite, o FloFi pode guardar, só para essa carteira — uma carteira comprovada no seu navegador ou, com sessão iniciada numa conta FloFi, a única carteira dessa família de redes nessa conta — (ou só para esta conta do Telegram/WhatsApp), o significado de palavras que você usa (por exemplo, “arb sep” para Arbitrum Sepolia) depois de evidência repetida nas suas próprias interações, e o idioma em que costuma escrever. Guardamos a palavra curta, o que ela significa no vocabulário fechado da FloFi, contagens de evidência e as datas, com a identidade apenas como um resumo criptográfico; nunca mensagens, valores, endereços, destinatários, slippage, saldos, assinaturas ou decisões. Um significado aprendido nunca escolhe sozinho uma rede com fundos reais: o FloFi apenas mostra essa opção primeiro e você decide. Carteiras diferentes e contas de chat diferentes nunca são tratadas como a mesma pessoa.',
    'Conforme a base legal definida pelo responsável, esta memória é ativada por você (consentimento) ou fica ativa até você se opor (legítimo interesse, com o direito de oposição a qualquer momento). Em Configurações → Privacidade e memória (ou, nos canais, com MEMÓRIA, “pausar memória”, “ativar memória”, “esqueça arb”, “esqueça tudo” ou STOP) pode ver o que é guardado e como cada significado surgiu, desligar o aprendizado (o que apaga o que foi aprendido automaticamente), apagar um item ou tudo e baixar uma cópia. Evidência não usada é apagada após 90 dias; um significado não usado, após 365 dias; os eventos estatísticos sem conteúdo, após 90 dias. Na primeira vez que você abre o aplicativo, a FloFi mostra uma vez um aviso de Privacidade e memória. A sua resposta fica num cookie próprio (flofi_privacy_notice) por um ano se você concordar, ou 30 dias para “Agora não”; concordar ativa o aprendizado, com consentimento, apenas para a carteira que você usa nesse momento, e você pode retirar a concordância em Privacidade e memória.',
    '(3) Melhorias globais: separadamente, e só se você ativar “Ajudar a melhorar o glossário compartilhado”, um termo generalizado (como “arb sep → Arbitrum Sepolia”) pode ser sugerido a um operador, sem a sua identidade, e só aparece individualmente quando várias pessoas o sugerem. Nada é publicado por repetição: cada entrada é revista por uma pessoa, avaliada automaticamente e publicada numa versão que pode ser revertida. Os modelos de IA nunca são treinados com os seus dados. A memória nunca autoriza operações: cada proposta mostra como as suas palavras foram lidas e continua exigindo simulação, revisão e a assinatura da sua carteira.'
  ] },
  { title: 'Segurança e autorização financeira', paragraphs: [
    'O bot apenas prepara propostas. Uma operação exige que o utilizador aceda à FloFi, comprove o controlo da carteira, obtenha uma simulação atualizada, reveja o Strategy Manifest e assine explicitamente na própria carteira. Nenhuma mensagem de Telegram autoriza movimentação de fundos. A partilha do estado de execução de volta ao chat é opcional.'
  ] },
  { title: 'Atualizações', paragraphs: [
    'Esta informação poderá ser atualizada quando mudarem de forma relevante as funcionalidades ou os tratamentos. Revisão: 9 de novembro de 2026.'
  ] },
];
const sectionsEN: readonly Paragraphs[] = [
  { title: 'Data and purposes', paragraphs: [
    'When you send a private message to @FloFiAppBot, FloFi receives your Telegram technical user ID, update ID, timestamp and message content. We use this to reply, prepare DeFi proposals, deduplicate updates, enforce usage limits and maintain short-lived conversation state. Provider identifiers are stored as cryptographic digests; required transient information is encrypted.',
    'If you open FloFi, you may connect a public wallet and prove that you control it with a signature. Strategy, simulation, execution and evidence information is used to present and track operations. Public blockchain transactions may remain visible to anyone and cannot be deleted by FloFi.',
    'The website may process interface preferences and technical session/security data. Never send private keys or recovery phrases to the bot.'
  ] },
  { title: 'Legal bases', paragraphs: [
    'Information needed to respond and provide requested features is processed for service performance or steps requested before a contract, as applicable. Technical identifiers and security records are processed to prevent abuse, fraud and operational errors under legitimate interests, balanced against data-subject rights. Optional notifications require voluntary opt-in.'
  ] },
  { title: 'Telegram channel retention', paragraphs: [
    'Incoming messages and unsent reply content: up to 15 minutes in FloFi transient storage. Temporary conversation state: erased after 30 minutes of inactivity. Encrypted reply address: generally up to 48 hours after the last message; voluntary notification links may extend this.',
    'Content-free technical event records: up to 8 days; content-free audit records: up to 30 days. Inactive conversation records: generally up to 7 days, with exceptions for opt-outs and applicable technical retention.',
    'These periods apply to the FloFi channel, not to Telegram’s own records, public blockchains or every other account, security and execution record maintained by the platform.'
  ] },
  { title: 'Service providers and transfers', paragraphs: [
    'Services may involve Telegram (messages), Vercel (website/functions), Railway (API), PostgreSQL/Neon (application data) and blockchain providers. Only if AI message interpretation is enabled may a model provider such as OpenAI be used. Telegram processes messages under its own policies.',
    'FloFi accounts use Privy as FloFi’s provider for sign-in and embedded wallets: Privy processes your sign-in identifiers (email, Google account, external wallet address) and keeps your embedded wallets’ keys in its own secure environment. A private key you import is typed into FloFi’s page and handed, in your browser, directly to Privy; it is never sent to FloFi’s servers, stored or logged. FloFi stores your Privy user’s public identifier, the identifiers Privy verified, the public addresses and Privy identifiers of your wallets, and your sessions. Deleting your FloFi account erases those at FloFi but not your Privy user or wallets: to have those erased too, first export any wallet you want to keep, then ask through the contact on this page.',
    'Depending on providers and hosting regions, international data transfers may take place, subject to applicable legal safeguards.'
  ] },
  { title: 'Your rights', paragraphs: [
    'Subject to applicable law, you may request access, correction, erasure, restriction, portability or object to processing. Use the contact on this page. You may lodge a complaint with the Portuguese data protection authority (CNPD), at www.cnpd.pt, or another competent authority.',
    'Send STOP to stop Telegram messaging. Conversation state and the reply address are erased, but certain content-free technical records may remain until the stated retention deadlines.'
  ] },
  { title: 'Flight FloFi campaign (/board)', id: 'flight-flofi', paragraphs: [
    'Beta list: when you join the list at flofi.xyz/board, FloFi stores the email you gave (lower-cased), the page language and the version of the notice shown, for the FloFi beta and only for it: to tell you when your group boards and to prove your beta entitlement before linking it to your authenticated account. Legal basis: your consent, given by submitting the form, which you may withdraw at any time. FloFi tells you by email when your group boards (see campaign emails below). To limit abuse of the form, a keyed digest (HMAC) of the request’s network (the IPv4 address, or the /64 prefix of an IPv6 address) — never the address itself — is kept for one day.',
    'Boarding pass: when you complete a simulation with your FloFi account during the campaign, FloFi keeps proof of that simulation for two hours (account, run, flow and workflow identifiers, and the simulated route: networks and steps, never amounts) and, when it issues your pass, stores the route (networks and steps, never amounts), your boarding number and, if you give it, your X handle. Your handle and route appear on the public departures board only if you choose it, and you may withdraw that choice at any time. Invites record which account used each code. Legal basis: running the campaign you asked to join and, for the public board, your consent.',
    'Campaign emails (from 9 November 2026): FloFi sends the campaign’s emails itself, from hello@flofi.xyz, through Resend (an email service acting as FloFi’s processor; replies go to the team’s mailbox): a confirmation when you join, a reminder the evening before boarding, your group’s boarding link and code, your boarding card, the next flight’s confirmation, and the team’s invitations. For each email FloFi keeps your address, the language, the kind of email and its delivery status until 90 days after it was sent or withdrawn; an email not yet sent is kept until it is sent, withdrawn or the beta ends. Every campaign email has a one-click unsubscribe: FloFi then stops campaign email to you and records a pseudonymised digest (SHA-256) of your address so it never writes to you again (the same digest is part of each email’s unsubscribe link), and sends you only the boarding link you ask for yourself. That digest is kept to honour your objection, also after erasure and after the beta ends (legal basis: your objection, which FloFi must respect). Your list entry itself stays until the end of the beta or until you ask for its erasure.',
    'Boarding access: your group’s email carries a link (valid 72 hours) and a six-digit code (valid 15 minutes), each usable once; FloFi stores only digests of them, never the link or the code. Using one proves you read that address and attaches that list entry to the FloFi account you are signed in with (or, before you sign in, to a cookie in that browser for one day, attached only when you press Board now signed in). It never signs you in, never creates an account and never links a wallet. Tries are limited (a keyed digest of your network and of the address, kept one day).',
    'Public card: your boarding card has its own public page at flofi.xyz/card/… (an unguessable link, not indexed by search engines) that shows the card only: route, steps, seat, date and, if you gave it, your X handle, marked as typed by you and not verified. It never shows your email, wallet or invites. You can ask for the page to be taken down at any time.',
    'Retention and erasure: list entries, with their access links, codes, sessions and pending emails, are deleted at the end of the beta, or earlier on request; your pass, the simulation proof and invite use are deleted with your FloFi account. FloFi also keeps content-free daily counters (campaign events as closed codes, with no identity, address, request or route) for 13 months. During the closed beta, an authenticated account needs active Flight access through an open group or a valid invite. Access is checked on the server and never authorizes a transaction: each operation still requires the applicable wallet authorization.'
  ] },
  { title: 'Copilot memory and learning', id: 'copilot-memory', paragraphs: [
    'The Copilot learns in three separate ways. (1) Within a conversation: when you answer one of FloFi’s questions or correct how it read a network, token or action, the rest of that conversation uses it. This stays in the conversation’s temporary state only (in your browser or, on channels, in the encrypted state erased after 30 minutes) and is not kept.',
    '(2) Individual memory: when the operator enables it and the applicable legal basis allows it, FloFi may keep, only for that wallet — a wallet you proved in your browser or, when you are signed in to a FloFi account, that account’s only wallet of that network family — (or only for this Telegram/WhatsApp account), what words you use mean (for example “arb sep” for Arbitrum Sepolia) after repeated evidence in your own interactions, and the language you usually write in. We keep the short word, what it means in FloFi’s closed vocabulary, evidence counts and dates, with your identity only as a cryptographic digest; never messages, amounts, addresses, recipients, slippage, balances, signatures or decisions. A learned meaning never selects a real-funds network on its own: FloFi only shows that option first and you decide. Different wallets and different chat accounts are never treated as the same person.',
    'Depending on the legal basis set by the controller, this memory is turned on by you (consent) or stays on until you object (legitimate interest, with the right to object at any time). In Settings → Privacy & memory (or, on channels, with MEMORY, “memory off”, “memory on”, “forget arb”, “forget everything” or STOP) you can see what is kept and how each meaning came to be, turn learning off (which deletes what was learned automatically), delete one item or everything, and download a copy. Unused evidence is deleted after 90 days; an unused meaning after 365 days; content-free statistical events after 90 days. The first time you open the app, FloFi shows a Privacy & Memory notice once. Your answer is kept in a first-party cookie (flofi_privacy_notice) for a year if you agree, or 30 days for “Not now”; agreeing turns learning on, under consent, only for the wallet you use at that moment, and you can withdraw it in Privacy & memory.',
    '(3) Global improvements: separately, and only if you turn on “Help improve FloFi’s shared glossary”, a generalized term (such as “arb sep → Arbitrum Sepolia”) may be suggested to an operator without your identity, and is listed individually only once several people suggest it. Nothing is published by repetition: every entry is reviewed by a person, evaluated automatically and published in a version that can be rolled back. AI models are never trained on your data. Memory never authorizes anything: every proposal shows how your words were read and still needs a simulation, your review and your wallet’s signature.'
  ] },
  { title: 'Wallet security and financial authorization', paragraphs: [
    'The bot only prepares proposals. Any operation requires the user to open FloFi, prove wallet control, obtain a fresh simulation, review the Strategy Manifest and explicitly sign using their own wallet. No Telegram message can authorize a transfer. Sharing execution status with the chat is optional.'
  ] },
  { title: 'Updates', paragraphs: [
    'This notice may be updated when features or processing change materially. Reviewed 9 November 2026.'
  ] },
];
function Policy({ lang, heading, sections }: { lang: 'pt' | 'en'; heading: string; sections: readonly Paragraphs[] }) {
  return <section id={lang} className={styles.language} lang={lang} aria-labelledby={'heading-' + lang}>
    <span className={styles.languageTag}>{lang === 'pt' ? 'PORTUGUÊS' : 'ENGLISH'}</span>
    <h2 id={'heading-' + lang} className={styles.languageTitle}>{heading}</h2>
    {sections.map((section, i) => <section key={section.title} {...section.id ? { id: section.id } : {}}>
      <h3 className={styles.sectionTitle}>{i + 2}. {section.title}</h3>
      {section.paragraphs.map((paragraph, j) => <p key={j}>{paragraph}</p>)}
    </section>)}
  </section>;
}
export default async function PrivacyPage() {
  const language = await legalLanguage(), pt = language === 'PT';
  const contact = getContact();
  const controller = (process.env.FLOFI_PRIVACY_CONTROLLER_NAME ?? '').trim();
  const title = pt ? 'Política de Privacidade' : 'Privacy Policy';
  return <div className={styles.page} lang={pt ? 'pt-BR' : 'en'}>
    <a className={styles.skip} href="#main">{pt ? 'Ir para o conteúdo' : 'Skip to content'}</a>
    <header className={styles.header}>
      <a className={styles.brand} href="/" aria-label={pt ? 'FloFi, início' : 'FloFi, home'}>
        <Image src="/brand/flofi-wordmark-light.png" width={118} height={45} alt="FloFi" priority />
      </a>
      <nav className={styles.headerNav} aria-label={pt ? 'Navegação' : 'Navigation'}>
        <a href="/terms">{pt ? 'Termos' : 'Terms'}</a><a href="/docs">Docs</a>
        <LanguageSwitch language={language} label={pt ? 'Idioma' : 'Language'}/>
      </nav>
    </header>
    <main id="main" className={styles.main}>
      <div className={styles.hero}>
        <h1>{title}</h1>
        <p>{pt ? 'Esta Política explica como a FloFi (flofi.xyz), um projeto desenvolvido pela equipe fundadora da FloFi, trata os seus dados pessoais, seguindo a Lei Geral de Proteção de Dados (LGPD).'
          : "This Policy explains how FloFi (flofi.xyz), a project built by the FloFi founding team, handles your personal data under Brazil's General Data Protection Law (LGPD)."}</p>
        <span className={styles.date}>{pt ? 'Beta da FloFi · Versão de 12 de novembro de 2026' : 'FloFi beta · Version of November 12, 2026'}</span>
      </div>
      <aside className={styles.notice} aria-label={pt ? 'Autorização financeira' : 'Financial authorization'}>
        <strong>{pt ? 'O Telegram não pode movimentar os seus fundos.' : 'Telegram cannot move your funds.'}</strong>
        <p>{pt ? 'O bot prepara propostas. A execução exige simulação, revisão do Strategy Manifest e assinatura explícita na carteira do utilizador, dentro da FloFi.'
          : 'The bot prepares proposals. Execution requires a simulation, review of the Strategy Manifest and an explicit signature in your wallet, within FloFi.'}</p>
      </aside>
      <section className={styles.language} aria-labelledby="controller-heading">
        <h2 className={styles.sectionTitle} id="controller-heading">{pt ? '1. Quem cuida dos seus dados' : '1. Who handles your data'}</h2>
        <p><strong>{pt ? 'Serviço: ' : 'Service: '}</strong>FloFi.</p>
        <p><strong>{pt ? 'Operador legal: ' : 'Legal controller: '}</strong>{controller || (pt ? 'Identidade legal ainda por identificar antes do lançamento público.' : 'Legal operator identity to be confirmed before public launch.')}</p>
        <p><strong>{pt ? 'Contato de privacidade: ' : 'Privacy contact: '}</strong>{contact && <a href={contact.href} rel="noopener noreferrer">{contact.label}</a>}</p>
      </section>
      <Policy lang={pt ? 'pt' : 'en'} heading={title} sections={pt ? sectionsPT : sectionsEN}/>
      <aside className={styles.notice}>
        <strong>{pt ? 'Para o lançamento público' : 'For public launch'}</strong>
        <p>{pt ? 'A FloFi deve confirmar a identificação legal do responsável e as garantias aplicáveis aos fornecedores antes de abrir o serviço ao público.'
          : 'The legal operator identity and applicable supplier safeguards must be confirmed before general public launch.'}</p>
        <p><a href="https://www.cnpd.pt/" rel="noopener noreferrer">CNPD</a> · <a href="https://t.me/FloFiAppBot" rel="noopener noreferrer">Telegram FloFi</a></p>
      </aside>
    </main>
    <footer className={styles.footer}>
      <span>© FloFi</span><span><a href="/terms">{pt ? 'Termos' : 'Terms'}</a><a href="/">FloFi</a><a href="/docs">Docs</a><a href="#main">{pt ? 'Topo ↑' : 'Top ↑'}</a></span>
    </footer>
  </div>;
}
