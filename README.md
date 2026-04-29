# Speaker Timer

A real-time speaker timer with WebSocket sync across desktop display, mobile controller, and audience view.

## Architecture

```
Frontend (Netlify)          Backend (Railway)
timer.phuzzforge.com   →    wss://your-app.railway.app
  /display                  WebSocket server
  /control                  Session management
  /view                     Timer state + broadcast
```

## Project Structure

```
speaker-timer/
├── frontend/               → Deploy to Netlify
│   ├── display/index.html  → Big screen timer + QR code
│   ├── control/index.html  → Mobile controller
│   ├── view/index.html     → Read-only audience view
│   └── netlify.toml
└── backend/                → Deploy to Railway
    ├── server.mjs
    └── package.json
```

## Setup

### 1. Deploy Backend to Railway

1. Push `backend/` to a GitHub repo
2. Connect repo to Railway
3. Railway auto-detects Node.js and runs `npm start`
4. Copy your Railway public URL (e.g. `wss://speaker-timer-production.up.railway.app`)

### 2. Configure Frontend

In both `display/index.html` and `control/index.html`, update the server URL:

```js
const SERVER_URL = 'wss://your-app.railway.app';
```

Or set it via an environment variable / config file for cleaner deploys.

### 3. Deploy Frontend to Netlify

1. Push `frontend/` to GitHub (can be same repo, different folder)
2. Connect to Netlify, set publish directory to `frontend/`
3. Done — Netlify handles routing via `netlify.toml`

## Usage

1. Open `https://timer.yourdomain.com/display/?session=ROOM1` on the presentation screen
2. QR code appears automatically — scan with phone
3. Phone opens `/control/?session=ROOM1` 
4. Set speaker name, duration, hit Start
5. Timer syncs instantly to display

## Session IDs

Sessions are auto-generated if none is provided in the URL. For multi-room use, use descriptive IDs:
- `/display/?session=ROOMA`
- `/display/?session=ROOMB`

Each session is completely isolated.

## Local Development

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend — just open the HTML files directly
# or use a local server:
cd frontend
npx serve .
```

Update `SERVER_URL` to `ws://localhost:3000` for local dev.

