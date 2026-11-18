// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (pt-BR, P0): the account's sign-in methods, the duplicate-account move and the boarding recovery copy.
 * Provider names (Google, Apple, Privy) stay as they are.
 */
export const portugueseIdentityRecovery: Readonly<Record<string, string>> = {
  // P0: sign-in methods, duplicate accounts, step-up and boarding recovery
  'Add Google or an email so they open this same account.': 'Adicione o Google ou um e-mail para que abram esta mesma conta.',
  'Manage': 'Gerenciar',
  'No sign-in method is recorded yet.': 'Nenhum método de login registrado ainda.',
  'That sign-in method already opens another FloFi account, so it was not added. Nothing was merged or moved.':
    'Esse método de login já abre outra conta FloFi, então não foi adicionado. Nada foi unido ou movido.',
  'Linked. You can now sign in with it.': 'Vinculado. Agora você pode entrar com ele.',
  // Authentication UX & Login Regression Fix (item 6): the step after a link, and after closing a duplicate.
  'Continue to my account': 'Continuar para minha conta',
  // Authentication UX & Login Regression Fix: shorter sign-in and Sign-in methods copy.
  'Sign in again with any method of this account.': 'Entre de novo com qualquer método desta conta.',
  'Use the method you boarded with.': 'Use o método com que você embarcou.',
  'Not available yet': 'Ainda não disponível',
  'If that account is empty, sign in with it and choose “Bring this sign-in to my other account”.':
    'Se essa conta estiver vazia, entre nela e escolha “Levar este login para minha outra conta”.',
  'Use the method you boarded with, not {0}.': 'Use o método com que você embarcou, não {0}.',
  'That account signs in with {0}.': 'Essa conta usa {0} para entrar.',
  'Getting sign-in ready…': 'Preparando o login…',
  'Every method here opens this same account.': 'Cada método aqui abre esta mesma conta.',
  'For your security, confirm it’s you first.': 'Por segurança, confirme primeiro que é você.',
  'Add Google': 'Adicionar Google', 'Add email': 'Adicionar e-mail',
  'Is this a second FloFi account?': 'Esta é uma segunda conta FloFi?',
  'If you boarded with another sign-in, close this empty account and bring its sign-in there. You will sign in to the other account to confirm.':
    'Se você embarcou com outro login, feche esta conta vazia e leve o login dela para lá. Você vai entrar na outra conta para confirmar.',
  'Nothing new was linked.': 'Nada novo foi vinculado.',
  'A sign-in method was linked at Privy before FloFi asked, so it was not added and does not open this account.': 'Um método de login foi vinculado na Privy antes de a FloFi pedir, então não foi adicionado e não abre esta conta.',
  'One FloFi account, several ways in. Every method you add opens this same account; adding one approves nothing and moves no funds.':
    'Uma conta FloFi, várias formas de entrar. Cada método que você adiciona abre esta mesma conta; adicionar um não aprova nada nem move fundos.',
  'Sign in to the account that keeps everything': 'Entre na conta que fica com tudo',
  'To finish, sign in to your other FloFi account (for example the one with your boarding pass).':
    'Para concluir, entre na sua outra conta FloFi (por exemplo, a que tem o seu cartão de embarque).',
  'This is the account you are closing': 'Esta é a conta que você está fechando',
  'Sign in to your other FloFi account, the one that keeps everything, to finish.': 'Para concluir, entre na sua outra conta FloFi, a que fica com tudo.',
  'Sign in to the other account': 'Entrar na outra conta',
  'Close the duplicate account?': 'Fechar a conta duplicada?',
  'Keep: this account, which signs in with:': 'Manter: esta conta, que entra com:',
  'This account': 'Esta conta',
  'Close: the duplicate account that signs in with:': 'Fechar: a conta duplicada que entra com:',
  'The duplicate account': 'A conta duplicada',
  'The duplicate holds nothing (no wallet, boarding pass, beta access, saved recipients or history): FloFi checks it again before closing it. Nothing moves to this account. After that you can link its sign-in method here.':
    'A duplicada não guarda nada (nenhuma carteira, cartão de embarque, acesso ao beta, destinatários salvos ou histórico): a FloFi confere de novo antes de fechá-la. Nada é movido para esta conta. Depois disso você pode vincular o método de login dela aqui.',
  'I understand the duplicate account will be closed for good.': 'Entendo que a conta duplicada será fechada de vez.',
  'Closing…': 'Fechando…', 'Close it and continue': 'Fechar e continuar',
  'The duplicate account is closed.': 'A conta duplicada foi fechada.',
  'Now link {0} to this account so it opens it.': 'Agora vincule {0} a esta conta para que ele a abra.',
  'This account signs in with': 'Esta conta entra com',
  'Add a sign-in method': 'Adicionar um método de login',
  'For your security, confirm it’s you before adding a sign-in method.': 'Por segurança, confirme que é você antes de adicionar um método de login.',
  'Adding sign-in methods is not available here yet.': 'Adicionar métodos de login ainda não está disponível aqui.',
  'Link Google': 'Vincular Google', 'Link an email': 'Vincular um e-mail', 'Link this email': 'Vincular este e-mail',
  'Linking an email is not available on this deployment yet.': 'Vincular um e-mail ainda não está disponível nesta implantação.',
  'A sign-in method that already opens another FloFi account cannot be added here. If that account is an empty duplicate, sign in with that method and choose to bring it to your main account.':
    'Um método de login que já abre outra conta FloFi não pode ser adicionado aqui. Se essa conta for uma duplicada vazia, entre com esse método e escolha trazê-lo para a sua conta principal.',
  'Is this a duplicate account?': 'Esta é uma conta duplicada?',
  'If you already have another FloFi account (for example the one with your boarding pass), you can close this empty one and bring its sign-in method there. You will sign in to the other account to confirm.':
    'Se você já tem outra conta FloFi (por exemplo, a que tem o seu cartão de embarque), pode fechar esta, que está vazia, e levar o método de login dela para lá. Você vai entrar na outra conta para confirmar.',
  'Bring this sign-in to my other account': 'Levar este login para minha outra conta',
  'This account holds something of its own (a wallet, a boarding pass, saved recipients or history), so it is not a duplicate FloFi can close.':
    'Esta conta guarda algo próprio (uma carteira, um cartão de embarque, destinatários salvos ou histórico), então não é uma duplicada que a FloFi possa fechar.',
  'Sign in again with a method of the account you are using. Nothing else changes.': 'Entre de novo com um método da conta que você está usando. Nada mais muda.',
  'Use the method of your other FloFi account (for example the one with your boarding pass). Not this one, which is closing: {0}.':
    'Use o método da sua outra conta FloFi (por exemplo, a que tem o seu cartão de embarque). Não este, que está sendo fechado: {0}.',
  'This email already belongs to a FloFi account.': 'Este e-mail já pertence a uma conta FloFi.',
  'That account signs in with: {0}. You can bring this sign-in to it (you will sign in to it once to confirm), create a separate account, or use another method.':
    'Essa conta entra com: {0}. Você pode trazer este login para ela (vai entrar nela uma vez para confirmar), criar uma conta separada ou usar outro método.',
  'Add this sign-in to that account': 'Adicionar este login àquela conta', 'Use another sign-in method': 'Usar outro método de login',
  'Create a separate account': 'Criar uma conta separada',
  'Email code': 'Código por e-mail', 'Web3 wallet': 'Carteira Web3',
  // Account messages
  'This sign-in method was never confirmed for your FloFi account, so it cannot open it. Sign in with a method you used before, then link this one in Sign-in methods.':
    'Este método de login nunca foi confirmado para a sua conta FloFi, então não pode abri-la. Entre com um método que você já usou e depois vincule este em Métodos de login.',
  'That sign-in belongs to a different FloFi account. You are still signed in to your account; confirm it with one of its own methods.':
    'Esse login pertence a outra conta FloFi. Você continua conectado à sua conta; confirme com um dos métodos dela.',
  'That link was not started from FloFi, or it took too long. Nothing was added. Start again.': 'Esse vínculo não foi iniciado pela FloFi ou demorou demais. Nada foi adicionado. Comece de novo.',
  'FloFi could not link that sign-in method. Nothing changed. Try again.': 'A FloFi não conseguiu vincular esse método de login. Nada mudou. Tente de novo.',
  'That sign-in method already opens another FloFi account. Nothing was linked, merged or moved.': 'Esse método de login já abre outra conta FloFi. Nada foi vinculado, unido ou movido.',
  'This account already has a sign-in method of that type.': 'Esta conta já tem um método de login desse tipo.',
  'This sign-in is being moved to another FloFi account. Try again in a few minutes.': 'Este login está sendo levado para outra conta FloFi. Tente de novo em alguns minutos.',
  'Moving this sign-in took too long, so nothing changed. Start again from the account you want to close.':
    'Levar este login demorou demais, então nada mudou. Comece de novo pela conta que você quer fechar.',
  'That move was already completed.': 'Essa mudança já foi concluída.',
  'That sign-in does not open a FloFi account yet. Sign in with a method of the account that keeps everything.':
    'Esse login ainda não abre uma conta FloFi. Entre com um método da conta que fica com tudo.',
  'You signed in to the account you are closing. Sign in to the other FloFi account, the one that keeps everything.':
    'Você entrou na conta que está fechando. Entre na outra conta FloFi, a que fica com tudo.',
  'FloFi could not confirm this move, so nothing changed. Start again.': 'A FloFi não conseguiu confirmar esta mudança, então nada mudou. Comece de novo.',
  'That sign-in also belongs to another FloFi account, so FloFi did not close anything.': 'Esse login também pertence a outra conta FloFi, então a FloFi não fechou nada.',
  'The wallet provider did not answer, so the move is not finished. Nothing was lost. Try again.': 'O provedor de carteiras não respondeu, então a mudança não terminou. Nada foi perdido. Tente de novo.',
  'This account has a wallet at the wallet provider, so FloFi will not close it: its funds would become unreachable. Keep using the sign-in method of your other account.':
    'Esta conta tem uma carteira no provedor de carteiras, então a FloFi não vai fechá-la: os fundos ficariam inacessíveis. Continue usando o método de login da sua outra conta.',
  'This account signs in with a wallet, so FloFi will not close it: the wallet and its history stay with it.':
    'Esta conta entra com uma carteira, então a FloFi não vai fechá-la: a carteira e o histórico dela continuam com ela.',
  'This account uses a second factor at the wallet provider, so FloFi will not close it.': 'Esta conta usa um segundo fator no provedor de carteiras, então a FloFi não vai fechá-la.',
  'This account has a sign-in method FloFi cannot move, so nothing was closed.': 'Esta conta tem um método de login que a FloFi não consegue mover, então nada foi fechado.',
  'The wallet provider sent an answer FloFi could not read. Nothing was closed.': 'O provedor de carteiras enviou uma resposta que a FloFi não conseguiu ler. Nada foi fechado.',
  'FloFi could not complete that. Nothing was closed or moved. Try again.': 'A FloFi não conseguiu concluir isso. Nada foi fechado ou movido. Tente de novo.',
  'This account holds something of its own (a wallet, a boarding pass, saved recipients or history), so FloFi will not close it. Nothing was moved.':
    'Esta conta guarda algo próprio (uma carteira, um cartão de embarque, destinatários salvos ou histórico), então a FloFi não vai fechá-la. Nada foi movido.',
};
