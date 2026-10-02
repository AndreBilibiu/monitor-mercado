// Monitor de mercado: avisa no celular (ntfy) quando um ativo sobe/cai além dos limites do config.json.
// Uso:
//   node --env-file=.env monitor.mjs                  roda em loop
//   node --env-file=.env monitor.mjs --uma-vez        uma checagem e sai
//   node --env-file=.env monitor.mjs --teste          manda notificação de teste

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const ESTADO = join(DIR, "estado.json");
const config = JSON.parse(await readFile(join(DIR, "config.json"), "utf8"));
const { NTFY_TOPIC, ANTHROPIC_API_KEY: CLAUDE_KEY } = process.env;
const args = new Set(process.argv.slice(2));

const log = (...m) => console.log(new Date().toLocaleString("pt-BR"), ...m);
const getJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} em ${url}`);
  return r.json();
};

// ---------- Dados ----------

// A api.binance.com bloqueia IPs dos EUA (onde rodam os servidores do GitHub).
// A data-api.binance.vision é o espelho público só de dados de mercado e funciona de lá.
const HOSTS_BINANCE = ["https://data-api.binance.vision", "https://api.binance.com"];

async function binance(caminho) {
  let ultimoErro;
  for (const host of HOSTS_BINANCE) {
    try { return await getJson(host + caminho); } catch (e) { ultimoErro = e; }
  }
  throw ultimoErro;
}

async function dadosCripto({ par }) {
  const [candles, t24] = await Promise.all([
    binance(`/api/v3/klines?symbol=${par}&interval=1d&limit=60`),
    binance(`/api/v3/ticker/24hr?symbol=${par}`),
  ]);
  return {
    preco: Number(t24.lastPrice),
    preco24hAtras: Number(t24.openPrice),
    var24h: Number(t24.priceChangePercent),
    fechamentos: candles.map((c) => Number(c[4])),
    maximas: candles.map((c) => Number(c[2])),
    moeda: "US$",
  };
}

async function dadosAcao({ ticker }) {
  const j = await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`,
  );
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`Sem dados para ${ticker}`);
  const q = res.indicators.quote[0];
  const fechamentos = q.close.filter((v) => v != null);
  const maximas = q.high.filter((v) => v != null);
  const preco = res.meta.regularMarketPrice;
  const anterior = fechamentos.at(-2); // chartPreviousClose do Yahoo é o fechamento antes do período inteiro, não o de ontem
  return {
    preco,
    preco24hAtras: anterior,
    var24h: ((preco - anterior) / anterior) * 100,
    fechamentos,
    maximas,
    moeda: res.meta.currency === "BRL" ? "R$" : res.meta.currency + " ",
  };
}

// ---------- Indicadores ----------

// RSI de Wilder
function rsi(fechamentos, periodo = 14) {
  if (fechamentos.length <= periodo) return null;
  let ganho = 0, perda = 0;
  for (let i = 1; i <= periodo; i++) {
    const d = fechamentos[i] - fechamentos[i - 1];
    d >= 0 ? (ganho += d) : (perda -= d);
  }
  ganho /= periodo;
  perda /= periodo;
  for (let i = periodo + 1; i < fechamentos.length; i++) {
    const d = fechamentos[i] - fechamentos[i - 1];
    ganho = (ganho * (periodo - 1) + Math.max(d, 0)) / periodo;
    perda = (perda * (periodo - 1) + Math.max(-d, 0)) / periodo;
  }
  return perda === 0 ? 100 : 100 - 100 / (1 + ganho / perda);
}

// ---------- Regras ----------

