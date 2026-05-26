/**
 * BET ANALYZER PRO — servidor
 * --------------------------------------------------------------------------
 * Backend seguro: as chaves de API ficam aqui no servidor (variáveis de
 * ambiente), nunca no navegador do cliente. O frontend conversa só com este
 * servidor, que faz o proxy das chamadas para a API-Football e a The Odds API.
 * Isso resolve o CORS e impede que o cliente veja/roube suas chaves.
 *
 * Variáveis de ambiente:
 *   API_FOOTBALL_KEY  -> chave de api-sports.io (dashboard.api-football.com)
 *   ODDS_API_KEY      -> chave de the-odds-api.com
 *   PORT              -> porta (a maioria das hospedagens define automático)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

// Carregador mínimo de .env (sem dependência externa). Em produção
// (Render/Railway) as variáveis vêm do painel e este bloco é ignorado.
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (_) { /* ignora */ }

const app = express();
app.use(express.json());

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const PORT = process.env.PORT || 3000;

// ───────────────────────── CONFIG DE LIGAS ─────────────────────────────────
const LEAGUES = {
  "71":  { name: "Brasileirão Série A", teams: 20, totalGames: 38, avgGoals: 2.65, avgCorners: 9.8,  oddsKey: "soccer_brazil_campeonato", defaultSeason: 2024 },
  "39":  { name: "Premier League",      teams: 20, totalGames: 38, avgGoals: 2.83, avgCorners: 10.1, oddsKey: "soccer_epl",               defaultSeason: 2024 },
  "140": { name: "La Liga",             teams: 20, totalGames: 38, avgGoals: 2.72, avgCorners: 9.5,  oddsKey: "soccer_spain_la_liga",     defaultSeason: 2024 },
  "78":  { name: "Bundesliga",          teams: 18, totalGames: 34, avgGoals: 3.18, avgCorners: 10.3, oddsKey: "soccer_germany_bundesliga",defaultSeason: 2024 },
  "135": { name: "Serie A (Itália)",    teams: 20, totalGames: 38, avgGoals: 2.67, avgCorners: 9.4,  oddsKey: "soccer_italy_serie_a",     defaultSeason: 2024 },
  "61":  { name: "Ligue 1",             teams: 18, totalGames: 34, avgGoals: 2.71, avgCorners: 9.6,  oddsKey: "soccer_france_ligue_one",  defaultSeason: 2024 },
};

// ───────────────────────── CACHE EM MEMÓRIA ────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWO_MIN = 2 * 60 * 1000;

// ───────────────────────── MATEMÁTICA POISSON ──────────────────────────────
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
function poissonCDF(upTo, lambda) {
  let s = 0;
  for (let k = 0; k <= upTo; k++) s += poissonPMF(k, lambda);
  return s;
}
function calcProbs(lH, lA) {
  let pH = 0, pD = 0, pA = 0, pO25 = 0, pBs = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = poissonPMF(h, lH) * poissonPMF(a, lA);
      if (h > a) pH += p; else if (h === a) pD += p; else pA += p;
      if (h + a >= 3) pO25 += p;
      if (h > 0 && a > 0) pBs += p;
    }
  }
  return { pH, pD, pA, pO25, pU25: 1 - pO25, pBs };
}
function cornerProbs(homeCorners10, awayCorners10) {
  const l = (homeCorners10 + awayCorners10) / 10;
  return {
    lambda: l,
    o85: 1 - poissonCDF(8, l), u85: poissonCDF(8, l),
    o95: 1 - poissonCDF(9, l), u95: poissonCDF(9, l),
    o105: 1 - poissonCDF(10, l), u105: poissonCDF(10, l),
  };
}
function formScore(wins, losses, gp) {
  if (!gp) return 0.5;
  const draws = gp - wins - losses;
  return (wins * 3 + draws) / (gp * 3);
}
function pressureFactor(position, totalTeams, gamesLeft) {
  const pct = position / totalTeams;
  const urgency = Math.max(0, 1 - gamesLeft / 10);
  if (pct <= 0.15 || pct >= 0.85) return 1 + urgency * 0.15;
  return 1 - urgency * 0.05;
}
function kellyFraction(prob, odds) {
  const b = odds - 1;
  const f = (b * prob - (1 - prob)) / b;
  return Math.max(0, Math.min(f * 0.5, 0.15));
}

