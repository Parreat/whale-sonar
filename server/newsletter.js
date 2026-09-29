// The daily newsletter: ranks the day's market headlines and runs the Stock signals screen from
// the site on public Finnhub data, then emails the same issue to every confirmed subscriber.
// Run directly with --preview to write data/preview.html, or --send to build and send today's issue now.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { C } from "./config.js";
import { esc, sendMail } from "./mail.js";

export const MARKETS = {
  "Big Tech": ["AAPL","MSFT","GOOGL","META","AMZN","NFLX"],
  "Semiconductors": ["NVDA","AMD","AVGO","TSM","MU","INTC"],
  "Software & AI": ["PLTR","CRM","ORCL","SNOW"],
  "EV & Autos": ["TSLA","RIVN","F","GM"],
  "Financials": ["JPM","BAC","GS","V","MA"],
  "Crypto stocks": ["COIN","MSTR","HOOD","MARA","RIOT"],
  "Energy": ["XOM","CVX","OXY"],
  "Healthcare": ["LLY","UNH","PFE"],
  "Consumer": ["WMT","COST","NKE","DIS"]
};
export const INDEXES = {SPY:"S&P 500", QQQ:"Nasdaq-100", DIA:"Dow Jones", IWM:"Russell 2000"};
export const NAMES = {AAPL:"Apple", MSFT:"Microsoft", GOOGL:"Alphabet", META:"Meta Platforms", AMZN:"Amazon", NFLX:"Netflix",
  NVDA:"NVIDIA", AMD:"AMD", AVGO:"Broadcom", TSM:"TSMC", MU:"Micron", INTC:"Intel",
  PLTR:"Palantir", CRM:"Salesforce", ORCL:"Oracle", SNOW:"Snowflake",
  TSLA:"Tesla", RIVN:"Rivian", F:"Ford", GM:"General Motors",
  JPM:"JPMorgan Chase", BAC:"Bank of America", GS:"Goldman Sachs", V:"Visa", MA:"Mastercard",
  COIN:"Coinbase", MSTR:"Strategy", HOOD:"Robinhood", MARA:"MARA Holdings", RIOT:"Riot Platforms",
  XOM:"ExxonMobil", CVX:"Chevron", OXY:"Occidental",
  LLY:"Eli Lilly", UNH:"UnitedHealth", PFE:"Pfizer",
  WMT:"Walmart", COST:"Costco", NKE:"Nike", DIS:"Disney"};
const MARKET_OF = {};
for (const [m, list] of Object.entries(MARKETS)) for (const s of list) MARKET_OF[s] = m;

// Same weights as the site's Stock signals tab, minus live whale prints, which the server doesn't stream.
export const WEIGHTS = {analysts:.35, news:.35, insiders:.15, momentum:.15};
const POS = /\b(beats?|tops|topped|surges?|surged|soars?|soared|jumps?|jumped|rall(?:y|ies|ied)|record|upgrades?|upgraded|raises?|raised|outperforms?|bullish|strong(?:er)?|growth|wins?|approv(?:al|ed|es)|partnerships?|buybacks?|profits?|gains?|higher|boosts?|expands?|expansion|breakthrough|rebounds?|climbs?|optimistic|upside|accelerates?|exceeds?|exceeded|overweight)\b/g;
const NEG = /\b(miss(?:es|ed)?|falls?|fell|drops?|dropped|plunges?|plunged|sinks?|sank|slumps?|downgrades?|downgraded|cuts?|lawsuits?|sues|sued|probes?|investigations?|recalls?|bearish|weak(?:er|ness)?|loss(?:es)?|layoffs?|fraud|halts?|declines?|declined|warns?|warning|lowers?|slides?|tumbles?|tumbled|delays?|bans?|crash(?:es)?|slowdown|concerns?|underperforms?|underweight|sell-?off|bankruptcy|default)\b/g;
const IMPACT = [
  [/\b(fed|fomc|powell|rate (?:cut|hike)s?|interest rates?|cpi|inflation|jobs report|payrolls|recession|tariffs?)\b/i, 3],
  [/\b(sec|lawsuits?|probe|investigation|bankrupt\w*|default|halt\w*|fraud|hack\w*|exploit\w*|rug ?pull\w*|delist\w*)\b/i, 3],
  [/\b(earnings|guidance|revenue|downgrades?|upgrades?|price target|merger|acquisitions?|acquires?|buyout|ipo|etf|listing|approv\w+)\b/i, 2],
  [/\b(surg\w+|soar\w*|plung\w+|crash\w*|tumbl\w+|skyrocket\w*|record high|all-time high|whales?)\b/i, 1]
];
const MEME = /\b(meme ?coins?|memes?|solana|pump\.?fun|bonk|wif|dogwifhat|popcat|pepe|doge|dogecoin|shib\w*|trump coin|raydium|jupiter)\b/i;
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const isoDay = n => new Date(Date.now() - n*864e5).toISOString().slice(0, 10);
export const nyDay = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", {timeZone:"America/New_York"});
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function tone(h){
  const s = String(h || "").toLowerCase();
  const p = (s.match(POS) || []).length, n = (s.match(NEG) || []).length;
  return p + n ? (p - n) / (p + n) : null;
}
function usd(n){
  const a = Math.abs(n), s = n < 0 ? "−" : "";
  if (a >= 1e9) return s+"$"+(a/1e9).toFixed(2)+"B";
  if (a >= 1e6) return s+"$"+(a/1e6).toFixed(2)+"M";
  if (a >= 1e3) return s+"$"+(a/1e3).toFixed(1)+"K";
  return s+"$"+a.toFixed(0);
}
const pct = (v, d = 1) => v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "")+Math.abs(v).toFixed(d)+"%";

