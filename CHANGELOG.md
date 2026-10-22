# Changelog

All notable changes to SILAS (formerly HAVOC / jarvis-pa) are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [2.7.3] - 2026-10-22

### Added
- Voice alerts: after the alert sound, the computer reads the problem out, e.g. "Red alert. Snapmaker U1: Print stopped. ...". Lead word follows severity (Red alert / Warning / Attention).
- Uses the browser's built-in text-to-speech (works offline); prefers an en-GB "Natural" voice.
- Raw error codes are skipped and long messages are cut at a sentence end; more than 3 alerts at once adds "Plus N more in the alert log".
- The siren drops in volume while the voice is speaking.
- Alert log has a "Voice: ON / OFF" toggle (localStorage `silas_alarm_voice`); turning it on reads a test announcement. Voice is silent when alert sound is off.

## [2.7.2] - 2026-10-22

### Changed
- New default alarm sound style, "Starship": the siren is a rising red-alert whoop, about once a second with a gap between pulses (350-700 Hz, two detuned voices).
- Short alert sounds in Starship style are console chirps (info: two rising blips; warning: three falling blips; critical: two whoops).
- Alert log has a "Style: STARSHIP / CLASSIC" toggle to switch back to the original siren and beeps (stored in localStorage `silas_alarm_style`).
- Siren is still built only from free-running oscillators, so it keeps sounding when the window is in the background.

## [2.7.1] - 2026-10-21

### Changed
- Starship Ops (LCARS) theme now covers the whole app, not just the frame:
  - Today and Learn tiles are LCARS L-frame blocks; tile labels are coloured pills with black text.
  - PIP diary, Study Now panel, energy and preset buttons, and diary option buttons restyled to match.
  - Neon text, borders and glass tints are remapped to the LCARS pastels (orange, peach, lilac, blue, sky, red, green).
  - Buttons always use black text on their coloured key.
  - Pomodoro pill is a solid key (red for focus, green for break); the study timer sits inside an orange elbow frame.
  - Modals and the 3D preview card use a black interior with a blue L-frame.
  - Screensaver shows a dim LCARS readout (still dim, to protect the panel).
- Cyberpunk themes are unchanged.

## [2.7.0] - 2026-10-21

### Added
- **Starship Ops (LCARS) theme.** Pick it in ⋮ Settings → Colour Themes; switch back to any cyberpunk theme at any time.
  - Elbow frame around the header: curved top bar and left column with segmented colour blocks.
  - Nav keys become pill buttons in rotating LCARS colours (orange, lilac, peach, periwinkle, tan); the active key turns pale with a coloured edge.
  - Panels get an L-shaped coloured frame with a rounded outer corner, on pure black.
  - Buttons become flat pills with black text; inputs get rounded periwinkle outlines.
  - Alert banners get the same rounded shape and keep their severity colours.
  - Tall condensed Antonio font (Google Fonts) for headings and text; data stays monospaced.
  - Thinner frame on small screens.
  - Original layout in the LCARS style: no franchise logos or insignia.
  - Everything is scoped to `html.theme-lcars` in `index.css`, so the other themes are untouched.

## [2.6.1] - 2026-10-19

### Added
- **Wallpaper mode** for running SILAS as a live desktop wallpaper (e.g. in Lively Wallpaper). Open it as `http://localhost:8000/?wallpaper=1`.
  - Has its own Screen Guard settings, separate from the normal app window.
  - **Screensaver off by default** so the dashboard stays visible; it deep-dims after 5 minutes idle instead. Hue drift and pixel shift keep running.
  - Hides scrollbars.
- Screen Guard: the screensaver timer can now be set to **Never**.

## [2.6.0] - 2026-10-18

### Added
- **Screen Guard (burn-in protection)**, for the Artist Pro 16 Gen 2. New `frontend/src/ScreenGuard.jsx`, with settings under ⋮ Settings → 🖥️ SCREEN (saved per device).
  - **Hue drift:** the whole HUD drifts ±10° of hue and back over 20 minutes, in half-degree steps every 30 seconds. You can't see it in use.
  - **Brightness breathing:** a very slow cycle between 100% and 92%.
  - **Pixel shift:** the layout moves up to 2 px every 3 minutes, so panel edges don't stay on the same pixel row.
  - **Deep dim** after 5 minutes idle (adjustable): pure black background, HUD dimmed and desaturated. Any input restores it.
  - **Screensaver** after 10 minutes idle (adjustable): pure black with a dim clock, printer progress, alert count and next event. The block wanders to a new spot every 40 seconds.
  - **Waking it:** mouse, pen, touch or keyboard. Pen jitter under 10 px is ignored, and the first tap on the screensaver only wakes it, so it never presses a button underneath.
  - **Exceptions:** a new printer alert wakes the screen. It never sleeps while a webcam view is open. During a Pomodoro round it only dims, and it wakes when the round ends.
  - **Cost:** values are stepped, not animated per frame, so there's no constant GPU load.