function runModel(leagueId, home, away) {
  const lg = LEAGUES[leagueId];
  const lgAvg = lg.avgGoals / 2;

  const homeAtt = (home.gf / home.gp) / lgAvg;
  const homeDef = (home.ga / home.gp) / lgAvg;
  const awayAtt = (away.gf / away.gp) / lgAvg;
  const awayDef = (away.ga / away.gp) / lgAvg;

  const gamesLeft = lg.totalGames - home.gp;
  const pressH = pressureFactor(home.position, lg.teams, gamesLeft);
  const pressA = pressureFactor(away.position, lg.teams, gamesLeft);

  const HOME_ADV = 1.10;
  const lH = lgAvg * homeAtt * awayDef * HOME_ADV * pressH;
  const lA = lgAvg * awayAtt * homeDef * (1 / HOME_ADV) * pressA;

  const raw = calcProbs(lH, lA);
  const formH = formScore(home.wins, home.losses, home.gp);
  const formA = formScore(away.wins, away.losses, away.gp);
  const aH = raw.pH * (0.7 + 0.3 * formH);
  const aA = raw.pA * (0.7 + 0.3 * formA);
  const aD = Math.max(0, 1 - aH - aA);
  const norm = aH + aD + aA;
  const probs = {
    pH: aH / norm, pD: aD / norm, pA: aA / norm,
    pO25: raw.pO25, pU25: raw.pU25, pBs: raw.pBs,
  };

  const corners = cornerProbs(home.corners10, away.corners10);

  const bets = [
    { label: `Vitória ${home.teamName}`, desc: "Resultado final — mandante vence", prob: probs.pH, market: "resultado" },
    { label: "Empate", desc: "Resultado final — partida empatada", prob: probs.pD, market: "resultado" },
    { label: `Vitória ${away.teamName}`, desc: "Resultado final — visitante vence", prob: probs.pA, market: "resultado" },
    { label: "Over 2.5 Gols", desc: "3 ou mais gols na partida", prob: probs.pO25, market: "gols" },
    { label: "Under 2.5 Gols", desc: "No máximo 2 gols na partida", prob: probs.pU25, market: "gols" },
    { label: "Ambos Marcam", desc: "Os dois times marcam pelo menos 1 gol", prob: probs.pBs, market: "gols" },
    { label: "Over 8.5 Escanteios", desc: "9 ou mais escanteios", prob: corners.o85, market: "escanteios" },
    { label: "Under 8.5 Escanteios", desc: "No máximo 8 escanteios", prob: corners.u85, market: "escanteios" },
    { label: "Over 9.5 Escanteios", desc: "10 ou mais escanteios", prob: corners.o95, market: "escanteios" },
    { label: "Under 9.5 Escanteios", desc: "No máximo 9 escanteios", prob: corners.u95, market: "escanteios" },
    { label: "Over 10.5 Escanteios", desc: "11 ou mais escanteios", prob: corners.o105, market: "escanteios" },
  ].sort((a, b) => b.prob - a.prob);

  const top = bets[0];
  const kelly = kellyFraction(top.prob, (1 / top.prob) * 1.05);

  return {
    league: lg.name,
    home, away,
    lambdaHome: lH, lambdaAway: lA,
    probs, corners,
    bets: bets.slice(0, 6),
    allBets: bets,
    top, kelly,
    formH, formA,
  };
}

