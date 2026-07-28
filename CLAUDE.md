# Speaker Timer — Claude Code Context

This file is the source of truth for Claude Code working on this project.
Read the entire file before making any changes.

Last verified against the codebase: **2026-07-27**.

---

## What This Is

A real-time speaker/presentation timer system built for AV and event production use.
A desktop display shows the timer on a big screen while a phone controller (reached by
scanning a QR code) lets the operator or speaker manage the session remotely.

**Key constraints that shaped every decision:**
- Target venue has tight enterprise WiFi security (Anschutz Medical Campus, Aurora CO)
- Device-to-device communication is blocked on the building network
- Solution: fully web-based, hosted publicly, works over any internet connection
- No app installs — everything runs in a browser

---

## Live Deployment

| | |
|---|---|
| Frontend | `https://speakertimerapp.com` (Netlify) |
| Backend | `wss://speaker-timer-production-4ec9.up.railway.app` (Railway) |
| Repo | `github.com/DelightfulSiteOfficial/Speaker-Timer` (**private**) |

**Railway requires `Root Directory = backend`.** The repo root has no `start` script, so a
service pointed at the root fails the build with "No start command detected". `backend/railway.toml`
is only read when the root directory is set correctly.

**Netlify requires a paid plan.** The free tier allows one contributor on private repos, and
commits here carry a `Co-Authored-By: Claude …` trailer, which counts as a second. On the free
tier every Git-triggered build is rejected before it runs — silently, with no deploy appearing.
If that ever recurs, a manual `netlify deploy --prod --dir=frontend` skips the Git build entirely.

Health check: `curl https://speaker-timer-production-4ec9.up.railway.app/health` → `{"ok":true,…}`

---

## Architecture

```
GitHub (one repo, two services)
│
├── backend/   ──→  Railway (Node.js WebSocket server, root dir = backend)
│
└── frontend/  ──→  Netlify (static HTML, base dir = frontend)
                      /              ← landing / session launcher
                      /display/      ← big screen + QR + presenter controls
                      /control/      ← phone controller
                      /view/         ← read-only audience
                      /hub/          ← multi-room manager
                      /event/        ← single-event console (agenda + timer)
                      /admin/        ← all-sessions dashboard
```

**How sessions work:**
- A session is a short alphanumeric ID in the URL (e.g. `?session=ROOMA`)
- Session IDs are `.toUpperCase().trim()` on the server — do the same client-side
- The display page auto-generates an ID if none is given and rewrites the URL via `history.replaceState`
- Multiple rooms run simultaneously; each session is fully isolated
- Sessions auto-clean 10 minutes after the last client disconnects
- State lives in a server-side `Map` — no database

---

## File Structure

```
speaker-timer/
├── CLAUDE.md                  ← you are here
├── README.md
├── package.json               ← root dev scripts only (no start script — see Railway note)
├── netlify.toml               ← root config: publish = "frontend"
│
├── backend/
│   ├── server.mjs             ← the whole server (~1030 lines, Node ESM)
│   ├── package.json           ← { "ws": "^8.16.0" }
│   └── railway.toml
│
└── frontend/                  ← zero build tooling; edit HTML directly
    ├── netlify.toml           ← redirects only (no publish key)
    ├── index.html             ← landing
    ├── display/index.html
    ├── control/index.html
    ├── view/index.html
    ├── hub/index.html
    ├── event/index.html
    └── admin/index.html
```

Each page is a single self-contained HTML file with inline `<style>` and `<script>`.
There is no shared CSS or JS. Nothing is minified or bundled.

---

## Backend: server.mjs

**Runtime:** Node.js 18+ ESM. **Dependencies:** `ws` only. No Express, no database, no auth framework.
**Port:** `process.env.PORT || 3000`.
**Env:** `STATS_KEY` guards `/stats` (defaults to the literal `'speaker-timer-stats'` — set a real
value in Railway before making this repo public).

### Broadcast session state

This is the exact object sent to every client as `{ type: 'state', payload: … }`:

