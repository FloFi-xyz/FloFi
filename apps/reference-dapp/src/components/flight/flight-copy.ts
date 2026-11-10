// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the /board copy. English is the team-approved Claude Artifact "Flight FloFi" (version 1793892357-f7d9), word for
 * word: the "Landing" boards (desktop, final call, five mobile states), the cards and the approved post "Gate closed. Boarding starts
 * tomorrow." for the night between the list closing and boarding. The boards are English only; the Portuguese is a translation for the
 * page's shared language menu (to be confirmed by the team). Numbers on the page are always real; the boards' sample numbers are not used.
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 (artifact version 1794236006-f919): no public count of people anywhere ("CLOSED BETA · OPENING IN GROUPS",
 * "PASSENGER SEATS OPEN" in place of the counters, the "FOUNDING FULL" banner without a number, no "N OF 100" bar); the marquee says FINAL
 * CALL until boarding; "I have an invite code" in every state; the card flow's four screens (handle, card, share, public page); the access
 * page with "Continue"; unsubscribe. English is the artifact's; Portuguese is a translation to be confirmed by the team.
 */
import type { Language } from '../../i18n/language';

const EN = {
  lang: 'en',
  title: 'Flight FloFi · Say where you’re going · FloFi',
  description: (day: string) => `FloFi boards ${day}. Say where you’re going, FloFi builds the route, you approve. The first 100 get the good seats.`,
  nav: { label: 'Flight FloFi navigation', how: 'How it works', founding: 'Founding', routes: 'Routes', home: 'FloFi, home', language: 'Language' },
  marquee: 'NOW BOARDING · DEFI THE WAY YOU TALK · YOU APPROVE · FLOFI.XYZ · ', marqueeFinal: 'FINAL CALL · DEFI THE WAY YOU TALK · YOU APPROVE · FLOFI.XYZ · ',
  marqueePause: 'Pause the moving text', routeTo: 'to', closedBeta: 'CLOSED BETA · OPENING IN GROUPS', passengerSeats: 'PASSENGER SEATS OPEN',
  finalCall: {
    eyebrow: (day: string) => `Flight FloFi · Closed beta · Boards ${day}`, title: ['Final call for ', 'the beta list.'],
    body: 'First boarding goes to the beta list. Say where you’re going, FloFi builds the route, you approve.',
    closesIn: 'List closes in', units: ['D', 'H', 'M'], unitWords: [['day', 'days'], ['hour', 'hours'], ['minute', 'minutes']], email: 'you@email.com', emailLabel: 'Your email', join: 'Join the list',
    notice: 'We only use your email for the FloFi beta.', consent: 'By joining, you agree to this use under our', privacy: 'Privacy Policy',
    joined: 'You’re on the list. First boarding goes to the beta list.', sticker: 'FINAL CALL',
  },
  gateClosed: {
    eyebrow: 'Flight FloFi · Gate closed', title: ['Gate closed. ', 'Boarding starts tomorrow.'], body: (time: string) => `${time} BRT. See you on board.`,
    join: 'Join the next flight', joined: 'You’re on the list for the next flight.', sticker: 'LIST CLOSED',
  },
  boarding: {
    eyebrow: 'Flight FloFi · Closed beta', title: ['Say where ', 'you’re going.'], body: ['FloFi builds the steps and simulates them. ', 'You approve.'],
    to: 'TO', placeholder: 'move my USDC from Ethereum to Base and lend it on Aave', promptLabel: 'Where you’re going', board: 'Board now',
    invite: 'I have an invite code',
    sticker: 'NOW BOARDING', checking: 'Checking your boarding…', signIn: 'Sign in to board',
  },
  access: {
    otherEmail: 'On the list with another email?', otherEmailAction: 'Get a link and a code', emailLabel: 'Your beta-list email', send: 'Send me a link and a code',
    sent: 'If this email is on the beta list and its group is boarding, a link and a 6-digit code are on their way. The code works for 15 minutes.',
    codeLabel: '6-digit code', codeUse: 'Use code', codeHint: 'Got the email on another device? Enter the email and its 6-digit code here.',
    claimed: 'Your boarding is confirmed. Press Board now.', eyebrow: 'Flight FloFi · Now boarding', pendingSignIn: 'Your email is confirmed for boarding. Sign in with your wallet or email to continue.',
    title: ['Your boarding ', 'link.'], body: 'Tap Continue to confirm your boarding on this device. The link works once.', proves: (address: string) => `This link is for ${address}.`, continue: 'Continue',
    working: 'Confirming…', done: 'Confirmed. Taking you to your gate…', missing: 'This link is incomplete. Open it again from the email, or ask for a new one at flofi.xyz/board.',
    back: 'Go to flofi.xyz/board',
  },
  unsubscribe: { title: ['Unsubscribe from ', 'Flight FloFi emails.'], body: 'You will stop getting campaign emails from FloFi. Emails you ask for (a boarding link) still arrive.',
    action: 'Unsubscribe', done: 'Done. You won’t get Flight FloFi campaign emails any more.', invalid: 'This unsubscribe link is not valid.' },
  foundingFull: { banner: 'FOUNDING FULL', seats: 'PASSENGER SEATS OPEN', body: ['All 100 Founding seats are taken. You still board, as a passenger. ', 'You approve.'],
    placeholder: 'bridge my USDC from Arbitrum to Base' },
  batch: { onTheList: 'ON THE LIST', yourGroup: 'Your group', group: (n: number) => `GROUP ${n}`, opens: 'Boarding opens',
    title: ['You’re on the list. ', 'Your group boards soon.'], body: (when: string) => `Your boarding opens ${when}. We’ll email you the moment it does.`,
    calendar: 'Add to calendar', invite: 'Got an invite code?', useIt: 'Use it here' },
  notListed: { board: ['LIST ONLY', 'NOT LISTED', 'NEXT FLIGHT'] as [string, string, string], labels: ['Status', 'Gate'], title: ['Not on the list. ', 'Yet.'],
    body: 'This flight is for the beta list. Exits are this way.', next: 'Join the next flight', share: 'Share on X', joined: 'You’re on the list for the next flight.' },
  inviteForm: { label: 'Invite code', placeholder: 'FLF-XXXX-XXXX', use: 'Use invite', redeemed: 'Invite accepted. You can board now.' },
  departures: { eyebrow: 'Departures · live', title: ['People are boarding. ', 'Right now.'], updated: (time: string) => `UPDATED ${time} BRT`,
    head: ['Passenger', 'Route', 'Steps', 'Seat', 'Status'], boarded: 'BOARDED', caption: 'Latest boarding passes' },
  how: { eyebrow: 'How it works', title: ['Three steps. ', 'The last one is yours.'], steps: [
    ['01', 'You say it', 'Type where you want your crypto to go, in plain words.'],
    ['02', 'FloFi builds and simulates', 'It lines up the steps across apps and networks and shows you the simulated result.'],
    ['03', 'You sign', 'Nothing moves until you review the plan and sign in your own wallet.']] },
  founding: { eyebrow: 'Founding Members', title: ['The first 100 ', 'get the good seats.'], perks: [
    ['Numbered seat.', 'Founding Member #001 to #100, in boarding order.'],
    ['FloFi in Claude and ChatGPT.', 'Early access to FloFi inside the assistants you already use.'],
    ['The team beside you.', 'Help from the FloFi team on Discord while you learn the ropes.'],
    ['Your @ on the wall.', 'A spot on the Founding Members wall.'],
    ['3 invites.', 'Bring three people on board, no list needed.']],
    cardYou: '@you', cardSeat: 'Founding Member #001–#100' },
  routes: { eyebrow: 'Example routes', title: ['Not sure where to go? ', 'Pick a route.'], use: 'Use this route', items: [
    { id: 'eth_base', from: 'ETH', to: 'BASE', prompt: 'Move my USDC from Ethereum to Base and lend it on Aave', meta: '2 STEPS · 2 NETWORKS' },
    { id: 'eth_sol', from: 'ETH', to: 'SOL', prompt: 'Swap my ETH, bring it to Solana and add liquidity on Orca', meta: '4 STEPS · 3 NETWORKS' },
    { id: 'arb_base', from: 'ARB', to: 'BASE', prompt: 'Bridge my USDC from Arbitrum to Base', meta: '1 STEP · 2 NETWORKS' }] },
  pass: {
    flight: 'Flight FloFi', boardingPass: 'BOARDING PASS', passenger: 'PASSENGER', departure: 'DEPARTURE', from: 'FROM', to: 'TO', via: 'VIA', seat: 'SEAT',
    route: 'ROUTE', gate: 'GATE', youApprove: 'You approve', checked: 'CHECKED', founding: 'FOUNDING', foundingMember: 'Founding Member',
    steps: (n: number, networks: number) => `${n} ${n === 1 ? 'STEP' : 'STEPS'} · ${networks} ${networks === 1 ? 'NETWORK' : 'NETWORKS'}`,
    more: (n: number) => `+${n} steps`, eyebrowFounding: 'Flight FloFi · Founding member', noHandle: 'Add your X handle',
    standbyBoard: ['FLIGHT FLOFI', 'FOUNDING FULL'], standbyTitle: ['You’re on board. ', 'Middle seat.'], standbyBody: 'Next to the bathroom. You still approve every step.',
    middleSeat: 'MIDDLE SEAT', yours: 'Your boarding pass',
    handleLabel: 'Your X handle', handlePublic: 'Show my handle and route on the public departures board', save: 'Save',
    saved: 'Saved.', share: 'Share on X', invitesTitle: 'Your 3 invites', invitesBody: 'Bring three people on board, no list needed. Each code works once.',
    used: 'used', open: 'Open FloFi',
    whoTitle: 'Who’s flying?', whoEyebrow: 'Simulation done · printing your card', whoBody: 'Add your X handle to print it on your boarding card. Optional.',
    print: 'Print my card', skip: 'Skip, print without a handle', ready: 'Your boarding card', download: 'Download card', copy: 'Copy link', copied: 'Link copied.',
    invitesReady: (n: number) => `${n} ${n === 1 ? 'invite' : 'invites'} ready`, emailed: 'We also emailed you this card.', handleNote: 'Your handle is typed by you, not verified, and shown on your public card.',
    test: 'TEST', testTitle: ['Test flight. ', 'Your card is a test.'], testBody: (day: string) => `This card is marked TEST and is not kept. Your official card comes out when boarding opens, ${day}.`,
  },
  card: { boarded: (who: string) => [`${who} boarded `, 'Flight FloFi.'], someone: 'A passenger', body: 'Say where your crypto should go. FloFi builds the route and simulates it. You approve every step.',
    boardToo: 'Board too', closed: 'Closed beta, opening in groups.', handle: 'Handle typed by the passenger, not verified.', missing: 'This boarding card is not available.',
    title: (who: string) => `${who} boarded Flight FloFi`, alt: (route: string, meta: string) => `Flight FloFi boarding card: ${route}, ${meta}, you approve` },
  footer: { nav: 'Footer navigation', privacy: 'Privacy', risks: 'Risks', discord: 'Discord', x: 'X',
    risk: 'DeFi involves risk. A simulation does not guarantee price or outcome. Review every step before you sign. FloFi never holds your keys or your funds.' },
  errors: { FLIGHT_EMAIL_INVALID: 'Enter a valid email address.', FLIGHT_RATE_LIMITED: 'Too many tries from here. Try again in an hour.',
    FLIGHT_BUSY: 'The list is busy. Try again in a minute.', FLIGHT_UNAVAILABLE: 'The list is not available right now. Try again soon.',
    INVITE_INVALID: 'That invite code does not exist.', INVITE_USED: 'That invite code was already used.', INVITE_OWN: 'You can’t use your own invite.',
    INVITE_ALREADY_HELD: 'You already have an invite.', ALREADY_BOARDED: 'You’re already on board.', FLIGHT_HANDLE_INVALID: 'Use up to 15 letters, digits or underscores.',
    FLIGHT_SIGN_IN_REQUIRED: 'Sign in first.', generic: 'Something went wrong. Try again.',
    ACCESS_INVALID: 'That link or code is not valid. Ask for a new one.', ACCESS_EXPIRED: 'That link has expired. Ask for a new one below.',
    ACCESS_USED: 'That link was already used. Ask for a new one if you need it.', ACCESS_CLAIMED_ELSEWHERE: 'This email is already boarding with another FloFi account. Sign in with that account.',
    ACCESS_ACCOUNT_HAS_OTHER_ENTRY: 'Your FloFi account already boards with another email.', ACCESS_BOARDED: 'This email has already boarded.', ACCESS_RATE_LIMITED: 'Too many tries. Wait an hour and try again.',
    FLIGHT_SIMULATION_NOT_FOUND: 'Run a simulation in FloFi first: your card comes from it.', FLIGHT_NOT_ELIGIBLE: 'Your group is not boarding yet.' },
  share: { notListed: (day: string) => `Not on the list. Yet. Flight FloFi boards ${day}.` },
  unavailable: 'Flight FloFi is not available on this deployment.',
};
type Copy = typeof EN;

