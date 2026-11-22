# FloFi Studio — fase de verificação

O Studio fica em `/developers/console`. Autentique-se com a conta FloFi e
selecione um projeto ativo. Em **Nova integração**, escolha **Rede** para
cadastrar a HyperEVM ou **Cofre ERC-4626** para informar o contrato e seu ativo
subjacente na Ethereum. **Usar configuração do Savings Dai** preenche o
exemplo verificado. A interface está disponível em português e inglês.

| Etapa | Resultado |
| --- | --- |
| Salvar rascunho | Cria uma versão imutável da configuração no projeto. |
| Verificar | Registra evidência de identidade da rede e, para cofres, dos contratos e do ativo. |
| Testar | Registra métodos RPC da carteira e estimativa de valor zero na HyperEVM, ou prévias e limites ERC-4626 na Ethereum. |
| Enviar para certificação | Coloca a versão na fila de revisão com as duas evidências obtidas nas últimas 24 horas. |
| Suspender, revogar ou criar nova versão | Retira a versão anterior da análise e desvincula suas evidências ativas. O histórico registra a alteração. |

A CLI de operações lista a fila de um tenant com
`studio-queue --tenant <id> [--limit 50]`. A consulta inclui a configuração,
o digest do manifesto, o bloco e a data das evidências e o indicador de
validade. Uma divergência confirmada de identidade invalida a evidência da
versão, inclusive se o envio para certificação ocorreu durante o teste.
Indisponibilidade transitória permite repetir a leitura.

O Studio reutiliza sessão, projetos, PostgreSQL, transporte HTTPS com IP
público fixado por requisição e o registro canônico para diagnosticar o
adaptador de transferências. O perfil de rede determina o RPC. O manifesto
aceita somente dados estruturados e fica fora do StrategySpec,
dos payloads de assinatura e da autorização financeira.

## Evidência em mainnet

Captura de 22 de novembro de 2026, às 20h58 UTC, usando o verificador da
aplicação. São consultas de leitura, sem autorização de carteira.

| Integração | Resultado |
| --- | --- |
| HyperEVM | RPC oficial `https://rpc.hyperliquid.xyz/evm`, chain ID `999`, HYPE, 18 decimais. O bloco de teste `0x31917f2` tem hash `0x731ee44faae73bb76c3c06f8b1cada4b1ef525cd0cfb665fbde8e6a1f65e3a96`. As consultas de saldo e nonce responderam e a estimativa de valor zero foi de 21.000 unidades de gás. |
| Savings Dai | Ethereum, bloco finalizado `0x193f2af`, hash `0x070800a1f91ef707d04d4106c8a1e9d3d92343eb5e70f6d8d590f9fc03852e06`. O cofre `0x83f20f44975d03b1b09e64809b757c47f942beea` retornou o ativo DAI `0x6b175474e89094c44da98b954eedeac495271d0f`. O teste leu as quatro prévias e os quatro limites no hash canônico. A prévia de depósito de 1 DAI retornou `845089118909604021` unidades mínimas de sDAI. |

O RPC oficial da HyperEVM atende consultas de estado recente. As sondagens
de carteira verificam o suporte aos métodos separadamente do bloco
registrado. O conector ERC-4626 usa a Ethereum e fixa as leituras por
hash de bloco finalizado. Os limites são do endereço de teste usado na
sondagem e podem variar por usuário e bloco.
[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)
· [JSON-RPC HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)
· [Endereços Spark](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Ethereum.sol)
· [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626)
· [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898)

## Certificação financeira e publicação

O estado atingível por envio é **Certificação pendente**. Esta fase
efetua cadastro, verificação, teste, versionamento e entrega de evidência à
fila de análise. A transferência de HYPE ainda precisa de um perfil no
adaptador canônico e da jornada de simulação, Review, assinatura explícita
e reconciliação em fork. A aceitação real exige assinatura do usuário
autorizado e reconciliação independente.

Para o cofre, a certificação inclui revisão de risco, governança e
possibilidade de upgrade, simulação e reconciliação de depósito e retirada
no motor canônico e validação dos controles de valor, saída e permissões
de token. As prévias e a leitura do código são evidências de interface.

A promoção a **Certificada** e a publicação global ou privada, com
revogação no catálogo e no momento da autorização, pertencem à etapa
financeira seguinte. O catálogo canônico continua sendo a fonte de capacidade
para Chat, Editor, API e MCP. O manifesto define os tipos de staking e CEX e
as interfaces de leitura. Conexões CEX futuras precisam isolar credenciais
por conta e tenant, limitar escopos e operar com saques desativados.

## Ativação

A ativação exige a migração aditiva `0035` e revisão do dono. Primeiro,
reúna a certificação do PR e ensaie em um banco Neon Preview dedicado.
Confira a compatibilidade de todos os consumidores antes do comando
operacional. [Certificado do schema 0035](../deploy/SCHEMA-COMPATIBILITY.md#27-certificate-0035_studio_integrations)
