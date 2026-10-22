# SILAS // Secure Interface for Local & Autonomous Systems

**Version 2.5.0** · see [CHANGELOG.md](CHANGELOG.md) for what's new.

A private, self-hosted command centre for an ADHD brain. One screen shows:
- **what to do right now**: the Now project, today's time blocks, Todoist tasks as tiles
- **the PIP diary**: a 30-second daily log of sleep, pain, meds and struggles
- **learning**: sorted by style, studied in Pomodoro rounds
- **the printers**: live status, alerts and a siren when a print stops
- **the day**: the calendar, with warnings when a print will clash with it
- **Silas**: a sarcastic, TARS-style AI co-pilot who nudges you back on task

Everything runs locally on this PC at `http://localhost:8000`. Nothing is hosted online.

---

## ⚡ Quick start (Windows)

| To… | Do this |
|---|---|
| Start SILAS | Double-click `run_jarvis.bat` (starts the server and opens an Edge app window) |
| Run full screen, like a proper program (no title bar or taskbar) | Double-click `silas_fullscreen.bat`, or the **SILAS Fullscreen** desktop icon. **Alt+F4** quits. Inside SILAS, ⋮ → **Full screen** (or F11) toggles it. |
| Restart SILAS, or fix "wrong version showing" | Double-click `restart_havoc.bat` (stops whatever holds port 8000, then starts this copy) |
| Make the desktop icons ("Silas Console" and "SILAS Fullscreen") | Right-click `create_shortcut.ps1` → **Run with PowerShell** |
| Bring settings across from an older copy | `switch_to_v2.3.bat` (runs `copy_settings_from_old.ps1`) |

The first run installs the Python packages listed in `backend/requirements.txt`.

The full-screen window uses its own Edge profile (`%LOCALAPPDATA%\SILAS\EdgeKiosk`), so the first time you open it, theme and panel choices start at their defaults. Set them once in ⋮ → Preferences.
When started from `run_jarvis.bat` the server reloads by itself when backend files change.

---

## 🧭 Layout

**Top bar keys:** MISSION · TODAY · FLEET · LEARN · SCHEDULE · DRIVES · AI USAGE

- The **SILAS** co-pilot key hides while the chat is on Mission Control. Open the full-screen chat with **⤢** on the chat box.
- **⋮ menu:**
  - **Mobile View**: the LAN link for other devices
  - **Full screen**: hides the taskbar
  - **Preferences**: colours, fonts, panel order, AI keys
- **Sync Google Cal** and **+ Add Machine** sit under the keys.

**Mission Control (front page)**
- The **Silas chat** is pinned top-left.
- The **TODAY tiles** sit beside it: Now project, current block, overdue count.
- Below that come the briefing, fleet and agenda, in the order set in Preferences.
- Panels with nothing to show are skipped, so nothing is left floating.

---

## ✅ Today (Todoist link)

Todoist stays the master copy. SILAS reads and writes it live.

**Set up once**
1. In Todoist, open Settings → Integrations → Developer.
2. Copy the API token.
3. Open the **TODAY** tab and paste the token. It's stored in `backend/data/config.json` and only ever shown masked.

**The screen is all tiles, no lists**
- **NOW PROJECT:** the one thing you're building, its finish line, and **✓ FINISHED IT**. It warns if more than one task sits in Now.
- **BLOCK / COMING UP:** the current routine block with a countdown, and what's next.
- **OVERDUE / DUE TODAY:** tap to see those tasks. Between 11:00 and 14:00 a **FUEL** tile reminds you to eat.
- **Lanes:** Next, Money, Admin, Parked, Ideas. Tap a lane to open its tasks as tiles. Drag a task onto another lane to move it, or onto another tile to reorder.
- **Dump an idea / Add for today:** type a line and press Enter, then straight back to work.
- **Other Todoist projects** (Inbox, Daily Routine and so on) each get a tile.

**The Todoist layout it expects**
- A **Daily Routine** project: timed, recurring blocks.
- A **Projects** project with sections **Now** (one task only), **Next**, **Money**, **Admin**, **Parked** and **Idea inbox**.
- In a task's notes, `**Finish line:** …` shows on the Now tile.