const PT: Copy = {
  lang: 'pt-BR',
  title: 'Flight FloFi · Diga para onde você vai · FloFi',
  description: (day: string) => `A FloFi embarca em ${day}. Diga para onde você vai, a FloFi monta a rota, você aprova. Os 100 primeiros ficam com os melhores assentos.`,
  nav: { label: 'Navegação do Flight FloFi', how: 'Como funciona', founding: 'Founding', routes: 'Rotas', home: 'FloFi, início', language: 'Idioma' },
  marquee: 'EMBARQUE ABERTO · DEFI DO JEITO QUE VOCÊ FALA · VOCÊ APROVA · FLOFI.XYZ · ', marqueeFinal: 'ÚLTIMA CHAMADA · DEFI DO JEITO QUE VOCÊ FALA · VOCÊ APROVA · FLOFI.XYZ · ',
  marqueePause: 'Pausar o texto em movimento', routeTo: 'para', closedBeta: 'BETA FECHADO · ABRINDO EM GRUPOS', passengerSeats: 'ASSENTOS DE PASSAGEIRO ABERTOS',
  finalCall: {
    eyebrow: (day: string) => `Flight FloFi · Beta fechado · Embarca em ${day}`, title: ['Última chamada para ', 'a lista beta.'],
    body: 'O primeiro embarque é da lista beta. Diga para onde você vai, a FloFi monta a rota, você aprova.',
    closesIn: 'A lista fecha em', units: ['D', 'H', 'M'], unitWords: [['dia', 'dias'], ['hora', 'horas'], ['minuto', 'minutos']], email: 'voce@email.com', emailLabel: 'Seu e-mail', join: 'Entrar na lista',
    notice: 'Usamos seu e-mail só para o beta da FloFi.', consent: 'Ao entrar, você concorda com esse uso, conforme a nossa', privacy: 'Política de Privacidade',
    joined: 'Você está na lista. O primeiro embarque é da lista beta.', sticker: 'ÚLTIMA CHAMADA',
  },
  gateClosed: {
    eyebrow: 'Flight FloFi · Portão fechado', title: ['Portão fechado. ', 'O embarque começa amanhã.'], body: (time: string) => `${time} BRT. Nos vemos a bordo.`,
    join: 'Entrar no próximo voo', joined: 'Você está na lista do próximo voo.', sticker: 'LISTA FECHADA',
  },
  boarding: {
    eyebrow: 'Flight FloFi · Beta fechado', title: ['Diga para onde ', 'você vai.'], body: ['A FloFi monta os passos e simula. ', 'Você aprova.'],
    to: 'PARA', placeholder: 'levar meu USDC da Ethereum para a Base e emprestar na Aave', promptLabel: 'Para onde você vai', board: 'Embarcar agora',
    invite: 'Tenho um código de convite',
    sticker: 'EMBARQUE ABERTO', checking: 'Conferindo seu embarque…', signIn: 'Entre para embarcar',
  },
  access: {
    otherEmail: 'Está na lista com outro e-mail?', otherEmailAction: 'Receber um link e um código', emailLabel: 'Seu e-mail da lista beta', send: 'Enviar link e código',
    sent: 'Se este e-mail estiver na lista beta e o grupo dele estiver embarcando, um link e um código de 6 dígitos estão a caminho. O código vale por 15 minutos.',
    codeLabel: 'Código de 6 dígitos', codeUse: 'Usar código', codeHint: 'Recebeu o e-mail em outro aparelho? Digite aqui o e-mail e o código de 6 dígitos.',
    claimed: 'Seu embarque está confirmado. Toque em Embarcar agora.', eyebrow: 'Flight FloFi · Embarque aberto', pendingSignIn: 'Seu e-mail está confirmado para o embarque. Entre com sua carteira ou e-mail para continuar.',
    title: ['Seu link ', 'de embarque.'], body: 'Toque em Continuar para confirmar seu embarque neste aparelho. O link vale uma vez.', proves: (address: string) => `Este link é de ${address}.`, continue: 'Continuar',
    working: 'Confirmando…', done: 'Confirmado. Levando você ao seu portão…', missing: 'Este link está incompleto. Abra de novo pelo e-mail ou peça um novo em flofi.xyz/board.',
    back: 'Ir para flofi.xyz/board',
  },
  unsubscribe: { title: ['Cancelar os e-mails ', 'do Flight FloFi.'], body: 'Você deixa de receber os e-mails da campanha da FloFi. E-mails que você pedir (um link de embarque) continuam chegando.',
    action: 'Cancelar inscrição', done: 'Pronto. Você não vai mais receber e-mails da campanha Flight FloFi.', invalid: 'Este link de cancelamento não é válido.' },
  foundingFull: { banner: 'FOUNDING ESGOTADO', seats: 'ASSENTOS DE PASSAGEIRO ABERTOS', body: ['Os 100 assentos Founding foram ocupados. Você ainda embarca, como passageiro. ', 'Você aprova.'],
    placeholder: 'levar meu USDC da Arbitrum para a Base' },
  batch: { onTheList: 'NA LISTA', yourGroup: 'Seu grupo', group: (n: number) => `GRUPO ${n}`, opens: 'Embarque abre',
    title: ['Você está na lista. ', 'Seu grupo embarca em breve.'], body: (when: string) => `Seu embarque abre em ${when}. Avisamos por e-mail assim que abrir.`,
    calendar: 'Adicionar à agenda', invite: 'Tem um código de convite?', useIt: 'Use aqui' },
  notListed: { board: ['SÓ LISTA', 'FORA DA LISTA', 'PRÓXIMO VOO'], labels: ['Status', 'Portão'], title: ['Fora da lista. ', 'Por enquanto.'],
    body: 'Este voo é da lista beta. As saídas ficam para lá.', next: 'Entrar no próximo voo', share: 'Compartilhar no X', joined: 'Você está na lista do próximo voo.' },
  inviteForm: { label: 'Código de convite', placeholder: 'FLF-XXXX-XXXX', use: 'Usar convite', redeemed: 'Convite aceito. Você já pode embarcar.' },
  departures: { eyebrow: 'Partidas · ao vivo', title: ['As pessoas estão embarcando. ', 'Agora.'], updated: (time: string) => `ATUALIZADO ${time} BRT`,
    head: ['Passageiro', 'Rota', 'Passos', 'Assento', 'Status'], boarded: 'EMBARCOU', caption: 'Últimos cartões de embarque' },
  how: { eyebrow: 'Como funciona', title: ['Três passos. ', 'O último é seu.'], steps: [
    ['01', 'Você diz', 'Escreva para onde quer levar suas criptos, com suas palavras.'],
    ['02', 'A FloFi monta e simula', 'Ela organiza os passos entre apps e redes e mostra o resultado simulado.'],
    ['03', 'Você assina', 'Nada se move até você revisar o plano e assinar na sua própria carteira.']] },
  founding: { eyebrow: 'Founding Members', title: ['Os 100 primeiros ', 'ficam com os melhores assentos.'], perks: [
    ['Assento numerado.', 'Founding Member #001 a #100, na ordem de embarque.'],
    ['A FloFi no Claude e no ChatGPT.', 'Acesso antecipado à FloFi dentro dos assistentes que você já usa.'],
    ['O time do seu lado.', 'Ajuda do time FloFi no Discord enquanto você pega o jeito.'],
    ['Seu @ no mural.', 'Um lugar no mural dos Founding Members.'],
    ['3 convites.', 'Traga três pessoas a bordo, sem precisar da lista.']],
    cardYou: '@voce', cardSeat: 'Founding Member #001–#100' },
  routes: { eyebrow: 'Rotas de exemplo', title: ['Não sabe para onde ir? ', 'Escolha uma rota.'], use: 'Usar esta rota', items: [
    { id: 'eth_base', from: 'ETH', to: 'BASE', prompt: 'Levar meu USDC da Ethereum para a Base e emprestar na Aave', meta: '2 PASSOS · 2 REDES' },
    { id: 'eth_sol', from: 'ETH', to: 'SOL', prompt: 'Trocar meu ETH, levar para a Solana e adicionar liquidez na Orca', meta: '4 PASSOS · 3 REDES' },
    { id: 'arb_base', from: 'ARB', to: 'BASE', prompt: 'Levar meu USDC da Arbitrum para a Base', meta: '1 PASSO · 2 REDES' }] },
  pass: {
    flight: 'Flight FloFi', boardingPass: 'CARTÃO DE EMBARQUE', passenger: 'PASSAGEIRO', departure: 'PARTIDA', from: 'DE', to: 'PARA', via: 'VIA', seat: 'ASSENTO',
    route: 'ROTA', gate: 'PORTÃO', youApprove: 'Você aprova', checked: 'CONFERIDO', founding: 'FOUNDING', foundingMember: 'Founding Member',
    steps: (n: number, networks: number) => `${n} ${n === 1 ? 'PASSO' : 'PASSOS'} · ${networks} ${networks === 1 ? 'REDE' : 'REDES'}`,
    more: (n: number) => `+${n} passos`, eyebrowFounding: 'Flight FloFi · Founding member', noHandle: 'Adicione seu @ do X',
    standbyBoard: ['FLIGHT FLOFI', 'FOUNDING ESGOTADO'], standbyTitle: ['Você está a bordo. ', 'Assento do meio.'], standbyBody: 'Ao lado do banheiro. Você continua aprovando cada passo.',
    middleSeat: 'ASSENTO DO MEIO', yours: 'Seu cartão de embarque',
    handleLabel: 'Seu @ do X', handlePublic: 'Mostrar meu @ e minha rota no painel público de partidas', save: 'Salvar',
    saved: 'Salvo.', share: 'Compartilhar no X', invitesTitle: 'Seus 3 convites', invitesBody: 'Traga três pessoas a bordo, sem precisar da lista. Cada código vale uma vez.',
    used: 'usado', open: 'Abrir a FloFi',
    whoTitle: 'Quem está voando?', whoEyebrow: 'Simulação feita · imprimindo seu cartão', whoBody: 'Adicione seu @ do X para imprimir no seu cartão de embarque. Opcional.',
    print: 'Imprimir meu cartão', skip: 'Pular, imprimir sem @', ready: 'Seu cartão de embarque', download: 'Baixar cartão', copy: 'Copiar link', copied: 'Link copiado.',
    invitesReady: (n: number) => `${n} ${n === 1 ? 'convite pronto' : 'convites prontos'}`, emailed: 'Também enviamos este cartão por e-mail.', handleNote: 'O @ é digitado por você, não é verificado e aparece no seu cartão público.',
    test: 'TEST', testTitle: ['Voo de teste. ', 'Seu cartão é um teste.'], testBody: (day: string) => `Este cartão está marcado TEST e não é guardado. Seu cartão oficial sai quando o embarque abrir, ${day}.`,
  },
  card: { boarded: (who: string) => [`${who} embarcou no `, 'Flight FloFi.'], someone: 'Um passageiro', body: 'Diga para onde suas criptos devem ir. A FloFi monta a rota e simula. Você aprova cada passo.',
    boardToo: 'Embarcar também', closed: 'Beta fechado, abrindo em grupos.', handle: '@ digitado pelo passageiro, não verificado.', missing: 'Este cartão de embarque não está disponível.',
    title: (who: string) => `${who} embarcou no Flight FloFi`, alt: (route: string, meta: string) => `Cartão de embarque do Flight FloFi: ${route}, ${meta}, você aprova` },
  footer: { nav: 'Navegação do rodapé', privacy: 'Privacidade', risks: 'Riscos', discord: 'Discord', x: 'X',
    risk: 'DeFi envolve riscos. Uma simulação não garante preço nem resultado. Revise cada passo antes de assinar. A FloFi nunca guarda suas chaves nem seus fundos.' },
  errors: { FLIGHT_EMAIL_INVALID: 'Digite um e-mail válido.', FLIGHT_RATE_LIMITED: 'Muitas tentativas daqui. Tente de novo em uma hora.',
    FLIGHT_BUSY: 'A lista está movimentada. Tente de novo em um minuto.', FLIGHT_UNAVAILABLE: 'A lista não está disponível agora. Tente de novo em breve.',
    INVITE_INVALID: 'Esse código de convite não existe.', INVITE_USED: 'Esse código de convite já foi usado.', INVITE_OWN: 'Você não pode usar seu próprio convite.',
    INVITE_ALREADY_HELD: 'Você já tem um convite.', ALREADY_BOARDED: 'Você já está a bordo.', FLIGHT_HANDLE_INVALID: 'Use até 15 letras, números ou sublinhados.',
    FLIGHT_SIGN_IN_REQUIRED: 'Entre primeiro.', generic: 'Algo deu errado. Tente de novo.',
    ACCESS_INVALID: 'Esse link ou código não é válido. Peça um novo.', ACCESS_EXPIRED: 'Esse link expirou. Peça um novo abaixo.',
    ACCESS_USED: 'Esse link já foi usado. Peça um novo se precisar.', ACCESS_CLAIMED_ELSEWHERE: 'Este e-mail já está embarcando com outra conta FloFi. Entre com essa conta.',
    ACCESS_ACCOUNT_HAS_OTHER_ENTRY: 'Sua conta FloFi já embarca com outro e-mail.', ACCESS_BOARDED: 'Este e-mail já embarcou.', ACCESS_RATE_LIMITED: 'Muitas tentativas. Espere uma hora e tente de novo.',
    FLIGHT_SIMULATION_NOT_FOUND: 'Faça uma simulação na FloFi primeiro: seu cartão vem dela.', FLIGHT_NOT_ELIGIBLE: 'Seu grupo ainda não está embarcando.' },
  share: { notListed: (day: string) => `Fora da lista. Por enquanto. O Flight FloFi embarca em ${day}.` },
  unavailable: 'O Flight FloFi não está disponível nesta implantação.',
};

export type FlightCopy = Copy;
/**
 * The boarding day as the copy writes it, on the Brazilian calendar: "Nov 12" in English, "12/11" in Portuguese (BUILD-FLOFI-UX-005: from
 * the deployment's campaign calendar, never a date written into the copy).
 */
export function boardingDay(ms: number, language: Language): string {
  return new Intl.DateTimeFormat(language === 'PT' ? 'pt-BR' : 'en-US', language === 'PT' ? { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }
    : { timeZone: 'America/Sao_Paulo', month: 'short', day: 'numeric' }).format(new Date(ms));
}
/** "9:00": the approved board's 24-hour Brazilian time, without a leading zero. */
export function brtClock(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return `${Number(parts.find(part => part.type === 'hour')?.value ?? 0)}:${parts.find(part => part.type === 'minute')?.value ?? '00'}`;
}
export const FLIGHT_COPY: Readonly<Record<Language, Copy>> = { EN, PT };
export const FLIGHT_LINKS = { discord: 'https://discord.gg/36rEhdUa', x: 'https://x.com/FloFi_xyz' } as const;
