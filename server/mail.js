// Sends through SMTP_URL, or writes messages to data/outbox when it isn't set (local development).
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { C } from "./config.js";

let transport;
function getTransport(){
  if (transport) return transport;
  transport = C.smtpUrl
    ? nodemailer.createTransport(C.smtpUrl, {disableFileAccess:true, disableUrlAccess:true})
    : null;
  return transport;
}

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

export async function sendMail({to, subject, text, html, headers}){
  const t = getTransport();
  const msg = {from:C.mailFrom, to, subject, text, html, headers};
  if (!t){
    const dir = path.join(C.dataDir, "outbox");
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const f = path.join(dir, Date.now() + "-" + to.replace(/[^a-z0-9@.]/gi, "_") + ".txt");
    fs.writeFileSync(f, "To: "+to+"\nSubject: "+subject+"\n"+Object.entries(headers || {}).map(([k, v]) => k+": "+v+"\n").join("")+"\n"+text, {mode:0o600});
    if (process.env.NODE_ENV !== "test") console.log("[mail] SMTP_URL not set; wrote", path.relative(C.root, f));
    return;
  }
  await t.sendMail(msg);
}

// A plain branded wrapper for account emails (verification, password reset). These are
// transactional, so they carry no unsubscribe link, but they still say who sent them.
export function accountEmail(title, lines, button){
  const text = [title, "", ...lines, "", button ? button.label+": "+button.href : "", "", "— Whale Sonar · "+C.baseUrl].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F3F7FB;font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0B1726">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<p style="font-weight:700;font-size:17px;margin:0 0 20px;color:#0E7490">Whale Sonar</p>
<div style="background:#fff;border:1px solid #D5DEE9;border-radius:10px;padding:24px">
<h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>
${lines.map(l => `<p style="margin:0 0 12px">${esc(l)}</p>`).join("")}
${button ? `<p style="margin:20px 0 8px"><a href="${esc(button.href)}" style="display:inline-block;background:#0E7490;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px">${esc(button.label)}</a></p>
<p style="margin:0;font-size:12px;color:#5B6B80;word-break:break-all">Or paste this link into your browser: ${esc(button.href)}</p>` : ""}
</div>
<p style="font-size:12px;color:#5B6B80;margin:16px 0 0">You're getting this because this address was entered on ${esc(C.baseUrl)}. If that wasn't you, ignore this email and nothing will happen.</p>
</div></body></html>`;
  return {text, html};
}