// ---------- Finnhub, paced under the free plan's 60 calls a minute ----------
export function finnhub(key, fetchImpl = fetch, gap = 1100, backoff = 3000){
  let last = 0;
  return async function fh(p){
    for (let tries = 0; tries < 4; tries++){
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await fetchImpl("https://finnhub.io/api/v1"+p+(p.includes("?") ? "&" : "?")+"token="+encodeURIComponent(key));
      if (r.status === 429 || r.status >= 500){ await sleep(backoff * 2**tries); continue; }
      if (r.status === 401 || r.status === 403) throw new Error("Finnhub rejected the key (HTTP "+r.status+")");
      if (!r.ok) throw new Error("Finnhub HTTP "+r.status);
      return r.json();
    }
    throw new Error("Finnhub is busy");
  };
}

export function scoreStock(d){
  const c = {};
  const r = d.rec;
  if (r){
    const sb = r.strongBuy || 0, b = r.buy || 0, h = r.hold || 0, se = r.sell || 0, ss = r.strongSell || 0, tot = sb + b + h + se + ss;
    if (tot){ const raw = (2*sb + b - se - 2*ss) / (2*tot); c.analysts = {v:clamp((raw - 0.35) * 2.5), txt:Math.round((sb + b) / tot * 100)+"% of "+tot+" analysts rate it a buy"}; }
  }
  if (d.news && d.news.length){
    let sum = 0, wsum = 0, n = 0; const now = Date.now() / 1000;
    for (const x of d.news){ const t = tone(x.headline); if (t == null) continue; n++; const wt = Math.exp(-Math.max(0, now - x.datetime) / 3600 / 36); sum += t * wt; wsum += wt; }
    if (n >= 2 && wsum > 0){ const v = clamp(sum / wsum); c.news = {v, txt:"headline tone "+(v >= 0 ? "+" : "")+v.toFixed(2)+" across "+n+" recent stories"}; }
  }
  if (d.ins && d.ins.length){
    let net = 0, gross = 0;
    const since = isoDay(30);
    for (const x of d.ins){
      if ((x.transactionDate || "") < since || (x.transactionCode !== "P" && x.transactionCode !== "S")) continue;
      const v = Math.abs(x.change || 0) * (+x.transactionPrice || 0); gross += v; net += x.transactionCode === "P" ? v : -v;
    }
    if (gross > 0) c.insiders = {v:clamp(net / 5e6), txt:"insiders net "+(net >= 0 ? "bought " : "sold ")+usd(Math.abs(net))+" in 30 days"};
  }
  const q = d.quote;
  let dp = null;
  if (q && q.pc && q.c){ dp = (q.c / q.pc - 1) * 100; c.momentum = {v:clamp(dp / 4), txt:pct(dp, 2)+" last session"}; }
  let sum = 0, wsum = 0;
  for (const k in c){ sum += c[k].v * WEIGHTS[k]; wsum += WEIGHTS[k]; }
  return {score:wsum >= 0.35 ? sum / wsum : null, comps:c, px:q && q.c || null, dp};
}

