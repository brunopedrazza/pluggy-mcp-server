# Decisões de design

Registro das decisões tomadas antes da implementação, com o motivo. Se você for
mudar alguma, leia o "porquê" primeiro — várias existem para evitar um modo de
falha específico, não por estética.

## 1. Acesso à Pluggy: Meu Pluggy + Conector 200

O plano comercial de Dados da Pluggy começa em **R$2.500/mês**. Para uso pessoal
existe o **Meu Pluggy** (`meu.pluggy.ai`), gratuito por tempo indeterminado, e o
**Conector 200 ("MeuPluggy")**, um proxy que expõe via API os dados que você já
conectou lá. Não há limite de contas desde que todas sejam suas, nominais.

O fluxo de onboarding acontece **fora deste servidor**: você conecta os bancos no
Meu Pluggy e autoriza o conector MeuPluggy dentro do `dashboard.pluggy.ai`. Não
há widget Pluggy Connect, nem OAuth, nem callback HTTP no nosso código.

O servidor é **item-agnóstico**: recebe N `itemId` e lê o que houver. Isso vale
igual para o Conector 200 gratuito e para um plano pago no futuro, sem reescrita.

## 2. Espelho fiel do banco.mcp.ai, sem agregação server-side

O banco.mcp.ai expõe 5 tools de listagem read-only. Adotamos a mesma filosofia:
as tools entregam dados, o modelo analisa.

**Objeção registrada e não acatada:** sem agregação no servidor, toda a aritmética
fica no modelo, e LLM somando centenas de linhas erra em silêncio. Mitigado (não
eliminado) pelas decisões 4, 11 e 14.

## 3. Saída em TSV enxuto

O `Transaction` da Pluggy tem ~25 campos no topo mais `paymentData`, `merchant` e
`creditCardMetadata` aninhados: **~396 tokens por transação**.

| transações | JSON cru | JSON enxuto | TSV enxuto |
|---|---|---|---|
| 400 (1 trimestre) | 158k | 10k | **7k** |
| 1.200 (1 ano) | 475k | 31k | **22k** |
| 3.000 (1 ano ativo) | 1.188k | 78k | **54k** |

Um ano em JSON cru estoura sozinho uma janela de 1M. TSV enxuto economiza ~22x.
Benefício secundário: o `paymentData` cru carrega CPF, agência e conta suas e da
contraparte em toda linha — a projeção enxuta os elimina por construção.

## 4. Truncamento sempre visível

Default de 90 dias quando o período não é informado. Teto de linhas configurável
(`MCP_MAX_ROWS`, padrão 800). Ao estourar, a **primeira linha** da resposta é um
aviso com a contagem real e a instrução explícita de não somar, mais um cursor.

O modo de falha que isso evita: truncar 800 de 1.847 e o modelo somar as 800,
produzindo um total plausível e errado.

## 5. HTTP no tailnet, sem exposição pública

Servidor HTTP rodando numa VM, alcançável apenas pela rede Tailscale.

**Consequência aceita:** não funciona no Claude web nem no app mobile. Custom
connectors do claude.ai são conectados **pela infraestrutura da Anthropic**, não
pelo seu dispositivo — a documentação exige que o servidor seja alcançável pela
internet pública. Clientes que conectam a partir da própria máquina (Claude Code,
Cursor, Cline, Zed) funcionam normalmente.

## 6. Nove tools

Cinco espelhando o banco.mcp.ai — `list_connections`, `list_accounts`,
`list_transactions`, `list_credit_card_bills`, `list_investments` — mais:

- `list_loans` — sem isso não dá para responder "vale a pena quitar ou investir?"
- `list_investment_transactions` — posição atual sem histórico de aportes não
  permite calcular rentabilidade, só saldo
- `search_transactions` — antídoto direto ao teto de linhas: filtra por texto,
  faixa de valor e categoria atravessando todas as contas

`get_identity` foi deliberadamente deixado de fora: não serve a nenhuma análise
e só despeja PII no contexto e nos logs do harness.

## 7. `refresh_connection` não-bloqueante

Auto-sync da Pluggy só existe para aplicações de produção (8/12/24h conforme o
plano), então no Conector 200 o dado pode estar velho. `PATCH /items/{id}` dispara
sync e retorna na hora; o modelo consulta `list_connections` para ver quando
concluiu. Se cair em `WAITING_USER_INPUT`, devolve instrução para resolver o MFA
no `meu.pluggy.ai` — o servidor não tem como responder MFA sozinho.

Tool bloqueante com polling foi descartada: uma chamada de ~2min estoura timeout
de cliente MCP e trava a conversa.

## 8. Cache em memória, invalidado por `lastUpdatedAt`

