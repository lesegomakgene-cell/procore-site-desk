# Procore Site Desk

A simple help chatbot for a construction site team. It answers common Procore
questions — safety, project management and everyday field tools — so the site
agent isn't fielding the same questions all day. When someone needs a person,
they can request a live session, which gets logged for the site agent.

- Zero dependencies (plain Node.js — built-in HTTP server + `fetch`)
- Your Anthropic API key stays on the server, never in the browser
- Mobile-first UI, built for phones on site
- Live-session requests saved to a local file

---

## Setup (about 2 minutes)

You need **Node.js 18 or newer** (20+ recommended). Check with `node --version`.

1. Add your API key:

   ```bash
   cp .env.example .env
   ```

   Open `.env` and paste your Anthropic API key into `ANTHROPIC_API_KEY`.
   Get one at https://console.anthropic.com (Settings → API Keys).
   While you're there, set `SITE_AGENT_NAME` to your name.

2. Start it:

   ```bash
   node server.js
   ```

3. Open **http://localhost:3000** in your browser.

That's it. No `npm install` needed.

---

## Using it

- **Ask anything Procore.** Type a question or tap a topic chip (Daily Log,
  RFIs, Submittals, Drawings, Inspections, etc.).
- **Request a live session.** The amber button opens a short form. Submissions
  are appended to `session-requests.jsonl` and printed in the server console.

### Seeing the session requests

As the site agent, you can view requests two ways:

- Read the file directly: `cat session-requests.jsonl`
- Or visit **http://localhost:3000/api/session-requests** (returns JSON).

---

## Configuration (`.env`)

| Setting             | What it does                                              |
|---------------------|-----------------------------------------------------------|
| `ANTHROPIC_API_KEY` | Required. Your API key.                                   |
| `MODEL`             | `claude-sonnet-4-6` (default) or `claude-haiku-4-5` (cheaper/faster) |
| `PORT`              | Defaults to `3000`.                                       |
| `SITE_AGENT_NAME`   | Shown in the UI and on the booking form.                  |
| `SITE_AGENT_EMAIL`  | Optional. Shown to users after they book.                 |

You can tune what the assistant knows and how it answers by editing the
`SYSTEM_PROMPT` near the top of `server.js`.

---

## Sharing it with the team

Running `node server.js` serves it on your machine only. To let the whole site
team use it, you'll want to host it somewhere (Render, Railway, a small VPS, or
your company server). **Before you deploy publicly, read the security note below.**

---

## Security notes (read before deploying)

- The API key lives only in `.env` on the server — never exposed to the browser.
  `.gitignore` keeps `.env` and `session-requests.jsonl` out of git.
- `GET /api/session-requests` has **no authentication**. That's fine on your own
  machine, but add a password / login before putting this on the public internet,
  or anyone could read the requests.
- There's no rate limiting. On a public deploy, add one so your API usage can't
  be run up by strangers.

Ask Claude Code to "add basic auth to the requests endpoint" or "add rate
limiting" when you're ready — see `CLAUDE.md`.

---

## Files

```
procore-site-desk/
├── server.js              # the whole backend (serve UI, proxy API, save requests)
├── public/index.html      # the chat interface
├── package.json
├── .env.example           # copy to .env
├── .gitignore
├── CLAUDE.md              # context for iterating with Claude Code
└── README.md
```

Unofficial team tool. Not affiliated with Procore. Procore's exact menus and
available tools depend on your company's account setup and your permissions.