**Silas reads the plan too.** Whenever Silas is using an online AI provider, he sees the current block, the Now task, Next and the overdue count.

**Editing a task:** click any tile to change its title, notes, priority, column or date. Moving the date on a repeating task keeps the repeat. Typing a due date such as `friday 10am` replaces it, and `none` clears it.

---

## ♥ PIP diary

A quick daily log for the PIP claim. It sits on the **TODAY** tab and saves privately to `backend/data/pip_diary.json` on this PC.

**Logging a day:** tap **♥ LOG TODAY** and fill in what applies. Everything is tap buttons, and anything can be skipped.
- Sleep: 1–9+ hours.
- Back pain and leg pain: 0–10, coloured green, amber or red.
- Mood: five levels.
- Meds: Morning (6am), Afternoon booster and Evening (8pm). Tap once for taken, twice for missed, a third time to clear.
- **Struggled with today:** the 12 PIP activities, from preparing food and washing to planning journeys and moving around.
- **What happened:** an optional note in your own words.

**The diary tile shows**
- The last 7 days as mini tiles, with back/leg pain and sleep. Tap a day to fill it in or fix it.
- Whether today is logged, and your streak. After 17:00 the tile glows if today isn't logged yet.

**Getting it into the full diary**
- **⧉ COPY LAST 7 DAYS:** copies the week as text. Paste it into "Karl's PIP Diary", or give it to Claude to log properly.
- **OPEN DIARY DOC ↗:** opens the full diary on claude.ai.

**Privacy:** `pip_diary.json` is in `.gitignore`. Never zip or share it.

---

## 🎓 Learn (Pomodoro)

**1. Pick your energy.** SILAS suggests what to study and how long the rounds should be:

| Energy | Pomodoro | Styles it suggests |
|---|---|---|
| 🔋 LOW: foggy, sore or tired | **Short**: 15 on, 5 off, long break after 4 | Watch, Listen, Recall |
| ⚡ OK: a normal day | **Classic**: 25 on, 5 off, long break after 4 | Course, Read, Practise |
| 🚀 HIGH: sharp | **Deep**: 45 on, 10 off, long break after 3 | Build it, Practise, Course |

You can override the round length with the SHORT / CLASSIC / DEEP buttons.

**2. Press ▶ START.** The timer goes full screen, with the topic, your next step, and the rounds shown as 🍅.
- Controls: pause, +5 min, skip break, minimise and stop.
- It chimes at the end of each round and break, with a desktop pop-up if you allow it.
- Switch tabs and the timer keeps running as a pill bottom-right. Tap it to come back.

**3. When a round ends, log it.** Say what you got done (optional), update the next step and set how far through you are. Then take the break; it's part of the method. Stopping early still logs the round if it ran for 5 minutes or more.

**Styles of learning:** 🎬 Watch · 🎧 Listen · 🧠 Recall · 📖 Read · 🎓 Course · ✏️ Practise · 🛠️ Build it. Tap a style tile to see only those items. Give each item every style that fits it.

**Learning tiles** show the category, status, next step, a progress bar, hours done (added up from your rounds) and a ▶ START button. Tap a tile to edit it, or **+ ADD** a new one.

**Progress tile:** 🍅 today, hours this week, a day streak and a 7-day chart. It nudges you after 3 days without a round.

**📅 Book it for later today** puts the study block on your Schedule, so the collision radar knows about it.

Data is stored in `backend/data/learning.json`. The fields match the planned Master Learning spreadsheet, so a sheet can be imported later.

---

## 🖨️ Fleet

Click **+ ADD MACHINE** and fill in:
- **Driver:** Moonraker/Klipper (port `7125`) or OctoPrint (port `5000`)
- **Host:** an IP or hostname, e.g. `192.168.1.103` or `mainsail.local`
- **Webcam URL** (optional)

**What you can see and do**
- Live temperatures with targets.
- Every toolhead is discovered automatically, 
- Progress, layer, time remaining, and a blended ETA with a confidence level.
- One-click preheat (PLA 210/60 °C, PETG 245/80 °C), pause, resume, cancel and E-stop (`M112`).
- Tool changes are locked while a job is printing or paused.

---