const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2).replace(".", ",")}%`;
const valor = (dados, v) => dados.moeda + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function avaliar(dados) {
  const r = config.regras;
  const alertas = [];

  if (Math.abs(dados.var24h) >= r.variacao24hPct) {
    // Cada faixa (pequena, média, grande) tem regra própria: se o movimento escalar, avisa de novo mesmo dentro do cooldown.
    const abs = Math.abs(dados.var24h);
    const nivel = abs >= (r.movimentoGrandePct ?? 10) ? "Grande" : abs >= (r.variacaoMediaPct ?? 5) ? "Media" : "";
    alertas.push({
      regra: `${dados.var24h > 0 ? "alta" : "queda"}24h${nivel}`,
      mov24h: true,
      nivel,
      texto: `${dados.var24h > 0 ? "📈 Alta" : "📉 Queda"} de ${pct(dados.var24h)} em 24h`,
    });
  }

  dados.rsi = rsi(dados.fechamentos);
  if (dados.rsi != null) {
    if (dados.rsi <= r.rsiBaixo) {
      alertas.push({ regra: "rsiBaixo", texto: `🔻 RSI(14) em ${dados.rsi.toFixed(0)} (sobrevendido, abaixo de ${r.rsiBaixo})` });
    } else if (dados.rsi >= r.rsiAlto) {
      alertas.push({ regra: "rsiAlto", texto: `🔺 RSI(14) em ${dados.rsi.toFixed(0)} (sobrecomprado, acima de ${r.rsiAlto})` });
    }
  }

  const maxima30 = Math.max(...dados.maximas.slice(-30));
  dados.distMaxima30 = ((dados.preco - maxima30) / maxima30) * 100;
  if (dados.distMaxima30 <= -r.quedaDaMaxima30dPct) {
    alertas.push({ regra: "distMaxima", texto: `⬇️ ${pct(dados.distMaxima30)} abaixo da máxima dos últimos 30 dias` });
  }
  return alertas;
}

// ---------- Cooldown (evita repetir o mesmo alerta) ----------

async function lerEstado() {
  try { return JSON.parse(await readFile(ESTADO, "utf8")); } catch { return {}; }
}

// ---------- Claude (contexto opcional) ----------

async function resumoClaude(ativo, dados, alertas) {
  if (!config.usarClaude || !CLAUDE_KEY) return null;
  const prompt = `Ativo: ${ativo.simbolo}
Preço atual: ${dados.moeda}${dados.preco.toFixed(2)}
Variação 24h: ${dados.var24h.toFixed(2)}%
RSI(14) diário: ${dados.rsi?.toFixed(0) ?? "n/d"}
Distância da máxima de 30 dias: ${dados.distMaxima30.toFixed(1)}%
Últimos 10 fechamentos diários: ${dados.fechamentos.slice(-10).map((v) => v.toFixed(2)).join(", ")}
Alertas disparados: ${alertas.map((a) => a.texto).join("; ")}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: config.modeloClaude,
        max_tokens: 300,
        system:
          "Você descreve movimentos de mercado em português, em no máximo 3 frases curtas, usando apenas os dados fornecidos. " +
          "Não preveja preços, não recomende comprar ou vender e não invente notícias ou causas. " +
          "Diga o que os números mostram e o que é incerto.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return (await r.json()).content?.[0]?.text ?? null;
  } catch (e) {
    log("Claude indisponível:", e.message);
    return null;
  }
}

// ---------- Notificação (ntfy.sh) ----------

// Publicação em JSON para aceitar acentos e emojis no título.
async function notificar(titulo, mensagem, { tags = [], prioridade = 3 } = {}) {
  if (process.env.DRY_RUN) return console.log(`[simulação] ${titulo}\n${mensagem}\n`);
  if (!NTFY_TOPIC) throw new Error("Defina NTFY_TOPIC no .env");
  const r = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: NTFY_TOPIC, title: titulo, message: mensagem, tags: tags, priority: prioridade }),
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}

// ---------- Alvos de preço (ex.: BTC a R$ 400.000 ou menos) ----------

