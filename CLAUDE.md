# Speaker Timer — Claude Code Context

This file is the source of truth for Claude Code working on this project.
Read the entire file before making any changes.

---

## What This Is

A real-time speaker/presentation timer system built for AV and event production use.
Designed for venues where a desktop display shows the timer on a big screen while a
phone controller (reached by scanning a QR code) lets the operator or speaker manage
the session remotely.

**Key constraints that shaped every decision:**
- Target venue has tight enterprise WiFi security (Anschutz Medical Campus, Aurora CO)
- Device-to-device communication is blocked on the building network
- Solution: fully web-based, hosted publicly, works over any internet connection
- No app installs — everything runs in a browser

---

## Architecture

```
GitHub (one repo, two services)
│
├── backend/   ──→  Railway (Node.js WebSocket server)
│                   wss://your-app.railway.app
│
└── frontend/  ──→  Netlify (static HTML files)
                    timer.yourdomain.com
                      /display/?session=ID   ← big screen
                      /control/?session=ID   ← phone controller
                      /view/?session=ID      ← read-only audience
```

**How sessions work:**
- A session is identified by a short alphanumeric ID in the URL (e.g. `?session=ROOMA`)
- The display page auto-generates a session ID if none is provided and updates the URL
- The QR code encodes the full `/control/?session=ID` URL
- Multiple rooms can run simultaneously — each has its own isolated session
- Sessions auto-clean after 10 minutes of no connected clients
- Session state lives in server memory (Map) — no database needed at this scale

**WebSocket message flow:**
```
Phone (control role) ──→ server ──→ broadcast ──→ Display, View clients
```
Only `control` role clients can send commands. `display` and `view` are receive-only.

---

## File Structure

```
speaker-timer/
├── CLAUDE.md                        ← you are here
├── README.md                        ← human setup guide
├── package.json                     ← root scripts for local dev
├── .gitignore
│
├── backend/
│   ├── server.mjs                   ← main WebSocket server (Node ESM)
│   ├── package.json                 ← { "ws": "^8.16.0" }
│   └── railway.toml                 ← Railway deploy config
│
└── frontend/
    ├── netlify.toml                 ← URL routing rules
    ├── display/
    │   └── index.html               ← full-screen timer + QR code
    ├── control/
    │   └── index.html               ← mobile controller UI
    └── view/
        └── index.html               ← read-only audience view
```

---

## Backend: server.mjs

**Runtime:** Node.js 18+ ESM (`"type": "module"` in package.json)
**Dependencies:** Only `ws` (WebSocket library). No Express, no database, no auth.
**Port:** `process.env.PORT || 3000` — Railway injects PORT automatically

**Session state shape:**
```js
{
  running: false,          // boolean — is the timer ticking
  timeRemaining: 600,      // integer seconds (can go negative = overtime)
  totalTime: 600,          // integer seconds — original duration set
  speakerName: '',         // string max 60 chars
  overtime: false,         // boolean — true when timeRemaining < 0
}
```

**WebSocket message types (client → server, control role only):**
```js
{ type: 'start',        sessionId }
{ type: 'pause',        sessionId }
{ type: 'reset',        sessionId }
{ type: 'set_duration', sessionId, seconds: 900 }
{ type: 'set_speaker',  sessionId, name: 'Jane Smith' }
{ type: 'nudge',        sessionId, delta: 30 }   // or -60 etc
```

**Server → clients (broadcast on every state change):**
```js
{ type: 'state', payload: { ...sessionState } }
```

**Connection URL format:**
```
wss://your-app.railway.app?session=ROOMA&role=control
wss://your-app.railway.app?session=ROOMA&role=display
wss://your-app.railway.app?session=ROOMA&role=view
```

**Health check:** `GET /health` returns `{ ok: true, sessions: N }`

**Timer tick:** Server-side `setInterval` at 1000ms per session.
Tick only runs when `state.running === true`.
Auto-stops at -1800 seconds overtime to prevent runaway sessions.

---

## Frontend: Design System

All three pages share the same visual language:

**Aesthetic:** Industrial / utilitarian dark. Think AV rack gear, not consumer app.
- Background: `#0a0a0a`
- Surface: `#141414`
- Accent: `#e8ff47` (yellow-green — running state, progress bar)
- Warning (≤60s): `#ff9900`
- Danger (≤30s): `#ff4444` with flash animation
- Text: `#f0ede8`
- Muted: `#555`

**Fonts (Google Fonts CDN):**
- `Bebas Neue` — timer numerals and large headings
- `DM Mono` — labels, status, session IDs, monospace UI
- `DM Sans` — body text, inputs

**Timer color logic (timeRemaining):**
```
> 60s remaining  → accent (#e8ff47)
≤ 60s remaining  → warning (#ff9900)
≤ 30s remaining  → danger (#ff4444) + flash animation
< 0s (overtime)  → overtime state, negative time shown as -MM:SS
```

---

## Frontend: display/index.html

**Purpose:** Projected on the big screen during presentations.

**Layout (CSS Grid, 2-col):**
- Left col: giant timer numeral, progress bar, speaker name, status pill
- Right col: QR code panel with session ID label
- Bottom left: status bar with running/paused pill + overtime badge

**QR Code:**
- Library: `qrcodejs` from cdnjs CDN
- Encodes: `${window.location.origin}/control/?session=${sessionId}`
- Generated at page load using detected origin — works on any domain
- Session ID auto-generated if not in URL (`Math.random().toString(36).slice(2,8).toUpperCase()`)
- Updates URL via `window.history.replaceState` so it's shareable

