/**
 * Saved analyses.
 *
 * These are the questions worth asking repeatedly, written once so they are
 * asked the same way each month and stay comparable over time. Each one names
 * the tools to use and the traps that apply, so the analysis does not depend on
 * the model rediscovering them.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'

function userPrompt(body: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }] }
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'analise_mensal',
    {
      title: 'Análise mensal',
      description: 'Revisão completa de um mês: entradas, saídas, categorias e comparação com o mês anterior.',
      argsSchema: z.object({
        period: z.string().describe('Mês a analisar, no formato YYYY-MM (por exemplo 2026-07).'),
      }),
    },
    ({ period }) =>
      userPrompt(
        `Faça uma análise financeira do mês ${period}.

1. Comece por list_connections e confirme que todos os bancos estão UPDATED. Se algum não estiver, diga isso antes de qualquer número.
2. Busque as transações de ${period} e do mês anterior.
3. Escrevendo código sobre as linhas retornadas (nunca somando de cabeça), calcule:
   - total que entrou e total que saiu, excluindo Credit card payment e Same person transfer para não contar o mesmo dinheiro duas vezes;
   - gasto por categoria, ordenado do maior para o menor;
   - as 10 maiores saídas individuais;
   - variação percentual por categoria contra o mês anterior.
4. Aponte o que mudou de forma relevante e o que parece fora do padrão. Seja específico e evite conselho genérico.

Apresente valores em reais com duas casas. Se algum resultado vier marcado PARCIAL ou INCOMPLETO, diga isso explicitamente em vez de apresentar o total como definitivo.`,
      ),
  )

  server.registerPrompt(
    'revisao_assinaturas',
    {
      title: 'Revisão de assinaturas',
      description: 'Encontra cobranças recorrentes, incluindo as esquecidas e as que subiram de preço.',
      argsSchema: z.object({
        months: z.string().optional().describe('Quantos meses considerar. Padrão: 6.'),
      }),
    },
    ({ months }) =>
      userPrompt(
        `Encontre todas as cobranças recorrentes dos últimos ${months ?? '6'} meses.

Busque as transações do período e, escrevendo código, agrupe por descrição normalizada. Considere recorrente o que aparece em pelo menos 3 meses distintos com valor semelhante.

Para cada assinatura encontrada, mostre: descrição, valor atual, periodicidade aparente, meses em que apareceu, e total já gasto no período.

Depois destaque em separado:
- assinaturas cujo valor aumentou ao longo do período, com o percentual;
- assinaturas que pararam de aparecer nos últimos 2 meses (podem ter sido canceladas ou o cartão pode ter falhado);
- duplicidades aparentes, como dois serviços de streaming muito parecidos.

Ignore parcelamentos: linhas com a coluna parc preenchida são uma compra única dividida, não uma assinatura.`,
      ),
  )

  server.registerPrompt(
    'saude_financeira',
    {
      title: 'Saúde financeira',
      description: 'Visão consolidada de patrimônio, dívidas, uso de crédito e taxa de poupança.',
      argsSchema: z.object({}),
    },
    () =>
      userPrompt(
        `Monte um retrato da minha situação financeira atual.

Use list_connections, list_accounts, list_investments, list_loans e as transações dos últimos 6 meses.

Calcule, sempre por código:
- patrimônio: saldo em contas mais investimentos, menos dívida de cartão e empréstimos;
- uso do limite de crédito por cartão, em percentual;
- entrada e saída médias mensais dos últimos 6 meses, excluindo Credit card payment e Same person transfer;
- taxa de poupança, ou seja, quanto sobra por mês em relação ao que entra;
- concentração da carteira por tipo de investimento.

Se houver empréstimo, compare o CET dele com a rentabilidade dos investimentos e diga objetivamente se faz mais sentido quitar ou seguir investindo.

Seja direto sobre o que está bem e o que está mal. Se algum dado estiver faltando ou desatualizado, diga qual e como isso afeta a conclusão, em vez de preencher a lacuna com suposição.`,
      ),
  )
}
