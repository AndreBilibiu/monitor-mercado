// Análise histórica de oportunidade: compara o preço de hoje com TODO o histórico diário da moeda
// e mostra o que aconteceu nas vezes em que o cenário foi parecido. Descreve o passado; não prevê o futuro.

const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

async function binance(caminho) {
  let ultimoErro;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + caminho, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} em ${host + caminho}`);
      return await r.json();
    } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro;
}

// Todos os candles diários desde o início da moeda (a Binance entrega 1000 por chamada).
export async function historico(par) {
  const candles = [];
  let inicio = 0;
  while (true) {
    const lote = await binance(`/api/v3/klines?symbol=${par}&interval=1d&limit=1000&startTime=${inicio}`);
    candles.push(...lote);
    if (lote.length < 1000) break;
    inicio = lote.at(-1)[0] + 1;
  }
  return candles.map((c) => ({ t: c[0], alta: Number(c[2]), fech: Number(c[4]) }));
}

// ---------- Indicadores ----------

const rsiDe = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));

// RSI de Wilder para toda a série
function serieRsi(f, p = 14) {
  const r = Array(f.length).fill(null);
  if (f.length <= p) return r;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = f[i] - f[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  g /= p; l /= p;
  r[p] = rsiDe(g, l);
  for (let i = p + 1; i < f.length; i++) {
    const d = f[i] - f[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    r[i] = rsiDe(g, l);
  }
  return r;
}

const mediana = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// As três condições de "preço barato" no dia i, comparadas com o histórico daquele momento.
function situacao(h, i, rsi, cfg) {
  const janela = h.slice(i - 364, i + 1);
  const pct = (100 * janela.filter((c) => c.fech <= h[i].fech).length) / janela.length;
  const max90 = Math.max(...h.slice(i - 89, i + 1).map((c) => c.alta));
  const queda = ((h[i].fech - max90) / max90) * 100;
  const ok = [pct <= cfg.percentilMax, rsi[i] != null && rsi[i] <= cfg.rsiMax, queda <= -cfg.quedaMaximaPct];
  return { pct, rsi: rsi[i], queda, ok, nCond: ok.filter(Boolean).length };
}

// Retornos futuros (em %) a partir de cada dia em `indices`, olhando `dias` à frente.
function resumoRetornos(h, indices, dias) {
  const r = indices.filter((i) => i + dias < h.length).map((i) => h[i + dias].fech / h[i].fech - 1);
  if (!r.length) return { n: 0 };
  return {
    n: r.length,
    positivos: (100 * r.filter((x) => x > 0).length) / r.length,
    mediana: 100 * mediana(r),
    pior: 100 * Math.min(...r),
  };
}

// Primeiro dia de cada episódio (com pelo menos 30 dias entre eventos, para não contar o mesmo episódio várias vezes).
function eventos(h, scores, minimo) {
  const ev = [];
  for (let i = 364; i < h.length - 1; i++) {
    if (scores[i] >= minimo && (!ev.length || i - ev.at(-1) >= 30)) ev.push(i);
  }
  return ev;
}

export async function analisar(par, cfg, { minimo: minimoForcado } = {}) {
  const h = await historico(par);
  const n = h.length;
  if (n < 500) throw new Error(`Histórico curto demais para ${par} (${n} dias)`);
  const rsi = serieRsi(h.map((c) => c.fech));

  const scores = Array(n).fill(0);
  for (let i = 364; i < n; i++) scores[i] = situacao(h, i, rsi, cfg).nCond;

  const hoje = situacao(h, n - 1, rsi, cfg);
  const todos = Array.from({ length: n - 364 }, (_, k) => k + 364);
  const sma200 = h.slice(-200).reduce((s, c) => s + c.fech, 0) / 200;

  // Estatística das vezes em que o passado teve o mesmo número de condições (ou mais) que hoje.
  const minimo = minimoForcado ?? Math.max(hoje.nCond, 1);
  const ev = eventos(h, scores, minimo);
  const estat = {};
  for (const dias of cfg.horizontesDias ?? [30, 90]) {
    estat[dias] = { evento: resumoRetornos(h, ev, dias), base: resumoRetornos(h, todos, dias) };
  }

  return {
    ...hoje,
    preco: h.at(-1).fech,
    acimaSma200: h.at(-1).fech >= sma200,
    distSma200: ((h.at(-1).fech - sma200) / sma200) * 100,
    dias: n,
    desde: new Date(h[0].t).toLocaleDateString("pt-BR", { month: "2-digit", year: "numeric" }),
    estat,
    eventosPassados: ev.length,
    eventosUltimoAno: ev.filter((i) => i >= n - 365).length,
    ...(({ rotulo, motivo }) => ({ leitura: rotulo, motivo }))(leitura(hoje, estat, cfg)),
  };
}

// ---------- Leitura (resumo em uma palavra) ----------

// Com preço baixo, o rótulo depende do que o histórico mostrou nas ocasiões parecidas, comparado a um dia qualquer:
// só é FAVORÁVEL se, nos dois horizontes, o resultado foi claramente melhor (mais vezes positivo e mediana maior).
function leitura(hoje, estat, cfg) {
  if (hoje.nCond >= cfg.minCondicoes) {
    const hs = Object.values(estat);
    if (hs.some(({ evento }) => evento.n < 8)) {
      return { rotulo: "INCONCLUSIVA", motivo: "poucas ocasiões parecidas no histórico para tirar conclusão" };
    }
    const melhor = ({ evento: e, base: b }) => e.positivos >= b.positivos + 5 && e.mediana > b.mediana;
    const pior = ({ evento: e, base: b }) => e.positivos < b.positivos && e.mediana < b.mediana;
    if (hs.every(melhor)) return { rotulo: "FAVORÁVEL", motivo: "nas ocasiões parecidas o resultado superou um dia qualquer" };
    if (hs.some(pior)) return { rotulo: "SEM VANTAGEM", motivo: "comprar em situações parecidas não superou um dia qualquer no histórico" };
    return { rotulo: "INCONCLUSIVA", motivo: "resultado misto no histórico" };
  }
  if (hoje.pct >= 85 && hoje.rsi >= 65) return { rotulo: "CAUTELA", motivo: "preço esticado (caro frente ao último ano e RSI alto)" };
  return { rotulo: "NEUTRA", motivo: "nenhum sinal de preço baixo ou esticado" };
}

// ---------- Textos ----------

const p0 = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`;
const sinal = (b) => (b ? "✅" : "▫️");

