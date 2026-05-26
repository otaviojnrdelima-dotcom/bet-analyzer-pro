# ⚡ Bet Analyzer Pro

App web (abre no celular) que analisa jogos de futebol com modelo estatístico **Poisson/Dixon-Coles**, um **motor de valor (+EV)** que cruza o modelo com as odds reais das casas pra achar onde a casa errou o preço, um **scanner de arbitragem** (surebets) e um **diário de banca** (ROI, lucro, taxa de acerto).

As chaves de API ficam **no servidor** (seguras). O cliente abre o link no navegador do celular e usa — sem precisar das chaves dele e sem ver as suas.

---

## ⚠️ Antes de tudo: as chaves certas

São **duas APIs diferentes**, cada uma com cadastro grátis próprio:

| API | Para quê | Onde pegar | Tier grátis |
|-----|----------|------------|-------------|
| **API-Football** | tabela, gols, vitórias, escanteios | https://dashboard.api-football.com | 100 requisições/dia |
| **The Odds API** | odds reais de 40+ casas (arbitragem) | https://the-odds-api.com | 500 créditos/mês |

> ❗ **A chave do ipstack NÃO serve aqui.** ipstack é geolocalização de IP, não tem nada a ver com futebol. Ignore. Você precisa das duas chaves da tabela acima.

O app funciona mesmo **sem nenhuma chave**, usando o **modo Manual** (você digita os números do jogo) e a **calculadora manual de arbitragem** (você cola as odds). As chaves só servem pra automatizar a busca.

---

## ▶️ Rodar no seu PC (teste rápido)

Precisa do Node.js 18+ instalado (https://nodejs.org).

```bash
cd bet-analyzer-pro
npm install
# copie .env.example para .env e cole suas chaves (opcional)
npm start
```

Abra `http://localhost:3000`.

---

## 🌐 Colocar online de graça (acessível pelo celular) — Render

Esse é o caminho pro cliente abrir no smartphone. Leva ~5 minutos.

1. **Crie uma conta** em https://render.com (grátis, dá pra logar com o GitHub).
2. Suba esta pasta `bet-analyzer-pro` num repositório no GitHub (ou use o botão de upload do Render). Garanta que o arquivo **`.env` NÃO foi enviado** (o `.gitignore` já cuida disso).
3. No Render: **New +** → **Web Service** → conecte o repositório.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em **Environment**, adicione as variáveis (clique em *Add Environment Variable*):
   - `API_FOOTBALL_KEY` = sua chave da API-Football
   - `ODDS_API_KEY` = sua chave da The Odds API
6. Clique em **Create Web Service**. Quando terminar, o Render te dá um link tipo
   `https://bet-analyzer-pro.onrender.com` — **esse é o link que você manda pro cliente abrir no celular.**

> O plano free do Render "dorme" após inatividade e demora ~30s pra acordar na primeira visita. Pra produto pago de verdade, o plano de ~US$7/mês mantém sempre ligado. O Railway (railway.app) é uma alternativa parecida.

---

## 🔧 Trocar/ajustar as ligas e temporadas

No `server.js`, no objeto `LEAGUES`, dá pra mudar `defaultSeason` de cada liga. No tier grátis da API-Football, algumas temporadas têm cobertura limitada — se a busca automática vier vazia, ajuste a temporada ali ou use o modo Manual.

---

## 🧱 Estrutura

```
bet-analyzer-pro/
├── server.js          # backend: proxy seguro das APIs + modelo + arbitragem
├── public/index.html  # frontend mobile-first (tudo num arquivo)
├── package.json
├── .env.example       # modelo das chaves (copie para .env)
└── .gitignore
```

## 🔌 Endpoints da API (caso queira integrar com outra coisa)

- `GET  /api/config` — ligas disponíveis e se as chaves estão configuradas
- `GET  /api/status` — testa a chave da API-Football e mostra requisições restantes
- `POST /api/analyze` — `{leagueId, homeTeam, awayTeam}` → análise com dados reais
- `POST /api/analyze-manual` — análise com dados digitados (não gasta API)
- `POST /api/value` — `{leagueId, homeTeam, awayTeam, bankroll}` → cruza modelo com odds reais e calcula EV por mercado
- `POST /api/value-manual` — `{prob, odd, bankroll}` → EV, odd justa e stake Kelly
- `GET  /api/arbitrage?sport=...&bankroll=...` — scanner de surebets
- `POST /api/arbitrage-manual` — `{odds:[...], bankroll}` → calculadora de surebet

O diário de banca fica no navegador do cliente (localStorage) — não precisa de servidor de banco de dados.

---

### Aviso

Análise estatística reduz risco mas não elimina incerteza. Nenhum modelo garante lucro em apostas. Use com responsabilidade.
