// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import Image from 'next/image';
import styles from './privacy.module.css';

// The page is public and lives outside the authenticated product workspace.
// Its contact information comes from the Telegram channel's server configuration.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Política de Privacidade / Privacy Policy | FloFi',
  description: 'Privacidade no site FloFi, bot Telegram e workflows DeFi. Privacy for the FloFi website, Telegram bot and wallet-controlled workflows.',
  alternates: { canonical: 'https://flofi.xyz/privacy' },
};

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
function getContact(): { label: string; href: string } | null {
  const raw = (process.env.FLOFI_CHANNEL_SUPPORT_CONTACT ?? '').trim();
  if (EMAIL.test(raw)) return { label: raw, href: 'mailto:' + raw };
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.username && !u.password && raw.length <= 256)
      return { label: u.host + u.pathname, href: u.toString() };
  } catch { /* invalid / not configured */ }
  return null;
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
    'Dependendo dos fornecedores e regiões de alojamento, podem existir transferências internacionais de dados, sujeitas às garantias legais aplicáveis.'
  ] },
  { title: 'Os seus direitos', paragraphs: [
    'Sujeito à legislação aplicável, pode pedir acesso, retificação, eliminação, limitação, portabilidade ou opor-se ao tratamento. Para exercer os direitos, utilize o contacto indicado nesta página. Pode reclamar junto da Comissão Nacional de Proteção de Dados (CNPD), em www.cnpd.pt, ou da autoridade competente.',
    'Para deixar de receber mensagens da FloFi no Telegram, envie STOP. O estado da conversa e o endereço para resposta são apagados, mas certos registos técnicos sem conteúdo podem permanecer até ao fim do prazo indicado.'
  ] },
  { title: 'Memória do Copilot (opcional)', id: 'memoria-copilot', paragraphs: [
    'Quando o operador ativa esta funcionalidade, o Copilot pode lembrar palavras que você usa (por exemplo, “arb” para Arbitrum) e o idioma das respostas — somente depois que você clicar em “Lembrar” e somente para a carteira comprovada nesta sessão (ou para esta conta do Telegram/WhatsApp). Guardamos o termo curto e o que ele significa no vocabulário fechado da FloFi, a data do consentimento e a versão deste aviso; nunca mensagens, valores, endereços ou chaves. A identidade é guardada apenas como um resumo criptográfico. Sem carteira comprovada, o que você diz vale só para a conversa atual.',
    'Separadamente, e só se você ativar “Ajudar a melhorar o glossário compartilhado”, um termo generalizado (como “arb → Arbitrum”) pode ser sugerido a um operador, sem a sua identidade. Nada é publicado por repetição: cada entrada é revista por uma pessoa e só entra em vigor depois de passar numa avaliação automática.',
    'Pode ver, pausar e apagar a memória a qualquer momento no painel Memória do Copilot ou, nos canais, com MEMÓRIA, “esqueça arb”, “esqueça tudo” ou STOP. Uma entrada não usada é apagada após 365 dias; os eventos estatísticos sem conteúdo após 90 dias. A memória nunca preenche valores nem autoriza operações: cada proposta mostra como as suas palavras foram lidas e continua exigindo simulação, revisão e a assinatura da sua carteira.'
  ] },
  { title: 'Segurança e autorização financeira', paragraphs: [
    'O bot apenas prepara propostas. Uma operação exige que o utilizador aceda à FloFi, comprove o controlo da carteira, obtenha uma simulação atualizada, reveja o Strategy Manifest e assine explicitamente na própria carteira. Nenhuma mensagem de Telegram autoriza movimentação de fundos. A partilha do estado de execução de volta ao chat é opcional.'
  ] },
  { title: 'Atualizações', paragraphs: [
    'Esta informação poderá ser atualizada quando mudarem de forma relevante as funcionalidades ou os tratamentos. Revisão: 15 de outubro de 2026.'
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
    'Depending on providers and hosting regions, international data transfers may take place, subject to applicable legal safeguards.'
  ] },
  { title: 'Your rights', paragraphs: [
    'Subject to applicable law, you may request access, correction, erasure, restriction, portability or object to processing. Use the contact on this page. You may lodge a complaint with the Portuguese data protection authority (CNPD), at www.cnpd.pt, or another competent authority.',
    'Send STOP to stop Telegram messaging. Conversation state and the reply address are erased, but certain content-free technical records may remain until the stated retention deadlines.'
  ] },
  { title: 'Copilot memory (optional)', id: 'copilot-memory', paragraphs: [
    'When the operator enables it, the Copilot can remember words you use (for example “arb” for Arbitrum) and your reply language — only after you click “Remember”, and only for the wallet you proved in this session (or for this Telegram/WhatsApp account). We keep the short term and what it means in FloFi’s closed vocabulary, the time of your consent and the version of this notice; never messages, amounts, addresses or keys. Your identity is stored only as a cryptographic digest. Without a proven wallet, what you say lasts for the current conversation only.',
    'Separately, and only if you turn on “Help improve FloFi’s shared glossary”, a generalized term (such as “arb → Arbitrum”) may be suggested to an operator without your identity. Nothing is published by repetition: every entry is reviewed by a person and takes effect only after passing an automated evaluation.',
    'You can view, pause and delete your memory at any time in the Copilot’s Memory panel or, on channels, with MEMORY, “forget arb”, “forget everything” or STOP. An unused entry is deleted after 365 days; content-free statistical events after 90 days. Memory never fills in amounts or authorizes anything: every proposal shows how your words were read and still needs a simulation, your review and your wallet’s signature.'
  ] },
  { title: 'Wallet security and financial authorization', paragraphs: [
    'The bot only prepares proposals. Any operation requires the user to open FloFi, prove wallet control, obtain a fresh simulation, review the Strategy Manifest and explicitly sign using their own wallet. No Telegram message can authorize a transfer. Sharing execution status with the chat is optional.'
  ] },
  { title: 'Updates', paragraphs: [
    'This notice may be updated when features or processing change materially. Reviewed 15 October 2026.'
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
export default function PrivacyPage() {
  const contact = getContact();
  const controller = (process.env.FLOFI_PRIVACY_CONTROLLER_NAME ?? '').trim();
  return <div className={styles.page}>
    <a className={styles.skip} href="#main">Ir para o conteúdo / Skip to content</a>
    <header className={styles.header}>
      <a className={styles.brand} href="/" aria-label="FloFi — home">
        <Image src="/brand/flofi-wordmark-light.png" width={118} height={45} alt="FloFi" priority />
      </a>
      <nav className={styles.headerNav} aria-label="Idiomas / Languages"><a href="#pt">Português</a><a href="#en">English</a><a href="/">← FloFi</a></nav>
    </header>
    <main id="main" className={styles.main}>
      <div className={styles.hero}>
        <span className={styles.kicker}>FLOFI / PRIVACY & TRUST</span>
        <h1>Privacidade, com clareza.<span>Privacy, made clear.</span></h1>
        <p>Informações sobre o site, o Telegram e os workflows da FloFi. Privacy information for the website, Telegram bot and wallet-controlled workflows.</p>
        <span className={styles.date}>Atualização / Updated · 12 October 2026</span>
      </div>
      <aside className={styles.notice} aria-label="Financial authorization">
        <strong>O Telegram não pode movimentar os seus fundos. / Telegram cannot move your funds.</strong>
        <p>O bot prepara propostas. A execução exige simulação, revisão do Strategy Manifest e assinatura explícita na carteira do utilizador, dentro da FloFi.</p>
      </aside>
      <section className={styles.language} aria-labelledby="controller-heading">
        <span className={styles.languageTag}>IDENTIDADE / IDENTITY</span>
        <h2 className={styles.sectionTitle} id="controller-heading">1. Responsável / Data controller</h2>
        <p><strong>Serviço / Service:</strong> FloFi.</p>
        <p><strong>Operador legal / Legal controller:</strong> {controller || 'Identidade legal ainda por identificar antes do lançamento público / Legal operator identity to be confirmed before public launch.'}</p>
        <p><strong>Contacto de privacidade / Privacy contact:</strong> {contact
          ? <a href={contact.href} rel="noopener noreferrer">{contact.label}</a>
          : 'Contacto de privacidade ainda não configurado / Privacy contact not yet configured.'}</p>
      </section>
      <Policy lang="pt" heading="Política de Privacidade" sections={sectionsPT}/>
      <Policy lang="en" heading="Privacy Policy" sections={sectionsEN}/>
      <aside className={styles.notice}>
        <strong>Para o lançamento público / For public launch</strong>
        <p>A FloFi deve confirmar a identificação legal do responsável e as garantias aplicáveis aos fornecedores antes de abrir o serviço ao público. The legal operator identity and applicable supplier safeguards must be confirmed before general public launch.</p>
        <p><a href="https://www.cnpd.pt/" rel="noopener noreferrer">CNPD</a> · <a href="https://t.me/FloFiAppBot" rel="noopener noreferrer">Telegram FloFi</a></p>
      </aside>
    </main>
    <footer className={styles.footer}><span>© FloFi · Programmable finance</span><span><a href="/">Home</a><a href="/docs">Docs</a><a href="#main">Top ↑</a></span></footer>
  </div>;
}
