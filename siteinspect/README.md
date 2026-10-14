# SiteInspect

Site inspections for a main contractor. Walk the site with your phone, tick
through a checklist, photograph defects, assign them to the subcontractor
responsible, sign off, and get a report you can print or save as PDF. Every
failed check becomes a tracked action until someone closes it out with evidence.

- Zero dependencies (plain Node.js, no `npm install`)
- Mobile-first: big Pass / Fail / N/A buttons, camera photos, finger signature
- Works for the whole site team from one password-protected server
- Optional AI summary on reports (your Anthropic key stays on the server)

## What's in it

| Screen | What it does |
|---|---|
| **Dashboard** | Open and overdue actions, inspections in the last 30 days, average score, drafts in progress, and open actions per subcontractor. |
| **Inspect** | Pick a checklist, enter the area, and work through it. Failed items get a priority, an assignee and an optional due date. Any item can have a note and photos. Progress saves as you go, so you can leave and come back. **Mark rest Pass** finishes a clean area quickly. |
| **Review & sign** | Shows the score and how many actions will be raised. You sign with your finger and submit. The inspection is then locked as part of the site record. |
| **Report** | Printable report: project details, score, findings with photos and action refs, the full checklist, notes and signature. **Print / Save PDF** uses the browser's print dialog. With an API key set, **AI summary** writes an overall assessment, key risks and priority actions. |
| **Actions** | The actions register: filter by open / overdue / closed and by subcontractor, search, raise ad-hoc actions, and close actions out. Closing needs a note or photo as evidence plus the name of the person closing it. **CSV** downloads the register for Excel. |
| **Setup** | Your name, projects, and your own checklists. |

### Built-in checklists

Weekly site safety (HSE) inspection, daily site walk, scaffold inspection,
excavation inspection, pre-pour concrete inspection, subcontractor compliance
audit, and snag / pre-handover quality inspection. Edit them in
`lib/templates.js`. You can also add company-specific checklists in **Setup**
without touching code. Type one check per line as `Section: check`.

**Scoring:** passes ÷ (passes + fails). N/A items don't count.
**Default action due dates** (when you leave the date blank): critical 1 day,
high 2 days, medium 7 days, low 14 days from the inspection date.

## Setup

You need **Node.js 18 or newer** (20+ recommended).

```bash
cd siteinspect
cp .env.example .env      # optional: COMPANY_NAME, ANTHROPIC_API_KEY
node server.js            # open http://localhost:3200
```

The first screen asks for your project. Then tap **＋ Inspect**.

### Using it from phones on site

By default the app only listens on your own computer. To let phones on the same
Wi-Fi connect, set an `APP_PASSWORD` and `HOST=0.0.0.0` in `.env`, restart, and
open `http://<your-computer's-IP>:3200` on the phone. Without a password the
app refuses to start in that mode. On Android or iPhone, use **Add to Home
Screen** to get an app icon.

## Configuration (`.env`)

| Setting | What it does |
|---|---|
| `APP_PASSWORD` | One shared password for the team (any username). Required when `HOST` isn't local. Ten wrong tries lock that address out for 15 minutes. |
| `COMPANY_NAME` | Printed at the top of reports. |
| `ANTHROPIC_API_KEY` | Optional. Turns on **AI summary** on reports. |
| `MODEL` / `EFFORT` | Model for summaries (default `claude-opus-5-5`, effort `medium`). |
| `DATA_DIR` | Where data is kept (default `data/` in this folder). |
| `PORT` / `HOST` | Default `3200` / `127.0.0.1`. |

## Your data

Everything is in `DATA_DIR`: `db.json` holds projects, inspections and
actions, and `photos/` holds the images, which are resized on the phone before
upload. **Back up that folder.** Copying it is the whole backup. It's in
`.gitignore`, so it never goes into git.

Submitted inspections can't be edited or deleted, so the record stays
trustworthy. Draft inspections can be deleted.

## Deploying on Render

`render.yaml` at the repo root includes a `siteinspect` service. **Important:**
a Render web service's disk is wiped on every deploy and restart. For real use,
add a persistent disk to the service (this needs a paid instance), mount it at,
for example, `/var/data`, and set `DATA_DIR=/var/data`. Otherwise your
inspections will disappear.

## Tests

```bash
node --test
```

## Files

```
siteinspect/
├── server.js            # HTTP server, auth, REST API, AI summary
├── lib/store.js         # JSON-file store + photo files
├── lib/templates.js     # built-in checklists
├── lib/claude.js        # minimal Anthropic Messages API client (fetch)
├── public/index.html    # app shell
├── public/app.js        # the whole frontend (vanilla JS)
├── public/app.css
└── test/api.test.js
```

Inspection checklists are a starting point. Check them against your company's
SHE plan, the client's requirements and the regulations that apply to your site.
