import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = "test";
process.env.BASE_URL = "http://localhost:3999";
process.env.POSTAL_ADDRESS = "123 Test St, Testville, CA 90000";
delete process.env.SMTP_URL;

const { openDb } = await import("./db.js");
const { createApp } = await import("./server.js");
const { resetLimits } = await import("./security.js");
const { renderIssue, sendIssue, saveIssue, rankNews, scoreStock, tone, buildIssue } = await import("./newsletter.js");

let server, base, db;
before(async () => {
  db = openDb(":memory:");
  server = http.createServer(createApp(db, {log:() => {}}));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:"+server.address().port;
});
after(() => { server.close(); fs.rmSync(dir, {recursive:true, force:true}); });

const ORIGIN = "http://localhost:3999";
async function call(p, body, {cookie, origin = ORIGIN, type = "application/json"} = {}){
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined){ headers["content-type"] = type; if (origin) headers.origin = origin; }
  const r = await fetch(base+p, {method:body === undefined ? "GET" : "POST", headers, body:body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect:"manual"});
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return {status:r.status, json, text, headers:r.headers, cookie:(r.headers.get("set-cookie") || "").split(";")[0]};
}
function lastMail(to){
  const out = path.join(dir, "outbox");
  const files = fs.readdirSync(out).filter(f => f.includes(to.replace(/[^a-z0-9@.]/gi, "_"))).sort();
  return fs.readFileSync(path.join(out, files.at(-1)), "utf8");
}
const tokenIn = (mail, a) => decodeURIComponent(mail.match(new RegExp("a="+a+"&t=([A-Za-z0-9_%-]+)"))[1]);

test("full account lifecycle", async () => {
  resetLimits();
  const email = "Alice@Example.com";
  let r = await call("/api/signup", {email, password:"correct horse battery", newsletter:true, agree:true});
  assert.equal(r.status, 200, r.text);
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get("alice@example.com");
  assert.ok(user, "email is stored lowercased");
  assert.equal(user.verified, 0);
  assert.match(user.pass, /^scrypt\$/);
  assert.ok(!user.pass.includes("correct horse"));
  assert.ok(user.newsletter_consent_at > 0);

  r = await call("/api/login", {email, password:"correct horse battery"});
  assert.equal(r.status, 403, "unverified accounts can't sign in");

  const t = tokenIn(lastMail("alice@example.com"), "verify");
  r = await call("/api/verify", {t});
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Lax/);
  r = await call("/api/verify", {t});
  assert.equal(r.status, 400, "verify links are single use");

  r = await call("/api/login", {email:"alice@example.com", password:"wrong password here"});
  assert.equal(r.status, 401);
  r = await call("/api/login", {email:"alice@example.com", password:"correct horse battery"});
  assert.equal(r.status, 200);
  const cookie = r.cookie;
  r = await call("/api/me", undefined, {cookie});
  assert.deepEqual([r.json.user.email, r.json.user.newsletter, r.json.user.verified], ["alice@example.com", true, true]);
  assert.equal(r.json.user.pass, undefined);

  r = await call("/api/export", undefined, {cookie});
  assert.equal(r.status, 200);
  assert.equal(r.json.email, "alice@example.com");
  assert.ok(!JSON.stringify(r.json).includes(user.pass.split("$").at(-1)), "no password hash in the export");

  r = await call("/api/newsletter", {on:false}, {cookie});
  assert.equal(r.json.user.newsletter, false);
  r = await call("/api/newsletter", {on:true}, {cookie});
  assert.equal(r.json.user.newsletter, true);

  r = await call("/api/password", {current:"nope nope nope", password:"another good phrase"}, {cookie});
  assert.equal(r.status, 403);
  r = await call("/api/password", {current:"correct horse battery", password:"another good phrase"}, {cookie});
  assert.equal(r.status, 200);
  const cookie2 = r.cookie;
  assert.equal((await call("/api/me", undefined, {cookie})).json.user, null, "old sessions end on password change");

  r = await call("/api/delete", {password:"correct horse battery"}, {cookie:cookie2});
  assert.equal(r.status, 403);
  r = await call("/api/delete", {password:"another good phrase"}, {cookie:cookie2});
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
});

test("sign-up validation and no account enumeration", async () => {
  resetLimits();
  let r = await call("/api/signup", {email:"not-an-email", password:"long enough pass", agree:true});
  assert.equal(r.status, 400);
  r = await call("/api/signup", {email:"b@example.com", password:"short", agree:true});
  assert.equal(r.status, 400);
  r = await call("/api/signup", {email:"b@example.com", password:"password123", agree:true});
  assert.equal(r.status, 400);
  r = await call("/api/signup", {email:"b@example.com", password:"a fine passphrase"});
  assert.equal(r.status, 400, "must agree to the terms");
  r = await call("/api/signup", {email:"b@example.com", password:"a fine passphrase", agree:true});
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT newsletter FROM users WHERE email = 'b@example.com'").get().newsletter, 0, "newsletter is opt-in");
  const again = await call("/api/signup", {email:"b@example.com", password:"a different phrase", agree:true});
  assert.equal(again.status, 200);
  assert.equal(again.json.message, r.json.message, "same answer for existing emails");
  const forgot1 = await call("/api/forgot", {email:"b@example.com"});
  const forgot2 = await call("/api/forgot", {email:"nobody@example.com"});
  assert.equal(forgot1.status, forgot2.status);
  assert.equal(forgot1.json.message.replace("b@", ""), forgot2.json.message.replace("nobody@", ""));
  const login1 = await call("/api/login", {email:"nobody@example.com", password:"whatever12345"});
  const login2 = await call("/api/login", {email:"b@example.com", password:"whatever12345"});
  assert.equal(login1.status, 401); assert.equal(login2.status, 401);
  assert.equal(login1.json.error, login2.json.error);
});

