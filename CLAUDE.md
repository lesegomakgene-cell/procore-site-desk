# CLAUDE.md

Context for working on this project with Claude Code.

## What this is

A small Procore help chatbot for a construction site team, plus a
"request a live session" feature so users can ask the site agent for time.
Built deliberately dependency-free and simple so it's easy to run and extend.

## Architecture

- **`server.js`** — a single zero-dependency Node HTTP server. It:
  - serves the static frontend from `public/`
  - `POST /api/chat` → proxies to the Anthropic Messages API
    (`https://api.anthropic.com/v1/messages`) using the key in `.env`, with a
    Procore-focused system prompt. Returns `{ reply }`.
  - `POST /api/request-session` → appends a JSON line to `session-requests.jsonl`
  - `GET /api/session-requests` → returns logged requests (NO auth yet)
  - `GET /api/config` → returns the site agent name for the UI
  - includes a tiny built-in `.env` loader (no dotenv dependency)
- **`public/index.html`** — the entire frontend: vanilla JS, no build step,
  no framework. Chat UI, topic chips, and the booking modal. Mobile-first.

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

- Add authentication to `GET /api/session-requests` before any public deploy.
- Add rate limiting on `/api/chat`.
- Email or Slack a notification to the site agent when a session is requested.
- Stream responses (Server-Sent Events) for faster-feeling replies.
- Add a small admin page at `/admin` to view/clear session requests.
- Ground answers in your company's actual Procore workflows (paste your SOPs
  into the system prompt or load them from a file).
- Optional: integrate the Procore API for live project data — would need OAuth
  and is a larger change.

## Running

```bash
cp .env.example .env   # add ANTHROPIC_API_KEY and SITE_AGENT_NAME
node server.js         # http://localhost:3000
```