// ───────────────────── ARBITRAGEM (SUREBET) ────────────────────────────────
function arbScan(games, bankroll) {
  const surebets = [];
  for (const game of games) {
    if (!game.bookmakers || game.bookmakers.length < 2) continue;
    const best = {};
    for (const bk of game.bookmakers) {
      for (const mkt of (bk.markets || [])) {
        for (const out of (mkt.outcomes || [])) {
          if (!best[out.name] || out.price > best[out.name].price) {
            best[out.name] = { price: out.price, bk: bk.title };
          }
        }
      }
    }
    const outcomes = Object.entries(best);
    if (outcomes.length < 2) continue;
    const sum = outcomes.reduce((acc, [, v]) => acc + 1 / v.price, 0);
    if (sum < 1.0) {
      const profit = (1 - sum) / sum * 100;
      const stakes = outcomes.map(([name, v]) => ({
        name, odd: v.price, bookmaker: v.bk,
        stake: Math.round((1 / v.price / sum) * bankroll * 100) / 100,
      }));
      surebets.push({
        game: `${game.home_team} vs ${game.away_team}`,
        commence: game.commence_time,
        impliedSum: sum,
        profitPct: profit,
        guaranteedProfit: Math.round(bankroll * profit / 100 * 100) / 100,
        stakes,
      });
    }
  }
  return surebets.sort((a, b) => b.profitPct - a.profitPct);
}

// ───────────────────── VALOR (+EV) ─────────────────────────────────────────
function expectedValue(modelProb, odd) { return modelProb * odd - 1; }
function fairOdd(modelProb) { return modelProb > 0 ? 1 / modelProb : Infinity; }
function valueKelly(modelProb, odd) {
  const b = odd - 1;
  if (b <= 0) return 0;
  const f = (b * modelProb - (1 - modelProb)) / b;
  return Math.max(0, Math.min(f * 0.5, 0.15));
}
function normTeam(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(fc|cf|sc|ac|ec|club|clube)\b/g, "")
    .replace(/[^a-z0-9]/g, "").trim();
}
function teamsMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ───────────────────── HELPERS API-FOOTBALL ────────────────────────────────
async function af(pathAndQuery) {
  // A "API-Football" existe em 2 provedores. Tentamos o direto (api-sports.io)
  // e, se a chave for de outro tipo, caímos automaticamente no RapidAPI.
  const attempts = [
    { url: `https://v3.football.api-sports.io${pathAndQuery}`, headers: { "x-apisports-key": API_FOOTBALL_KEY } },
    { url: `https://api-football-v1.p.rapidapi.com/v3${pathAndQuery}`, headers: { "x-rapidapi-key": API_FOOTBALL_KEY, "x-rapidapi-host": "api-football-v1.p.rapidapi.com" } },
  ];
  let lastErr = "";
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { headers: a.headers });
      const d = await r.json();
      const errs = d.errors;
      const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
      if (hasErr) {
        const msg = Array.isArray(errs) ? errs.join(" | ") : Object.values(errs).join(" | ");
        if (/key|token|subscri|rapidapi|missing/i.test(msg)) { lastErr = msg; continue; } // chave não é deste provedor → tenta o próximo
        throw new Error(`API-Football: ${msg}`);
      }
      return d;
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`API-Football: ${lastErr || "não consegui autenticar a chave em nenhum provedor."}`);
}

