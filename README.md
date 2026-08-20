# pluggy-mcp-server

MCP server **read-only** que expõe seus dados financeiros pessoais (Open Finance
Brasil, via [Pluggy](https://pluggy.ai)) para qualquer cliente MCP — Claude Code,
Cursor, Cline, Zed.

Alternativa self-hosted a serviços pagos de "banco no MCP": o
[Meu Pluggy](https://meu.pluggy.ai) é **gratuito por tempo indeterminado** para
pessoa física acessar os próprios dados via API.

**Sem movimentação de dinheiro.** Não há PIX, transferência ou pagamento. O
`PaymentsClient` do SDK da Pluggy nunca é importado, e há teste que falha se
alguém importar.

## Tools

| Tool | O que faz |
|---|---|
| `list_connections` | Conexões, status e frescor do dado por produto |
| `list_accounts` | Contas correntes, poupanças e cartões, com saldo |
| `list_transactions` | Extrato em TSV, com parcela e valor cheio da compra |
| `search_transactions` | Busca por texto, faixa de valor e categoria, entre contas |
| `list_credit_card_bills` | Faturas: vencimento, fechamento, total, pagamentos |
| `list_investments` | Posição atual da carteira |
| `list_investment_transactions` | Aportes e resgates, para calcular rentabilidade |
| `list_loans` | Empréstimos e financiamentos: saldo devedor, juros, parcelas |
| `refresh_connection` | Dispara sync na Pluggy (não bloqueante) |

## Setup

### 1. Conectar seus bancos (uma vez, ~15 min)

1. Crie conta em [meu.pluggy.ai](https://meu.pluggy.ai) e conecte seus bancos
2. Crie conta em [dashboard.pluggy.ai](https://dashboard.pluggy.ai)
3. Crie **uma** aplicação e copie `Client ID` e `Client Secret`
4. Na aplicação, escolha o conector **MeuPluggy** e autorize com seu login do Meu Pluggy
5. Copie o **Item ID** (botão "Copiar Item ID")

### 2. Verificar o que o Conector 200 entrega

```bash
cp .env.example .env   # preencha CLIENT_ID, CLIENT_SECRET e ITEM_IDS
npm install
npm run probe
```

A sonda responde se investimentos, faturas e empréstimos estão disponíveis nas
suas conexões, e valida o tratamento de datas e categorias. Ela **não** imprime
número de conta, CPF nem descrição de transação.

### 3. Rodar

```bash
npm run build
npm start
```

## Deploy (VM + Tailscale)

O processo escuta **somente em loopback**. A exposição é feita pelo Tailscale,
nunca por bind em `0.0.0.0` — VMs de nuvem têm IP público, e um bind errado
somado a uma security list aberta coloca seu extrato bancário na internet.

```bash
sudo cp deploy/pluggy-mcp.service /etc/systemd/system/
sudo install -d -m 700 /etc/pluggy-mcp
sudo install -m 600 .env /etc/pluggy-mcp/env
sudo systemctl enable --now pluggy-mcp

tailscale serve --bg --https=443 127.0.0.1:8787
```

### Conectar o cliente

```bash
claude mcp add pluggy --transport http \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN" \
  https://SUA-VM.SEU-TAILNET.ts.net/mcp
```

> Não funciona no Claude web nem no app mobile: custom connectors do claude.ai
> são conectados pela infraestrutura da Anthropic, que não alcança um tailnet
> privado. Clientes que conectam da própria máquina funcionam normalmente.

## Design

As decisões e o motivo de cada uma estão em [DESIGN.md](./DESIGN.md).

## Licença

MIT