export function rankNews(items, names, maxAgeMs = 36*36e5){
  const seen = new Set(), out = [];
  for (const x of items){
    const k = String(x.headline || "").toLowerCase().trim();
    const t = (x.datetime || 0) * 1000;
    if (!k || seen.has(k) || !/^https?:\/\//.test(x.url || "") || Date.now() - t > maxAgeMs) continue;
    seen.add(k);
    const text = x.headline+" "+(x.summary || ""), tags = [];
    let w = 0;
    for (const [re, n] of IMPACT){ const m = text.match(re); if (m){ w += n; tags.push(m[0].toLowerCase()); } }
    for (const [label, re, n] of names) if (re.test(x.headline) || re.test(x.related || "")){ w += n; tags.push(label); }
    out.push({h:String(x.headline).slice(0, 220), u:x.url, src:String(x.source || "").slice(0, 60), t,
      tags:[...new Set(tags)].slice(0, 3), score:(1 + w) * 0.5 ** (Math.max(0, Date.now() - t) / 216e5)});
  }
  return out.sort((a, b) => b.score - a.score);
}

// Builds the issue's data. Takes about 3 minutes on the free plan (~170 calls).
export async function buildIssue(key, {log = () => {}, fetchImpl, gap, backoff} = {}){
  if (!key) throw new Error("FINNHUB_KEY is not set");
  const fh = finnhub(key, fetchImpl, gap, backoff);
  const safe = p => fh(p).catch(e => { if (/rejected/.test(e.message)) throw e; log("skip "+p.split("?")[0]+": "+e.message); return null; });
  const general = (await safe("/news?category=general")) || [];
  const crypto = (await safe("/news?category=crypto")) || [];
  const index = [];
  for (const [s, name] of Object.entries(INDEXES)){
    const q = await safe("/quote?symbol="+s);
    if (q && q.c && q.pc) index.push({s, name, px:q.c, dp:(q.c / q.pc - 1) * 100});
  }
  const rows = [];
  const all = Object.values(MARKETS).flat();
  for (const [i, s] of all.entries()){
    log("stocks "+(i + 1)+"/"+all.length+" "+s);
    const q = encodeURIComponent(s);
    const d = {
      quote: await safe("/quote?symbol="+q),
      rec: ((await safe("/stock/recommendation?symbol="+q)) || [])[0] || null,
      news: ((await safe("/company-news?symbol="+q+"&from="+isoDay(3)+"&to="+isoDay(0))) || []).slice(0, 40),
      ins: ((await safe("/stock/insider-transactions?symbol="+q+"&from="+isoDay(30))) || {}).data || []
    };
    const sc = scoreStock(d);
    const top = d.news.filter(n => /^https?:\/\//.test(n.url || "")).sort((a, b) => b.datetime - a.datetime)[0];
    rows.push({s, name:NAMES[s] || s, market:MARKET_OF[s] || "Other", score:sc.score, px:sc.px, dp:sc.dp,
      why:Object.keys(WEIGHTS).filter(k => sc.comps[k]).map(k => sc.comps[k].txt),
      story:top ? {h:String(top.headline).slice(0, 200), u:top.url, src:top.source} : null});
    for (const n of d.news) general.push({...n, related:s});
  }
  const names = [];
  for (const s of all){
    if (s.length > 1) names.push([s, new RegExp("\\b"+reEsc(s)+"\\b"), 3]);
    const nm = NAMES[s]; if (nm && nm.length > 3 && nm !== "Strategy") names.push([s, new RegExp("\\b"+reEsc(nm)+"\\b", "i"), 3]);
  }
  const scored = rows.filter(r => r.score != null);
  const markets = Object.keys(MARKETS).map(m => {
    const l = scored.filter(r => r.market === m);
    return {m, avg:l.length ? l.reduce((a, r) => a + r.score, 0) / l.length : null};
  }).filter(m => m.avg != null).sort((a, b) => b.avg - a.avg);
  return {
    day:nyDay(), at:Date.now(),
    index,
    headlines:rankNews(general, names).slice(0, 8),
    crypto:rankNews(crypto, [["meme", MEME, 4]]).slice(0, 4),
    bull:scored.filter(r => r.score >= 0.12).sort((a, b) => b.score - a.score).slice(0, 5),
    bear:scored.filter(r => r.score <= -0.12).sort((a, b) => a.score - b.score).slice(0, 3),
    markets,
    covered:scored.length, universe:all.length
  };
}

// ---------- rendering ----------
const COL = {ink:"#0B1726", muted:"#5B6B80", line:"#D5DEE9", bg:"#F3F7FB", card:"#FFFFFF", accent:"#0E7490", up:"#047857", down:"#B91C1C", warm:"#B45309"};
const longDay = day => new Date(day+"T12:00:00Z").toLocaleDateString("en-US", {weekday:"long", month:"long", day:"numeric", year:"numeric", timeZone:"UTC"});
export const subjectFor = I => "Whale Sonar Daily · "+new Date(I.day+"T12:00:00Z").toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric", timeZone:"UTC"})+
  (I.headlines[0] ? ": "+I.headlines[0].h.slice(0, 70)+(I.headlines[0].h.length > 70 ? "…" : "") : "");
const rh = s => "https://robinhood.com/us/en/stocks/"+encodeURIComponent(s)+"/";
const score = v => { const n = Math.round(v * 100); return (n > 0 ? "+" : n < 0 ? "−" : "")+Math.abs(n); };

export const DISCLAIMER = "Whale Sonar Daily is a general, impersonal publication for information and education only. It is not investment, " +
  "financial, legal or tax advice, and it is not a recommendation or offer to buy or sell any security. The stocks to watch are produced " +
  "automatically by the published formula described in each issue from third-party data that may be late, incomplete or wrong; they are the same for every reader " +
  "and do not consider your goals, finances or risk tolerance. Scores describe recent data, not future prices. Investing involves risk, including " +
  "loss of principal, and past performance does not guarantee future results. Do your own research and consider talking to a licensed financial " +
  "professional before you invest. No company pays to be included, and the people who run Whale Sonar may hold positions in securities mentioned.";
export const METHOD = "How the screen works: each of "+Object.values(MARKETS).flat().length+" large U.S. stocks gets a score from −100 to +100 blending " +
  "analyst ratings (35%), the tone of the last 3 days of headlines by keyword matching (35%), insider buying and selling over 30 days (15%) " +
  "and the last session's price move (15%). \"Watch for strength\" lists scores of +12 or more; \"watch for weakness\" lists −12 or less.";

// links: {unsubscribe, manage, web}
export function renderIssue(I, links){
  const S = `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${COL.ink}`;
  const h2 = t => `<h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${COL.muted};margin:28px 0 10px">${esc(t)}</h2>`;
  const story = x => `<tr><td style="padding:10px 0;border-bottom:1px solid ${COL.line}"><a href="${esc(x.u)}" style="color:${COL.ink};text-decoration:none;font-weight:600;font-size:15px;line-height:1.4">${esc(x.h)}</a>` +
    `<div style="font-size:12px;color:${COL.muted};margin-top:3px">${esc(x.src)}${x.tags.length ? " · "+x.tags.map(esc).join(" · ") : ""}</div></td></tr>`;
  const pick = (r, up) => `<tr><td style="padding:12px 0;border-bottom:1px solid ${COL.line}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="font-size:15px"><a href="${esc(rh(r.s))}" style="color:${COL.ink};font-weight:700;text-decoration:none;font-family:Menlo,Consolas,monospace">${esc(r.s)}</a> <span style="color:${COL.muted}">${esc(r.name)} · ${esc(r.market)}</span></td>` +
    `<td align="right" style="white-space:nowrap;font-family:Menlo,Consolas,monospace;font-weight:700;color:${up ? COL.up : COL.down}">${score(r.score)}</td></tr></table>` +
    `<div style="font-size:13px;color:${COL.muted};margin-top:4px">${r.px ? "$"+r.px.toFixed(2)+" · " : ""}${r.why.map(esc).join(" · ")}</div>` +
    (r.story ? `<div style="font-size:13px;margin-top:4px">Latest: <a href="${esc(r.story.u)}" style="color:${COL.accent}">${esc(r.story.h)}</a></div>` : "") + `</td></tr>`;
  const table = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  const idx = I.index.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>${I.index.map(x =>
    `<td style="padding:10px;border:1px solid ${COL.line};background:${COL.card}"><div style="font-size:11px;color:${COL.muted};text-transform:uppercase;letter-spacing:.06em">${esc(x.name)}</div>` +
    `<div style="font-family:Menlo,Consolas,monospace;font-weight:700;color:${x.dp >= 0 ? COL.up : COL.down}">${pct(x.dp, 2)}</div></td>`).join("")}</tr></table>` +
    `<div style="font-size:11px;color:${COL.muted};margin-top:4px">Index ETF moves in the last session.</div>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subjectFor(I))}</title></head>
<body style="margin:0;background:${COL.bg};${S}">
<div style="display:none;max-height:0;overflow:hidden">${esc((I.headlines[0] || {}).h || "Today's top market news and stocks to watch.")}</div>
<div style="max-width:620px;margin:0 auto;padding:24px 18px">
${links.web ? `<p style="font-size:12px;color:${COL.muted};margin:0 0 12px;text-align:right"><a href="${esc(links.web)}" style="color:${COL.muted}">View in your browser</a></p>` : ""}
<div style="background:${COL.card};border:1px solid ${COL.line};border-radius:12px;padding:24px 22px">
<div style="font-weight:800;font-size:20px;color:${COL.accent}">Whale Sonar Daily</div>
<div style="font-size:13px;color:${COL.muted}">${esc(longDay(I.day))} · top market news and stocks to watch</div>
${idx}
${h2("Top stories")}
${I.headlines.length ? table(I.headlines.map(story).join("")) : `<p style="color:${COL.muted}">No major headlines came through this morning.</p>`}
${h2("Stocks to watch for strength")}
${I.bull.length ? table(I.bull.map(r => pick(r, true)).join("")) : `<p style="color:${COL.muted}">No stock on the list scores clearly positive today.</p>`}
${h2("Stocks to watch for weakness")}
${I.bear.length ? table(I.bear.map(r => pick(r, false)).join("")) : `<p style="color:${COL.muted}">No stock on the list scores clearly negative today.</p>`}
${I.markets.length ? `<p style="font-size:13px;color:${COL.muted};margin:14px 0 0">Strongest sector: <b style="color:${COL.ink}">${esc(I.markets[0].m)}</b> (${score(I.markets[0].avg)}). Weakest: <b style="color:${COL.ink}">${esc(I.markets.at(-1).m)}</b> (${score(I.markets.at(-1).avg)}).</p>` : ""}
${I.crypto.length ? h2("Crypto and meme coins") + table(I.crypto.map(story).join("")) : ""}
<p style="font-size:12px;color:${COL.muted};margin:24px 0 0;line-height:1.5">${esc(METHOD)}</p>
<p style="font-size:12px;color:${COL.muted};margin:10px 0 0;line-height:1.5"><b>Not financial advice.</b> ${esc(DISCLAIMER)}</p>
</div>
<div style="font-size:12px;color:${COL.muted};line-height:1.6;padding:16px 4px">
<p style="margin:0 0 8px">You're receiving this because you signed up for Whale Sonar Daily at ${esc(C.baseUrl)} and confirmed your email.</p>
<p style="margin:0 0 8px">${links.unsubscribe ? `<a href="${esc(links.unsubscribe)}" style="color:${COL.accent}">Unsubscribe</a> · ` : ""}<a href="${esc(links.manage)}" style="color:${COL.accent}">Manage your account</a> · <a href="${esc(C.baseUrl)}/terms.html" style="color:${COL.accent}">Terms</a> · <a href="${esc(C.baseUrl)}/privacy.html" style="color:${COL.accent}">Privacy</a></p>
<p style="margin:0">Headlines link to and belong to their publishers. Market data from Finnhub.</p>
${C.postalAddress ? `<p style="margin:8px 0 0">Whale Sonar · ${esc(C.postalAddress)}</p>` : ""}
</div></div></body></html>`;
  const line = x => "- "+x.h+" ("+x.src+")\n  "+x.u;
  const pickT = r => "- "+r.s+" "+r.name+" ("+score(r.score)+"): "+r.why.join("; ");
  const text = ["WHALE SONAR DAILY — "+longDay(I.day), "",
    I.index.length ? I.index.map(x => x.name+" "+pct(x.dp, 2)).join(" · ")+"\n" : "",
    "TOP STORIES", ...I.headlines.map(line), "",
    "STOCKS TO WATCH FOR STRENGTH", ...(I.bull.length ? I.bull.map(pickT) : ["None today."]), "",
    "STOCKS TO WATCH FOR WEAKNESS", ...(I.bear.length ? I.bear.map(pickT) : ["None today."]), "",
    ...(I.crypto.length ? ["CRYPTO AND MEME COINS", ...I.crypto.map(line), ""] : []),
    METHOD, "", "NOT FINANCIAL ADVICE. "+DISCLAIMER, "",
    "You're receiving this because you signed up at "+C.baseUrl+".",
    links.unsubscribe ? "Unsubscribe: "+links.unsubscribe : "", "Manage your account: "+links.manage,
    C.postalAddress ? "Whale Sonar · "+C.postalAddress : ""].join("\n");
  return {subject:subjectFor(I), html, text};
}

// ---------- sending ----------
export const unsubUrl = tok => C.baseUrl+"/account.html?a=unsubscribe&t="+encodeURIComponent(tok);

export async function sendIssue(db, I, {log = console.log} = {}){
  if (!C.postalAddress) throw new Error("POSTAL_ADDRESS is not set. U.S. law (CAN-SPAM) requires a postal address in every newsletter, so nothing was sent.");
  const list = db.prepare("SELECT id, email, unsub FROM users WHERE verified = 1 AND newsletter = 1 AND (last_issue IS NULL OR last_issue < ?)").all(I.day);
  const mark = db.prepare("UPDATE users SET last_issue = ? WHERE id = ?");
  let sent = 0, failed = 0;
  for (const u of list){
    const unsubscribe = unsubUrl(u.unsub);
    const m = renderIssue(I, {unsubscribe, manage:C.baseUrl+"/#account", web:C.baseUrl+"/issue/"+I.day});
    try {
      await sendMail({to:u.email, subject:m.subject, text:m.text, html:m.html, headers:{
        "List-Unsubscribe":"<"+C.baseUrl+"/api/unsubscribe?t="+encodeURIComponent(u.unsub)+">",
        "List-Unsubscribe-Post":"List-Unsubscribe=One-Click",
        "List-Id":"Whale Sonar Daily <daily."+new URL(C.baseUrl).hostname+">"
      }});
      mark.run(I.day, u.id); sent++;
    } catch(e){ failed++; log("[newsletter] send failed for user "+u.id+": "+e.message); }
    await sleep(150);
  }
  db.prepare("UPDATE issues SET sent_at = ? WHERE day = ?").run(Date.now(), I.day);
  log("[newsletter] "+I.day+": sent "+sent+", failed "+failed);
  return {sent, failed};
}

export function saveIssue(db, I){
  db.prepare("INSERT INTO issues(day, subject, data, created) VALUES(?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET subject = excluded.subject, data = excluded.data, created = excluded.created")
    .run(I.day, subjectFor(I), JSON.stringify(I), Date.now());
}

// Weekdays only, once the configured New York time has passed and today's issue hasn't gone out.
export function startScheduler(db, {log = console.log} = {}){
  let busy = false;
  const [hh, mm] = C.sendAt.split(":").map(Number);
  async function tick(){
    if (busy || !C.finnhubKey) return;
    const now = new Date();
    const ny = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York", weekday:"short", hour:"numeric", minute:"numeric", hourCycle:"h23"}).formatToParts(now);
    const g = t => (ny.find(p => p.type === t) || {}).value;
    if (g("weekday") === "Sat" || g("weekday") === "Sun") return;
    if (+g("hour") * 60 + +g("minute") < hh * 60 + mm) return;
    const day = nyDay();
    const row = db.prepare("SELECT data, sent_at FROM issues WHERE day = ?").get(day);
    if (row && row.sent_at) return;
    busy = true;
    try {
      let I = row ? JSON.parse(row.data) : null;
      if (!I){ log("[newsletter] building "+day); I = await buildIssue(C.finnhubKey); saveIssue(db, I); }
      await sendIssue(db, I, {log});
    } catch(e){ log("[newsletter] "+e.message); }
    finally { setTimeout(() => { busy = false; }, 30*60e3); } // after a failure, wait 30 minutes before retrying
  }
  setInterval(tick, 60e3).unref();
  setTimeout(tick, 5e3).unref();
}

// ---------- command line ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const mode = process.argv[2];
  const I = await buildIssue(C.finnhubKey, {log:m => process.stderr.write("\r"+m.padEnd(50))});
  process.stderr.write("\n");
  if (mode === "--send"){
    const { openDb } = await import("./db.js");
    const db = openDb(); saveIssue(db, I); await sendIssue(db, I);
  } else {
    const m = renderIssue(I, {unsubscribe:C.baseUrl+"/account.html?a=unsubscribe&t=PREVIEW", manage:C.baseUrl+"/#account"});
    fs.mkdirSync(C.dataDir, {recursive:true});
    const f = path.join(C.dataDir, "preview.html");
    fs.writeFileSync(f, m.html);
    console.log("Subject:", m.subject, "\nWrote", f);
  }
}