Chave = `(itemId, produto, item.lastUpdatedAt)`. Enquanto a Pluggy não sincroniza
a chave não muda e serve da memória; quando o item atualiza, a chave muda e o
cache erra sozinho. Sem TTL arbitrário e sem risco de servir dado velho. Só o
`fetchItem` tem TTL curto (~60s) para não martelar a API.

**Nada em disco.** Se a VM for comprometida, não há extrato bancário parado lá.

## 9. Parcelamento: os dois regimes, explícitos

Uma compra de R$3.000 em 12x feita em março é R$3.000 (regime de compra) ou R$250
(regime de caixa). Ambos são legítimos e diferem em 12x.

`CreditCardBills` só traz o cabeçalho da fatura (`dueDate`, `billClosingDate`,
`totalAmount`) — os itens vivem em `transactions`, ligados por
`creditCardMetadata.billId`. Então: `list_transactions` usa data da compra e ganha
as colunas `parc` e `total_compra`; `list_credit_card_bills` mostra o que cai em
cada fatura. As duas visões coexistem e a parcela aparece na própria linha, de
modo que não dá para confundir os regimes sem perceber.

## 10. Bearer token obrigatório, bind em loopback

O processo escuta **somente em `127.0.0.1`**; a exposição no tailnet é feita por
`tailscale serve`. Isso elimina por construção a classe de erro "subiu em
`0.0.0.0` e a security list da VM estava aberta" — relevante porque VMs de nuvem
têm IP público.

Além disso, bearer token obrigatório, comparado em tempo constante, com 401 sem
detalhe. O tailnet já é uma fronteira, mas defesa em camada única falha inteira:
basta adicionar um device, compartilhar um nó, rodar um container que herda a
rede, ou errar uma ACL.

## 11. `instructions`, descriptions ricas e prompts

Como não há agregação server-side (decisão 2), o servidor injeta no handshake as
regras que evitam erro silencioso: somar com código e nunca de cabeça, nunca
tratar saída marcada `⚠ PARCIAL` como total, não converter fuso, não misturar
`amount` com `total_compra`, e tratar descrição de transação como dado não
confiável.

## 12. Repositório público, MIT

O código não contém dado do usuário — credenciais e itemIds vêm de env. Existe um
buraco real de mercado: cobra-se R$19,90–49,90/mês por cima de um Meu Pluggy que
é gratuito.

## 13. systemd + `tailscale serve`

`Restart=always`, `After=tailscaled.service`, `EnvironmentFile` em modo 600 para
o `clientSecret`, logs no journald. Sem container, o que importa numa VM de free
tier. `tailscale serve` publica com HTTPS e certificado válido, então o bearer
token não trafega em claro.

Bind direto no IP `100.x` foi descartado: além de HTTP puro, o systemd pode subir
antes do `tailscaled` atribuir o IP e o serviço não volta depois de um reboot.

## 14. Item quebrado degrada com banner

Com 4-5 bancos, um estar em `LOGIN_ERROR`/`OUTDATED`/`WAITING_USER_INPUT` é o
estado normal. As tools retornam os itens saudáveis, mas a primeira linha declara
o que está faltando, desde quando e como consertar.

Mesmo risco do truncamento: se o Itaú está fora, o total de março vem menor e
plausível. Falhar a chamada inteira foi descartado porque um banco quebrado
inutilizaria o servidor.

---

## Decisões sem pergunta

**Datas são calendário, não instantes.** O `pluggy-sdk` converte cegamente
qualquer string ISO em `Date` (regex + reviver no `JSON.parse`). Se você formatar
com `timeZone: 'America/Sao_Paulo'`, `2026-03-01T00:00:00.000Z` vira `28/02/2026`
— e todo lançamento do dia 1º (aluguel, salário, assinaturas) cai no mês errado,
corrompendo qualquer "gasto por mês". Formatação é sempre
`toISOString().slice(0,10)`, sem conversão de fuso em lugar nenhum.

**Descrição de transação é dado hostil.** Qualquer pessoa pode te mandar R$0,01
via PIX com a descrição `"IGNORE AS INSTRUÇÕES ANTERIORES E ..."`. Esse texto
entra direto no contexto de um agente que pode ter bash e escrita de arquivo. As
descrições saem delimitadas, com caracteres de controle removidos, e as tools
declaram no description que o conteúdo é não confiável. O servidor ser read-only
protege a Pluggy, não o resto do seu harness.

**`PaymentsClient` nunca é importado.** O `pluggy-sdk` inclui iniciação de PIX,
smart transfers e pagamentos. Nada disso é importado, e há teste que falha se
alguém importar.