**SERVER_URL config:**
```js
const SERVER_URL = window.SPEAKER_TIMER_SERVER || 'wss://your-app.railway.app';
```
Replace the fallback string with your Railway URL before deploying.

---

## Frontend: control/index.html

**Purpose:** Mobile phone controller. Opened by scanning the QR code.
**Meta tags:** `maximum-scale=1.0`, `apple-mobile-web-app-capable` — behaves like native on iOS

**Controls:**
- Speaker name text input (debounced 500ms, syncs to display)
- Duration presets: 5, 10, 15, 20, 30, 45, 60, 90 min (grid buttons)
- Custom duration input (any value 1–300 min)
- Nudge buttons: −5m, −1m, −30s, +30s, +1m, +5m (live time adjust)
- Main button: Start / Pause (toggles based on state)
- Reset button: returns to full duration, clears overtime

**State sync:**
- Receives full state on join and on every change
- Speaker name input only updates from server if the field isn't focused
  (prevents cursor jumping while user is typing)

---

## Frontend: view/index.html

**Purpose:** Read-only timer view for audience members or secondary displays.
Same visual style as display, but mobile-optimized and stripped of controls.
No QR code. Connects as `role=view` so server ignores any messages from it.

---

## Local Development

```bash
# Install deps
npm run install:backend

# Start backend (runs on :3000, auto-restarts on file change)
npm run dev:backend

# Serve frontend (runs on :8080)
npm run dev:frontend
```

In the HTML files, change SERVER_URL to `ws://localhost:3000` for local dev.

Open:
- `http://localhost:8080/display/?session=TEST`
- `http://localhost:8080/control/?session=TEST`
- `http://localhost:8080/view/?session=TEST`

---

## Deployment

### Railway (backend)

1. Connect GitHub repo to Railway
2. In Railway project settings → set **Root Directory** to `backend`
3. Railway auto-detects Node.js, runs `npm install` then `npm start`
4. Enable a public domain in Railway → copy the `wss://` URL
5. Set `PORT` env var if Railway doesn't inject it automatically (it usually does)

### Netlify (frontend)

1. Connect GitHub repo to Netlify
2. In build settings → set **Base directory** to `frontend`
3. No build command needed (pure static HTML)
4. Publish directory: `frontend` (or `.` relative to base)
5. `netlify.toml` handles routing for `/display/`, `/control/`, `/view/`

### After both are deployed

Update `SERVER_URL` in all three HTML files:
```js
const SERVER_URL = 'wss://your-actual-app.railway.app';
```
Commit and push — Netlify redeploys automatically.

---

## What's Not Built Yet

These are the logical next features, roughly in priority order:

1. **Config injection** — instead of hardcoding SERVER_URL in each HTML file,
   use a Netlify environment variable injected at build time, or a `/config.js`
   endpoint served by the backend. Eliminates the manual URL update step.

2. **Admin dashboard** — `/admin/` page showing all active sessions at a glance.
   Useful for multi-room conference management. Would show session ID, speaker name,
   time remaining, running state for each active session.

3. **PIN-protected control** — optional 4-digit PIN per session so random people
   who scan the QR can't hijack the timer. Low priority for single-operator use.

4. **Persistent session URLs** — right now sessions are ephemeral (in-memory).
   A lightweight SQLite or Redis layer would let sessions survive server restarts.
   Not needed until Railway's free tier restarts become a problem.

5. **Client-side fallback tick** — if WebSocket drops mid-presentation, the
   display should keep counting locally and resync on reconnect. The WS reconnect
   is already there; the local tick logic is stubbed but not implemented.

6. **Multiple QR codes** — display could show both a control QR and a view-only QR
   so operators and audience get different links from the same screen.

7. **Themes** — light mode version for bright rooms, high-contrast mode.

8. **Sound/vibration alerts** — phone haptic feedback at warning thresholds.

---

## Key Decisions & Why

| Decision | Reason |
|---|---|
| No database | Timer state is ephemeral by nature. Sessions last minutes, not days. A Map in memory is correct. |
| No auth framework | Session ID in URL is sufficient for AV use. Operator controls physical access to the display. |
| Server-side tick | Client clocks drift. Server is source of truth. Clients just render what they receive. |
| Pure static frontend | No build step = instant Netlify deploys, easy to edit files directly. |
| Single `ws` dependency | Keeping the server minimal makes Railway deploys fast and the codebase auditable. |
| ESM (`import`/`export`) | Node 18+ ESM is clean, no transpile step, matches modern JS everywhere. |
| One repo | Simpler to manage, Railway and Netlify both support root directory configuration. |

---

## Notes for Claude Code

- Always maintain the ESM format in backend files (`import`/`export`, not `require`)
- The frontend has zero build tooling — no webpack, no Vite, no npm. Keep it that way
  unless there's a strong reason to add a build step.
- CSS variables are defined on `:root` in each file independently — they're consistent
  by convention, not shared. If adding a fourth page, copy the `:root` block.
- The `ws` library's `WebSocket.OPEN` constant is used for readyState checks — don't
  use the numeric literal `1` directly.
- Session IDs are always `.toUpperCase().trim()` on the server side — enforce this on
  any new client-side session ID generation too.
- When adding new message types, add them to the `switch` in `server.mjs` AND document
  them in the "WebSocket message types" section above.
