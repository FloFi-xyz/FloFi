// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 approved UX (boards 09–15, secondary pages): Brazilian Portuguese for this workstream's new copy, and Brazilian forms of the existing copy
 * these six pages show (spread late in `pt.ts`, so they replace older European Portuguese forms; the final shell catalog still wins).
 */
export const portugueseApprovedUxPages: Readonly<Record<string, string>> = {
  // Shared: status tags and approved terms (board 16 §4).
  'Coming soon': 'Em breve', 'In testing': 'Em teste', 'Your workflows': 'Seus fluxos', 'Create workflow': 'Criar fluxo', 'Passkeys': 'Passkeys',
  'Saved': 'Salvo', 'Executed': 'Executado', 'All': 'Todos', 'Open': 'Abrir', 'Save': 'Salvar', 'Connect': 'Conectar', 'Disconnect': 'Desconectar',
  'Copy address': 'Copiar endereço', 'Add wallet': 'Adicionar carteira', 'Advanced settings': 'Configurações avançadas',
  'FloFi could not complete this ({0}).': 'A FloFi não conseguiu concluir isto ({0}).',

  // Dashboard (board 10).
  'Your wallet and what needs you.': 'Sua carteira e o que precisa de você.',
  'Needs you': 'Precisa de você', '{0} record needs you': '{0} registro precisa de você', '{0} records need you': '{0} registros precisam de você',
  'See what to do': 'Ver o que fazer', 'See what to do: {0}': 'Ver o que fazer: {0}', 'View all in Your workflows': 'Ver todos em Seus fluxos',
  'No execution in progress.': 'Nenhuma execução em andamento.',
  '{0} workflow executed': '{0} fluxo executado', '{0} workflows executed': '{0} fluxos executados', 'View in Your workflows': 'Ver em Seus fluxos',
  'View current run: {0}': 'Ver execução atual: {0}', 'Open record: {0}': 'Abrir registro: {0}',
  'Open Your workflows': 'Abrir Seus fluxos', 'Use the wallet control in the FloFi header.': 'Use o controle da carteira no cabeçalho da FloFi.',
  'Your wallet portfolio, execution status and workflow records will appear here.': 'Sua carteira, o estado das execuções e os registros dos fluxos aparecerão aqui.',
  'Your executed history and the records that need attention appear here once this wallet is verified above.':
    'Seu histórico de execuções e os registros que precisam de atenção aparecem aqui assim que esta carteira for verificada acima.',
  'updated {0}': 'atualizado {0}', 'About the values': 'Sobre os valores',
  'Transactions, DeFi positions and perpetuals are not shown: FloFi has no verified source for them. Your FloFi executions are in Your workflows.':
    'Transações, posições DeFi e perpétuos não são exibidos: a FloFi não tem uma fonte verificada para eles. Suas execuções na FloFi estão em Seus fluxos.',

  // Your workflows (board 11).
  'Open a workflow to continue where you left off.': 'Abra um fluxo para continuar de onde parou.', 'Filter workflows': 'Filtrar fluxos',
  'Verify this wallet above to see its saved workflows.': 'Verifique esta carteira acima para ver os fluxos salvos dela.',
  'No saved workflows waiting.': 'Nenhum fluxo salvo aguardando.', 'Your workflows are temporarily unavailable.': 'Seus fluxos estão temporariamente indisponíveis.',
  'Loading your workflows…': 'Carregando seus fluxos…', 'Build a workflow and save it from the Canvas; it will appear here.': 'Crie um fluxo e salve-o no Canvas; ele aparecerá aqui.',
  'Refresh workflows': 'Atualizar fluxos', 'Connect a wallet from the header to see your workflows.': 'Conecte uma carteira no cabeçalho para ver seus fluxos.',
  'Executed workflows will appear here when their records are available.': 'Os fluxos executados aparecerão aqui quando os registros deles estiverem disponíveis.',
  'Showing up to 100 workflows.': 'Mostrando até 100 fluxos.',
  'This wallet is not held by a FloFi account you are signed in to. Verify it once to save and reopen its workflows; this signs a message only and never moves funds.':
    'Esta carteira não pertence a uma conta FloFi em que você entrou. Verifique-a uma vez para salvar e reabrir os fluxos dela; isso só assina uma mensagem e nunca movimenta fundos.',

  // Automations (board 12).
  'Routines that prepare proposals. You review and sign each one.': 'Rotinas que preparam propostas. Você revisa e assina cada uma.',
  'Recurring buy': 'Compra recorrente', 'Price trigger': 'Gatilho de preço', 'Daily watch': 'Vigiar diariamente',
  'Prepares a buy of a fixed amount every week or every day.': 'Prepara uma compra de valor fixo toda semana ou todo dia.',
  'Prepares a buy or a sell when the price reaches the value you chose.': 'Prepara uma compra ou venda quando o preço chega no valor que você escolheu.',
  'Tells you regularly how the assets you choose are doing.': 'Avisa regularmente como estão os ativos que você escolher.',
  'Prefer to describe?': 'Prefere descrever?', 'Create with chat': 'Criar pelo chat',
  'Recurring buys, price triggers and daily watches': 'Compras recorrentes, gatilhos de preço e vigias diárias',
  'Automations are not enabled on this deployment.': 'As automações ainda não estão disponíveis nesta implantação.',
  'Waiting for you': 'Aguardando você', 'Your automations': 'Suas automações', 'No automations yet. Choose a routine above.': 'Nenhuma ainda. Escolha uma rotina acima.',
  'Max price difference': 'Diferença máxima de preço', 'Max price difference {0}': 'Diferença máxima de preço {0}',
  'Max price difference (%)': 'Diferença máxima de preço (%)', 'Max price difference limit': 'Limite da diferença máxima de preço',
  'Max price difference limit (%)': 'Limite da diferença máxima de preço (%)', 'The max price difference is above your limit.': 'A diferença máxima de preço está acima do seu limite.',
  '{0} since the last round': '{0} desde a última verificação', 'Waiting until': 'Aguardando até', 'sent to your chat': 'enviada para o seu chat',
  'Review in FloFi': 'Revisar na FloFi', 'No BTC swap route in FloFi yet': 'A FloFi ainda não tem rota de troca para BTC',
  'Ask me before every execution': 'Perguntar antes de cada execução', 'Notify me': 'Avisar', 'Rebind': 'Reassociar',
  'Price falls below': 'O preço cai abaixo de', 'Price rises above': 'O preço sobe acima de',
  'Price falls by a percentage': 'O preço cai uma porcentagem', 'Price rises by a percentage': 'O preço sobe uma porcentagem', 'Percentage': 'Porcentagem',
  'If {0} falls below {1}': 'Se {0} cair abaixo de {1}', 'If {0} falls {1}% from {2} (at or below {3})': 'Se {0} cair {1}% a partir de {2} (a {3} ou menos)',
  'Side': 'Lado', 'Threshold (USD)': 'Valor-limite (USD)', 'Notify me only': 'Só avisar', 'Nothing — notify me only': 'Nada — só avisar',
  'Nothing is authorized yet. Review opens FloFi’s approval: prove your wallet, run a fresh simulation, review the Strategy Manifest and sign with your own wallet.':
    'Nada está autorizado ainda. Revisar abre a aprovação da FloFi: comprove sua carteira, faça uma nova simulação, revise o Strategy Manifest e assine com sua própria carteira.',
  'This is your own new trade, not part of this automation: it goes to your Editor draft as an ordinary proposal, exactly as if you had composed it there. The automation adds no authority and no limits to it. Nothing is signed: apply it, simulate and review the Strategy Manifest first.':
    'Esta é uma nova operação sua, que não faz parte desta automação: ela vai para o seu rascunho no Editor como uma proposta comum, exatamente como se você a tivesse criado lá. A automação não acrescenta autoridade nem limites a ela. Nada é assinado: aplique, simule e revise o Strategy Manifest primeiro.',
  'The saved workflow changed after this automation was created. FloFi proposes nothing until you rebind it to the current version.':
    'O fluxo salvo mudou depois que esta automação foi criada. A FloFi não propõe nada até você reassociá-la à versão atual.',
  'This action no longer reproduces with FloFi’s current engine. FloFi proposes nothing until you rebind it.':
    'Esta ação não se reproduz mais com o motor atual da FloFi. A FloFi não propõe nada até você reassociá-la.',
  'Limits bound what FloFi proposes. They are not on-chain spending limits: every execution still needs your review and your wallet signature.':
    'Os limites restringem o que a FloFi propõe. Não são limites de gasto on-chain: cada execução ainda precisa da sua revisão e da assinatura da sua carteira.',
  'In FloFi': 'Na FloFi', 'always on — proposals wait for you in this workspace.': 'sempre ativas — as propostas aguardam você nesta área.',
  'Send this message to the FloFi bot within 10 minutes:': 'Envie esta mensagem ao bot da FloFi nos próximos 10 minutos:',
  'A notification never authorizes anything. It only brings you back here, where your own wallet decides.':
    'Uma notificação nunca autoriza nada. Ela só traz você de volta para cá, onde sua própria carteira decide.',

  // Credentials (board 13).
  'Wallets and payment methods you use with FloFi. Saving here never approves anything.': 'Carteiras e meios de pagamento que você usa com a FloFi. Salvar aqui nunca aprova nada.',
  '{0} wallet': 'Carteira {0}', 'in use on {0}': 'em uso na {0}', 'last used on {0}': 'usada por último na {0}', 'More actions for {0}': 'Mais ações de {0}',
  'Connect a wallet you already have': 'Conectar uma carteira que você já tem', 'Create or import a FloFi wallet': 'Criar ou importar uma carteira FloFi',
  'Pix and boleto': 'Pix e boleto', 'Payments through a connected provider': 'Pagamentos por um provedor conectado',
  'Danger zone · delete FloFi account': 'Zona de risco · excluir conta FloFi',
  'Add a wallet to save its public address here. FloFi never holds your keys.': 'Adicione uma carteira para salvar aqui o endereço público dela. A FloFi nunca guarda suas chaves.',
  'Cards are added through a certified card provider\'s secure entry. FloFi never sees or stores your card number or security code.':
    'O cartão é cadastrado no ambiente seguro de um provedor certificado. A FloFi nunca vê nem armazena o número do cartão ou o código de segurança.',
  'Remove {0} from FloFi?': 'Remover {0} da FloFi?', 'This also disconnects it.': 'Isso também a desconecta.',
  'Only FloFi\'s reference is removed; the wallet and its assets are not affected.': 'Só a referência da FloFi é removida; a carteira e os ativos dela não são afetados.',
  'Remove this card from FloFi? The card itself is not affected.': 'Remover este cartão da FloFi? O cartão em si não é afetado.',
  'Signs with your FloFi wallet (Privy), after you review the transaction in FloFi.': 'Assina com sua carteira FloFi (Privy), depois que você revisa a transação na FloFi.',
  'Secure card entry could not be loaded. Nothing was collected. Try again later.': 'Não foi possível carregar o cadastro seguro do cartão. Nada foi coletado. Tente mais tarde.',
  'Card entry status could not be checked. Nothing was collected. Try again later.': 'Não foi possível verificar o cadastro de cartões. Nada foi coletado. Tente mais tarde.',
  'FloFi never asks for your card number or security code in its own forms. Cards are added only through the card provider\'s secure entry, on FloFi\'s separate card page, which isn\'t set up on this deployment yet.':
    'A FloFi nunca pede o número do cartão ou o código de segurança nos próprios formulários. Os cartões só são cadastrados no ambiente seguro do provedor, na página de cartões separada da FloFi, que ainda não está configurada nesta implantação.',
  'FloFi never asks for your card number or security code in its own forms. Cards are added only through a certified card provider\'s secure entry, and no card provider is connected to FloFi yet.':
    'A FloFi nunca pede o número do cartão ou o código de segurança nos próprios formulários. Os cartões só são cadastrados no ambiente seguro de um provedor certificado, e nenhum provedor de cartões está conectado à FloFi ainda.',
  'Expires {0}': 'Expira em {0}', 'verified {0}': 'verificada em {0}', 'added {0}': 'adicionada em {0}', 'Credential expires on': 'A credencial expira em',
  'Revoke on-chain with your wallet': 'Revogar on-chain com sua carteira',
  'Spend up to {0} from this wallet’s token account; recipient and program are checked by FloFi, not on-chain':
    'Gastar até {0} da conta de token desta carteira; o destinatário e o programa são verificados pela FloFi, não on-chain',
  'Enroll a wallet once to let FloFi execute workflows you authorize, inside the limits it signs here. Each enrollment is one wallet signature per network; workflows never ask the wallet again.':
    'Registre uma carteira uma vez para permitir que a FloFi execute os fluxos que você autorizar, dentro dos limites que ela assina aqui. Cada registro é uma assinatura da carteira por rede; os fluxos nunca pedem a carteira de novo.',
  'Register a passkey first (Passkeys). Every Credential is bound to the passkey that will authorize your workflows.':
    'Registre primeiro uma passkey (Passkeys). Cada Credencial fica vinculada à passkey que vai autorizar seus fluxos.',

  // Agents (board 14).
  'Connect AI assistants to FloFi. They suggest, and you approve each step here.': 'Conecte assistentes de IA à FloFi. Eles sugerem, e você aprova cada passo aqui.',
  'Connect an assistant': 'Conectar um assistente', 'Connect with {0}': 'Conectar com {0}', 'Use FloFi from inside {0}.': 'Use a FloFi de dentro do {0}.',
  'API clients': 'Clientes de API', 'For people who integrate FloFi through code': 'Para quem integra a FloFi por código',

  // Passkeys (board 15).
  'Sign in with your fingerprint or face': 'Entrar com a digital ou o rosto',
  'A passkey lets you sign in to FloFi without a password, using your device unlock. It does not sign transactions.':
    'Uma passkey deixa você entrar na FloFi sem senha, usando o desbloqueio do seu aparelho. Ela não assina transações.',
  'Checking passkeys…': 'Verificando as passkeys…',
  'A passkey is how you authorize automatic workflows: once per workflow, on this device.': 'Uma passkey é a forma de autorizar fluxos automáticos: uma vez por fluxo, neste dispositivo.',
  'A passkey is how you authorize automatic workflows: once per workflow, with this device. It is never a wallet key and never moves funds by itself.':
    'Uma passkey é a forma de autorizar fluxos automáticos: uma vez por fluxo, com este dispositivo. Ela nunca é uma chave de carteira e nunca movimenta fundos sozinha.',
  'Verify wallet ownership to manage passkeys.': 'Verifique a titularidade da carteira para gerenciar passkeys.',
  'Add a passkey': 'Adicionar uma passkey', 'Passkey name': 'Nome da passkey', 'Passkey {0}': 'Passkey {0}',
  'No passkeys yet. Add one to get started.': 'Ainda não há passkeys. Adicione uma para começar.',
};
