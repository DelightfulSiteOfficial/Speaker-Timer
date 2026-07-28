# Speaker Timer

A real-time speaker timer with WebSocket sync across a big-screen display, a phone
controller, and an audience view. Built for AV and event production — no app installs,
works over any internet connection.

**Live:** https://speakertimerapp.com

## Architecture

```
Frontend (Netlify)              Backend (Railway)
speakertimerapp.com      →      wss://speaker-timer-production-4ec9.up.railway.app
  /            landing            WebSocket server
  /display     big screen         Session management
  /control     phone              Timer state + broadcast
  /view        audience           Control arbitration
  /hub         multi-room
  /event       agenda + timer
  /admin       all sessions
```

## Project Structure

```
speaker-timer/
├── frontend/               → Netlify  (base directory: frontend)
│   ├── index.html          → landing / session launcher
│   ├── display/index.html  → big screen timer, QR code, presenter controls
│   ├── control/index.html  → phone controller
│   ├── view/index.html     → read-only audience view
│   ├── hub/index.html      → multi-room manager
│   ├── event/index.html    → single-event console (agenda + timer)
│   ├── admin/index.html    → all-sessions dashboard
│   └── netlify.toml
└── backend/                → Railway  (root directory: backend)
    ├── server.mjs
    ├── package.json
    └── railway.toml
```

## Usage

1. Open `https://speakertimerapp.com/display/?session=ROOM1` on the presentation screen
2. A QR code appears automatically — scan it with a phone
3. The phone opens `/control/?session=ROOM1`
4. Set the room name and duration, then hit Start
5. The timer syncs instantly to every connected screen

Sessions are auto-generated if you don't supply one. For multi-room events, use
descriptive IDs — `?session=ROOMA`, `?session=ROOMB`. Each session is fully isolated,
and sessions clean themselves up 10 minutes after the last client disconnects.

## Setup

### Backend — Railway

1. Connect the repo to Railway
2. **Set Root Directory to `backend`** — this is required. The repo root has no `start`
   script, so a service pointed at the root fails with "No start command detected"
3. Railway auto-detects Node and runs `npm start`
4. Generate a public domain and copy the `wss://` URL

### Frontend — Netlify

1. Connect the repo to Netlify
2. Set **Base directory** to `frontend`
3. No build command needed — it's pure static HTML
4. `frontend/netlify.toml` handles routing for all seven pages

**Netlify plan note:** the free tier allows only one contributor on private repos.
Commits in this repo carry a `Co-Authored-By` trailer, which counts as a second
contributor, so free-tier builds are rejected before they run — silently, with no
deploy appearing at all. This repo needs a paid plan, or a public repo.

### Pointing the frontend at the backend

`SERVER_URL` is currently hardcoded in **six** files:

```
frontend/display/index.html      frontend/hub/index.html
frontend/control/index.html      frontend/event/index.html
frontend/view/index.html         frontend/admin/index.html
```

If the backend URL changes, update all six:

```bash
grep -rl 'OLD-HOSTNAME' frontend/ | xargs sed -i '' 's|OLD-HOSTNAME|NEW-HOSTNAME|g'
```

Then verify the deploy actually landed — don't assume it did:

```bash
curl -s https://speakertimerapp.com/display/ | grep -o 'wss://[a-z0-9.-]*'
```

## Local Development

```bash
npm run install:backend
npm run dev:backend     # WebSocket server on :3000
npm run dev:frontend    # static files on :8080
```

Set `SERVER_URL` to `ws://localhost:3000` in the pages you're testing, then open
`http://localhost:8080/display/?session=TEST`.

Backend health check:

```bash
curl https://speaker-timer-production-4ec9.up.railway.app/health
```

## Manual deploy

If the Git pipeline is ever broken, you can deploy the frontend directly:

```bash
netlify deploy --prod --dir=frontend
```

This skips the Git-triggered build entirely. Alternatively, drag the `frontend/`
folder onto the drop zone in your existing site's **Deploys** tab — use the existing
site rather than `app.netlify.com/drop`, which would create a new site and lose the
domain.

---

See [CLAUDE.md](CLAUDE.md) for the full technical reference — protocol, state shape,
control-arbitration rules, and known gaps.
