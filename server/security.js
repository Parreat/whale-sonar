// Password hashing, random tokens, input checks and rate limits.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const N = 2**15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize("NFKC"), salt, KEYLEN, {N, r:R, p:P, maxmem:MAXMEM});
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function checkPassword(pw, stored){
  const [alg, n, r, p, salt, key] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64"), want.length, {N:+n, r:+r, p:+p, maxmem:128 * +n * +r * 2});
  return crypto.timingSafeEqual(want, got);
}

// Burn the same time as a real check so a login for an unknown email isn't measurably faster.
let dummy;
export async function fakeCheck(pw){
  dummy ||= await hashPassword("not-a-real-password");
  await checkPassword(String(pw || ""), dummy);
  return false;
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");

// Deliberately simple: one @, a dot in the domain, no spaces or control characters, sane lengths.
export function normEmail(e){
  const s = String(e || "").trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@<>()[\]\\,;:"\x00-\x1f]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) return null;
  return s;
}

const COMMON = new Set(("password password1 password12 password123 password1234 123456789 1234567890 12345678910 qwertyuiop " +
  "iloveyou1 sunshine1 princess1 football1 baseball1 welcome1 welcome123 admin12345 letmein123 passw0rd1 " +
  "qwerty1234 qwerty12345 abc1234567 1q2w3e4r5t 1qaz2wsx3edc trustno1234 whalesonar whalesonar1 changeme12 " +
  "0987654321 1111111111 0000000000 aaaaaaaaaa zaq12wsxcde").split(" "));

// NIST 800-63B style: length over composition rules, and block the obvious ones.
export function passwordProblem(pw, email){
  if (typeof pw !== "string") return "Enter a password.";
  if ([...pw].length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "Use 200 characters or fewer.";
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return "That password is too common. Try a short phrase instead.";
  if (email && (low === email || low === email.split("@")[0])) return "Don't use your email as your password.";
  return null;
}

// Fixed-window counters in memory. Fine for one server process.
const buckets = new Map();
export function limited(key, max, windowMs, now = Date.now()){
  let b = buckets.get(key);
  if (!b || b.reset <= now){ b = {n:0, reset:now + windowMs}; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 10*60e3).unref();
export const resetLimits = () => buckets.clear();
