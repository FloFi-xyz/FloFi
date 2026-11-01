// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-PRIVY-UX-001: Privy sign-in, Add your wallets, the import screen, My wallets and Privy messages (pt-BR). */
export const portuguesePrivy: Readonly<Record<string, string>> = {
  // Sign-in
  'Sign in to your FloFi account or create one with Google, your email or your wallet.': 'Entre na sua conta FloFi ou crie uma com o Google, seu e-mail ou sua carteira.',
  "Sign-in isn't configured on this deployment yet.": 'O login ainda não está configurado nesta implantação.',
  'Signing you in…': 'Entrando…',
  // Showcase
  'PROTECTED BY PRIVY': 'PROTEGIDO PELA PRIVY', 'Keys are created and kept by Privy, not by FloFi.': 'As chaves são criadas e guardadas pela Privy, não pelo FloFi.',
  // Add your wallets
  'Create a new wallet or import one you already have. Keys are created and kept by our wallet provider, Privy — FloFi’s servers never receive or store them.':
    'Crie uma nova carteira ou importe uma que você já tem. As chaves são criadas e guardadas pelo nosso provedor de carteiras, a Privy — os servidores do FloFi nunca as recebem nem armazenam.',
  'Creating your {0} wallet…': 'Criando sua carteira {0}…', '{0} wallets': 'Carteiras {0}', 'Wallet created': 'Carteira criada', 'Creating…': 'Criando…',
  'A new {0} wallet, ready right away': 'Uma carteira {0} nova, pronta na hora', 'Bring an existing {0} wallet with its private key': 'Traga uma carteira {0} existente com a chave privada',
  'Connecting to your wallet provider…': 'Conectando ao seu provedor de carteiras…', "Your wallet provider isn't responding.": 'Seu provedor de carteiras não está respondendo.',
  'Check your connection, then try again. Nothing was created.': 'Verifique sua conexão e tente de novo. Nada foi criado.',
  'Sign in again to add wallets.': 'Entre de novo para adicionar carteiras.',
  'Your wallet provider session has ended in this browser. Your account and wallets are unchanged.':
    'Sua sessão no provedor de carteiras terminou neste navegador. Sua conta e suas carteiras não mudaram.',
  'Check again': 'Verificar de novo', 'Created': 'Criada', 'Imported': 'Importada', 'Legacy FloFi Wallet': 'FloFi Wallet antiga', 'Continue': 'Continuar',
  // Import screen
  'Import {0} wallet': 'Importar carteira {0}', 'Import your {0} wallet': 'Importe sua carteira {0}',
  'Your private key is handed, in this browser, straight to our wallet provider Privy, which takes it into its own secure frame. It passes briefly through this page’s code on the way and is never sent to FloFi’s servers, stored or logged.':
    'Sua chave privada é entregue, neste navegador, diretamente ao nosso provedor de carteiras, a Privy, que a leva para o próprio quadro seguro. Ela passa rapidamente pelo código desta página no caminho e nunca é enviada aos servidores do FloFi, armazenada ou registrada.',
  'Importing isn’t available right now.': 'A importação não está disponível agora.', 'Go back to Add wallets and sign in again if it asks you to.':
    'Volte para Adicionar carteiras e entre de novo se for pedido.', 'Back to Add wallets': 'Voltar para Adicionar carteiras', 'Private key': 'Chave privada',
  'Base58 private key': 'Chave privada em base58', 'Paste the 64-character hexadecimal private key of the EVM wallet.': 'Cole a chave privada hexadecimal de 64 caracteres da carteira EVM.',
  'Paste the base58 private key of the Solana wallet.': 'Cole a chave privada em base58 da carteira Solana.', 'Never share it with anyone else.': 'Nunca a compartilhe com mais ninguém.',
  'Importing a wallet authorizes nothing. Every transaction is still simulated, reviewed and signed by you.':
    'Importar uma carteira não autoriza nada. Toda transação continua sendo simulada, revisada e assinada por você.',
  // My wallets and export
  'This wallet was created in the earlier FloFi Wallet. Export happens there, in a separate secure window: you unlock it again, confirm, and the secret is shown only inside Turnkey’s secure frame. To keep using it in FloFi, import the key afterwards in Add wallets.':
    'Esta carteira foi criada na FloFi Wallet anterior. A exportação acontece lá, numa janela segura separada: você a desbloqueia de novo, confirma, e o segredo aparece só dentro do quadro seguro da Turnkey. Para continuar a usá-la no FloFi, importe a chave depois em Adicionar carteiras.',
  'Export happens in Privy’s own secure screen. The key is shown only there; FloFi never sees it.': 'A exportação acontece na tela segura da própria Privy. A chave aparece só ali; o FloFi nunca a vê.',
  'Export private key': 'Exportar chave privada', 'Continue in the export screen…': 'Continue na tela de exportação…', 'Export screen closed.': 'Tela de exportação fechada.',
  'Managed by Privy': 'Gerenciada pela Privy',
  'Signs with your FloFi wallet (Privy), after you review the transaction in FloFi.': 'Assina com sua carteira FloFi (Privy), depois que você revisa a transação no FloFi.',
  'Wallets created or imported in FloFi are not deleted: they stay with their provider and their funds are unchanged. Export them first if you want to keep using them elsewhere.':
    'As carteiras criadas ou importadas no FloFi não são apagadas: continuam no provedor e os fundos não mudam. Exporte-as antes se quiser continuar a usá-las em outro lugar.',
  'Authorize opens your FloFi wallet, where you confirm the exact transaction.': 'Autorizar abre sua carteira FloFi, onde você confirma a transação exata.',
  // Messages (account-messages.ts, flofi-signing.ts, wallet-messages.ts)
  'This address is already one of your FloFi wallets, so it is not added again as an external wallet.': 'Este endereço já é uma das suas carteiras FloFi, por isso não é adicionado de novo como carteira externa.',
  'That name looks like part of a key. Choose a different name; nothing was saved.': 'Esse nome parece parte de uma chave. Escolha outro nome; nada foi salvo.',
  'Your sign-in and wallets at our wallet provider, Privy, are not deleted by this. To have Privy delete them too, export your wallets first, then ask FloFi (see Privacy).': 'Isto não apaga o seu acesso nem as suas carteiras no nosso provedor de carteiras, a Privy. Para que a Privy também os apague, exporte primeiro as suas carteiras e depois peça ao FloFi (veja Privacidade).',
  'Wallets FloFi keeps for you stay in your account. Export one if you want to use it elsewhere.': 'As carteiras que o FloFi guarda para você continuam na sua conta. Exporte uma se quiser usá-la em outro lugar.',
  'FloFi could not save that wallet to your account yet. Your wallet is safe with the provider; choose Check again.':
    'O FloFi ainda não conseguiu salvar essa carteira na sua conta. Sua carteira está segura no provedor; escolha Verificar de novo.',
  'This sign-in matches more than one FloFi account, so FloFi did not sign you in. Sign in with the method you used before.':
    'Este login corresponde a mais de uma conta FloFi, então o FloFi não fez o login. Entre com o método que você usou antes.',
  'This FloFi account belongs to another wallet-provider user. Nothing was signed in or changed.': 'Esta conta FloFi pertence a outro usuário do provedor de carteiras. Nada foi conectado nem alterado.',
  'The wallet provider could not be reached. Nothing changed. Try again in a moment.': 'Não foi possível falar com o provedor de carteiras. Nada mudou. Tente de novo em instantes.',
  'FloFi could not verify that sign-in. Nothing was signed in.': 'O FloFi não conseguiu verificar esse login. Nada foi conectado.',
  'FloFi could not find that sign-in at the wallet provider. Start again.': 'O FloFi não encontrou esse login no provedor de carteiras. Comece de novo.',
  'Sign-in is misconfigured on this deployment. Nothing was signed in.': 'O login está mal configurado nesta implantação. Nada foi conectado.',
  'The wallet provider sent an answer FloFi could not read. Nothing changed.': 'O provedor de carteiras enviou uma resposta que o FloFi não conseguiu ler. Nada mudou.',
  'Sign-in did not complete. Try again.': 'O login não foi concluído. Tente de novo.', 'Sign in with Google, your email or a Web3 wallet.': 'Entre com o Google, seu e-mail ou uma carteira Web3.',
  'Your wallet provider session has ended in this browser. Sign in again.': 'Sua sessão no provedor de carteiras terminou neste navegador. Entre de novo.',
  'You are signed in to the wallet provider as someone else. Sign in again.': 'Você está conectado ao provedor de carteiras como outra pessoa. Entre de novo.',
  'You closed the window before it finished. Nothing changed.': 'Você fechou a janela antes de terminar. Nada mudou.',
  'FloFi could not send a code to that address. Check it and try again.': 'O FloFi não conseguiu enviar um código para esse endereço. Confira e tente de novo.',
  'That code is not valid or has expired. Request a new one.': 'Esse código não é válido ou expirou. Peça um novo.',
  'The wallet was not created. Nothing changed. Try again.': 'A carteira não foi criada. Nada mudou. Tente de novo.',
  'The wallet was not imported. Check the key and try again.': 'A carteira não foi importada. Confira a chave e tente de novo.',
  'The export could not start. Nothing was revealed.': 'A exportação não pôde começar. Nada foi revelado.',
  'Your wallet provider already holds a wallet of this kind for you. FloFi shows it instead of creating another.':
    'Seu provedor de carteiras já guarda uma carteira desse tipo para você. O FloFi a mostra em vez de criar outra.',
  'That does not look like a private key for this network. Nothing was imported.': 'Isso não parece uma chave privada desta rede. Nada foi importado.',
  'This is taking longer than usual. Your wallet may still be finishing; choose Check again.': 'Está demorando mais que o normal. Sua carteira ainda pode estar terminando; escolha Verificar de novo.',
  'Wallets created in the earlier FloFi Wallet can be exported, not used to sign. Export it, then import the key here.':
    'As carteiras criadas na FloFi Wallet anterior podem ser exportadas, não usadas para assinar. Exporte-a e depois importe a chave aqui.',
  'Sign in to FloFi again in this browser to use your FloFi wallet. Nothing was signed.': 'Entre no FloFi de novo neste navegador para usar sua carteira FloFi. Nada foi assinado.',
  'That sign-in was already used or is too old. Sign in again.': 'Esse acesso já foi usado ou é antigo demais. Entre de novo.',
  'This Review expires in a few seconds, too soon to confirm it in your wallet. Simulate again, then Authorize. Nothing was signed.': 'Esta Revisão expira em poucos segundos, cedo demais para confirmá-la na sua carteira. Simule de novo e depois Autorize. Nada foi assinado.',
  'Your FloFi wallet is still loading in this page. Wait a moment, then choose Authorize again. Nothing was signed.': 'Sua carteira FloFi ainda está carregando nesta página. Aguarde um momento e escolha Autorizar de novo. Nada foi assinado.',
};