```js
{
  running: false,           // is the timer ticking
  timeRemaining: 600,       // integer seconds, may go negative (overtime)
  totalTime: 600,           // original duration
  roomName: '',             // max 60 chars  ← NOT "speakerName"
  overtime: false,          // timeRemaining < 0
  controllerConnected: false,
  waitingList: [],          // [{ id, name }]     — queue, visible to all
  pendingRequests: [],      // [{ id, fromName }] — awaiting admin approval
  message: '',              // operator message shown on display (max 200)
  messageSeq: 0,            // bumps on every set_message so repeat text is detectable
  runCount: 0,              // increments on reset, if the timer had been started
  controllerName: '',
  presenterLocked: false,   // true = desktop presenter controls disabled
}
```

Server-internal fields (**never** broadcast): `clients`, `tickInterval`, `controller`,
`waitingControllers`, `everStarted`, `controlKey`, `keyVerified`, `presenterActivated`,
`prevControllerWaitingId`, `controlGraceTimer`, `keyDenied`.

### Connection URL

```
wss://HOST?session=ROOMA&role=control[&key=…][&presenter=true][&background=true][&force=true]
```

| Param | Meaning |
|---|---|
| `session` | required; uppercased + trimmed server-side |
| `role` | `display` \| `control` \| `view` (default `view`) |
| `key` | session control key; grants admin |
| `presenter=true` | the display page's own control socket — lowest priority holder |
| `background=true` | the hub's silent admin socket — yields to any real admin page |
| `force=true` | force-reclaim control (presenter or key-holder only) |

### Client → server

Any `control`-role client:

```js
{ type: 'request_control',   waitingId }
{ type: 'cancel_request',    waitingId }
{ type: 'claim_control' }
{ type: 'set_waiting_name',  waitingId, name }   // max 40
```

Current controller only:

```js
{ type: 'start' }
{ type: 'pause' }
{ type: 'reset' }
{ type: 'set_duration', seconds }      // 0–18000 (5 hr)
{ type: 'set_room',     name }         // max 60
{ type: 'set_message',  text }         // max 200
{ type: 'nudge',        delta }        // |delta| ≤ 3600, clamps at -1800
{ type: 'release_control' }
```

Controller **and** (`isAdmin` or `isPresenter`) only:

```js
{ type: 'approve_request',    targetId }
{ type: 'deny_request',       targetId }
{ type: 'pass_control_to',    targetId }
{ type: 'set_presenter_lock', locked }
```

### Server → client

```js
{ type: 'state',   payload }               // on join and every change
{ type: 'session_info', controlKey }       // admin + presenter connections only
{ type: 'control_granted' }
{ type: 'control_denied', waitingId }
{ type: 'control_request', requestId, fromName }
{ type: 'control_request_cancelled', requestId }
{ type: 'control_available' }
{ type: 'request_pending' }
{ type: 'request_denied' }
{ type: 'request_cancelled' }
{ type: 'key_required' }                   // wrong key — connection demoted to view
```

### HTTP endpoints

```
GET  /health                            → { ok: true, sessions: N }
GET  /sessions                          → { sessions: [{ id, state, clientCount }] }
GET  /stats?key=STATS_KEY               → HTML usage dashboard (in-memory, resets on restart)
POST /sessions/:id/load                 { name, seconds }      — set name + duration, reset
POST /sessions/:id/release              { key }                — force-release controller
POST /sessions/:id/pass                 { targetId, key }
POST /sessions/:id/approve-request      { targetId, key }
POST /sessions/:id/deny-request         { targetId, key }
```

CORS is wide open (`Access-Control-Allow-Origin: *`).

### Control arbitration — the most intricate part of the server

One controller per session; everyone else sits in `waitingControllers`. Most of `server.mjs`
exists to arbitrate this fairly across a phone that keeps locking its screen, a projector that
should never steal the timer mid-talk, and an operator who may walk away.

**`autoPromote()` priority order** (`server.mjs:82`):
1. `prevControllerWaitingId` — the admin who deliberately delegated control
2. first real human in the queue
3. background admin socket (hub)
4. Presenter Display — last-resort fallback, skipped when `humanOnly=true`

