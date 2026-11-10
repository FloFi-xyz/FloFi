// SPDX-License-Identifier: AGPL-3.0-only
/** Flight's owner-provided EN/PT Terms; the owner's definitive launch rules remove the superseded value cap from clause 4. */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { LanguageSwitch } from '../../components/flight/language-switch';
import { legalLanguage } from '../../components/flight/legal-language';
import styles from '../privacy/privacy.module.css';

const terms = {
  "EN": [
    {
      "title": "1. Who we are and acceptance",
      "body": "These Terms govern your use of FloFi (flofi.xyz and related services), a project built by the FloFi founding team (\"FloFi\"). By joining the beta or running any route, you confirm that you have read and accept these Terms and the Privacy Policy. If you do not agree, do not use FloFi."
    },
    {
      "title": "2. What FloFi does",
      "body": "FloFi is software that turns a request you write into a plan of steps across third-party protocols and networks, and simulates that plan before you decide. FloFi does not execute anything on its own: a transaction only happens if you review it and sign it in your own wallet."
    },
    {
      "title": "3. What FloFi is not",
      "body": "FloFi does not hold your keys, funds or assets, and has no access to them. FloFi is not a broker, bank, payment institution, asset manager or investment adviser, and nothing on FloFi is investment advice, an offer of any asset or a promise of returns."
    },
    {
      "title": "4. Closed beta on mainnet",
      "body": "The beta runs on real networks (mainnet), with real assets. It is a test version: it may have bugs, be unavailable, change or end at any time. During the beta, only routes and contracts approved by FloFi can be used. Access is personal and may open in groups."
    },
    {
      "title": "5. Your wallet, your decisions",
      "body": "You alone are responsible for your wallet, keys and recovery phrases, and for every transaction you sign. Check each step, amount, network, fee and address before signing. Blockchain transactions are generally irreversible."
    },
    {
      "title": "6. Risks",
      "body": "By using FloFi you acknowledge risks including: bugs or exploits in smart contracts, bridges and protocols; price movements and slippage; variable network fees; bridge delays or failures; network congestion or outages; and total or partial loss of assets. The simulation shows the expected result based on data available at that moment and does not guarantee price, amount received or outcome."
    },
    {
      "title": "7. Third-party services",
      "body": "Routes use third-party protocols, bridges, wallets, data providers and networks that FloFi does not control. Using them is also subject to their own terms. FloFi is not responsible for their failures, changes or downtime."
    },
    {
      "title": "8. Fees",
      "body": "During the beta, FloFi charges no fee. Network (gas) fees and third-party protocol and bridge fees are paid by you and are shown in the simulation whenever available."
    },
    {
      "title": "9. Invites, Founding Member and card",
      "body": "Invites, the Founding Member badge, seat numbers and the boarding card have no monetary value, are not digital assets, grant no right to any payment, token or stake, and may not be sold. The card may show the handle you enter and your route, never amounts or wallet addresses, and stays on a public page until you ask us to remove it. FloFi may cancel invites or access used abusively."
    },
    {
      "title": "10. Eligibility and prohibited use",
      "body": "You must be 18 or older with legal capacity, and not on a sanctions list or in a jurisdiction where use is prohibited. You may not use FloFi for illegal activity, money laundering or fraud, to get around beta limits, or to harm FloFi or others."
    },
    {
      "title": "11. Intellectual property",
      "body": "The FloFi brand, the flight-attendant droplet, the campaign visuals and the software belong to FloFi or its licensors, under the project licenses. You may share your boarding card."
    },
    {
      "title": "12. Liability",
      "body": "To the fullest extent permitted by law, FloFi is not liable for losses arising from decisions and transactions you sign, from the risks above or from third-party services. Nothing in these Terms limits rights you have under the Brazilian Consumer Defense Code or other applicable law."
    },
    {
      "title": "13. Privacy",
      "body": "Your data (email, the handle you enter, connected wallet and product usage) is handled under the Privacy Policy and Brazil's LGPD. You can request access, correction or deletion through the contact below."
    },
    {
      "title": "14. Changes and termination",
      "body": "FloFi may change these Terms, with notice on the site and, for material changes, by email. You can stop using FloFi at any time, and FloFi may suspend or end access for anyone who breaches these Terms."
    },
    {
      "title": "15. Governing law",
      "body": "These Terms are governed by Brazilian law. Consumers may sue in the courts of their home city."
    },
    {
      "title": "16. Contact",
      "body": "flofi.xyz@gmail.com · Version of November 12, 2026."
    }
  ],
  "PT": [
    {
      "title": "1. Quem somos e aceite",
      "body": "Estes Termos regem o uso da FloFi (flofi.xyz e serviços relacionados), um projeto desenvolvido pela equipe fundadora da FloFi (\"FloFi\"). Ao entrar no beta ou executar qualquer rota, você declara que leu e aceita estes Termos e a Política de Privacidade. Se não concordar, não use a FloFi."
    },
    {
      "title": "2. O que a FloFi faz",
      "body": "A FloFi é um software que transforma um pedido escrito por você em um plano de passos em protocolos e redes de terceiros, e simula esse plano antes de você decidir. A FloFi não executa nada por conta própria: toda transação só acontece se você revisar e assinar na sua própria carteira."
    },
    {
      "title": "3. O que a FloFi não é",
      "body": "A FloFi não guarda suas chaves, seus fundos nem seus ativos, e não tem acesso a eles. A FloFi não é corretora, banco, instituição de pagamento, gestora ou consultora de investimentos, e nada na FloFi é recomendação de investimento, oferta de ativo ou promessa de rendimento."
    },
    {
      "title": "4. Beta fechado em mainnet",
      "body": "O beta usa redes reais (mainnet), com ativos reais. É uma versão de teste: pode ter falhas, ficar indisponível, mudar ou ser encerrada a qualquer momento. Durante o beta, só rotas e contratos aprovados pela FloFi podem ser usados. O acesso é pessoal e pode ser liberado por lotes."
    },
    {
      "title": "5. Sua carteira, suas decisões",
      "body": "Você é a única pessoa responsável pela sua carteira, suas chaves, frases de recuperação e por cada transação que assina. Confira cada passo, valor, rede, taxa e endereço antes de assinar. Transações em blockchain são, em regra, irreversíveis."
    },
    {
      "title": "6. Riscos",
      "body": "Ao usar a FloFi você reconhece, entre outros, estes riscos: falhas ou ataques em contratos inteligentes, bridges e protocolos; variação de preço e slippage; taxas de rede variáveis; atrasos ou falhas de bridges; congestionamento ou interrupção de redes; perda total ou parcial dos ativos. A simulação mostra o resultado esperado com base nos dados disponíveis no momento e não garante preço, valor recebido nem resultado."
    },
    {
      "title": "7. Serviços de terceiros",
      "body": "As rotas usam protocolos, bridges, carteiras, provedores de dados e redes de terceiros, que a FloFi não controla. O uso desses serviços também segue os termos de cada um. A FloFi não responde por falhas, mudanças ou indisponibilidade desses serviços."
    },
    {
      "title": "8. Taxas",
      "body": "Durante o beta, a FloFi não cobra taxa pelo uso. Taxas de rede (gás) e taxas de protocolos e bridges de terceiros são pagas por você e aparecem na simulação sempre que disponíveis."
    },
    {
      "title": "9. Convites, Founding Member e cartão",
      "body": "Convites, o selo Founding Member, a numeração de assento e o cartão de embarque não têm valor monetário, não são ativos digitais, não dão direito a nenhum pagamento, token ou participação, e não podem ser vendidos. O cartão pode mostrar o @ que você informar e a sua rota, nunca valores ou endereço de carteira, e fica numa página pública até você pedir a remoção. A FloFi pode cancelar convites ou acessos usados de forma abusiva."
    },
    {
      "title": "10. Quem pode usar e usos proibidos",
      "body": "Para usar a FloFi você precisa ter 18 anos ou mais e capacidade legal, e não pode estar em lista de sanções nem em jurisdição onde o uso seja proibido. É proibido usar a FloFi para atividade ilegal, lavagem de dinheiro, fraude, para burlar limites do beta ou para prejudicar a FloFi ou outras pessoas."
    },
    {
      "title": "11. Propriedade intelectual",
      "body": "A marca FloFi, a gota comissária, o visual da campanha e o software pertencem à FloFi ou a seus licenciadores, nos termos das licenças do projeto. Você pode compartilhar o seu cartão de embarque."
    },
    {
      "title": "12. Responsabilidade",
      "body": "Na máxima extensão permitida pela lei, a FloFi não responde por perdas decorrentes de decisões e transações assinadas por você, de riscos descritos acima ou de serviços de terceiros. Nada nestes Termos limita direitos que o Código de Defesa do Consumidor e a legislação brasileira garantem a você."
    },
    {
      "title": "13. Privacidade",
      "body": "O tratamento dos seus dados (e-mail, @ informado, carteira conectada e uso do produto) segue a Política de Privacidade e a LGPD. Você pode pedir acesso, correção ou exclusão pelo contato abaixo."
    },
    {
      "title": "14. Mudanças e encerramento",
      "body": "A FloFi pode mudar estes Termos, avisando no site e, se houver mudança relevante, por e-mail. Você pode parar de usar a FloFi a qualquer momento, e a FloFi pode suspender ou encerrar o acesso de quem violar estes Termos."
    },
    {
      "title": "15. Lei e foro",
      "body": "Estes Termos seguem a lei brasileira. O consumidor pode usar o foro do seu domicílio."
    },
    {
      "title": "16. Contato",
      "body": "flofi.xyz@gmail.com · Versão de 12 de novembro de 2026."
    }
  ]
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const language = await legalLanguage();
  return { title: `${language === 'PT' ? 'Termos de Uso' : 'Terms of Use'} | FloFi`, alternates: { canonical: 'https://flofi.xyz/terms' } };
}
export default async function TermsPage() {
  const language = await legalLanguage(), pt = language === 'PT';
  const title = pt ? 'Termos de Uso' : 'Terms of Use';
  return <div className={styles.page} lang={pt ? 'pt-BR' : 'en'}>
    <a className={styles.skip} href="#main">{pt ? 'Ir para o conteúdo' : 'Skip to content'}</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/" aria-label={pt ? 'FloFi, início' : 'FloFi, home'}>
        <Image src="/brand/flofi-wordmark-light.png" width={118} height={45} alt="FloFi" priority/>
      </Link>
      <nav className={styles.headerNav} aria-label={pt ? 'Navegação' : 'Navigation'}>
        <Link href="/docs">Docs</Link><Link href="/board">Flight FloFi</Link>
        <LanguageSwitch language={language} label={pt ? 'Idioma' : 'Language'}/>
      </nav>
    </header>
    <main id="main" className={styles.main}>
      <div className={styles.hero}>
        <h1>{title}</h1>
        <p>{pt ? 'Beta da FloFi · Versão de 12 de novembro de 2026' : 'FloFi beta · Version of November 12, 2026'}</p>
      </div>
      <div className={styles.language}>
        {terms[language].map((section, index) => <section key={section.title} id={index === 5 ? 'risks' : `section-${index + 1}`}>
          <h2 className={styles.sectionTitle}>{section.title}</h2>
          <p>{index === 15 ? <><a href="mailto:flofi.xyz@gmail.com">flofi.xyz@gmail.com</a>{section.body.slice('flofi.xyz@gmail.com'.length)}</> : section.body}</p>
        </section>)}
      </div>
    </main>
    <footer className={styles.footer}>
      <span>© FloFi</span><span><Link href="/privacy">{pt ? 'Privacidade' : 'Privacy'}</Link><Link href="/docs/security">{pt ? 'Segurança' : 'Security'}</Link><Link href="/board">Flight FloFi</Link></span>
    </footer>
  </div>;
}