function linhaEstat(rotulo, e, b, nCond) {
  if (!e.n) return `• ${rotulo}: nunca houve ${nCond}+ condições juntas com tempo suficiente para medir.`;
  const aviso = e.n < 8 ? " (poucos casos, pouco confiável)" : "";
  return `• ${rotulo}: em ${e.n} ocasiões parecidas, o preço estava mais alto em ${e.positivos.toFixed(0)}% (mediana ${p0(e.mediana)}, pior caso ${p0(e.pior)})${aviso}. Em um dia qualquer: ${b.positivos.toFixed(0)}%.`;
}

// Uma linha para juntar aos alertas normais.
export function linhaLeitura(a) {
  return `Leitura do histórico: ${a.leitura} · preço no ${a.pct.toFixed(0)}º percentil do último ano, RSI ${a.rsi.toFixed(0)}, ${a.queda.toFixed(0)}% da máxima de 90 dias (${a.nCond} de 3 condições de preço baixo).`;
}

// Texto completo do alerta de oportunidade.
export function textoSinal(a, cfg, precoTxt) {
  const [c1, c2, c3] = a.ok;
  const h = cfg.horizontesDias ?? [30, 90];
  return [
    `Preço: ${precoTxt}`,
    "",
    `Condições de preço baixo (${a.nCond} de 3):`,
    `${sinal(c1)} Preço no ${a.pct.toFixed(0)}º percentil do último ano (alvo: até ${cfg.percentilMax}º)`,
    `${sinal(c2)} RSI(14) em ${a.rsi.toFixed(0)} (alvo: até ${cfg.rsiMax})`,
    `${sinal(c3)} ${a.queda.toFixed(0)}% da máxima de 90 dias (alvo: ${cfg.quedaMaximaPct}% ou mais)`,
    `Tendência: ${a.acimaSma200 ? "acima" : "abaixo"} da média de 200 dias (${p0(a.distSma200)}).`,
    "",
    `Histórico completo (${a.dias} dias, desde ${a.desde}):`,
    ...h.map((d) => linhaEstat(`${d} dias depois`, a.estat[d].evento, a.estat[d].base, a.nCond)),
    "",
    `Leitura: ${a.leitura}, ${a.motivo}.`,
    "O passado não garante o futuro. Informativo automático, não é recomendação de investimento.",
  ].join("\n");
}
