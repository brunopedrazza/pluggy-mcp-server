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
3. Decida a visão de cartão antes de somar, e diga qual escolheu. A coluna date é a data de lançamento, não a da compra: um mês de calendário traz parcelas de compras antigas e deixa de fora as parcelas futuras das compras novas. Para a visão de compra, agrupe por data_compra quando preenchida e por date quando vazia. Para a visão de fatura, use o argumento bill de list_transactions e confira o total contra list_credit_card_bills.
4. Escrevendo código sobre as linhas retornadas (nunca somando de cabeça), calcule:
   - total que entrou e total que saiu, excluindo Credit card payment e Same person transfer para não contar o mesmo dinheiro duas vezes;
   - gasto por categoria, ordenado do maior para o menor;
   - as 10 maiores saídas individuais;
   - variação percentual por categoria contra o mês anterior.
5. Aponte o que mudou de forma relevante e o que parece fora do padrão. Seja específico e evite conselho genérico.

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
    'fatura_cartao',
    {
      title: 'Fatura do cartão',
      description: 'Analisa uma fatura fechada: reconcilia com o total do banco e separa compras novas de parcelas antigas.',
      argsSchema: z.object({
        bill: z
          .string()
          .optional()
          .describe('Vencimento da fatura (2026-08-05), ou ~2026-09 para uma ainda aberta. Padrão: a última fechada.'),
        card: z.string().optional().describe('Restringe a um cartão, pelo rótulo. Padrão: todos.'),
      }),
    },
    ({ bill, card }) =>
      userPrompt(
        `Analise a fatura ${bill ?? 'mais recente já fechada'} ${card ? `do cartão ${card}` : 'de cada cartão'}.

1. Comece por list_connections. Se algum banco não estiver UPDATED, diga isso antes de qualquer número: uma fatura pode vir incompleta sem nenhum outro sinal.
2. Use list_credit_card_bills para ver vencimento, fechamento, total, mínimo e encargos. Esse total é o número que o banco publicou, e é a referência de tudo que vem depois.
3. Traga as linhas com list_transactions usando o argumento bill, com o valor exato que aparece na coluna due. Não filtre por período: uma fatura atravessa dois meses de calendário e o período cortaria ela ao meio.
4. Reconcilie por código: some os débitos das linhas e compare com o total da fatura. Se sobrar diferença, verifique se os encargos já aparecem entre as linhas antes de somá-los, porque em alguns conectores aparecem nos dois lugares e somar duas vezes é o erro fácil aqui. Diga o tamanho da diferença que restar em vez de fechá-la inventando linhas.
5. Separe o total em duas partes, que é o ponto desta análise:
   - compras novas deste ciclo, ou seja, linhas sem parc;
   - parcelas de compras anteriores, linhas com parc preenchido, cada uma com a sua data_compra.
   Dê quanto é cada parte em reais e em percentual do total.
6. Para cada parcelamento em curso, mostre parcela atual, total de parcelas, valor da parcela e quanto ainda resta. Some o que resta para dar o piso já comprometido das próximas faturas.
7. Compare com as duas faturas anteriores do mesmo cartão e explique a variação: subiu porque houve mais compra nova, ou porque entrou parcelamento novo, ou caiu porque parcelas terminaram.
8. Aponte as maiores linhas e o que fugiu do padrão.

Valores em reais com duas casas. Linhas com valor_orig são compras em moeda estrangeira: amount já está convertido, então nunca some valor_orig nem o leia como reais. Se algum resultado vier marcado PARCIAL ou INCOMPLETO, diga isso explicitamente em vez de apresentar o total como definitivo.`,
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