test("password reset", async () => {
  resetLimits();
  await call("/api/signup", {email:"c@example.com", password:"first pass phrase", agree:true});
  await call("/api/verify", {t:tokenIn(lastMail("c@example.com"), "verify")});
  await call("/api/forgot", {email:"c@example.com"});
  const t = tokenIn(lastMail("c@example.com"), "reset");
  let r = await call("/api/reset", {t, password:"short"});
  assert.equal(r.status, 400);
  r = await call("/api/reset", {t, password:"second pass phrase"});
  assert.equal(r.status, 200);
  r = await call("/api/reset", {t, password:"third pass phrase"});
  assert.equal(r.status, 400, "reset links are single use");
  assert.equal((await call("/api/login", {email:"c@example.com", password:"second pass phrase"})).status, 200);
});

test("CSRF: cross-site and non-JSON posts are refused", async () => {
  resetLimits();
  let r = await call("/api/login", {email:"c@example.com", password:"second pass phrase"}, {origin:"https://evil.example"});
  assert.equal(r.status, 403);
  r = await call("/api/login", "email=c@example.com&password=second+pass+phrase", {type:"application/x-www-form-urlencoded"});
  assert.equal(r.status, 403);
});

test("login lockout and rate limits", async () => {
  resetLimits();
  await call("/api/signup", {email:"d@example.com", password:"dee pass phrase", agree:true});
  await call("/api/verify", {t:tokenIn(lastMail("d@example.com"), "verify")});
  for (let i = 0; i < 8; i++) await call("/api/login", {email:"d@example.com", password:"wrong guess "+i});
  const r = await call("/api/login", {email:"d@example.com", password:"dee pass phrase"});
  assert.equal(r.status, 429, "account locks after 8 wrong passwords");
  resetLimits();
  let last;
  for (let i = 0; i < 6; i++) last = await call("/api/signup", {email:"spam"+i+"@example.com", password:"spammy pass phrase", agree:true});
  assert.equal(last.status, 429);
});

test("unsubscribe: one-click POST and confirm page", async () => {
  resetLimits();
  await call("/api/signup", {email:"e@example.com", password:"eee pass phrase", newsletter:true, agree:true});
  await call("/api/verify", {t:tokenIn(lastMail("e@example.com"), "verify")});
  const u = db.prepare("SELECT unsub FROM users WHERE email = 'e@example.com'").get();
  let r = await call("/api/unsubscribe?t="+u.unsub);
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /account\.html\?a=unsubscribe/);
  // RFC 8058: mail providers POST form-encoded with no Origin.
  r = await call("/api/unsubscribe?t="+u.unsub, "List-Unsubscribe=One-Click", {type:"application/x-www-form-urlencoded", origin:null});
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT newsletter FROM users WHERE email = 'e@example.com'").get().newsletter, 0);
  r = await call("/api/unsubscribe", {t:"bogus"});
  assert.equal(r.status, 400);
});

test("pages carry security headers and a hash-based CSP", async () => {
  const r = await call("/");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  for (const p of ["/terms.html", "/privacy.html", "/disclaimer.html", "/account.html"]){
    const x = await call(p);
    assert.equal(x.status, 200, p);
    assert.ok(!x.text.includes("{{"), p+" has unfilled placeholders");
    if (p === "/terms.html" || p === "/privacy.html") assert.match(x.text, /123 Test St/, p+" shows the postal address");
  }
  assert.equal((await call("/server/server.js")).status, 404);
  assert.equal((await call("/data/whale-sonar.db")).status, 404);
  assert.equal((await call("/package.json")).status, 404);
});

const ISSUE = {day:"2026-09-29", at:Date.now(), index:[{s:"SPY", name:"S&P 500", px:600, dp:0.52}],
  headlines:[{h:"Fed signals <rate cut> as inflation cools", u:"https://news.example/a", src:"Reuters", t:Date.now(), tags:["fed"]}],
  crypto:[], bull:[{s:"NVDA", name:"NVIDIA", market:"Semiconductors", score:0.41, px:180, dp:1.2, why:["82% of 60 analysts rate it a buy"], story:null}],
  bear:[], markets:[{m:"Semiconductors", avg:0.3}, {m:"Energy", avg:-0.2}], covered:40, universe:40};