## [2.5.0] - 2026-10-18

### Added
- **LEARN tab.** New `backend/learning.py` at `/api/learning/*` and `frontend/src/Learn.jsx`.
  - **Learning sorted by style:** Watch, Listen, Recall, Read, Course, Practise and Build it. Each style is a tile you can tap to filter.
  - **"Study now" tile:**
    - Pick your energy: Low, OK or High.
    - SILAS suggests the best-matching active item and its next step.
    - It sets the Pomodoro length to match: Short 15/5 for low energy, Classic 25/5 for OK, Deep 45/10 for high.
  - **Pomodoro timer:**
    - A full-screen focus ring that counts rounds as 🍅.
    - Pause, +5 min, skip break, minimise and stop.
    - Chimes and optional desktop notifications.
    - A long break after the last round.
    - It keeps running when you switch tabs, as a floating pill bottom-right, and survives a page refresh.
  - **Logging a round:** after each round you say what you got done, update the next step and set how far through you are. Hours done are added up from the logged rounds.
  - **Progress tile:** 🍅 today, hours this week, a day streak, a 7-day bar chart, and a nudge after 3 days with nothing logged.
  - **📅 Book it for later today** adds the study block to the Schedule, so the collision radar respects it.
  - **Learning items** use the planned Master Learning spreadsheet fields: topic, category, resource, platform, link, status, priority, progress, estimated hours, next step, linked project and notes.
  - **Starter items:** Blender, Drawing and GIMP space art.
  - Stored in `backend/data/learning.json`.
- **LEARN key** added to the top bar.

## [2.4.0] - 2026-10-18

### Added
- **TODAY tab (Todoist link).** A new `backend/todoist.py` connects to the Todoist API v1 at `/api/todoist/*`. The front end is `frontend/src/Todo.jsx`.
  - **All tiles, no lists.** There's a big NOW PROJECT tile with its finish line and a ✓ FINISHED IT button, plus Block (with a countdown), Coming Up, Overdue / Due Today, and Fuel (a reminder to eat between 11:00 and 14:00).
  - **Lanes:** Next, Money, Admin, Parked and Ideas. Each opens into task tiles. Drag a tile onto a lane to move it, or onto another tile to reorder it.
  - **Quick add:** "Dump an idea" and "Add something for today" tiles.
  - **Other Todoist projects** each get a tile that opens their tasks.
  - **Editing:** an edit dialog for title, notes, priority, column and date. Moving the date on a repeating task keeps the repeat, via a Sync API `item_update`.
  - **Token storage:** the Todoist token is saved in `config.json` and is only ever shown masked.
- **PIP diary daily log.** New `backend/pip_diary.py` (`/api/pip/*`) and `frontend/src/Pip.jsx`.
  - One-tap logging of sleep, back and leg pain (0–10), mood, the three meds (taken or missed) and which of the 12 PIP activities were a struggle, plus a note.
  - A 7-day strip of mini tiles, a streak, and a nudge after 17:00 if today isn't logged.
  - **⧉ Copy last 7 days** for the full diary, and **Open diary doc ↗**.
  - Stored privately in `backend/data/pip_diary.json`.
- **Silas knows the plan.** The cloud-LLM system prompt now includes the current block, the Now task, Next and the overdue count.
- **Mission Control focus tiles.** Now project, Block and Overdue sit beside the chat.
- **Full screen.**
  - `silas_fullscreen.bat` starts the server if needed and opens SILAS as an Edge kiosk window, with no title bar or taskbar. Alt+F4 quits.
  - ⋮ → **Full screen** toggles it from inside the app (F11 / Esc also work).
- **⋮ menu.** It now holds Mobile View, Full screen and Preferences.
- **⤢ button on the chat** opens the full-screen co-pilot.
- **`restart_havoc.bat`** stops whatever is holding port 8000, then starts this copy.
- **README.md** rewritten, and this **CHANGELOG.md** added.