## 🚨 Printer alerts and siren

SILAS keeps a live websocket to each Moonraker printer and forwards these as they happen:

| Source | Catches |
|---|---|
| Snapmaker U1 exception manager | Every touchscreen pop-up: runout or tangle per toolhead, feeder faults, spaghetti detection, homing, MCU faults. Shown with the U1's `LLLL-MMMM-IIII-CCCC` code. |
| Klipper (any printer) | Shutdowns (thermal runaway, `Timer too close`) and `!!` error lines |
| SILAS | A printer dropping off the network mid-print |

**How alerts show up**
- A banner on every tab that stays until **ACKNOWLEDGE**, plus a sound and a flashing tab title.
- Optional Windows pop-ups: **ALERTS → Enable desktop pop-ups**.
- The **Alert log** keeps the last 200 alerts. **Send test alert** fires a fake U1 tangle.
- Acknowledging in SILAS doesn't clear the error on the printer itself.

**The siren** wails when a print **stops on its own**, until you acknowledge it or press **SILENCE SIREN**. These set it off:
- a self-pause (runout, tangle, macro `PAUSE`)
- a cancel or abort
- a Klipper error mid-print
- a U1 level 2/3 pop-up
- losing contact for over a minute mid-print

Your own Pause / Cancel / E-stop and normal finishes don't set it off.

**Siren controls:** the header badge shows **ARMED**, **CLICK TO ARM** (the browser needs one click first) or **OFF**. **ALERTS → Test siren (3s)** checks the volume.