**The session control key.** Generated per session. `keyVerified` starts false, so access is open
until the first non-presenter control connection claims it — that client becomes admin and receives
the key via `session_info`. Presenter connections deliberately do **not** set `keyVerified`, or the
display would claim ownership before any human arrived. Clients that scan the plain QR never get
the key, so they cannot approve requests or transfer control.

**Grace periods.** A disconnecting controller starts a 20 s timer before control is offered on;
an HTTP `/release` starts 15 s with `humanOnly=true`. Both exist so a phone that locks and wakes
silently regains control instead of the projector grabbing it. Any reconnecting control client
cancels the pending timer.

**Timing constants:** tick 1000 ms · heartbeat ping 25 s (dead sockets terminated ~35 s) ·
auto-stop at −1800 s overtime · session cleanup 10 min after the last client leaves.

---

## Frontend: Design System

**Aesthetic:** industrial / utilitarian dark. AV rack gear, not consumer app.

```css
:root {
  --bg:      #0a0a0a;
  --surface: #111111;
  --border:  #1e1e1e;
  --text:    #f0ede8;
  --muted:   #555;
  --accent:  #e8ff47;   /* running state, progress bar */
  --danger:  #ff4444;
  --warn:    #ff9900;
}
```

**Fonts** (Google Fonts CDN): `Bebas Neue` (numerals, large headings) · `DM Mono` 300/400/500
(labels, status, session IDs) · `DM Sans` 300/400/500 (body, inputs).

**Timer colour logic:**

```
> 60s  → accent    ≤ 60s → warn    ≤ 30s → danger + flash    < 0s → overtime, shown as -MM:SS
```

Each page defines its own `:root` block. They are consistent **by convention, not by sharing** —
if you add a page, copy the block. If you change a token, change it in all seven files.

---

## Frontend: the seven pages

### `/` — landing (`index.html`, ~590 lines)
Session launcher. Create a session or join by ID, with a recent-sessions list from localStorage
offering Display / Control / Event / View links per session.

### `/display/` — big screen (~2554 lines)
Giant timer, progress bar, QR panel, status bar. The QR encodes
`${window.location.origin}/control/?session=${sessionId}` — built from the detected origin, so it
works on any domain. Also holds **fullscreen toggle**, **message flash** overlay, and the
**presenter panel** (duration slider, Start/Reset, nudges).

Opens **two** sockets: `role=display` for rendering, plus a second `role=control&presenter=true`
socket so the physical screen can take over when no operator is present. "Presenter Mode" adds
`force=true` to reclaim control from a phone; this sets `presenterActivated` server-side so a
background hub socket cannot silently undo it.

### `/control/` — phone controller (~1910 lines)
Drag dial for duration (with a Min/Sec mode toggle), preset buttons, nudges, Start/Pause, Reset.
`maximum-scale=1.0` and `apple-mobile-web-app-capable` for native-feeling iOS. Prompts for the
user's name, stored and reused. Handles the full waiting-room flow: request control, pending,
denied, granted. Speaker/room input only syncs from the server when the field is not focused,
so the cursor never jumps mid-typing.

Most of the recent commit history is mobile/tablet **landscape** layout tuning on this page and
the display. Those media queries are hand-tuned to real devices — change them deliberately.

### `/view/` — audience (~221 lines)
Read-only. Connects as `role=view`; the server ignores anything it sends. No QR, no controls.

### `/hub/` — multi-room manager (~2243 lines)
Room cards for many sessions at once, add-room sheet with a **QR scanner**, per-room agenda
builder, and co-host handoff (approve/deny/pass). Holds a **silent background admin socket**
per room (`role=control&key=…&background=true`) so it can act without stealing control from a
live operator.

### `/event/` — single-event console (~2642 lines)
Agenda panel + timer panel side by side, with a draggable column divider (width persisted) and
a mobile tab bar. Loading an agenda item pushes name + duration via `POST /sessions/:id/load`.

### `/admin/` — all-sessions dashboard (~721 lines)
Polls `GET /sessions` over HTTP (no WebSocket). Shows every active session with time, state, and
waiting list; can force-release or pass control. Derives its HTTP base from `SERVER_URL`.

---

