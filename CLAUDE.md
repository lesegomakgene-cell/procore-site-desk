# CLAUDE.md

Context for working on this project with Claude Code.

## What this is

Site Desk: a Procore help assistant for a construction site team. People create an account,
chat with the assistant, and can request a live session with the site agent (who is alerted
for real). `/admin` shows usage statistics and manages accounts. Built deliberately
dependency-free (plain Node 18+, no database) so it is easy to run and extend.

## Architecture

- **`server.js`** - routing and handlers. Pages: `/login` (also `/signup`), `/` (needs a session),
  `/contact` (public contact form), `/admin` (HTTP Basic auth with `ADMIN_PASSWORD`; switched off if unset).
  APIs: `/api/signup|login|logout|me|chat|feedback|event|request-session|contact|public`,
  `/api/account/password|delete`, `/api/admin/*` (incl. `visits`, `messages`, `message-action`, CSV exports).
- **`lib/`** - `config.js` (env + data folder), `store.js` (JSON/JSONL files: users, sessions,
  requests, usage events), `auth.js` (scrypt, cookies, sessions), `notify.js` (Resend email +
  webhook, checks delivery really succeeded), `stats.js` (dashboard maths, SAST days),
  `topics.js` (topic cards, question classifier, roles), `visits.js` (bot filter, source of a visit,
  visitor stats by SAST day / Monday week / month), `util.js`.
- **`views/`** `login.html`, `app.html`, `contact.html`. **`public/`** `theme.css` (shared look, incl. contact
  page), `app.css`, `admin.css`, `app.js`, `login.js`, `contact.js`, `logo.svg`. **`admin/`** `index.html`, `admin.js`.
- All page JavaScript is external and the CSP is `script-src 'self'; style-src 'self'`: do not
  add inline `<script>`, inline `style=""` attributes or `setAttribute("style")`. Setting
  `el.style.x = ...` from JS is fine. Build admin DOM with text nodes, never `innerHTML` with data.

## Behaviour worth knowing

- Sign-in name is an email or a SA cell number (normalised in `util.parseLogin`). Passwords:
  scrypt, 8+ chars. Sessions: random token, only its hash is stored, HttpOnly + SameSite=Lax
  (+ Secure behind https). POSTs must be `application/json` and same-origin (CSRF defence).
- Live-session requests: saved, then email + webhook are awaited; the response says
  `notified: true/false`, and when false the person gets a WhatsApp fallback link.
- Contact details default to bskm.projects@outlook.com / WhatsApp 0791718085 (`SITE_AGENT_EMAIL` /
  `SITE_AGENT_WHATSAPP` override). Live-session and contact responses always include pre-written
  `whatsappUrl` + `emailUrl` so the person can send it themselves (the only route when Resend isn't set up).
- Contact form (`/api/contact`): no account needed; hidden trap field + `elapsed` < 2.5 s = bot (fake OK,
  nothing saved); 6 per IP and 120 overall per hour. Saved to `messages.jsonl` with status new/answered.
- Visitor counting: page GETs of `/`, `/login`, `/signup`, `/contact` append to `visits.jsonl`
  (`{t, v, p, u?, d, s?, n?}`) via `trackVisit`, which is wrapped so it can never break a page. Anonymous
  `sd_v` cookie (HttpOnly, 400 days). Bots skipped (`visits.isBot`). Source from `?ref=`/`utm_source` or
  Referer. Browsers that open `/admin` are saved in `owner.json` and left out, as is the owner's own account
  (login = agent email/WhatsApp, `isOwner`). Visits older than 400 days are pruned on start.
- The assistant ends a reply with `[[SESSION]]` when a live session would help; the server strips
  it and returns `offerSession: true` so the app shows a button.
- Usage events (`events.jsonl`) store topic + counts, not question text, unless `STORE_QUESTIONS=true`.
  Deleting a person rewrites events/requests to remove identity but keeps anonymous totals.
- Data lives in `DATA_DIR` (`/var/data` is auto-used on Render). The free Render plan has no
  persistent disk, so accounts vanish on restart; the admin Health tab warns about this.
- Rate limits are in memory per process: sign-up (`SIGNUP_LIMIT`/hour/IP), sign-in, chat per person,
  `DAILY_LIMIT` questions per person per day.

## Tests

`npm test` (spawns the real server against fake Anthropic/Resend/webhook services).
`test/contact-visits.test.js` also checks that data from the previous version loads untouched. Page GETs in
tests need a browser-like `User-Agent`, or the visit is treated as a bot.
Test hooks: `ANTHROPIC_API_URL`, `RESEND_API_URL`.

## InstantSiteMail (`instantsitemail/`)

A separate, standalone app in its own folder (own `server.js`, `package.json`,
`.env`). The user drops a saved Outlook email (.msg/.eml) plus drawings and gets
a contracts-manager analysis + reply. Zero dependencies, same conventions as
above. The brief and JSON schema live in `instantsitemail/lib/prompt.js`;
parsers in `instantsitemail/lib/`. Tests: `cd instantsitemail && node --test`.
Default model `claude-opus-5-5`.

## SiteInspect (`siteinspect/`)

A separate, standalone site inspection app for a main contractor (own
`server.js`, `package.json`, `.env`). Checklists run on a phone, failed items
become actions assigned to subcontractors, inspections are signed and locked on
submit, and reports print to PDF. Data: JSON file + photos under `DATA_DIR`
(`lib/store.js`). Built-in checklists in `lib/templates.js`. Optional AI report
summary via `lib/claude.js` (default `claude-opus-5-5`, effort medium). Same
conventions as above. Tests: `cd siteinspect && node --test`.

## Conventions / constraints

- Keep it dependency-free if reasonable. Built-in `fetch` requires Node 18+.
- Never expose the API key to the client — all model calls go through `server.js`.
- The frontend escapes HTML before rendering model output (see `format()`),
  keep that when changing the renderer.
- Model IDs are canonical strings: `claude-sonnet-4-6`, `claude-haiku-4-5`,
  `claude-opus-4-8`. The dateless ID is a fixed snapshot, not an evergreen alias.
- The assistant's behaviour and Procore knowledge live in `SYSTEM_PROMPT` in
  `server.js` — edit there to change scope, tone, or guidance.

## Good next steps (ask me to do any of these)

- A second storage backend (e.g. a hosted database) so accounts survive on Render's free plan.
- A weekly usage summary emailed to the site agent.
- Admin approval of new accounts instead of (or as well as) the site access code.
- Stream answers (Server-Sent Events) for faster-feeling replies.
- Ground answers in the company's own Procore SOPs (load them into the system prompt).

## Running

```bash
cp .env.example .env   # add ANTHROPIC_API_KEY, ADMIN_PASSWORD, SIGNUP_CODE
node server.js         # http://localhost:3000
npm test
```
