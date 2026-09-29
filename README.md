# Whale Sonar

A dashboard of whale trades in Solana meme coins and U.S. stocks, stock signals and ranked market news. It also has free accounts and **Whale Sonar Daily**, a weekday-morning email with the top market headlines and the stocks the signal screen flags.

- `index.html` is the whole dashboard. It still works as a static page (for example on GitHub Pages); the account and newsletter features appear only when it's served by the Whale Sonar server.
- `server/` holds the server: accounts, sessions, the newsletter builder and scheduler, and email. It uses Node's built-in `http` and `node:sqlite` modules plus one dependency, `nodemailer`.
- `terms.html`, `privacy.html` and `disclaimer.html` are the legal pages. `account.html` handles email confirmation, password resets and unsubscribes.

## Run it locally

Needs Node 22.5 or newer.

```sh
npm install
npm start            # http://localhost:3000
npm test
```

Without `SMTP_URL`, emails aren't sent. They're written to `data/outbox/` so you can open the confirmation links by hand.

To preview a newsletter with real data (takes about 3 minutes on Finnhub's free plan):

```sh
FINNHUB_KEY=your_key npm run newsletter:preview   # writes data/preview.html
```

## The Ask tab

Signed-in users can ask questions about stocks, budgets and investing plans. The answers come from Claude (`claude-opus-5-5` by default) and use real data. For each ticker the answer covers, the server looks up Finnhub data: price, analyst ratings, key metrics, headlines and insider trades, plus the site's signal score. It also reads the latest daily screen. Users can add optional "About you" details (amount, time horizon, risk tolerance, experience, emergency fund) to tailor the answers.

- **Off by default.** The tab appears only when `ASK_ENABLED=1` and `ANTHROPIC_API_KEY` are set. It needs the server, so it never appears on GitHub Pages.
- **Cost:** each question makes 2 to 4 calls to the model. At Opus 5.5 prices ($4 in / $20 out per million tokens), that's roughly 5 to 15 cents a question. `ASK_USER_DAILY` (default 15) and `ASK_DAILY` (default 300) cap the spend, so the default worst case is about $30–45 a day. `ASK_MODEL=claude-sonnet-5-5` roughly halves the cost.
- **Privacy:** question text, profile details and answers are never stored. Only a per-user daily count is kept, and it's deleted after 7 days.
- **Safeguards:**
  - Users must be signed in (18+, Terms accepted) and tick an acknowledgment that the answers are AI-generated and not from a licensed adviser.
  - The system prompt matches ideas to the person's risk and puts an emergency fund and paying off debt first. It lists the risks of each idea, never promises returns, and discourages leverage, margin, options and gambling-like behavior.
  - Market data and headlines are treated as data, not instructions.
- **Legal risk:** unlike the rest of the site, Ask gives *personalized* answers. In the U.S., personalized investment advice given for compensation, which can include ad revenue or a paid plan, generally requires registering as an investment adviser. The Terms, Privacy Policy and Disclaimer cover Ask, but have a securities lawyer review it before you turn it on.

## Deploy

1. Run `npm start` on any host that runs Node (a VPS, Fly.io, Render, Railway…), behind HTTPS. `BASE_URL` must be the public `https://` address; that turns on secure cookies and HSTS.
2. Set the environment variables in `.env.example`. `DATA_DIR` must be on a persistent disk, because the SQLite database lives there. Back it up.
3. Set up an email provider and add SPF, DKIM and DMARC records for the sending domain, or the newsletter will land in spam.
4. The newsletter goes out on weekdays at `NEWSLETTER_SEND_AT` New York time. It won't send until `FINNHUB_KEY` and `POSTAL_ADDRESS` are set. Each issue is saved, and anyone can view it at `/issue/YYYY-MM-DD` or `/issue/latest`.

The server keeps rate limits in memory, so run a single process.

## What's in place for account safety

- Passwords are hashed with scrypt and a random salt. The rules follow NIST 800-63B: at least 10 characters, and common passwords are blocked.
- Sessions use random tokens, and the database stores only their SHA-256 hashes. They're kept in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` with the `__Host-` prefix over HTTPS. Changing or resetting the password signs out every other session.
- Accounts must confirm their email (double opt-in) before they can sign in or receive the newsletter. Confirmation links expire after 48 hours and reset links after 1 hour. Both are single use.
- Sign-up, sign-in and password reset give the same answer and take about the same time whether or not an email is registered, so they can't be used to find out who has an account.
- There are rate limits per IP address and per email. An account locks for 15 minutes after 8 wrong passwords.
- Cross-site requests are blocked with an Origin check and a JSON-only API. Every page gets a strict Content-Security-Policy with hashed scripts, plus HSTS, `X-Frame-Options`, `nosniff` and `Referrer-Policy`.
- Users can download their data and delete their account themselves. Accounts that never confirm their email are purged after 7 days.

## What's in place for the law (not legal advice — have a lawyer review before launch)

| Area | What the site does |
| --- | --- |
| Investment advice (U.S. Investment Advisers Act, similar rules elsewhere) | The newsletter is impersonal: every reader gets the same issue, on a regular schedule, made by a published formula. It says "stocks to watch", not "buy" or "sell". It carries a full disclaimer and conflict disclosure, and has a dedicated disclaimer page. |
| Email marketing (CAN-SPAM, CASL, GDPR/PECR) | Newsletter consent is opt-in with an unchecked box, confirmed by double opt-in, and the time of consent is recorded. Every issue has a one-click unsubscribe (RFC 8058 `List-Unsubscribe` headers plus a link) and a postal address, and says why the reader is getting it. Unsubscribes take effect immediately. |
| Privacy (GDPR, UK GDPR, CCPA/CPRA) | The privacy policy covers legal bases, retention and rights. Access, export, deletion and consent withdrawal are self-serve. Nothing is sold or shared, and there are no trackers, analytics or ad pixels. Google Fonts were removed, so visitors' IP addresses no longer go to Google. |
| Cookies (ePrivacy) | There's only one strictly necessary session cookie, so no consent banner is needed. |
| Children (COPPA) | Accounts are for ages 18+, which people confirm at sign-up. |
| Liability | The Terms include disclaimers of warranties, a limitation of liability, an indemnity clause, and acceptable-use rules. |

**Before you launch, you still need to:**

- Have a lawyer review `terms.html`, `privacy.html` and `disclaimer.html` for your jurisdiction. Consider adding an arbitration clause or class-action waiver if they recommend one.
- Set `OPERATOR_NAME`, `CONTACT_EMAIL`, `GOVERNING_LAW` and `POSTAL_ADDRESS`.
- **Check your data licenses.** Finnhub's free plan is for personal use. Emailing its news and data to subscribers is redistribution, which usually needs a commercial plan.
- Keep the promise in the disclaimer: don't trade tickers ahead of an issue going out.
- If you ever charge for the newsletter, turn on the Ask tab, or take payment to feature a stock or token, the legal picture changes a lot. Talk to a securities lawyer first.
- Sign a data processing agreement with your email and hosting providers if you have EU or UK subscribers.