## localStorage keys

| Key | Written by | Contents |
|---|---|---|
| `speakerTimerSessions` | index, display, control, event | recent sessions, capped at 10 |
| `speakerTimerRooms` | hub | saved room list |
| `speakerTimerAgendas` | hub, event | `{ sessionId: [items] }` — **local only, never synced** |
| `speakerTimerKeys` | event | `{ sessionId: controlKey }` |
| `speakerTimerKey_${id}` | control | that session's control key |
| `speakerTimerMyName` | control | the user's display name |
| `speakerTimerNamePromptSeen` | control | whether the name prompt has shown |
| `eventTimerPanelW` | event | timer column width |

---

## Local Development

```bash
npm run install:backend
npm run dev:backend     # :3000, node --watch
npm run dev:frontend    # :8080, npx serve
```

`.claude/launch.json` defines the same two servers for the preview tooling.
Set `SERVER_URL` to `ws://localhost:3000` in whichever pages you're testing — remember it is
hardcoded in **six** separate files.

Open `http://localhost:8080/display/?session=TEST` (and `/control/`, `/view/`, …).

---

## Known Gaps & Rough Edges

Verified present as of 2026-07-27:

1. **`sync_agenda` goes nowhere.** `event/index.html:2093` sends it; `server.mjs` has no handler.
   Agendas live in `localStorage` under `speakerTimerAgendas`, so hub and event never share them
   across devices. This is the largest real feature gap.
2. **Dead listener** — `control/index.html:1859` handles `waiting_list`, a message the server
   never sends (the queue arrives inside the `state` payload).
3. **`join` is a no-op** — display and view both send it; role comes from the query string.
4. **`SERVER_URL` is hardcoded in six files.** A backend move means six edits, which is exactly
   what caused the July 2026 outage. A single `frontend/config.js` would fix this permanently —
   it remains the highest-value cleanup.
5. **Two `netlify.toml` files** — the root one sets `publish = "frontend"`; `frontend/netlify.toml`
   holds redirects only. Both are needed as-is; don't merge them without care. A drag-and-drop
   deploy must use the `frontend/` one, since the root's `publish` key breaks a dropped folder.
6. **Empty directory literally named `{frontend,backend}`** — a shell brace-expansion accident,
   safe to delete.
7. **`STATS_KEY` has a literal default** in `server.mjs:6`.

### Wishlist (not started)

Admin PIN per session · persistent sessions (SQLite/Redis) · client-side fallback tick on WS drop ·
separate control and view QR codes on the display · light / high-contrast themes · haptic alerts.

---

## Key Decisions & Why

| Decision | Reason |
|---|---|
| No database | Timer state is ephemeral. Sessions last minutes. A `Map` is correct. |
| No auth framework | Per-session control key + physical control of the display is enough for AV use. |
| Server-side tick | Client clocks drift. The server is the source of truth; clients render what they receive. |
| Pure static frontend | No build step = instant deploys and directly editable files. |
| Single `ws` dependency | Keeps Railway deploys fast and the server auditable. |
| ESM | Node 18+ ESM, no transpile step. |
| One repo | Railway and Netlify both support a root/base directory. |
| Presenter as lowest-priority holder | The projector should keep a session alive, never outrank a human. |

---

## Notes for Claude Code

- Backend is ESM — `import`/`export`, never `require`.
- The frontend has **zero build tooling**. No webpack, Vite, or npm. Keep it that way.
- Use `WebSocket.OPEN` for readyState checks, never the literal `1`.
- Session IDs are always `.toUpperCase().trim()`.
- New message types must be added to the `switch` in `server.mjs` **and** documented above.
- Adding a page means copying the `:root` block and adding redirects to **both** `netlify.toml`
  files plus `frontend/_redirects` if you regenerate a drop bundle.
- The mobile/tablet landscape media queries on control and display are hand-tuned against real
  devices over many commits. Don't refactor them casually.
- After any push that must reach production, **verify the live site actually serves it** —
  `curl https://speakertimerapp.com/display/ | grep -o 'wss://[a-z0-9.-]*'`. This project has a
  history of deploy pipelines failing silently.
