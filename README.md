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
