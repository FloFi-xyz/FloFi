# Runbook · E-mails Flight FloFi · sexta 13/11/2026, 09:00 BRT

Operações deste PR (#189). **Nenhuma foi executada em produção** pelo PR ou pela sessão que o preparou. O calendário
(`FLOFI_FLIGHT_BOARDING_OPENS_AT`), o Neon e o Resend são do operador.

Todos os comandos rodam da raiz do repositório **no commit que foi deployado**, com Node 24.21.0, `DATABASE_URL` de produção no ambiente
(nunca na linha de comando) e `umask 077`. Guarde cada saída JSON em `/secure/` (arquivo privado; a saída mascara endereços).

## Pré-condições (todas obrigatórias)

1. O PR foi revisado e mergeado pelo owner, e tanto a Vercel quanto o worker do Railway rodam o commit do merge (confira em Railway →
   serviço worker → Deployments: o SHA ativo é o do merge). O banco não enxerga o commit do worker, por isso o apply pede a confirmação.
   Se um worker antigo pegar uma linha v3, ele a segura como `RENDER_FAILED` sem chamar o Resend. Mas o token de acesso daquela linha
   passa a contar as 72 h a partir dessa tentativa. Recuperação, depois do deploy certo: `$A email-release $T --reason RENDER_FAILED`.
2. Envio de campanha pausado durante as operações (passo 1). Os e-mails de acesso pedidos pelas pessoas continuam saindo.

## Passos

```bash
umask 077; A="node apps/reference-dapp/backend/flight-admin.ts"; T="--tenant default"
```

0. Fotografia antes:

```bash
$A email-status $T > /secure/1311-00-status-antes.json
```

1. Pausar a campanha. Em seguida, espere 1 minuto e confira que nenhum e-mail de campanha está em `SENDING`
   (o ciclo do worker roda a cada 15 s, e o lease relê a pausa sob o lock):

```bash
$A email-pause $T --reason "1311 launch upgrade"
```

```bash
$A email-status $T > /secure/1311-01-status-pausado.json
```

2. Dry-run da migração dos pendentes (Email 3 v2 → v3 + PT; 4a/4b/5/6 em inglês → PT). Nada muda:

```bash
$A email-launch-upgrade $T > /secure/1311-02-upgrade-dryrun.json
```

   Confira:
   - `campaignPaused: true` e `codeVersions.GROUP_BOARDING = 3`.
   - `eligible` = 48 Email 3 + 1 CARD_FOUNDING, mais qualquer Email 5 pendente em inglês.
   - `planned` lista cada `emailId` com versão e idioma de/para.
   - `skipped` traz o que já passou do ponto e não será tocado: tentado, reservado, SENDING/UNKNOWN/SENT/HELD.
   - `guestOnWaitlist` mostra a sobreposição (passo 5).

   Se algo não bater, pare. Dois casos conhecidos:
   - **`releasedPendingIds` não vazio** (motivo `RELEASED_OR_RETRIED`): são linhas que já foram liberadas ou retentadas. Uma liberação de
     `UNRESOLVED_OUTCOME` apaga as tentativas, então essas linhas podem ter chegado ao Resend. Procure cada id no log do Resend (chave de
     idempotência). Só se nenhum foi enviado, rode o apply com `--include-released`.
   - **Email 3 `HELD` nunca tentado** (por exemplo `QUOTA_DAILY`, motivo `NOT_PENDING`): fica em v2. Esta operação só altera PENDING.
     Decida com o owner: cancelar por id ou aceitar o texto antigo.

3. Aplicar (só com a campanha pausada e o worker no commit novo; recusa sem os dois):

```bash
$A email-launch-upgrade $T --apply --confirm-worker-deployed > /secure/1311-03-upgrade-apply.json
```

   `updated` deve ser igual ao `eligible` do passo 2; `updatedIds` é a trilha de auditoria; `before`/`after` são as contagens.
   Rodar de novo é seguro (idempotente): o dry-run seguinte precisa dar `eligible: 0`.

```bash
$A email-launch-upgrade $T > /secure/1311-03b-upgrade-verifica.json
```

4. Email 6 para os 9 convites CREATOR ativos sem Email 6 (reusa os códigos; não cria convite; entra **HELD**, lote `creators-v5`):

```bash
$A creator-requeue-missing $T > /secure/1311-04-email6-dryrun.json
```

   Confira:
   - `eligible: 9`.
   - `invites` por situação: `MISSING`, `EMAIL6_SENT`, `EMAIL6_QUEUED`, `REVOKED`, `EXPIRED`, `SUPPRESSED`, `EMAIL6_STOPPED` e
     `EMAIL6_OPERATOR_CANCELLED`.
   - `EMAIL6_STOPPED` (falha no provedor, descadastro, sem consentimento) nunca é reenfileirado.
   - Se os 9 aparecerem como `EMAIL6_OPERATOR_CANCELLED` (por exemplo, cancelados com `email-cancel` no adiamento), acrescente
     `--include-operator-cancelled` ao dry-run e ao apply.
   - Se houver `EMAIL6_QUEUED` de versão antiga (v1–v4 em `TEMPLATE_VERSION_REVIEW`), use `creator-supersede-templates` (dry-run
     primeiro). Atenção: o apply dele cria a v5 PENDING, que sai na retomada.
   - Um convidado que resgatar o código antes da liberação tem o Email 6 cancelado (`INVITE_REDEEMED`).

   Depois:

```bash
$A creator-requeue-missing $T --apply > /secure/1311-04b-email6-apply.json
```

5. Convidado também na lista de espera (`guestOnWaitlist` do passo 2). Consequência: recebe o Email 6 (convite) **e** o Email 3 (grupo),
   com dois caminhos de acesso válidos: código de convite, ou link/código do Email 3. Nenhum bloqueia o outro, e quando a pessoa embarca
   (primeiro cartão) o Email 3 ainda não enviado é cancelado sozinho (`BOARDED`). Solução recomendada, sem tirar o acesso: cancelar só o
   Email 3 dessa pessoa antes da retomada. A entrada na lista e o convite continuam válidos, e ela ainda pode pedir um link em
   flofi.xyz/board.

```bash
$A email-cancel $T --email-id <groupBoardingEmailId do passo 2>
```

   Se `groupBoardingEmailId` vier `null`, o Email 3 dela ainda não existe. A partir das 09:00, mesmo com a campanha pausada, o worker
   agenda o Email 3 dos grupos abertos. Por isso, **logo antes do passo 7** (já depois das 09:00), rode de novo o dry-run do passo 2 e
   cancele o `groupBoardingEmailId` que aparecer.

6. Testes da Dayane (procedimento do time, antes das 09:00). Conferir quota real no painel do Resend: a campanha de hoje gasta cerca de
   48 + 9 + 1 = 58 envios do limite diário (100, dos quais 5 ficam para e-mails de acesso).

7. Às 09:00, liberar o Email 6 e retomar a campanha:

```bash
$A email-release $T --batch creators-v5
```

```bash
$A email-resume $T
```

   O worker envia o lote em ~30 s (2/s). A ordem dentro do ciclo segue a fila (`next_attempt_at`): o Email 3 já estava na fila e pode
   sair alguns segundos antes do Email 6.

8. Depois:

```bash
$A email-status $T > /secure/1311-08-status-depois.json
```

```bash
$A email-attention $T > /secure/1311-08b-atencao.json
```

   Reenvio só do que falhou, com `email-release` por `--email-id` ou `--reason`.
   Nunca libere `UNRESOLVED_OUTCOME` sem conferir o log do Resend.

## Rollback

- Antes do passo 7: `email-pause` continua valendo; para não enviar o Email 6, use `email-cancel $T --batch creators-v5`.
- A migração do passo 3 não tem volta automática, e não precisa: as linhas v3/PT são enviadas só pelo código novo. Para não enviar o
  Email 3, use `email-cancel $T --template GROUP_BOARDING` (só pendentes; enviados nunca são tocados).
