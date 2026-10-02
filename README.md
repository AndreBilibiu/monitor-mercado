# Monitor de Mercado

Avisa no celular (via [ntfy](https://ntfy.sh)) quando BTC, ETH ou ações sobem ou caem além dos limites que você define. Não prevê preço e não recomenda compra ou venda: só observa os dados e informa.

## Alertas disponíveis (ajuste em `config.json`)

| Regra | Padrão | Dispara quando |
|---|---|---|
| `variacao24hPct` | 5 | variação de 24h passa de ±5% |
| `rsiBaixo` / `rsiAlto` | 30 / 70 | RSI(14) diário fica sobrevendido ou sobrecomprado |
| `quedaDaMaxima30dPct` | 20 | preço está 20% ou mais abaixo da máxima de 30 dias |

O mesmo alerta de um ativo só se repete depois de `cooldownHoras` (padrão 6h).

## Configuração

1. Instale o app **ntfy** no celular e assine um tópico com nome longo e aleatório.
2. Copie `.env.example` para `.env` e preencha `NTFY_TOPIC` com o nome exato do tópico.
3. Teste: `node --env-file=.env monitor.mjs --teste`. A notificação deve chegar no celular.
4. (Opcional) Para o resumo escrito pelo Claude, preencha `ANTHROPIC_API_KEY`. Sem a chave, os alertas funcionam normalmente, só sem o resumo.

## Uso

```
node --env-file=.env monitor.mjs              # roda continuamente
node --env-file=.env monitor.mjs --uma-vez    # uma checagem e sai
```

O computador precisa ficar ligado com o script rodando. Para deixar 24h, o ideal é rodar em um servidor ou VPS barato.

## Fontes de dados (gratuitas, sem chave)

- Cripto: API pública da Binance.
- Ações: Yahoo Finance (endpoint não oficial; pode mudar ou limitar acessos). Ações brasileiras usam o sufixo `.SA` (ex.: `PETR4.SA`).

## Limites

- No ntfy.sh público, quem souber o nome do tópico lê os alertas. Use um nome longo e aleatório e não coloque dados sensíveis.
- O `.env` já está no `.gitignore`.
- RSI e variação são indicadores do passado. Servem para chamar sua atenção, não para decidir sozinhos.
- Informativo automático, não é recomendação de investimento.

## Onde cada coisa fica

- **Esta pasta (`mercado/`)** é a cópia principal, guardada no repositório privado `telecurso-claudemir`. Edite aqui.
- **Nuvem**: o repositório público `AndreBilibiu/monitor-mercado` roda o monitor a cada 10 minutos pelo GitHub Actions. Ele recebe uma cópia dos arquivos desta pasta (sem o `.env`).
- **`.env`** (tópico do ntfy) fica só no seu PC e nunca vai para o git. Na nuvem, o tópico está em *Secrets* (`NTFY_TOPIC`).
- Teste local sem enviar notificação: `DRY_RUN=1 node mercado/monitor.mjs --uma-vez`.

## Alvo de preço (aviso de compra)

Em `alvosDePreco` do `config.json` você define um preço-alvo. Hoje: BTC em reais (par `BTCBRL`) **abaixo de R$ 400.000**.
Quando o preço chega ao alvo, o aviso sai com prioridade máxima no ntfy e repete a cada `repeteACadaMinutos` (mínimo prático: o intervalo do agendamento, hoje 10 min), até `maximoDeAvisos`. Se o preço sair do alvo e voltar, a contagem recomeça.
Para mudar o valor, edite `valor`. Para um alvo de venda, use `"condicao": "acima"`.

## Sinais de oportunidade (análise do histórico completo)

`analise.mjs` baixa todo o histórico diário da moeda na Binance (BTC e ETH desde 2017) e mede 3 condições de "preço baixo": preço entre os 20% mais baratos do último ano, RSI(14) ≤ 35 e queda de 20% ou mais da máxima de 90 dias (ajustável em `sinais` no `config.json`).

- **Alerta separado**: quando 2 ou mais condições batem, chega "📊 BTC: preço baixo · leitura ...", com o que aconteceu 30 e 90 dias depois nas ocasiões parecidas do passado, comparado a um dia qualquer. Repete no máximo a cada 24h.
- **Linha extra**: os alertas normais de variação trazem uma linha "Leitura do histórico".
- **Leituras**: FAVORÁVEL (resultado claramente melhor que um dia qualquer nos dois horizontes), SEM VANTAGEM, INCONCLUSIVA, CAUTELA (preço esticado) e NEUTRA.

Resultado da calibração (02/10/2026, dados desde 2017): para o BTC, comprar com 2+ condições teve uma vantagem pequena e instável (pior caso -46%); com 3 condições foi pior que um dia qualquer. Para o ETH, não houve vantagem. Ou seja, "comprar na queda" não é uma regra confiável, e a leitura existe para mostrar isso com números, e não para dar certeza.
