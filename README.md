# Site Desk

A friendly Procore help assistant for a construction site team.

- **Accounts.** People create an account (name, email or cell number, password). Nothing is
  visible until they sign in.
- **Ask anything Procore.** Safety, RFIs, the daily log, drawings, inspections and more, in plain
  step-by-step answers that work on a phone.
- **Live sessions.** If the assistant can't solve it, the person taps *Request a live session*.
  You are alerted by email (and optionally Slack/Discord), with a one-tap WhatsApp reply link.
  If an alert can't be delivered, the person is told and can message you on WhatsApp directly.
- **Your dashboard at `/admin`.** Who signed up, who is active, what people ask about, how helpful
  the answers are, busiest hours, phone vs computer, live-session requests, and one-click
  health checks. Reset passwords, switch people off, download everything as CSV.

No database and no dependencies: plain Node.js 18 or newer.

---

## Setting it up on Render (about 10 minutes)

The service already exists if you set up the earlier version. Add these in **Render, your service,
Environment**. Only the first two are essential.

| Setting | What to put | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com | powers the answers |
| `ADMIN_PASSWORD` | a long password you choose | opens `/admin` (without it the admin page stays off) |
| `SIGNUP_CODE` | any word or number | stops strangers using up your credit. Give it to your team |
| `RESEND_API_KEY` and `NOTIFY_EMAIL` | free key from resend.com, and the email you signed up there with | emails you every live-session request |
| `SITE_AGENT_WHATSAPP` | your cell number, e.g. `0821234567` | fallback button if an alert fails |

Then open `https://your-app.onrender.com/admin` (any username, your admin password) and go to
**Health and settings**. Each line shows green when it's working, and has **Test** buttons for the
assistant and for live-session alerts.

### Keep accounts safe (important)

Render's free plan **forgets everything whenever the app restarts or goes to sleep**. That would
delete every account. To keep them:

1. In Render, open the service and change the plan to **Starter** (about $7 a month).
2. Add a **Disk**: name `sitedesk-data`, mount path `/var/data`, size 1 GB (about $0.25 a month).

Nothing else to change: the app finds `/var/data` automatically, and the Health tab will turn green.

---

## Using it

- **Team members:** open your link, tap *Create account*, enter the site access code.
- **Forgotten password:** they ask you. In `/admin`, **People**, **Reset password** gives you a
  temporary one to pass on. They can change it from the menu (the round button, top right).
- **Leaving:** people can delete their own account from that menu, or you can delete it for them.

## Privacy

Sign-up shows a short notice and needs a tick-box. By default only the *topic* of each question is
recorded (for example "RFIs"), not the question. Set `STORE_QUESTIONS=true` if you also want the
first 200 characters of each question in the activity export. Passwords are stored only as salted
scrypt hashes and can't be read back, even by you.

## Running it on your own computer

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY, ADMIN_PASSWORD, SIGNUP_CODE
node server.js           # http://localhost:3000
npm test                 # checks everything still works
```

## Files

```
server.js            the server: pages, accounts, chat, live sessions, admin
lib/                 accounts and passwords, storage, statistics, notifications, topics
views/               the sign-in page and the chat page
public/              styles, scripts and logo
admin/               the dashboard
test/                automated checks
instantsitemail/     separate app (unchanged)
siteinspect/         separate app (unchanged)
```

Unofficial team tool. Not affiliated with Procore. Procore's exact menus depend on your company's
account setup and each person's permissions.
