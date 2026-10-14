# InstantSiteMail

Drop in a saved Outlook email with its drawings and attachments. InstantSiteMail
reads it the way an experienced site contracts manager would, then gives you a
reply that's ready to send.

**You never connect your mailbox.** You save the email as a file and drop the
file in. Nothing is linked to your work account and nothing is stored.

## What you get

| Tab | What's in it |
|---|---|
| **Reply** | An editable reply (To, Cc, Subject, Body) in your name and sign-off. Copy it, open it in your mail app, or rewrite it with one click: *Firmer*, *Softer*, *Shorter*, *Add RFI list*, or your own instruction. |
| **Reading the email** | Who the sender is and their likely role, the tone and what they're really after, everything they ask for, key facts, and any assumptions the analysis made. |
| **Contractual** | Instructions, variations, compensation events, notices, claims, early warnings, admissions to avoid. Deadlines and time-bars, plus a risk table. |
| **Drawings & gaps** | Each drawing identified from its title block (number, revision, status), with technical observations and discrepancies against the email and other documents. Missing or contradictory information is written up as RFI-ready questions. |
| **Actions & notices** | Next steps with owners and dates, and draft formal notices (early warning, delay, claim, RFI) when they're warranted. |

**Download full analysis** saves everything as a Markdown file for your records.

## What it can read

| File | Handling |
|---|---|
| `.msg` (Outlook desktop) | Subject, people, date, body (plain, HTML or rich text) and every attachment, including emails forwarded as attachments |
| `.eml` (Outlook web / new Outlook / other mail apps) | Same as above |
| PDF drawings, specs, letters | Read in full, including the drawing images |
| PNG, JPG, GIF, WebP (photos, scans, markups) | Read visually. Large scans are resized automatically |
| Word `.docx`, Excel `.xlsx` | Text and tables extracted |
| `.txt`, `.csv` | Read as text |
| DWG / DXF / RVT / IFC, TIFF, old `.doc` / `.xls` | Can't be read. They show up as **information gaps**, so the reply asks for a PDF |

You can also drop extra drawings or documents next to the email (for example
drawings that only came as a download link), or paste the email text if you
can't save it.

## Saving an email from Outlook

- **Outlook for Windows (classic):** drag the email from your inbox onto your desktop.
  That creates a `.msg` file. Or open the email and use **File → Save As**.
- **New Outlook / Outlook on the web:** open the email, then **… (More actions) → Save as** or **Download**. That gives you an `.eml` file.
- **Outlook for Mac:** drag the email onto your desktop to get an `.eml` file.

Then drag the file into InstantSiteMail. Delete the saved file afterwards if your
company's policy requires it.

## Setup

You need **Node.js 18 or newer** (20+ recommended). There's nothing to install
with npm.

```bash
cd instantsitemail
cp .env.example .env      # paste your Anthropic API key into ANTHROPIC_API_KEY
node server.js            # open http://localhost:3100
```

On first use, click **My profile** and fill in your name, position, company,
project, your role on the contract, the form of contract (JBCC, NEC, FIDIC,
GCC, JCT…), your sign-off and any house style. Replies are written in your
voice from these details. The profile is stored only in your browser.

### Settings (`.env`)

| Setting | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Required. Get one at console.anthropic.com |
| `MODEL` | `claude-opus-5-5` | The model needs to support PDF and image input and structured JSON output |
| `EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. Higher is more thorough, slower and costlier |
| `MAX_TOKENS` | `32000` | Room for the written analysis |
| `PORT` | `3100` | |
| `HOST` | `127.0.0.1` | Only this computer can reach the app. Set to `0.0.0.0` to use it from your phone on the same network, **and set a password** |
| `APP_PASSWORD` | – | When set, the browser asks for it (any username) |

## Privacy and confidentiality

- Your mailbox is never connected. The app only sees the files you drop in.
- Files are parsed in memory by the local server and sent to the Anthropic API
  only when you click **Analyse**. Nothing is written to disk, and email
  content isn't logged.
- Your API key stays on the server and is never sent to the browser.
- Check that sending project correspondence to an external AI service is
  allowed under your company's IT policy and your contract's confidentiality
  terms before you use the app on live projects.

## Important

InstantSiteMail is a drafting and review aid, not legal or contractual advice.
Always check the reply before you send it, especially clause references,
notice periods and dates. Your actual contract documents take precedence.

## How it works

```
instantsitemail/
  server.js          zero-dependency HTTP server: /api/parse, /api/analyse, /api/refine
  lib/msg.js         Outlook .msg reader (compound file + MAPI properties + compressed RTF)
  lib/eml.js         MIME .eml reader
  lib/office.js      .docx / .xlsx text extraction (built-in zlib)
  lib/files.js       file type detection and attachment preparation
  lib/prompt.js      the contracts-manager brief and the analysis JSON schema  <- edit to tune behaviour
  lib/claude.js      streaming Messages API client (built-in fetch)
  public/index.html  the whole UI: vanilla JS, no build step
  test/              node --test suite and fixture generator
```

The analysis is one Claude call. The PDFs and images go in as document and
image blocks, followed by your profile, an attachment register (including
files that couldn't be read), the email thread and your notes. The response
is constrained to a JSON schema so every section is always present. Adaptive
thinking is on, and the call is streamed so long analyses don't time out.

Run the tests with `npm test`. To regenerate the fixtures, run
`python3 test/fixtures/make_fixtures.py` (needs `pip install compressed-rtf`).
