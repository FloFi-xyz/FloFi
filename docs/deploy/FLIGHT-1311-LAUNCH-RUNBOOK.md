# Runbook · E-mails Flight FloFi · sexta 13/11/2026, 09:00 BRT

Operações deste PR (#189). **Nenhuma foi executada em produção** pelo PR ou pela sessão que o preparou. O calendário
(`FLOFI_FLIGHT_BOARDING_OPENS_AT`), o Neon e o Resend são do operador.

Todos os comandos rodam da raiz do repositório **no commit que foi deployado**, com Node 24.21.0, `DATABASE_URL` de produção no ambiente
(nunca na linha de comando) e `umask 077`. Guarde cada saída JSON em `/secure/` (arquivo privado; a saída mascara endereços).

## Pré-condições (todas obrigatórias)

1. O PR foi revisado e mergeado pelo owner; Vercel **e** o worker do Railway rodam o commit do merge (Railway → serviço worker →
   Deployments: o SHA ativo é o do merge). Um worker antigo não envia linha v3: ele a segura como `RENDER_FAILED`, sem chamar o Resend.
2. Envio de campanha pausado durante as operações (passo 1). Os e-mails de acesso pedidos pelas pessoas continuam saindo.

## Passos

```bash
umask 077; A="node apps/reference-dapp/backend/flight-admin.ts"; T="--tenant default"
```

0. Fotografia antes:

```bash
$A email-status $T > /secure/1311-00-status-antes.json
```

1. Pausar a campanha:

```bash
$A email-pause $T --reason "1311 launch upgrade"
```

2. Dry-run da migração dos pendentes (Email 3 v2 → v3 + PT; 4a/4b/5/6 em inglês → PT). Nada muda:

```bash
$A email-launch-upgrade $T > /secure/1311-02-upgrade-dryrun.json
```

   Confira: `campaignPaused: true`; `codeVersions.GROUP_BOARDING = 3`; `eligible` = 48 Email 3 + 1 CARD_FOUNDING (+ qualquer 5 em inglês
   pendente); `planned` lista cada `emailId` com versão/idioma de/para; `skipped` traz o que já passou do ponto (tentado, reservado,
   SENDING/UNKNOWN/SENT/HELD) e não será tocado; `guestOnWaitlist` mostra a sobreposição (passo 5). Se algo não bater, pare.

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

   Confira `eligible: 9` e `invites` por situação (`MISSING`, `EMAIL6_SENT`, `EMAIL6_QUEUED`, `REVOKED`, `SUPPRESSED`...). Se houver
   `EMAIL6_QUEUED` de uma versão antiga (v1–v4 em `TEMPLATE_VERSION_REVIEW`), esse código é tratado por `creator-supersede-templates`
   (dry-run primeiro; o apply cria a v5 PENDING, que sai na retomada). Depois:

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

   Se `groupBoardingEmailId` vier `null`, o Email 3 dela ainda não existe: nada a fazer agora. Confira de novo depois do passo 7.

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
