// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the /board copy. English is the team-approved Claude Artifact "Flight FloFi" (version 1793892357-f7d9), word for
 * word: the "Landing" boards (desktop, final call, five mobile states), the cards and the approved post "Gate closed. Boarding starts
 * tomorrow." for the night between the list closing and boarding. The boards are English only; the Portuguese is a translation for the
 * page's EN · PT switch (to be confirmed by the team). Numbers on the page are always real; the boards' sample numbers are not used.
 */
import type { Language } from '../../i18n/language';

const EN = {
  lang: 'en',
  title: 'Flight FloFi · Say where you’re going · FloFi',
  description: 'FloFi boards Nov 17. Say where you’re going, FloFi builds the route, you approve. The first 100 get the good seats.',
  nav: { label: 'Flight FloFi navigation', how: 'How it works', founding: 'Founding', routes: 'Routes', home: 'FloFi, home', language: 'Language' },
  marquee: 'NOW BOARDING · DEFI THE WAY YOU TALK · YOU APPROVE · FLOFI.XYZ · ',
  finalCall: {
    eyebrow: 'Flight FloFi · Closed beta · Boards Nov 17', title: ['Final call for ', 'the beta list.'],
    body: 'First boarding goes to the beta list. Say where you’re going, FloFi builds the route, you approve.',
    closesIn: 'List closes in', units: ['D', 'H', 'M'], email: 'you@email.com', emailLabel: 'Your email', join: 'Join the list',
    onList: (n: string) => `${n} ON THE LIST`, notice: 'We only use your email for the FloFi beta.', consent: 'By joining, you agree to this use under our', privacy: 'Privacy Policy',
    joined: 'You’re on the list. First boarding goes to the beta list.', sticker: 'FINAL CALL',
  },
  gateClosed: {
    eyebrow: 'Flight FloFi · Gate closed', title: ['Gate closed. ', 'Boarding starts tomorrow.'], body: '9:00 BRT. See you on board.',
    join: 'Join the next flight', joined: 'You’re on the list for the next flight.', sticker: 'LIST CLOSED',
  },
  boarding: {
    eyebrow: 'Flight FloFi · Closed beta', title: ['Say where ', 'you’re going.'], body: ['FloFi builds the steps and simulates them. ', 'You approve.'],
    to: 'TO', placeholder: 'move my USDC from Ethereum to Base and lend it on Aave', promptLabel: 'Where you’re going', board: 'Board now',
    counters: (boarded: string) => `${boarded} BOARDED`, left: (n: string) => `${n} FOUNDING SEATS LEFT`, invite: 'I have an invite code',
    sticker: 'NOW BOARDING', checking: 'Checking your boarding…', signIn: 'Sign in to board',
  },
  foundingFull: { banner: 'FOUNDING FULL', body: ['All 100 Founding seats are taken. You still board, as a passenger. ', 'You approve.'],
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
    ['Your name on the wall.', 'A spot on the Founding Members wall.'],
    ['3 invites.', 'Bring three people on board, no list needed.']],
    taken: (n: number) => `${n} OF 100 FOUNDING SEATS TAKEN`, cardYou: '@you', cardSeat: (seat: string) => `Founding Member ${seat}` },
  routes: { eyebrow: 'Example routes', title: ['Not sure where to go? ', 'Pick a route.'], use: 'Use this route', items: [
    { id: 'eth_base', from: 'ETH', to: 'BASE', prompt: 'Move my USDC from Ethereum to Base and lend it on Aave', meta: '2 STEPS · 2 NETWORKS' },
    { id: 'eth_sol', from: 'ETH', to: 'SOL', prompt: 'Swap my ETH, bring it to Solana and add liquidity on Orca', meta: '4 STEPS · 3 NETWORKS' },
    { id: 'arb_base', from: 'ARB', to: 'BASE', prompt: 'Bridge my USDC from Arbitrum to Base', meta: '1 STEP · 2 NETWORKS' }] },
  pass: {
    flight: 'Flight FloFi', boardingPass: 'BOARDING PASS', passenger: 'PASSENGER', departure: 'DEPARTURE', from: 'FROM', to: 'TO', via: 'VIA', seat: 'SEAT',
    route: 'ROUTE', gate: 'GATE', youApprove: 'You approve', checked: 'CHECKED', founding: 'FOUNDING', foundingMember: 'Founding Member',
    steps: (n: number, networks: number) => `${n} ${n === 1 ? 'STEP' : 'STEPS'} · ${networks} ${networks === 1 ? 'NETWORK' : 'NETWORKS'}`,
    more: (n: number) => `+${n} steps`, eyebrowFounding: 'Flight FloFi · Founding member', noHandle: 'Add your X handle',
    standbyBoard: ['FLIGHT FLOFI', 'FOUNDING FULL'], standbyTitle: ['You’re on board. ', 'Middle seat.'], standbyBody: 'Next to the bathroom.',
    middleSeat: 'MIDDLE SEAT', yours: 'Your boarding pass',
    handleLabel: 'Your X handle', handlePublic: 'Show my handle and route on the public departures board', save: 'Save',
    saved: 'Saved.', share: 'Share on X', invitesTitle: 'Your 3 invites', invitesBody: 'Bring three people on board, no list needed. Each code works once.',
    used: 'used', open: 'Open FloFi',
  },
  footer: { nav: 'Footer navigation', privacy: 'Privacy', risks: 'Risks', discord: 'Discord', x: 'X',
    risk: 'DeFi involves risk. A simulation does not guarantee price or outcome. Review every step before you sign. FloFi never holds your keys or your funds.' },
  errors: { FLIGHT_EMAIL_INVALID: 'Enter a valid email address.', FLIGHT_RATE_LIMITED: 'Too many tries from here. Try again in an hour.',
    FLIGHT_BUSY: 'The list is busy. Try again in a minute.', FLIGHT_UNAVAILABLE: 'The list is not available right now. Try again soon.',
    INVITE_INVALID: 'That invite code does not exist.', INVITE_USED: 'That invite code was already used.', INVITE_OWN: 'You can’t use your own invite.',
    INVITE_ALREADY_HELD: 'You already have an invite.', ALREADY_BOARDED: 'You’re already on board.', FLIGHT_HANDLE_INVALID: 'Use up to 15 letters, digits or underscores.',
    FLIGHT_SIGN_IN_REQUIRED: 'Sign in first.', generic: 'Something went wrong. Try again.' },
  share: { notListed: 'Not on the list. Yet. Flight FloFi boards Nov 17.', pass: (seat: string, route: string) => `Flight FloFi · ${seat} · ${route} · You approve.` },
  unavailable: 'Flight FloFi is not available on this deployment.',
};
type Copy = typeof EN;

