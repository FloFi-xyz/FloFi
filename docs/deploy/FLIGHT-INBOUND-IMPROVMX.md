# Flight: receber hello@flofi.xyz no Gmail

Estado em 10/11/2026: **preparado, não ativado**. Nenhuma conta foi criada, nenhum DNS foi alterado e nenhum e-mail foi enviado por este build.
O encaminhamento só estará comprovado quando uma mensagem externa chegar a `flofi.xyz@gmail.com`.

## Observação pública antes da configuração

Consulta DNS de 10/11/2026, sem credenciais:

| Nome | Tipo | Resposta observada |
| --- | --- | --- |
| flofi.xyz | NS | ns1.vercel-dns.com, ns2.vercel-dns.com |
| flofi.xyz | MX | ENODATA: nenhum MX publicado |
| flofi.xyz | TXT | ENODATA: nenhum TXT publicado |
| _dmarc.flofi.xyz | TXT | `v=DMARC1; p=none;` |
| resend._domainkey.flofi.xyz | TXT | Chave DKIM pública presente; preservar integralmente |
| send.flofi.xyz | MX | prioridade 10, feedback.forge.rmta.net |
| send.flofi.xyz | TXT | `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all` |
| flofi.xyz | A | 216.198.79.1, 216.198.79.65 |
| www.flofi.xyz | CNAME | ENODATA na consulta direta; não remover outros registros |

Essa observação não verifica o status da conta Resend nem enumera toda a zona. Repetir as consultas e exportar a zona no painel Vercel antes de aplicar mudanças.

## Procedimento do proprietário

ImprovMX Free pode receber neste domínio sem trocar nameservers: Vercel suporta MX e TXT. O plano gratuito consultado oferece um domínio,
25 aliases e 500 encaminhamentos/dia; não inclui SMTP de saída. Basta um alias. Fontes:
[ImprovMX: preços](https://improvmx.com/pricing/),
[registros oficiais](https://www.improvmx.com/guides/netlify/),
[Vercel: DNS](https://vercel.com/docs/domains/managing-dns-records).

1. O proprietário entra/cria uma conta real no ImprovMX **Free**, adiciona `flofi.xyz` e confirma o endereço de destino quando solicitado.
2. Cria somente o alias `hello` → `flofi.xyz@gmail.com`; desabilita/remove catch-all se criado por padrão. Não compra SMTP.
3. No painel Vercel, abre Domains → flofi.xyz → DNS Records. Confere que o MX raiz continua vazio. Se houver MX de outro serviço,
   interrompe a alteração e usa o encaminhamento desse serviço; não mistura provedores de recebimento no mesmo nome.
4. Adiciona os registros abaixo, conferindo-os também no painel ImprovMX da conta:

| Tipo | Nome na zona flofi.xyz | Prioridade | Valor |
| --- | --- | --- | --- |
| MX | @ (raiz; campo vazio se a UI assim exigir) | 10 | mx1.improvmx.com |
| MX | @ (raiz) | 20 | mx2.improvmx.com |
| TXT | @ (raiz) | — | `v=spf1 include:spf.improvmx.com ~all` |

Se já houver SPF raiz, **editar o único SPF existente**, incorporando o include recomendado antes do terminador; nunca criar dois TXT `v=spf1`
no mesmo nome. Validar o orçamento de dez consultas SPF. Não copiar o SPF do subdomínio `send` para a raiz.

5. Preserva todos os A/AAAA/CNAME, NS, o DKIM Resend, o MX/SPF de `send.flofi.xyz` e o DMARC existente. Não altera Railway, Resend,
   datas, quotas, filas ou variáveis da campanha. Confere a zona exportada antes/depois para garantir só as três adições previstas.
6. Executa `dig +short MX flofi.xyz`, `dig +short TXT flofi.xyz`, `dig +short TXT _dmarc.flofi.xyz`,
   `dig +short TXT resend._domainkey.flofi.xyz`, `dig +short MX send.flofi.xyz` e `dig +short TXT send.flofi.xyz`.
   Confere a verificação no ImprovMX; propagação DNS pode demorar.
7. De uma caixa externa controlada pelo proprietário, envia uma mensagem nova para `hello@flofi.xyz`, com assunto único e horário anotado.
   Confirma recebimento no Gmail destino, inclusive Spam, remetente original e cabeçalhos. Responde e confirma o retorno ao remetente externo.
8. Registra horário, Message-ID e resultado de forma privada. Só marca o checklist como ativo depois dessa confirmação. Uma tela verde
   do provedor ou um HTTP 200 não comprovam chegada ao Gmail.

O envio da campanha continua em Resend/Railway, com From `FloFi <hello@flofi.xyz>` e Reply-To `flofi.xyz@gmail.com`.
Um teste de autenticação de saída (SPF/DKIM/DMARC nos cabeçalhos de uma mensagem efetivamente recebida) permanece necessário,
usando os controles operacionais existentes e sem reenviar campanhas.

## Reversão

Se a ativação falhar, remover somente os novos MX raiz e o novo SPF raiz (ou restaurar exatamente o SPF anterior se editado).
Preservar o restante da zona. O Reply-To continua permitindo respostas diretas para o Gmail.

## Checklist de lançamento

- [x] Autoridade DNS e registros públicos consultados, sem mudanças.
- [x] Solução gratuita e registros documentados separadamente do envio Resend.
- [ ] Conta real Free e alias criados pelo proprietário.
- [ ] Destino Gmail confirmado quando solicitado.
- [ ] Zona exportada e registros aplicados com aprovação operacional.
- [ ] MX/SPF verificados; DKIM/DMARC/Resend e web preservados.
- [ ] Mensagem externa recebida no Gmail e resposta confirmada.
- [ ] Encaminhamento declarado ativo somente com essa evidência.
