// All settings come from environment variables; see README.md.
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

export const C = {
  root,
  port: +env.PORT || 3000,
  host: env.HOST || "127.0.0.1",
  baseUrl: (env.BASE_URL || "http://localhost:" + (+env.PORT || 3000)).replace(/\/+$/, ""),
  dataDir: env.DATA_DIR || path.join(root, "data"),
  // Trust X-Forwarded-For only behind a proxy you run, or rate limits can be dodged by spoofing it.
  trustProxy: env.TRUST_PROXY === "1",
  finnhubKey: env.FINNHUB_KEY || "",
  smtpUrl: env.SMTP_URL || "",
  mailFrom: env.MAIL_FROM || "Whale Sonar <no-reply@localhost>",
  // CAN-SPAM requires a valid physical postal address in every commercial email.
  postalAddress: env.POSTAL_ADDRESS || "",
  operator: env.OPERATOR_NAME || "the Whale Sonar team",
  contactEmail: env.CONTACT_EMAIL || "",
  governingLaw: env.GOVERNING_LAW || "the state or country where the operator is based",
  sendAt: /^\d{1,2}:\d{2}$/.test(env.NEWSLETTER_SEND_AT || "") ? env.NEWSLETTER_SEND_AT : "07:30", // America/New_York
  newsletterOn: env.NEWSLETTER_ENABLED !== "0",
  // Ask tab: off unless ASK_ENABLED=1 and an Anthropic key is set. It gives personalized answers,
  // so have a securities lawyer review it before turning it on.
  anthropicKey: env.ANTHROPIC_API_KEY || "",
  askModel: env.ASK_MODEL || "claude-opus-5-5",
  askUserDaily: Math.max(1, +env.ASK_USER_DAILY || 15),
  askDaily: Math.max(1, +env.ASK_DAILY || 300)
};
C.askOn = env.ASK_ENABLED === "1" && !!C.anthropicKey;
C.operatorSet = !!env.OPERATOR_NAME;
C.governingLawSet = !!env.GOVERNING_LAW;
C.secure = C.baseUrl.startsWith("https://");
C.origin = new URL(C.baseUrl).origin;

// Bump these when the documents change; accounts record which version they agreed to.
export const TERMS_VERSION = "2026-09-29";
export const PRIVACY_VERSION = "2026-09-29";