async function getStandings(leagueId, season) {
  const key = `stand:${leagueId}:${season}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const d = await af(`/standings?league=${leagueId}&season=${season}`);
  const standings = d.response?.[0]?.league?.standings?.[0] || [];
  cacheSet(key, standings, SIX_HOURS);
  return standings;
}

async function fetchTeamStats(teamName, leagueId, season) {
  const key = `team:${leagueId}:${season}:${teamName.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const search = await af(`/teams?search=${encodeURIComponent(teamName)}&league=${leagueId}&season=${season}`);
  if (!search.response || !search.response.length) {
    throw new Error(`Time "${teamName}" não encontrado nessa liga/temporada. Confira o nome (ex: "Flamengo", "Man United").`);
  }
  const teamId = search.response[0].team.id;
  const teamNameReal = search.response[0].team.name;

  const stats = await af(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`);
  const s = stats.response;
  const gp = (s.fixtures?.played?.total) || ((s.fixtures?.played?.home || 0) + (s.fixtures?.played?.away || 0)) || 1;
  const gf = s.goals?.for?.total?.total || 0;
  const ga = s.goals?.against?.total?.total || 0;
  const wins = s.fixtures?.wins?.total || 0;
  const losses = s.fixtures?.loses?.total || 0;

  let position = Math.ceil(LEAGUES[leagueId].teams / 2);
  try {
    const standings = await getStandings(leagueId, season);
    const ts = standings.find(t => t.team.id === teamId);
    if (ts) position = ts.rank;
  } catch (_) { /* posição média se a tabela falhar */ }

  let corners10 = LEAGUES[leagueId].avgCorners * 5;
  try {
    const fixt = await af(`/fixtures?team=${teamId}&league=${leagueId}&season=${season}&last=5`);
    let total = 0, n = 0;
    for (const fx of (fixt.response || [])) {
      const st = await af(`/fixtures/statistics?fixture=${fx.fixture.id}&team=${teamId}`);
      const c = st.response?.[0]?.statistics?.find(x => x.type === "Corner Kicks");
      if (c && c.value != null) { total += c.value; n++; }
    }
    if (n > 0) corners10 = (total / n) * 10;
  } catch (_) { /* mantém fallback */ }

  const result = { teamId, teamName: teamNameReal, gp, gf, ga, wins, losses, position, corners10 };
  cacheSet(key, result, SIX_HOURS);
  return result;
}

// ───────────────────── HELPER THE ODDS API ─────────────────────────────────
async function fetchOdds(sport, regions, markets) {
  const cacheKey = `odds:${sport}:${regions}:${markets}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { games: cached, remaining: null, cached: true };
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&oddsFormat=decimal`;
  const r = await fetch(url);
  const remaining = r.headers.get("x-requests-remaining");
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`The Odds API (${r.status}): ${txt.slice(0, 200)}`);
  }
  const games = await r.json();
  if (!Array.isArray(games)) throw new Error("Resposta inesperada da The Odds API.");
  cacheSet(cacheKey, games, TWO_MIN);
  return { games, remaining, cached: false };
}

function bestOddsByOutcome(game) {
  const best = {};
  const bestTotals = {};
  for (const bk of (game.bookmakers || [])) {
    for (const mkt of (bk.markets || [])) {
      for (const out of (mkt.outcomes || [])) {
        if (mkt.key === "h2h") {
          if (!best[out.name] || out.price > best[out.name].price)
            best[out.name] = { price: out.price, bk: bk.title };
        } else if (mkt.key === "totals" && out.point != null) {
          const k = `${out.name} ${out.point}`;
          if (!bestTotals[k] || out.price > bestTotals[k].price)
            bestTotals[k] = { price: out.price, bk: bk.title, point: out.point };
        }
      }
    }
  }
  return { best, bestTotals, homeTeam: game.home_team, awayTeam: game.away_team };
}

// ─────────────────────────── ENDPOINTS ─────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true, version: "3.0.0" }));

app.get("/api/config", (_req, res) => {
  res.json({
    leagues: Object.entries(LEAGUES).map(([id, l]) => ({
      id, name: l.name, oddsKey: l.oddsKey, defaultSeason: l.defaultSeason,
    })),
    hasFootballKey: !!API_FOOTBALL_KEY,
    hasOddsKey: !!ODDS_API_KEY,
  });
});

app.get("/api/status", async (_req, res) => {
  if (!API_FOOTBALL_KEY) return res.status(400).json({ ok: false, error: "API_FOOTBALL_KEY não configurada no servidor." });
  try {
    const d = await af(`/status`);
    const acc = d.response?.account || {};
    const rq = d.response?.requests || {};
    res.json({
      ok: true,
      account: `${acc.firstname || ""} ${acc.lastname || ""}`.trim(),
      plan: d.response?.subscription?.plan || "—",
      requestsToday: rq.current,
      limitDay: rq.limit_day,
      remaining: (rq.limit_day != null && rq.current != null) ? rq.limit_day - rq.current : null,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { leagueId, homeTeam, awayTeam } = req.body || {};
  const season = parseInt(req.body?.season, 10) || LEAGUES[leagueId]?.defaultSeason;
  if (!API_FOOTBALL_KEY) return res.status(400).json({ error: "API_FOOTBALL_KEY não configurada no servidor. Veja o README." });
  if (!LEAGUES[leagueId]) return res.status(400).json({ error: "Liga inválida." });
  if (!homeTeam || !awayTeam) return res.status(400).json({ error: "Informe o time da casa e o visitante." });
  try {
    const [home, away] = await Promise.all([
      fetchTeamStats(homeTeam, leagueId, season),
      fetchTeamStats(awayTeam, leagueId, season),
    ]);
    const analysis = runModel(leagueId, home, away);
    res.json({ ok: true, season, analysis });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/analyze-manual", (req, res) => {
  const b = req.body || {};
  if (!LEAGUES[b.leagueId]) return res.status(400).json({ error: "Liga inválida." });
  const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const mid = Math.ceil(LEAGUES[b.leagueId].teams / 2);
  const home = {
    teamName: b.homeTeam || "Casa",
    gp: num(b.gamesPlayed, 1) || 1,
    gf: num(b.homeGoalsFor), ga: num(b.homeGoalsAgainst),
    wins: num(b.homeWins), losses: num(b.homeLosses),
    position: num(b.homePosition, mid),
    corners10: num(b.homeCorners10, LEAGUES[b.leagueId].avgCorners * 5),
  };
  const away = {
    teamName: b.awayTeam || "Fora",
    gp: num(b.gamesPlayed, 1) || 1,
    gf: num(b.awayGoalsFor), ga: num(b.awayGoalsAgainst),
    wins: num(b.awayWins), losses: num(b.awayLosses),
    position: num(b.awayPosition, mid),
    corners10: num(b.awayCorners10, LEAGUES[b.leagueId].avgCorners * 5),
  };
  try {
    const analysis = runModel(b.leagueId, home, away);
    res.json({ ok: true, manual: true, analysis });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/arbitrage", async (req, res) => {
  if (!ODDS_API_KEY) return res.status(400).json({ error: "ODDS_API_KEY não configurada no servidor. Veja o README." });
  const sport = req.query.sport || "soccer_brazil_campeonato";
  const bankroll = parseFloat(req.query.bankroll) || 1000;
  const regions = req.query.regions || "eu,uk";
  try {
    const { games, remaining } = await fetchOdds(sport, regions, "h2h");
    const surebets = arbScan(games, bankroll);
    res.json({ ok: true, scanned: games.length, bankroll, remaining, surebets });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/arbitrage-manual", (req, res) => {
  const odds = (req.body?.odds || []).map(Number).filter(x => x > 1);
  const bankroll = parseFloat(req.body?.bankroll) || 500;
  if (odds.length < 2) return res.status(400).json({ error: "Informe pelo menos 2 odds maiores que 1.00." });
  const implied = odds.map(o => 1 / o);
  const sum = implied.reduce((a, b) => a + b, 0);
  const isArb = sum < 1.0;
  const profitPct = isArb ? (1 - sum) / sum * 100 : 0;
  const stakes = implied.map((i, idx) => ({
    odd: odds[idx],
    stake: Math.round((i / sum) * bankroll * 100) / 100,
  }));
  const payout = stakes[0].stake * odds[0];
  res.json({
    ok: true, isArb, impliedSum: sum, profitPct,
    guaranteedProfit: isArb ? Math.round((bankroll * profitPct / 100) * 100) / 100 : 0,
    bankroll, stakes,
    payoutPerOutcome: Math.round(payout * 100) / 100,
  });
});

// MOTOR DE VALOR: cruza a probabilidade do modelo com as odds reais das casas.
app.post("/api/value", async (req, res) => {
  const { leagueId, homeTeam, awayTeam } = req.body || {};
  const season = parseInt(req.body?.season, 10) || LEAGUES[leagueId]?.defaultSeason;
  const bankroll = parseFloat(req.body?.bankroll) || 1000;
  const regions = req.body?.regions || "eu,uk";
  if (!LEAGUES[leagueId]) return res.status(400).json({ error: "Liga inválida." });
  if (!API_FOOTBALL_KEY) return res.status(400).json({ error: "API_FOOTBALL_KEY não configurada." });
  if (!ODDS_API_KEY) return res.status(400).json({ error: "ODDS_API_KEY não configurada (necessária pra comparar com o mercado)." });
  if (!homeTeam || !awayTeam) return res.status(400).json({ error: "Informe os dois times." });

  try {
    const [home, away] = await Promise.all([
      fetchTeamStats(homeTeam, leagueId, season),
      fetchTeamStats(awayTeam, leagueId, season),
    ]);
    const analysis = runModel(leagueId, home, away);

    const { games, remaining } = await fetchOdds(LEAGUES[leagueId].oddsKey, regions, "h2h,totals");

    const game = games.find(g =>
      teamsMatch(g.home_team, home.teamName) && teamsMatch(g.away_team, away.teamName)
    );
    if (!game) {
      return res.json({
        ok: true, matched: false, remaining, analysis,
        message: "Análise pronta, mas não achei esse jogo nas odds do mercado agora (jogo distante, nome diferente ou liga sem cobertura). Use a calculadora de valor manual com a probabilidade acima.",
      });
    }

    const { best, bestTotals } = bestOddsByOutcome(game);

    const rows = [];
    const pushRow = (label, modelProb, oddObj) => {
      if (!oddObj || !(oddObj.price > 1)) return;
      const ev = expectedValue(modelProb, oddObj.price);
      const k = ev > 0 ? valueKelly(modelProb, oddObj.price) : 0;
      rows.push({
        label, modelProb,
        marketOdd: oddObj.price, bookmaker: oddObj.bk,
        fairOdd: fairOdd(modelProb),
        impliedProb: 1 / oddObj.price,
        evPct: ev * 100,
        isValue: ev > 0,
        kelly: k,
        suggestedStake: Math.round(k * bankroll * 100) / 100,
      });
    };

    pushRow(`Vitória ${home.teamName}`, analysis.probs.pH, best[game.home_team]);
    pushRow("Empate", analysis.probs.pD, best["Draw"]);
    pushRow(`Vitória ${away.teamName}`, analysis.probs.pA, best[game.away_team]);
    pushRow("Over 2.5 Gols", analysis.probs.pO25, bestTotals["Over 2.5"]);
    pushRow("Under 2.5 Gols", analysis.probs.pU25, bestTotals["Under 2.5"]);

    rows.sort((a, b) => b.evPct - a.evPct);

    res.json({
      ok: true, matched: true, remaining, bankroll,
      game: `${game.home_team} vs ${game.away_team}`,
      commence: game.commence_time,
      analysis, valueRows: rows,
      bestValue: rows.find(r => r.isValue) || null,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Calculadora de valor manual (sem API): probabilidade do modelo vs odd da casa.
app.post("/api/value-manual", (req, res) => {
  const prob = parseFloat(req.body?.prob); // 0..1
  const odd = parseFloat(req.body?.odd);
  const bankroll = parseFloat(req.body?.bankroll) || 1000;
  if (!(prob > 0 && prob < 1)) return res.status(400).json({ error: "Probabilidade deve estar entre 0 e 100%." });
  if (!(odd > 1)) return res.status(400).json({ error: "Odd deve ser maior que 1.00." });
  const ev = expectedValue(prob, odd);
  const k = ev > 0 ? valueKelly(prob, odd) : 0;
  res.json({
    ok: true,
    evPct: ev * 100,
    isValue: ev > 0,
    fairOdd: fairOdd(prob),
    impliedProb: 1 / odd,
    kelly: k,
    suggestedStake: Math.round(k * bankroll * 100) / 100,
    bankroll,
  });
});

// SUGESTÃO AGORA: jogos das próximas horas + surebets + melhor aposta de valor
// (calculada contra o consenso do mercado — usa só a The Odds API, é barato).
app.get("/api/now", async (req, res) => {
  if (!ODDS_API_KEY) return res.status(400).json({ error: "ODDS_API_KEY não configurada no servidor. Veja o README." });
  const sport = req.query.sport || "soccer_brazil_campeonato";
  const bankroll = parseFloat(req.query.bankroll) || 1000;
  const hours = parseFloat(req.query.hours) || 72;
  const regions = req.query.regions || "eu,uk";
  try {
    const { games, remaining } = await fetchOdds(sport, regions, "h2h");
    const now = Date.now();
    const horizon = now + hours * 3600 * 1000;
    const inWindow = games.filter(g => {
      const t = new Date(g.commence_time).getTime();
      return t >= now - 2 * 3600 * 1000 && t <= horizon;
    });

    const enriched = inWindow.map(g => {
      const byOutcome = {}; // nome -> { prices:[], best:{price,bk} }
      for (const bk of (g.bookmakers || [])) {
        for (const mkt of (bk.markets || [])) {
          if (mkt.key !== "h2h") continue;
          for (const o of (mkt.outcomes || [])) {
            if (!byOutcome[o.name]) byOutcome[o.name] = { prices: [], best: { price: 0, bk: "" } };
            byOutcome[o.name].prices.push(o.price);
            if (o.price > byOutcome[o.name].best.price) byOutcome[o.name].best = { price: o.price, bk: bk.title };
          }
        }
      }
      const names = Object.keys(byOutcome);
      if (!names.length) return null;
      const avgImplied = {}; let sumAvg = 0;
      for (const n of names) {
        const ps = byOutcome[n].prices;
        const ai = ps.reduce((a, p) => a + 1 / p, 0) / ps.length;
        avgImplied[n] = ai; sumAvg += ai;
      }
      const outcomes = names.map(n => {
        const fair = avgImplied[n] / sumAvg;          // prob de consenso (sem margem)
        const best = byOutcome[n].best;
        const ev = best.price * fair - 1;             // valor vs consenso
        const k = ev > 0 ? valueKelly(fair, best.price) : 0;
        return {
          name: n, bestOdd: best.price, bookmaker: best.bk,
          consensusProb: fair, evPct: ev * 100,
          kelly: k, stake: Math.round(k * bankroll * 100) / 100,
        };
      }).sort((a, b) => b.evPct - a.evPct);
      return {
        game: `${g.home_team} vs ${g.away_team}`,
        home: g.home_team, away: g.away_team,
        commence: g.commence_time,
        outcomes, best: outcomes[0],
        marginPct: (sumAvg - 1) * 100,
      };
    }).filter(Boolean).sort((a, b) => new Date(a.commence) - new Date(b.commence));

    const surebets = arbScan(inWindow, bankroll);

    let suggestion = null;
    if (surebets.length) {
      const sb = surebets[0];
      suggestion = { type: "surebet", game: sb.game, commence: sb.commence, profitPct: sb.profitPct, guaranteedProfit: sb.guaranteedProfit, stakes: sb.stakes };
    } else {
      let bestRow = null;
      for (const g of enriched) {
        const o = g.best;
        if (o && (!bestRow || o.evPct > bestRow.evPct)) bestRow = { ...o, game: g.game, commence: g.commence };
      }
      if (bestRow) suggestion = { type: "value", ...bestRow };
    }

    res.json({ ok: true, sport, remaining, capturedAt: new Date().toISOString(), count: enriched.length, suggestion, surebets, games: enriched });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PALPITE 1-CLIQUE: a IA varre os jogos, escolhe o melhor candidato e roda o
// modelo completo (Poisson) nele, cruzando com as odds reais. Devolve a aposta.
app.get("/api/auto-pick", async (req, res) => {
  const leagueId = req.query.leagueId;
  const bankroll = parseFloat(req.query.bankroll) || 1000;
  const regions = req.query.regions || "eu,uk";
  if (!LEAGUES[leagueId]) return res.status(400).json({ error: "Liga inválida." });
  if (!ODDS_API_KEY) return res.status(400).json({ error: "ODDS_API_KEY não configurada no servidor." });
  const lg = LEAGUES[leagueId];
  const season = parseInt(req.query.season, 10) || lg.defaultSeason;
  try {
    const { games, remaining } = await fetchOdds(lg.oddsKey, regions, "h2h");
    const now = Date.now();
    const horizon = now + 72 * 3600 * 1000;
    const inWindow = games.filter(g => {
      const t = new Date(g.commence_time).getTime();
      return t >= now - 2 * 3600 * 1000 && t <= horizon;
    });
    if (!inWindow.length) return res.json({ ok: true, kind: "empty", message: "Sem jogos nas próximas horas nessa liga.", remaining });

    // 1) surebet tem prioridade absoluta (lucro garantido)
    const surebets = arbScan(inWindow, bankroll);
    if (surebets.length) return res.json({ ok: true, kind: "surebet", surebet: surebets[0], remaining });

    // 2) escolhe o jogo com maior sinal de valor de mercado (consenso entre casas)
    let candidate = null;
    for (const g of inWindow) {
      const byOutcome = {};
      for (const bk of (g.bookmakers || [])) for (const mkt of (bk.markets || [])) {
        if (mkt.key !== "h2h") continue;
        for (const o of (mkt.outcomes || [])) {
          if (!byOutcome[o.name]) byOutcome[o.name] = { prices: [], best: 0 };
          byOutcome[o.name].prices.push(o.price);
          if (o.price > byOutcome[o.name].best) byOutcome[o.name].best = o.price;
        }
      }
      const names = Object.keys(byOutcome);
      if (!names.length) continue;
      const avg = {}; let sum = 0;
      for (const n of names) { const ps = byOutcome[n].prices; const ai = ps.reduce((a, p) => a + 1 / p, 0) / ps.length; avg[n] = ai; sum += ai; }
      let bestEv = -Infinity;
      for (const n of names) { const fair = avg[n] / sum; const ev = byOutcome[n].best * fair - 1; if (ev > bestEv) bestEv = ev; }
      if (!candidate || bestEv > candidate.signal) candidate = { game: g, signal: bestEv };
    }
    if (!candidate) return res.json({ ok: true, kind: "empty", message: "Sem dados suficientes nos jogos.", remaining });

    const g = candidate.game;

    // 3) análise REAL com o modelo Poisson (precisa da API-Football)
    if (!API_FOOTBALL_KEY) {
      return res.json({
        ok: true, kind: "market-only", remaining,
        game: `${g.home_team} vs ${g.away_team}`, commence: g.commence_time,
        message: "Varredura de mercado pronta, mas a chave da API-Football não está configurada pra rodar o modelo completo.",
      });
    }
    const [home, away] = await Promise.all([
      fetchTeamStats(g.home_team, leagueId, season),
      fetchTeamStats(g.away_team, leagueId, season),
    ]);
    const analysis = runModel(leagueId, home, away);
    const { best } = bestOddsByOutcome(g);
    const rows = [];
    const push = (label, p, oddObj) => {
      if (!oddObj || !(oddObj.price > 1)) return;
      const ev = expectedValue(p, oddObj.price);
      const k = ev > 0 ? valueKelly(p, oddObj.price) : 0;
      rows.push({ label, modelProb: p, marketOdd: oddObj.price, bookmaker: oddObj.bk, fairOdd: fairOdd(p), evPct: ev * 100, isValue: ev > 0, kelly: k, suggestedStake: Math.round(k * bankroll * 100) / 100 });
    };
    push(`Vitória ${home.teamName}`, analysis.probs.pH, best[g.home_team]);
    push("Empate", analysis.probs.pD, best["Draw"]);
    push(`Vitória ${away.teamName}`, analysis.probs.pA, best[g.away_team]);
    rows.sort((a, b) => b.evPct - a.evPct);
    res.json({
      ok: true, kind: "model", remaining,
      game: `${g.home_team} vs ${g.away_team}`, commence: g.commence_time,
      analysis, valueRows: rows, bestValue: rows.find(r => r.isValue) || rows[0],
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────── STATIC (frontend) ─────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Bet Analyzer Pro rodando em http://localhost:${PORT}`);
  console.log(`API-Football key: ${API_FOOTBALL_KEY ? "OK" : "FALTANDO"} | Odds key: ${ODDS_API_KEY ? "OK" : "FALTANDO"}`);
});