// Quando o preço está no alvo, avisa com prioridade máxima e repete a cada `repeteACadaMinutos`,
// até `maximoDeAvisos`. Se o preço sair do alvo e voltar, a contagem recomeça.
async function checarAlvos(estado, agora) {
  for (const alvo of config.alvosDePreco ?? []) {
    try {
      const preco = Number((await binance(`/api/v3/ticker/price?symbol=${alvo.par}`)).price);
      const atingiu = alvo.condicao === "abaixo" ? preco <= alvo.valor : preco >= alvo.valor;
      const chave = `alvo:${alvo.par}:${alvo.condicao}:${alvo.valor}`;
      const fmt = (v) => valor({ moeda: alvo.moeda }, v);
      log(`Alvo ${alvo.simbolo} ${alvo.condicao} de ${fmt(alvo.valor)}: preço ${fmt(preco)} ${atingiu ? "NO ALVO" : "fora do alvo"}`);

      if (!atingiu) {
        delete estado[chave];
        continue;
      }
      const s = estado[chave] ?? { avisos: 0, ultimo: 0 };
      const maximo = alvo.maximoDeAvisos ?? 6;
      if (s.avisos >= maximo || agora - s.ultimo < (alvo.repeteACadaMinutos ?? 5) * 60_000) continue;

      await notificar(`🚨 ${alvo.simbolo} NO ALVO: ${fmt(preco)}`, [
        `${alvo.simbolo} está em ${fmt(preco)}, ${alvo.condicao} do seu alvo de ${fmt(alvo.valor)}.`,
        `Aviso ${s.avisos + 1} de ${maximo}. Repete a cada ${alvo.repeteACadaMinutos ?? 5} min enquanto o preço estiver no alvo.`,
        "\nInformativo automático, não é recomendação de investimento.",
      ].join("\n"), { tags: ["rotating_light", "moneybag"], prioridade: 5 });
      estado[chave] = { avisos: s.avisos + 1, ultimo: agora };
    } catch (e) {
      log(`Erro no alvo ${alvo.simbolo}:`, e.message);
    }
  }
}

// ---------- Ciclo ----------

async function checar() {
  const estado = await lerEstado();
  const agora = Date.now();
  const cooldownMs = config.cooldownHoras * 3600_000;

  for (const ativo of config.ativos) {
    try {
      const dados = await (ativo.tipo === "cripto" ? dadosCripto(ativo) : dadosAcao(ativo));
      const novos = avaliar(dados).filter((a) => agora - (estado[`${ativo.simbolo}:${a.regra}`] ?? 0) >= cooldownMs);
      log(`${ativo.simbolo} ${dados.moeda}${dados.preco.toFixed(2)} var24h=${dados.var24h.toFixed(2)}% rsi=${dados.rsi?.toFixed(0)} alertas=${novos.length}`);
      if (!novos.length) continue;

      const resumo = await resumoClaude(ativo, dados, novos);
      // Alerta de movimento: "BTC baixou". Se for movimento grande: "BTC baixou de X para Y".
      const mov = novos.find((a) => a.mov24h);
      const verbo = dados.var24h > 0 ? "subiu" : "baixou";
      let titulo = `${ativo.simbolo}  ${valor(dados, dados.preco)}`;
      const linhas = [];
      if (mov) {
        titulo = `${ativo.simbolo} ${verbo}${{ Media: " bastante", Grande: " muito" }[mov.nivel] ?? ""}`;
        linhas.push(
          mov.nivel
            ? `${ativo.simbolo} ${verbo} de ${valor(dados, dados.preco24hAtras)} para ${valor(dados, dados.preco)} (${pct(dados.var24h)} em 24h)`
            : `Agora em ${valor(dados, dados.preco)} (${pct(dados.var24h)} em 24h)`,
        );
      }
      linhas.push(...novos.filter((a) => !a.mov24h).map((a) => a.texto));
      const msg = [
        ...linhas,
        ...(resumo ? [`\n${resumo}`] : []),
        "\nInformativo automático, não é recomendação de investimento.",
      ].join("\n");
      const caiu = mov ? dados.var24h < 0 : novos.some((a) => /rsiBaixo|distMaxima/.test(a.regra));
      await notificar(titulo, msg, {
        tags: [caiu ? "chart_with_downwards_trend" : "chart_with_upwards_trend"],
        prioridade: { Grande: 5, Media: 4 }[mov?.nivel] ?? 3,
      });
      for (const a of novos) estado[`${ativo.simbolo}:${a.regra}`] = agora;
    } catch (e) {
      log(`Erro em ${ativo.simbolo}:`, e.message);
    }
  }
  await checarAlvos(estado, agora);
  await writeFile(ESTADO, JSON.stringify(estado, null, 2));
}

// ---------- Entrada ----------

if (args.has("--teste")) {
  await notificar("Monitor de mercado", "✅ Conectado. Você vai receber os alertas aqui.", { tags: ["white_check_mark"] });
  log("Notificação de teste enviada.");
} else if (args.has("--uma-vez")) {
  await checar();
} else {
  log(`Monitorando ${config.ativos.map((a) => a.simbolo).join(", ")} a cada ${config.intervaloMinutos} min. Ctrl+C para parar.`);
  while (true) {
    await checar();
    await new Promise((r) => setTimeout(r, config.intervaloMinutos * 60_000));
  }
}