### Changed
- **Renamed HAVOC → SILAS** (Secure Interface for Local & Autonomous Systems) in every visible label, prompt and message.
  - Internal names (`havoc_*` settings keys, the `havoc_token` cookie, `HavocConsole.exe`) are unchanged, so saved settings carry over.
  - The startup console shows the SILAS banner.
- **Top navigation redesigned as chamfered "command keys"** with line icons, key numbers, live readouts, a scan-sweep hover and a glowing active bar. The colours follow the theme accent.
  - The SILAS key hides while the chat is on Mission Control.
  - Mobile moved into the ⋮ menu.
- **Mission Control layout:**
  - The chat is pinned top-left, with the TODAY tiles docked beside it.
  - Panels with nothing to show (such as an empty briefing) are skipped, so nothing is left floating.
  - The Fleet and Agenda pairing still works.
- **Desktop shortcuts.**
  - `create_shortcut.ps1` now points at its own folder; it used to point at the old Antigravity scratch copy.
  - It makes two icons: "Silas Console" and "SILAS Fullscreen".
- The header sits above page content, so its menus are no longer hidden behind tiles.
- `.gitignore` now also covers `pip_diary.json`, `ai_usage.json` and the `_backup_*` folders.

### Fixed
- `ERR_TOO_MANY_REDIRECTS` at `/`. Two hand-added `@app.get("/")` redirects (one to itself and one to the Vite dev port) were removed. The built UI is served at `/` as before.
- `{"detail":"Not Found"}` at `/`. `backend/app.py` had been truncated after the edit-printer route. The missing routes (printer delete and commands, tool select, thumbnails, calendar, AI config and chat, diagnose, and serving the front end) were restored, keeping the SILAS banner changes.
- The AI chat box no longer hangs on its own half-row when the briefing is empty.

## [2.3.0] - 2026-10-10

### Added
- **Siren** for prints that stop on their own: self-pause, cancel, a Klipper error mid-print, U1 level 2/3 pop-ups, or contact lost for over a minute mid-print.
  - It isn't triggered by your own Pause, Cancel or E-stop, or by normal finishes.
  - Arm/off badge, Silence button and a 3-second test.
- `switch_to_v2.3.bat` and `copy_settings_from_old.ps1` to carry settings across from older copies.

## [2.2.0] - 2026-10-10

### Added
- **Drives & Storage (Drive Commander).** Drive overview, root clutter fixer, deep folder organiser and duplicate quarantine, all with dry runs and an undo journal. It only works from the host PC and refuses system, program and game folders.
  - Originally built in Antigravity; merged and hardened here.
- **AI Usage tab.**
  - A limit-tracker card for each AI app, with a reset countdown and an alert when it's back.
  - Exact token and rate-limit metering of SILAS's own LLM calls.

## [2.1.0] - 2026-10-10

### Added
- **Live printer alerts.**
  - Snapmaker U1 exception-manager pop-ups (with `LLLL-MMMM-IIII-CCCC` codes), Klipper shutdowns and `!!` errors, and printers going offline mid-print.
  - A banner that stays until acknowledged, a sound, desktop pop-ups, an alert log and a test alert.
- Moonraker websocket event link per printer, with automatic reconnect.

## [2.0.0] - 2026-10-07

### Added
- **LAN access token** for every non-host device, set once via `?token=…` and kept in a cookie. Devices without it get a locked page.
- **Background state hub** that pushes snapshots over WebSocket `/ws`, with polling as a fallback.
- **Blended print ETA** with a confidence level, and automatic toolhead discovery (T0–T9 for the SV08 toolchanger).
- **Collision radar improvements:**
  - recurring events are expanded and all-day events ignored
  - the buffer can be set
  - only the first clash per printer is shown

### Security
- Leaked API keys removed from the source.
- Path traversal blocked when serving the UI.
- Printer control now requires the access token.
- Keys are stored server-side and shown masked.

[2.5.0]: https://github.com/OWNER/silas/releases/tag/v2.5.0
[2.4.0]: https://github.com/OWNER/silas/releases/tag/v2.4.0
[2.3.0]: https://github.com/OWNER/silas/releases/tag/v2.3.0
[2.2.0]: https://github.com/OWNER/silas/releases/tag/v2.2.0
[2.1.0]: https://github.com/OWNER/silas/releases/tag/v2.1.0
[2.0.0]: https://github.com/OWNER/silas/releases/tag/v2.0.0
