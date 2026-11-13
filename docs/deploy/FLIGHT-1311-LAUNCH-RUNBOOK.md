# Runbook · Lançamento Flight FloFi · sexta 13/11/2026, 09:00 BRT

**Só o Email 3** (`GROUP_BOARDING`, v3, texto "estamos começando") sai no lançamento, para a lista de espera, em português.
**Nenhum Email 6** (`CREATOR_INVITE`, convidados) é enviado: ele foi adiado. Os convites e seus códigos continuam valendo.

Este runbook não foi executado por ninguém além do operador. O calendário (`FLOFI_FLIGHT_BOARDING_OPENS_AT`) e o lote 1 (`opens_at`)
são configurados pelo operador à parte.

Como rodar os comandos:
- Sempre da raiz do repositório, **no commit que está em produção**, com Node 24.21.0.
- `DATABASE_URL` de produção vai no ambiente, nunca na linha de comando.
- Use `umask 077` e guarde cada saída JSON em `/secure/`. A saída já mascara os endereços.

```bash
umask 077; A="node apps/reference-dapp/backend/flight-admin.ts"; T="--tenant default"
```

## Não executar neste lançamento

- `creator-requeue-missing`, `creator-supersede-templates` e `email-release --batch creators-v5` (Email 6 adiado).
- `email-release --reason …` **sem** `--template GROUP_BOARDING` durante o lançamento. Qualquer liberação por motivo pode devolver à
  fila e-mails retidos de outros templates (cartões, Email 6) com outro motivo (`RENDER_FAILED`, `QUOTA_DAILY`…). Exemplo correto:
  `$A email-release $T --reason QUOTA_DAILY --template GROUP_BOARDING`.
- `email-resume` antes do passo 5: ele libera toda a campanha pendente.

## Pré-condições

1. O PR #189 está mergeado e o deploy terminou em dois lugares:
   - **Vercel.**
   - **Worker do Railway.** Em Railway → serviço worker → Deployments, o SHA ativo tem de ser o do merge.

   O banco não enxerga o commit do worker, por isso o passo 3 pede a sua confirmação. Se um worker antigo pegar uma linha v3, ele a
   segura como `RENDER_FAILED` sem chamar o Resend. Depois do deploy certo e **antes do passo 4**, recupere só o Email 3 com
   `$A email-release $T --reason RENDER_FAILED --template GROUP_BOARDING`.
   Atenção: o link de acesso dessa linha começa a contar as 72 h na tentativa que falhou.
2. Teste do Email 3 em português para a Dayane antes das 09:00, seguindo o procedimento do time, com o OK dela.

## Passos

**0. Foto de antes:**

```bash
$A email-status $T > /secure/1311-00-status-antes.json
```

**1. Pausar a campanha.** Os e-mails de acesso pedidos pelas pessoas continuam saindo. Espere 1 minuto e confira que nenhum e-mail de
campanha está em `SENDING`:

```bash
$A email-pause $T --reason "1311 launch"
```

```bash
$A email-status $T > /secure/1311-01-status-pausado.json
```

**2. Dry-run da atualização da fila.** Os 48 Email 3 v2 vão para a v3 final + PT, no lugar. Cartões e Email 5 em inglês vão para PT.
Este passo não muda nada:

```bash
$A email-launch-upgrade $T > /secure/1311-02-upgrade-dryrun.json
```

Confira:
- `campaignPaused: true` e `codeVersions.GROUP_BOARDING = 3`.
- `eligible` = 48 `GROUP_BOARDING`, mais os cartões e Email 5 pendentes em inglês.
- `planned` lista cada `emailId` com versão e idioma de/para.
- `skipped` é o que já passou do ponto e **não** será tocado: tentado, reservado, SENDING/UNKNOWN/SENT/HELD.

Pare se algo não bater. Dois casos conhecidos:
- **`releasedPendingIds` não vazio:** linhas já liberadas ou retentadas, que podem ter chegado ao Resend. Procure cada id no log do Resend
  (é a chave de idempotência). Só se nenhum foi enviado, acrescente `--include-released` ao passo 3.
- **Email 3 `HELD` nunca tentado** (`NOT_PENDING`, por exemplo `QUOTA_DAILY`): fica em v2, porque esta operação só altera PENDING. Decida
  com o owner: cancelar por id ou aceitar o texto antigo.

**3. Aplicar a atualização.** Só funciona com a campanha pausada e com o worker no commit novo:

