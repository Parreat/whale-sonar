// Whale Sonar server: serves the site and runs accounts and the daily newsletter.
// No framework; Node's http module, the built-in SQLite driver and nodemailer.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { C, TERMS_VERSION, PRIVACY_VERSION } from "./config.js";
import { openDb, sweep } from "./db.js";
import { hashPassword, checkPassword, fakeCheck, newToken, sha256, normEmail, passwordProblem, limited } from "./security.js";
import { sendMail, accountEmail, esc } from "./mail.js";
import { renderIssue, startScheduler } from "./newsletter.js";

const SESSION_DAYS = 30;
const COOKIE = C.secure ? "__Host-ws_sid" : "ws_sid";
const PAGES = {"/":"index.html", "/index.html":"index.html", "/account.html":"account.html",
  "/terms.html":"terms.html", "/privacy.html":"privacy.html", "/disclaimer.html":"disclaimer.html"};
const STATIC = {"/favicon.svg":["favicon.svg", "image/svg+xml"], "/site.css":["site.css", "text/css; charset=utf-8"], "/robots.txt":["robots.txt", "text/plain; charset=utf-8"]};

// ---------- responses ----------
// Every inline <script> in a page gets its hash in the CSP, so no other script can run.
const pageCache = new Map();
function loadPage(file){
  const f = path.join(C.root, file), st = fs.statSync(f);
  const c = pageCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const body = Buffer.from(fillTemplate(fs.readFileSync(f, "utf8")));
  const hashes = [...body.toString("utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-"+crypto.createHash("sha256").update(m[1]).digest("base64")+"'");
  const csp = ["default-src 'self'", "script-src 'self' "+hashes.join(" "), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:", "connect-src 'self' https: wss:", "font-src 'self'", "object-src 'none'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; ")+(C.secure ? "; upgrade-insecure-requests" : "");
  const v = {body, csp, mtime:st.mtimeMs, etag:'"'+crypto.createHash("sha1").update(body).digest("base64url")+'"'};
  pageCache.set(file, v);
  return v;
}
// The legal pages name the operator and contact details from the environment.
function fillTemplate(html){
  const contact = C.contactEmail ? '<a href="mailto:'+esc(C.contactEmail)+'">'+esc(C.contactEmail)+'</a>' : "the email address listed on this site";
  return html.replaceAll("{{OPERATOR}}", esc(C.operator)).replaceAll("{{CONTACT}}", contact).replaceAll("{{LAW}}", esc(C.governingLaw))
    .replaceAll("{{ADDRESS_LINE}}", C.postalAddress ? " · "+esc(C.postalAddress) : "")
    .replaceAll("{{UPDATED}}", new Date(TERMS_VERSION+"T12:00:00Z").toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric", timeZone:"UTC"}));
}
function baseHeaders(res){
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (C.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
function json(res, status, obj, extra = {}){
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...extra});
  res.end(JSON.stringify(obj));
}
const fail = (res, status, error) => json(res, status, {error});

// ---------- cookies and sessions ----------
function cookies(req){
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")){
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const sessionCookie = (tok, maxAge) => COOKIE+"="+tok+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+maxAge+(C.secure ? "; Secure" : "");

export function createApp(db, {log = console.log} = {}){
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users(email, pass, created, newsletter, newsletter_consent_at, terms_version, privacy_version, unsub) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
    session: db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires > ?"),
    addSession: db.prepare("INSERT INTO sessions(hash, user_id, created, expires) VALUES(?, ?, ?, ?)"),
    dropSession: db.prepare("DELETE FROM sessions WHERE hash = ?"),
    dropSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    addToken: db.prepare("INSERT INTO tokens(hash, user_id, kind, expires) VALUES(?, ?, ?, ?)"),
    takeToken: db.prepare("DELETE FROM tokens WHERE hash = ? AND kind = ? AND expires > ? RETURNING user_id"),
    dropTokens: db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = ?")
  };

  function currentUser(req){
    const tok = cookies(req)[COOKIE];
    if (!tok || tok.length > 100) return null;
    return q.session.get(sha256(tok), Date.now()) || null;
  }
  function startSession(res, userId){
    const tok = newToken();
    q.addSession.run(sha256(tok), userId, Date.now(), Date.now() + SESSION_DAYS*864e5);
    res.setHeader("Set-Cookie", sessionCookie(tok, SESSION_DAYS*86400));
  }
  function issueToken(userId, kind, ttlMs){
    q.dropTokens.run(userId, kind);
    const tok = newToken();
    q.addToken.run(sha256(tok), userId, kind, Date.now() + ttlMs);
    return tok;
  }
  const publicUser = u => ({email:u.email, verified:!!u.verified, newsletter:!!u.newsletter, created:u.created});
  const mailSafe = async m => { try { await sendMail(m); } catch(e){ log("[mail] "+e.message); } };

  async function sendVerify(u){
    const tok = issueToken(u.id, "verify", 48*36e5);
    const m = accountEmail("Confirm your email", [
      "Thanks for creating a Whale Sonar account. Confirm this is your email address to finish"+(u.newsletter ? " and start getting Whale Sonar Daily." : "."),
      "The link works for 48 hours."
    ], {label:"Confirm my email", href:C.baseUrl+"/account.html?a=verify&t="+tok});
    await mailSafe({to:u.email, subject:"Confirm your Whale Sonar account", ...m});
  }
  async function sendReset(u){
    const tok = issueToken(u.id, "reset", 36e5);
    const m = accountEmail("Reset your password", [
      "Someone asked to reset the password for the Whale Sonar account with this email address.",
      "The link works for 1 hour and signs you out everywhere once used. If you didn't ask for this, you can ignore this email; your password hasn't changed."
    ], {label:"Choose a new password", href:C.baseUrl+"/account.html?a=reset&t="+tok});
    await mailSafe({to:u.email, subject:"Reset your Whale Sonar password", ...m});
  }

  // ---------- API ----------
  const routes = {
    "GET /api/me": async ({req, res}) => {
      const u = currentUser(req);
      json(res, 200, {user:u ? publicUser(u) : null, terms:TERMS_VERSION, privacy:PRIVACY_VERSION});
    },

    "POST /api/signup": async ({res, body, ip}) => {
      const email = normEmail(body.email);
      if (!email) return fail(res, 400, "Enter a valid email address.");
      if (body.agree !== true) return fail(res, 400, "Please confirm you're 18 or older and agree to the Terms and Privacy Policy.");
      const problem = passwordProblem(body.password, email);
      if (problem) return fail(res, 400, problem);
      // Counted after validation so typos don't use up the allowance; only requests that can send email count.
      if (limited("signup:"+ip, 5, 36e5)) return fail(res, 429, "Too many sign-ups from your network. Try again in an hour.");
      const done = () => json(res, 200, {ok:true, message:"Check "+email+" for a link to confirm your account. It can take a minute; look in spam if it doesn't show up."});
      if (limited("signup-mail:"+email, 3, 36e5)) return done();
      const existing = q.userByEmail.get(email);
      // Same answer whether or not the address is registered, so the form can't be used to find out who has an account.
      if (existing){
        await hashPassword(body.password); // take as long as a new sign-up, so timing doesn't give it away either
        if (!existing.verified) await sendVerify(existing);
        else {
          const m = accountEmail("You already have an account", [
            "Someone tried to create a Whale Sonar account with this email address, but it already has one.",
            "If it was you, sign in, or reset your password if you've forgotten it."
          ], {label:"Go to Whale Sonar", href:C.baseUrl+"/#account"});
          await mailSafe({to:email, subject:"Your Whale Sonar account", ...m});
        }
        return done();
      }
      const news = body.newsletter === true;
      const now = Date.now();
      const r = q.insertUser.run(email, await hashPassword(body.password), now, news ? 1 : 0, news ? now : null, TERMS_VERSION, PRIVACY_VERSION, newToken());
      await sendVerify(q.userById.get(r.lastInsertRowid));
      done();
    },

    "POST /api/verify": async ({res, body}) => {
      const row = typeof body.t === "string" && q.takeToken.get(sha256(body.t), "verify", Date.now());
      if (!row) return fail(res, 400, "That link has expired or was already used. Sign in, or sign up again to get a new one.");
      db.prepare("UPDATE users SET verified = 1 WHERE id = ?").run(row.user_id);
      const u = q.userById.get(row.user_id);
      startSession(res, u.id);
      json(res, 200, {ok:true, user:publicUser(u)});
    },

    "POST /api/login": async ({res, body, ip}) => {
      if (limited("login:"+ip, 20, 15*60e3)) return fail(res, 429, "Too many attempts. Wait 15 minutes and try again.");
      const email = normEmail(body.email), pw = typeof body.password === "string" ? body.password.slice(0, 200) : "";
      const u = email && q.userByEmail.get(email);
      const bad = () => fail(res, 401, "That email and password don't match an account.");
      if (!u){ await fakeCheck(pw); return bad(); }
      if (u.locked_until > Date.now()){ await fakeCheck(pw); return fail(res, 429, "This account is locked for a few minutes after too many wrong passwords. Try again later or reset your password."); }
      if (!(await checkPassword(pw, u.pass))){
        const fails = u.fails + 1;
        db.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE id = ?").run(fails >= 8 ? 0 : fails, fails >= 8 ? Date.now() + 15*60e3 : 0, u.id);
        return bad();
      }
      db.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?").run(u.id);
      if (!u.verified){ await sendVerify(u); return fail(res, 403, "Confirm your email first. We just sent a new link to "+u.email+"."); }
      startSession(res, u.id);
      json(res, 200, {ok:true, user:publicUser(u)});
    },

    "POST /api/logout": async ({req, res}) => {
      const tok = cookies(req)[COOKIE];
      if (tok) q.dropSession.run(sha256(tok));
      json(res, 200, {ok:true}, {"Set-Cookie":sessionCookie("", 0)});
    },

    "POST /api/forgot": async ({res, body, ip}) => {
      if (limited("forgot:"+ip, 5, 36e5)) return fail(res, 429, "Too many requests. Try again in an hour.");
      const email = normEmail(body.email);
      if (!email) return fail(res, 400, "Enter a valid email address.");
      const u = q.userByEmail.get(email);
      if (u && !limited("forgot-mail:"+email, 3, 36e5)) await (u.verified ? sendReset(u) : sendVerify(u));
      json(res, 200, {ok:true, message:"If "+email+" has an account, we've sent it a link to reset the password."});
    },

    "POST /api/reset": async ({res, body}) => {
      if (typeof body.t !== "string") return fail(res, 400, "That link is missing its code.");
      const hash = sha256(body.t);
      const peek = db.prepare("SELECT t.user_id, u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.kind = 'reset' AND t.expires > ?").get(hash, Date.now());
      if (!peek) return fail(res, 400, "That reset link has expired or was already used. Ask for a new one.");
      const problem = passwordProblem(body.password, peek.email);
      if (problem) return fail(res, 400, problem);
      if (!q.takeToken.get(hash, "reset", Date.now())) return fail(res, 400, "That reset link was already used.");
      db.prepare("UPDATE users SET pass = ?, fails = 0, locked_until = 0 WHERE id = ?").run(await hashPassword(body.password), peek.user_id);
      q.dropSessions.run(peek.user_id);
      startSession(res, peek.user_id);
      json(res, 200, {ok:true, user:publicUser(q.userById.get(peek.user_id))});
    },

    "POST /api/password": async ({req, res, body}) => {
      const u = currentUser(req); if (!u) return fail(res, 401, "Sign in first.");
      if (limited("pw:"+u.id, 10, 36e5)) return fail(res, 429, "Too many attempts. Try again later.");
      if (!(await checkPassword(String(body.current || "").slice(0, 200), u.pass))) return fail(res, 403, "Your current password isn't right.");
      const problem = passwordProblem(body.password, u.email);
      if (problem) return fail(res, 400, problem);
      db.prepare("UPDATE users SET pass = ? WHERE id = ?").run(await hashPassword(body.password), u.id);
      q.dropSessions.run(u.id);
      startSession(res, u.id);
      json(res, 200, {ok:true, message:"Password changed. Other devices have been signed out."});
    },

    "POST /api/newsletter": async ({req, res, body}) => {
      const u = currentUser(req); if (!u) return fail(res, 401, "Sign in first.");
      const on = body.on === true;
      db.prepare("UPDATE users SET newsletter = ?, newsletter_consent_at = ? WHERE id = ?").run(on ? 1 : 0, on ? Date.now() : u.newsletter_consent_at, u.id);
      json(res, 200, {ok:true, user:publicUser(q.userById.get(u.id))});
    },

    // Right of access / portability: everything stored about the account, minus secrets.
    "GET /api/export": async ({req, res}) => {
      const u = currentUser(req); if (!u) return fail(res, 401, "Sign in first.");
      const sessions = db.prepare("SELECT created, expires FROM sessions WHERE user_id = ?").all(u.id);
      const iso = t => t ? new Date(t).toISOString() : null;
      json(res, 200, {
        exported:iso(Date.now()), email:u.email, account_created:iso(u.created), email_confirmed:!!u.verified,
        newsletter_subscribed:!!u.newsletter, newsletter_consent_given:iso(u.newsletter_consent_at), last_newsletter_sent:u.last_issue,
        terms_version_accepted:u.terms_version, privacy_version_accepted:u.privacy_version,
        active_sessions:sessions.map(s => ({signed_in:iso(s.created), expires:iso(s.expires)})),
        note:"Your password is stored only as a one-way scrypt hash and is not included. Site settings and API keys you enter on the dashboard stay in your browser and are never sent to us."
      }, {"Content-Disposition":'attachment; filename="whale-sonar-account.json"'});
    },

    // Right to erasure: the account row goes, and sessions and tokens go with it.
    "POST /api/delete": async ({req, res, body}) => {
      const u = currentUser(req); if (!u) return fail(res, 401, "Sign in first.");
      if (limited("del:"+u.id, 10, 36e5)) return fail(res, 429, "Too many attempts. Try again later.");
      if (!(await checkPassword(String(body.password || "").slice(0, 200), u.pass))) return fail(res, 403, "That password isn't right.");
      db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
      log("[account] deleted user "+u.id);
      json(res, 200, {ok:true}, {"Set-Cookie":sessionCookie("", 0)});
    },

    // Mail clients' one-click button (RFC 8058) POSTs here; people clicking the link land on a confirm page.
    "GET /api/unsubscribe": async ({res, url}) => {
      res.writeHead(303, {Location:"/account.html?a=unsubscribe&t="+encodeURIComponent(url.searchParams.get("t") || "")}); res.end();
    },
    "POST /api/unsubscribe": async ({res, body, url}) => {
      const t = typeof body.t === "string" ? body.t : url.searchParams.get("t") || "";
      const r = t && t.length < 100 ? db.prepare("UPDATE users SET newsletter = 0 WHERE unsub = ?").run(t) : {changes:0};
      if (!r.changes && !db.prepare("SELECT 1 FROM users WHERE unsub = ?").get(t)) return fail(res, 400, "We couldn't find that subscription. It may belong to a deleted account, which means you're already off the list.");
      json(res, 200, {ok:true, message:"You're unsubscribed from Whale Sonar Daily. You won't get another issue."});
    },

    "GET /api/issues": async ({res}) => {
      json(res, 200, {issues:db.prepare("SELECT day, subject FROM issues ORDER BY day DESC LIMIT 30").all()});
    }
  };

  async function readBody(req){
    const chunks = []; let n = 0;
    for await (const c of req){ n += c.length; if (n > 16384) throw Object.assign(new Error("too large"), {status:413}); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString("utf8");
    const type = String(req.headers["content-type"] || "");
    if (!raw) return {};
    if (type.startsWith("application/json")){ try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { throw Object.assign(new Error("bad json"), {status:400}); } }
    if (type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data")) return {_form:raw};
    return {};
  }

  // Cross-site requests can't send JSON without a CORS preflight we never approve, and browsers
  // send Origin on POST, so checking both stops CSRF. The one-click unsubscribe is token-authorized.
  function crossSite(req, route){
    if (req.method !== "POST" || route === "POST /api/unsubscribe") return false;
    const o = req.headers.origin;
    if (o && o !== C.origin) return true;
    if (!o && req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) return true;
    return !String(req.headers["content-type"] || "").startsWith("application/json");
  }

  function serveIssue(res, day){
    const row = day === "latest"
      ? db.prepare("SELECT data FROM issues ORDER BY day DESC LIMIT 1").get()
      : /^\d{4}-\d{2}-\d{2}$/.test(day) && db.prepare("SELECT data FROM issues WHERE day = ?").get(day);
    if (!row){ res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); return res.end("No issue for that day yet."); }
    const m = renderIssue(JSON.parse(row.data), {manage:C.baseUrl+"/#account"});
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"public, max-age=300",
      "Content-Security-Policy":"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
    res.end(m.html);
  }

  return async function handle(req, res){
    baseHeaders(res);
    let url;
    try { url = new URL(req.url, C.baseUrl); } catch { res.writeHead(400); return res.end(); }
    const ip = (C.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
    const key = req.method+" "+url.pathname;
    try {
      if (url.pathname.startsWith("/api/")){
        const fn = routes[key];
        if (!fn) return fail(res, routes["GET "+url.pathname] || routes["POST "+url.pathname] ? 405 : 404, "Not found.");
        if (crossSite(req, key)) return fail(res, 403, "Cross-site request blocked.");
        const body = req.method === "POST" ? await readBody(req) : {};
        return await fn({req, res, body, url, ip});
      }
      if (req.method !== "GET" && req.method !== "HEAD"){ res.writeHead(405, {Allow:"GET, HEAD"}); return res.end(); }
      const issue = url.pathname.match(/^\/issue\/(latest|\d{4}-\d{2}-\d{2})$/);
      if (issue) return serveIssue(res, issue[1]);
      if (PAGES[url.pathname]){
        const p = loadPage(PAGES[url.pathname]);
        const headers = {"Content-Type":"text/html; charset=utf-8", "Content-Security-Policy":p.csp, "Cache-Control":"no-cache", ETag:p.etag};
        // Account links carry one-time codes in the URL; don't leak them in Referer.
        if (url.pathname === "/account.html") headers["Referrer-Policy"] = "no-referrer";
        if (req.headers["if-none-match"] === p.etag){ res.writeHead(304, headers); return res.end(); }
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : p.body);
      }
      if (STATIC[url.pathname]){
        const [f, type] = STATIC[url.pathname];
        res.writeHead(200, {"Content-Type":type, "Cache-Control":"public, max-age=86400"});
        return res.end(req.method === "HEAD" ? undefined : fs.readFileSync(path.join(C.root, f)));
      }
      res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); res.end("Not found.");
    } catch(e){
      if (e.status){ if (!res.headersSent) fail(res, e.status, e.status === 413 ? "Request too large." : "Bad request."); return; }
      log("[error] "+key+": "+(e.stack || e.message));
      if (!res.headersSent) fail(res, 500, "Something went wrong on our end. Try again in a moment.");
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const db = openDb();
  sweep(db);
  setInterval(() => sweep(db), 36e5).unref();
  const server = http.createServer(createApp(db));
  server.headersTimeout = 15e3; server.requestTimeout = 30e3;
  server.listen(C.port, C.host, () => {
    console.log("Whale Sonar on "+C.baseUrl+" (listening on "+C.host+":"+C.port+")");
    if (!C.smtpUrl) console.log("SMTP_URL isn't set: emails are written to "+path.join(C.dataDir, "outbox")+" instead of being sent.");
    if (!C.finnhubKey) console.log("FINNHUB_KEY isn't set: the daily newsletter is off.");
    if (!C.contactEmail) console.log("CONTACT_EMAIL isn't set: the Terms and Privacy Policy have no contact address to show.");
    if (!C.postalAddress) console.log("POSTAL_ADDRESS isn't set: newsletters won't send until it is (CAN-SPAM).");
  });
  if (C.newsletterOn) startScheduler(db);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