test("newsletter render: escaping, disclaimer, unsubscribe, address", () => {
  const m = renderIssue(ISSUE, {unsubscribe:"https://x.example/u?t=abc", manage:"https://x.example/#account"});
  assert.ok(m.html.includes("&lt;rate cut&gt;") && !m.html.includes("<rate cut>"));
  assert.match(m.html, /Not financial advice/);
  assert.match(m.html, /Unsubscribe/);
  assert.match(m.html, /123 Test St/);
  assert.match(m.text, /Unsubscribe: https:\/\/x\.example\/u\?t=abc/);
  assert.match(m.subject, /^Whale Sonar Daily · Tue, Sep 29: Fed signals/);
});

test("newsletter send: only confirmed subscribers, once per day, with List-Unsubscribe", async () => {
  resetLimits();
  db.prepare("UPDATE users SET newsletter = 0").run();
  await call("/api/signup", {email:"f@example.com", password:"eff pass phrase", newsletter:true, agree:true});
  await call("/api/verify", {t:tokenIn(lastMail("f@example.com"), "verify")});
  await call("/api/signup", {email:"g@example.com", password:"gee pass phrase", newsletter:true, agree:true}); // never confirmed
  saveIssue(db, ISSUE);
  let r = await sendIssue(db, ISSUE, {log:() => {}});
  assert.deepEqual(r, {sent:1, failed:0});
  const mail = lastMail("f@example.com");
  assert.match(mail, /List-Unsubscribe: <http:\/\/localhost:3999\/api\/unsubscribe\?t=/);
  assert.match(mail, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  r = await sendIssue(db, ISSUE, {log:() => {}});
  assert.deepEqual(r, {sent:0, failed:0}, "no duplicates on a re-run");
  const web = await call("/issue/2026-09-29");
  assert.equal(web.status, 200);
  assert.ok(!/t=[A-Za-z0-9_-]{20,}/.test(web.text), "the public web copy has no personal unsubscribe token");
});

test("scoring helpers", () => {
  assert.ok(tone("Nvidia beats estimates, shares surge") > 0);
  assert.ok(tone("Tesla shares plunge after recall") < 0);
  const now = Date.now() / 1000;
  const ranked = rankNews([
    {headline:"Local bakery opens", url:"https://a.example", datetime:now},
    {headline:"Fed cuts interest rates; NVIDIA jumps", url:"https://b.example", datetime:now},
    {headline:"Fed cuts interest rates; NVIDIA jumps", url:"https://c.example", datetime:now},
    {headline:"No link", url:"javascript:alert(1)", datetime:now}
  ], [["NVDA", /\bNVIDIA\b/i, 3]]);
  assert.equal(ranked.length, 2, "dedupes and drops non-http links");
  assert.match(ranked[0].h, /Fed/);
  const s = scoreStock({rec:{strongBuy:20, buy:20, hold:5, sell:0, strongSell:0}, quote:{c:105, pc:100}, news:[], ins:[]});
  assert.ok(s.score > 0);
  assert.equal(scoreStock({}).score, null);
});

test("buildIssue against a fake Finnhub", async () => {
  const now = Math.floor(Date.now() / 1000);
  const calls = [];
  const fake = async url => {
    const u = new URL(url); calls.push(u.pathname);
    assert.equal(u.searchParams.get("token"), "k");
    const s = u.searchParams.get("symbol");
    const body = {
      "/api/v1/news": [{headline:"Fed holds rates as inflation cools", url:"https://n.example/1", source:"Reuters", datetime:now}],
      "/api/v1/quote": {c:s === "TSLA" ? 95 : 104, pc:100},
      "/api/v1/stock/recommendation": [s === "TSLA" ? {strongBuy:1, buy:2, hold:10, sell:6, strongSell:4} : {strongBuy:20, buy:20, hold:3, sell:0, strongSell:0}],
      "/api/v1/company-news": s === "TSLA"
        ? [{headline:"Tesla shares plunge on recall", url:"https://n.example/t1", source:"X", datetime:now}, {headline:"Tesla misses delivery estimates", url:"https://n.example/t2", source:"X", datetime:now}]
        : [{headline:s+" beats estimates", url:"https://n.example/"+s, source:"Y", datetime:now}, {headline:s+" shares jump", url:"https://n.example/j"+s, source:"Y", datetime:now}],
      "/api/v1/stock/insider-transactions": {data:[]}
    }[u.pathname];
    if (u.pathname === "/api/v1/quote" && s === "RIVN") return new Response("", {status:500});
    return new Response(JSON.stringify(body), {status:200});
  };
  const I = await buildIssue("k", {fetchImpl:fake, gap:0, backoff:0});
  assert.equal(I.index.length, 4);
  assert.ok(I.headlines.length >= 1);
  assert.equal(I.bull.length, 5);
  assert.equal(I.bear[0].s, "TSLA");
  assert.ok(I.bull.every(r => r.score >= 0.12 && r.why.length));
  const bad = async () => new Response("", {status:401});
  await assert.rejects(buildIssue("k", {fetchImpl:bad, gap:0}), /rejected the key/);
});