```bash
$A email-launch-upgrade $T --apply --confirm-worker-deployed > /secure/1311-03-upgrade-apply.json
```

`updated` deve ser igual ao `eligible` do passo 2, e `updatedIds` é a trilha de auditoria. O comando é idempotente: o dry-run seguinte tem
de dar `eligible: 0`.

```bash
$A email-launch-upgrade $T > /secure/1311-03b-upgrade-verifica.json
```

**4. Reter tudo que não for Email 3** (dry-run e depois apply). Ficam retidos os dois `CARD_FOUNDING` pendentes, qualquer Email 6 ou
Email 5 pendente e qualquer outro e-mail de campanha. Nada é cancelado: só passa a `HELD` / `OPERATOR_HOLD`. Os e-mails de acesso
(ESSENTIAL) nunca são retidos.

```bash
$A email-hold-campaign $T --keep GROUP_BOARDING > /secure/1311-04-hold-dryrun.json
```

Confira:
- `toHoldByTemplate` (por exemplo `CARD_FOUNDING: 2`) e `stillPending` (`GROUP_BOARDING: 48`, mais os e-mails de acesso).
- `unknownToHoldIds`: tentativas de resultado desconhecido de outros templates. Seriam retentadas na retomada, então o apply as retém
  como `UNRESOLVED_OUTCOME` (liberação só por id, depois de conferir o log do Resend).
- `sendingIds` tem de estar vazio. Se não estiver, o apply recusa (`FLIGHT_HOLD_CAMPAIGN_IN_FLIGHT`): espere 2 minutos e repita.

Depois:

```bash
$A email-hold-campaign $T --keep GROUP_BOARDING --apply > /secure/1311-04b-hold-apply.json
```

Os Email 6 de versão antiga (v1–v4) já ficam retidos sozinhos como `TEMPLATE_VERSION_REVIEW`. A retenção libera a reserva de cota dos
e-mails retidos. Um e-mail retido continua com a validade dele: um cartão retido além de 7 dias é cancelado como `EXPIRED`.

**5. Às 09:00.** O worker agenda o Email 3 dos grupos que abriram, já na v3 em PT, mesmo com a campanha pausada. Logo antes de retomar,
repita a retenção, que pega qualquer outro e-mail de campanha criado nesse meio-tempo:

```bash
$A email-hold-campaign $T --keep GROUP_BOARDING --apply > /secure/1311-05-hold-0900.json
```

```bash
$A email-resume $T
```

O worker envia o Email 3 (2 por segundo) dentro da cota do dia. A conta: 48 + os novos, dentro de 95 envios de campanha por dia; os
outros 5 do limite de 100 ficam para os e-mails de acesso. Confira antes a cota real no painel do Resend.

Os dois comandos acima são separados. Um e-mail automático criado entre eles (um cartão emitido nesse segundo) sai na retomada, e pode
sair antes dos dois cartões que ficaram retidos.

O convidado que também está na lista de espera recebe o Email 3 normalmente. Ele não sai da lista e o convite dele continua valendo.

**6. Depois:**

```bash
$A email-status $T > /secure/1311-06-status-depois.json
```

```bash
$A email-attention $T > /secure/1311-06b-atencao.json
```

Confira:
- `GROUP_BOARDING` em `SENT`.
- `CREATOR_INVITE` **sem** nenhum `SENT` a mais que na foto do passo 0.
- `CARD_FOUNDING` retidos em `HELD` / `OPERATOR_HOLD`.

Reenvie só o que falhou, com `email-release` por `--email-id`, ou por `--reason` sempre com `--template GROUP_BOARDING`. Nunca libere `UNRESOLVED_OUTCOME` sem conferir o log do
Resend.

## Depois do lançamento

- Os e-mails automáticos criados a partir de agora seguem o fluxo normal: cartão emitido (4a/4b) e inscrição nova (5).
- Os cartões retidos no passo 4 saem quando o time decidir:

```bash
$A email-release $T --reason OPERATOR_HOLD --template CARD_FOUNDING
```

- O Email 6 continua retido, até nova decisão.

## Rollback

- **Antes do passo 5:** a pausa continua valendo e nada de campanha sai.
- **Para não enviar o Email 3:** cancela só os pendentes; os já enviados nunca são tocados.

```bash
$A email-cancel $T --template GROUP_BOARDING
```

- **Para parar tudo de novo:**

```bash
$A email-pause $T
```