const PT: Copy = {
  lang: 'pt-BR',
  title: 'Flight FloFi · Diga para onde você vai · FloFi',
  description: 'A FloFi embarca em 17/11. Diga para onde você vai, a FloFi monta a rota, você aprova. Os 100 primeiros ficam com os melhores assentos.',
  nav: { label: 'Navegação do Flight FloFi', how: 'Como funciona', founding: 'Founding', routes: 'Rotas', home: 'FloFi, início', language: 'Idioma' },
  marquee: 'EMBARQUE ABERTO · DEFI DO JEITO QUE VOCÊ FALA · VOCÊ APROVA · FLOFI.XYZ · ',
  finalCall: {
    eyebrow: 'Flight FloFi · Beta fechado · Embarca em 17/11', title: ['Última chamada para ', 'a lista beta.'],
    body: 'O primeiro embarque é da lista beta. Diga para onde você vai, a FloFi monta a rota, você aprova.',
    closesIn: 'A lista fecha em', units: ['D', 'H', 'M'], email: 'voce@email.com', emailLabel: 'Seu e-mail', join: 'Entrar na lista',
    onList: (n: string) => `${n} NA LISTA`, notice: 'Usamos seu e-mail só para o beta da FloFi.', consent: 'Ao entrar, você concorda com esse uso, conforme a nossa', privacy: 'Política de Privacidade',
    joined: 'Você está na lista. O primeiro embarque é da lista beta.', sticker: 'ÚLTIMA CHAMADA',
  },
  gateClosed: {
    eyebrow: 'Flight FloFi · Portão fechado', title: ['Portão fechado. ', 'O embarque começa amanhã.'], body: '9h (BRT). Até logo a bordo.',
    join: 'Entrar no próximo voo', joined: 'Você está na lista do próximo voo.', sticker: 'LISTA FECHADA',
  },
  boarding: {
    eyebrow: 'Flight FloFi · Beta fechado', title: ['Diga para onde ', 'você vai.'], body: ['A FloFi monta os passos e simula. ', 'Você aprova.'],
    to: 'PARA', placeholder: 'levar meu USDC da Ethereum para a Base e emprestar na Aave', promptLabel: 'Para onde você vai', board: 'Embarcar agora',
    counters: (boarded: string) => `${boarded} EMBARCARAM`, left: (n: string) => `${n} ASSENTOS FOUNDING RESTANTES`, invite: 'Tenho um código de convite',
    sticker: 'EMBARQUE ABERTO', checking: 'Conferindo seu embarque…', signIn: 'Entre para embarcar',
  },
  foundingFull: { banner: 'FOUNDING ESGOTADO', body: ['Os 100 assentos Founding foram ocupados. Você ainda embarca, como passageiro. ', 'Você aprova.'],
    placeholder: 'levar meu USDC da Arbitrum para a Base' },
  batch: { onTheList: 'NA LISTA', yourGroup: 'Seu grupo', group: (n: number) => `GRUPO ${n}`, opens: 'Embarque abre',
    title: ['Você está na lista. ', 'Seu grupo embarca em breve.'], body: (when: string) => `Seu embarque abre ${when}. Avisamos por e-mail assim que abrir.`,
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
    ['Seu nome no mural.', 'Um lugar no mural dos Founding Members.'],
    ['3 convites.', 'Traga três pessoas a bordo, sem precisar da lista.']],
    taken: (n: number) => `${n} DE 100 ASSENTOS FOUNDING OCUPADOS`, cardYou: '@voce', cardSeat: (seat: string) => `Founding Member ${seat}` },
  routes: { eyebrow: 'Rotas de exemplo', title: ['Não sabe para onde ir? ', 'Escolha uma rota.'], use: 'Usar esta rota', items: [
    { id: 'eth_base', from: 'ETH', to: 'BASE', prompt: 'Levar meu USDC da Ethereum para a Base e emprestar na Aave', meta: '2 PASSOS · 2 REDES' },
    { id: 'eth_sol', from: 'ETH', to: 'SOL', prompt: 'Trocar meu ETH, levar para a Solana e adicionar liquidez na Orca', meta: '4 PASSOS · 3 REDES' },
    { id: 'arb_base', from: 'ARB', to: 'BASE', prompt: 'Levar meu USDC da Arbitrum para a Base', meta: '1 PASSO · 2 REDES' }] },
  pass: {
    flight: 'Flight FloFi', boardingPass: 'CARTÃO DE EMBARQUE', passenger: 'PASSAGEIRO', departure: 'PARTIDA', from: 'DE', to: 'PARA', via: 'VIA', seat: 'ASSENTO',
    route: 'ROTA', gate: 'PORTÃO', youApprove: 'Você aprova', checked: 'CONFERIDO', founding: 'FOUNDING', foundingMember: 'Founding Member',
    steps: (n: number, networks: number) => `${n} ${n === 1 ? 'PASSO' : 'PASSOS'} · ${networks} ${networks === 1 ? 'REDE' : 'REDES'}`,
    more: (n: number) => `+${n} passos`, eyebrowFounding: 'Flight FloFi · Founding member', noHandle: 'Adicione seu @ do X',
    standbyBoard: ['FLIGHT FLOFI', 'FOUNDING ESGOTADO'], standbyTitle: ['Você está a bordo. ', 'Assento do meio.'], standbyBody: 'Ao lado do banheiro.',
    middleSeat: 'ASSENTO DO MEIO', yours: 'Seu cartão de embarque',
    handleLabel: 'Seu @ do X', handlePublic: 'Mostrar meu @ e minha rota no painel público de partidas', save: 'Salvar',
    saved: 'Salvo.', share: 'Compartilhar no X', invitesTitle: 'Seus 3 convites', invitesBody: 'Traga três pessoas a bordo, sem precisar da lista. Cada código vale uma vez.',
    used: 'usado', open: 'Abrir a FloFi',
  },
  footer: { nav: 'Navegação do rodapé', privacy: 'Privacidade', risks: 'Riscos', discord: 'Discord', x: 'X',
    risk: 'DeFi envolve riscos. Uma simulação não garante preço nem resultado. Revise cada passo antes de assinar. A FloFi nunca guarda suas chaves nem seus fundos.' },
  errors: { FLIGHT_EMAIL_INVALID: 'Digite um e-mail válido.', FLIGHT_RATE_LIMITED: 'Muitas tentativas daqui. Tente de novo em uma hora.',
    FLIGHT_BUSY: 'A lista está movimentada. Tente de novo em um minuto.', FLIGHT_UNAVAILABLE: 'A lista não está disponível agora. Tente de novo em breve.',
    INVITE_INVALID: 'Esse código de convite não existe.', INVITE_USED: 'Esse código de convite já foi usado.', INVITE_OWN: 'Você não pode usar seu próprio convite.',
    INVITE_ALREADY_HELD: 'Você já tem um convite.', ALREADY_BOARDED: 'Você já está a bordo.', FLIGHT_HANDLE_INVALID: 'Use até 15 letras, números ou sublinhados.',
    FLIGHT_SIGN_IN_REQUIRED: 'Entre primeiro.', generic: 'Algo deu errado. Tente de novo.' },
  share: { notListed: 'Fora da lista. Por enquanto. O Flight FloFi embarca em 17/11.', pass: (seat: string, route: string) => `Flight FloFi · ${seat} · ${route} · Você aprova.` },
  unavailable: 'O Flight FloFi não está disponível nesta implantação.',
};

export type FlightCopy = Copy;
export const FLIGHT_COPY: Readonly<Record<Language, Copy>> = { EN, PT };
export const FLIGHT_LINKS = { discord: 'https://discord.gg/36rEhdUa', x: 'https://x.com/FloFi_xyz' } as const;