**Overnight:** leave the SILAS window open (don't minimise it), keep the PC awake and the speakers on.

---

## 📅 Schedule and collision radar

**Linking Google Calendar** (no Google Cloud setup needed)
1. Open Google Calendar → Settings → your calendar → **Integrate calendar**.
2. Copy the **Secret address in iCal format**.
3. Click **🔗 SYNC GOOGLE CAL** and paste it.

**Local events** can be added with **+ Add Event**.

**Collision radar:** warns when an active print will finish during, or just before, an event. Repeating events are expanded and all-day events are ignored. The buffer comes from `pa_settings.collision_buffer_minutes`.

---

## 🤖 Silas co-pilot

- **Providers:** Gemini, Groq, OpenAI, or a custom endpoint. Keys go in **⋮ → Preferences** and stay on the server, shown masked.
- **Humour slider:** sets how much TARS you get.
- **What Silas sees:** live printer state and your Todoist plan.
- **Without a key:** an offline mode still answers printer and schedule questions.

---

## 💽 Drives & Storage

**What it does**
- Drive overview.
- Root clutter fixer.
- Deep folder organiser (STLs, G-code, documents…).
- Duplicate hunter: duplicates are *moved* to `<drive>:\_Duplicates_Quarantine`, never deleted.

**Safety**
- Everything is a dry run first.
- Every batch can be undone (`backend/data/undo_history.json`).
- Refuses Windows, Program Files, AppData, game libraries and anything that looks like an installed program or a code project.
- Only works from the SILAS PC itself.

---

## 📊 AI Usage

- **A card for every AI app** (Claude, ChatGPT, Gemini, Antigravity, Copilot, plus your own). Click **Hit limit** and pick when it resets. SILAS counts down and pings you when it's usable again.
- **SILAS's own AI calls are metered exactly:** tokens today and over 7 days, failed calls, and rate-limit headroom where the provider reports it.

---

## 📱 Mobile (secure LAN link)

The SILAS PC is always trusted. Every other device on your Wi-Fi needs the access token once:
1. Open **⋮ → Mobile View**, or click the **LAN LINK** badge.
2. Open the link (`http://<PC-IP>:8000/?token=…#mobile`) on the phone. The device is then remembered for a year.

Devices without the token get a locked page.

**To revoke every device:** delete `backend/data/access_token.txt` and restart.

---

## 🔐 Secrets

These are in `.gitignore`. **Never zip or share them:**
- `backend/data/config.json`: printer keys, the iCal secret, AI keys, the Todoist token
- `backend/data/access_token.txt`
- `backend/data/pip_diary.json`: your health log
- `backend/data/learning.json`: your learning list and study log

`backend/data/config.example.json` is the safe template.

---

## 🗂️ Folder map

```
SILAS/
├─ run_jarvis.bat / restart_havoc.bat / silas_fullscreen.bat / create_shortcut.ps1
├─ README.md, CHANGELOG.md
├─ HavocConsole.exe, HavocLauncher.cs   desktop launcher (name is compiled in)
├─ backend/                              FastAPI server
│  ├─ app.py            routes + serves the built UI
│  ├─ hub.py            background loop, WebSocket /ws snapshots
│  ├─ todoist.py        Todoist link (/api/todoist/*)
│  ├─ pip_diary.py      PIP daily log (/api/pip/*)
│  ├─ learning.py       LEARN tab + Pomodoro log (/api/learning/*)
│  ├─ ai_companion.py   Silas chat + offline brain
│  ├─ alerts.py         alert centre + siren rules
│  ├─ drive_commander.py, ai_usage.py, pa_intelligence.py, security.py, config.py
│  ├─ printers/         moonraker, octoprint, eta, live event link
│  ├─ calendar_sync/    iCal reader
│  ├─ data/             config + state (secrets live here)
│  └─ tests/
└─ frontend/            React + Vite (Tailwind via CDN)
   ├─ src/App.jsx       shell, nav, Mission Control
   ├─ src/Todo.jsx      TODAY tab + focus tiles
   ├─ src/Pip.jsx       PIP diary tile + log form
   ├─ src/Learn.jsx     LEARN tab, Pomodoro timer + floating pill
   ├─ src/AIUsage.jsx, src/DrivesManager.jsx, src/index.css
   └─ dist/             built UI that the server actually serves
```

---

## 🛠️ Changing the code

**Front end:** edit `frontend/src/…`, then build:
```bat
cd frontend
npm install
npm run build
```
The server serves `frontend/dist`. For live editing, run `npm run dev` and open `http://localhost:5173`; `/api` is proxied to port 8000.

**Back end:** edit `backend/…`. The server reloads by itself when started with `run_jarvis.bat`.

**Tests:**
```bat
python -m pytest backend/tests -q
```

**Adding a feature:**
1. Add `backend/<feature>.py` with an `APIRouter`, included in `app.py`.
2. Add `frontend/src/<Feature>.jsx`.
3. Add a key to the nav list in `App.jsx`.

---

## 🩺 Troubleshooting

| Symptom | Fix |
|---|---|
| New tab or feature not showing | An old copy is still running on port 8000. Run `restart_havoc.bat`, then `create_shortcut.ps1`. |
| `ERR_TOO_MANY_REDIRECTS` | A redirect was added on `/` in `app.py`. Remove it; the UI is already served at `/`. Then click **Delete cookies** on the error page. |
| `{"detail":"Not Found"}` at `/` | `app.py` is incomplete (the `serve_frontend` block at the bottom is missing) or `frontend/dist` is missing. |
| TODAY says the token was rejected | Paste a fresh token from Todoist → Settings → Integrations → Developer, using **⚙ LINK** on the TODAY tab. |
| Siren silent | Click once anywhere on SILAS (the browser needs a click before it may play sound). Check **ALERTS → Test siren**. |

Backups of files changed during upgrades are in `_backup_pre_todo/`, `_backup_pre_silas/` and `_backup_pre_pip/`.

---

## 🚀 Publishing to GitHub

Before the first push, check that **none** of these are included. `.gitignore` already excludes them:
- `backend/data/config.json`
- `backend/data/access_token.txt`
- `backend/data/pip_diary.json`
- `backend/data/learning.json`
- `alerts.json`
- `undo_history.json`
- `ai_usage.json`
- the `_backup_*` folders
- `*.zip`
- `frontend/node_modules`

Run `git status` and make sure no `backend/data/*.json` file is listed except `config.example.json`.

**Making a release:**
1. Add a new section at the top of `CHANGELOG.md`.
2. Bump the version line at the top of this README.
3. Commit, then tag it, e.g. `git tag v2.5.0`.
4. Push with tags: `git push --follow-tags`.

**Repo link:** replace `OWNER` in the links at the bottom of `CHANGELOG.md` with your GitHub username once the repo exists.
