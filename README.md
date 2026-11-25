# Site Desk

A friendly Procore help assistant for a construction site team.

- **Accounts.** People create an account (name, email or cell number, password). Nothing is
  visible until they sign in.
- **Ask anything Procore.** Safety, RFIs, the daily log, drawings, inspections and more, in plain
  step-by-step answers that work on a phone.
- **Live sessions.** If the assistant can't solve it, the person taps *Request a live session*.
  You are alerted by email (and optionally Slack/Discord), with a one-tap WhatsApp reply link.
  If an alert can't be delivered, the person is told and can message you on WhatsApp directly.
- **Contact form at `/contact`.** Anyone can send you a question, no account needed. You get it by
  email (when Resend is set up) and on the Messages tab, with one-tap Reply by email / WhatsApp.
  People are always offered a pre-written WhatsApp or email to bskm.projects@outlook.com /
  079 171 8085, so nothing depends on email alerts being set up.
- **Your dashboard at `/admin`.** Opens on **Visitors**: who visits per day, week and month, pages,
  where they came from, phone vs computer, busiest hours, and a list of recent visitors (names for
  signed-in people). Plus app usage, people, messages, live-session requests and one-click health
  checks. Signed in to the app with your own email or number, you get a **Dashboard** button.
  Reset passwords, switch people off, download everything as CSV.
- **See which links work.** Add `?ref=whatsapp` (or `linkedin`, `email`, `qr`) to links you share,
  e.g. `https://your-app.onrender.com/contact?ref=whatsapp`, and the Visitors tab shows where people came from.

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
| `SITE_AGENT_WHATSAPP` and `SITE_AGENT_EMAIL` | already built in: `0791718085` and `bskm.projects@outlook.com` | only set these to change them |

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

Visits are counted with one small anonymous cookie (`sd_v`), only on this site, never shared. Robots,
link previews and your own visits are left out. Contact messages are used only to reply.

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
views/               the sign-in, chat and contact pages
public/              styles, scripts and logo
admin/               the dashboard
test/                automated checks
instantsitemail/     separate app (unchanged)
siteinspect/         separate app (unchanged)
```

Unofficial team tool. Not affiliated with Procore. Procore's exact menus depend on your company's
account setup and each person's permissions.
