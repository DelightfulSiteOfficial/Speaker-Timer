import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT       = process.env.PORT       || 3000;
const STATS_KEY  = process.env.STATS_KEY  || 'speaker-timer-stats';

// ── Lifetime stats (in-memory, resets on restart) ────────────────────────────
const stats = {
  serverStarted:    new Date(),
  connections:      { control: 0, display: 0, view: 0 },
  uniqueSessions:   new Set(),
  peakConcurrent:   0,
  timerStarts:      0,
  messagesSent:     0,
};

// ── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();

function generateId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createSession(id) {
  return {
    state: {
      running: false,
      timeRemaining: 600, // default 10 min
      totalTime: 600,
      roomName: '',
      overtime: false,
      controllerConnected: false,
      waitingList: [], // [{ id, name }] — visible to all clients
      message: '',     // operator message shown on display when QR is hidden
      messageSeq: 0,   // increments on every set_message so same-text resends are detectable
      runCount: 0,     // increments each time reset is called after a timer was started
      coHost: false,
      coHostName: '',
      presenterLocked: false,  // true = desktop presenter controls disabled
      operatorApproved: false, // true after first operator is approved (display-side gate)
    },
    clients: new Set(),
    tickInterval: null,
    controller: null,             // WebSocket of the current controller
    waitingControllers: new Map(), // waitingId → { ws, name }
    everStarted: false,           // internal flag — tracks if current timer was ever started
    coHostWs: null,
    controlKey: Math.random().toString(36).slice(2,8).toUpperCase() + Math.random().toString(36).slice(2,8).toUpperCase(),
    keyVerified: false,
    approvedDeviceTokens: new Set(), // per-device tokens issued on approval — required for trusted_reclaim
  };
}

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, createSession(id));
  return sessions.get(id);
}

function syncWaitingList(session) {
  session.state.waitingList = Array.from(session.waitingControllers.entries())
    .map(([id, { name }]) => ({ id, name }));
}

// ── Broadcast state to all clients in a session ───────────────────────────────
function broadcast(session) {
  const msg = JSON.stringify({ type: 'state', payload: session.state });
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ── Send a message to one client ──────────────────────────────────────────────
function sendMsg(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Broadcast a non-state message to all clients ──────────────────────────────
function broadcastMsg(session, msg) {
  const str = JSON.stringify(msg);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  }
}

// ── Timer tick ────────────────────────────────────────────────────────────────
function startTick(session, sessionId) {
  if (session.tickInterval) return;
  session.tickInterval = setInterval(() => {
    const s = session.state;
    if (!s.running) return;

    s.timeRemaining -= 1;

    if (s.timeRemaining < 0) {
      s.overtime = true;
    }

    broadcast(session);

    // Auto-stop at -30 minutes overtime to avoid runaway sessions
    if (s.timeRemaining < -1800) {
      s.running = false;
      clearInterval(session.tickInterval);
      session.tickInterval = null;
    }
  }, 1000);
}

function stopTick(session) {
  if (session.tickInterval) {
    clearInterval(session.tickInterval);
    session.tickInterval = null;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  if (req.url === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const list = [];
    for (const [id, session] of sessions.entries()) {
      list.push({
        id,
        state: session.state,
        clientCount: session.clients.size,
      });
    }
    res.end(JSON.stringify({ sessions: list }));
    return;
  }

  // GET /stats?key=…  — private usage dashboard
  if (req.method === 'GET' && req.url.startsWith('/stats')) {
    const { query: q } = parse(req.url, true);
    if (q.key !== STATS_KEY) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Count currently active connections across all sessions
    let activeCx = 0;
    for (const s of sessions.values()) activeCx += s.clients.size;

    const upMs      = Date.now() - stats.serverStarted.getTime();
    const upDays    = Math.floor(upMs / 86400000);
    const upHours   = Math.floor((upMs % 86400000) / 3600000);
    const upMins    = Math.floor((upMs % 3600000)  / 60000);
    const upStr     = upDays > 0
      ? `${upDays}d ${upHours}h ${upMins}m`
      : upHours > 0 ? `${upHours}h ${upMins}m` : `${upMins}m`;

    const total = stats.connections.control + stats.connections.display + stats.connections.view;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Speaker Timer — Stats</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#f0ede8;font-family:'DM Mono',ui-monospace,monospace;
       padding:48px 40px;min-height:100vh}
  h1{font-size:13px;letter-spacing:.25em;text-transform:uppercase;color:#555;margin-bottom:40px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:40px}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:24px 20px}
  .card .val{font-size:42px;font-weight:700;letter-spacing:-.02em;color:#e8ff47;
             font-family:system-ui,sans-serif;line-height:1;margin-bottom:8px}
  .card .val.muted{color:#f0ede8}
  .card .lbl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#555}
  .section{margin-bottom:32px}
  .section h2{font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:#333;
              margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1a1a1a}
  .row{display:flex;justify-content:space-between;align-items:center;
       padding:10px 0;border-bottom:1px solid #141414;font-size:12px}
  .row:last-child{border-bottom:none}
  .row .k{color:#555;letter-spacing:.12em}
  .row .v{color:#f0ede8}
  .footer{font-size:10px;color:#333;letter-spacing:.15em;margin-top:32px}
  @media(max-width:500px){body{padding:28px 20px}.card .val{font-size:32px}}
</style>
</head>
<body>
<h1>Speaker Timer &mdash; Usage Stats</h1>

<div class="grid">
  <div class="card">
    <div class="val">${stats.connections.control.toLocaleString()}</div>
    <div class="lbl">QR Scans (control joins)</div>
  </div>
  <div class="card">
    <div class="val">${stats.uniqueSessions.size.toLocaleString()}</div>
    <div class="lbl">Unique Sessions</div>
  </div>
  <div class="card">
    <div class="val">${stats.timerStarts.toLocaleString()}</div>
    <div class="lbl">Timer Starts</div>
  </div>
  <div class="card">
    <div class="val">${stats.messagesSent.toLocaleString()}</div>
    <div class="lbl">Messages Sent</div>
  </div>
  <div class="card">
    <div class="val">${activeCx}</div>
    <div class="lbl">Active Connections Now</div>
  </div>
  <div class="card">
    <div class="val">${stats.peakConcurrent}</div>
    <div class="lbl">Peak Concurrent</div>
  </div>
</div>

<div class="section">
  <h2>Connection breakdown (lifetime)</h2>
  <div class="row"><span class="k">Control (QR scans)</span><span class="v">${stats.connections.control.toLocaleString()}</span></div>
  <div class="row"><span class="k">Display screens</span><span class="v">${stats.connections.display.toLocaleString()}</span></div>
  <div class="row"><span class="k">View-only</span><span class="v">${stats.connections.view.toLocaleString()}</span></div>
  <div class="row"><span class="k">Total connections</span><span class="v">${total.toLocaleString()}</span></div>
</div>

<div class="section">
  <h2>Server</h2>
  <div class="row"><span class="k">Started</span><span class="v">${stats.serverStarted.toUTCString()}</span></div>
  <div class="row"><span class="k">Uptime</span><span class="v">${upStr}</span></div>
  <div class="row"><span class="k">Active sessions</span><span class="v">${sessions.size}</span></div>
</div>

<div class="footer">Stats reset on server restart &mdash; showing data since ${stats.serverStarted.toDateString()}</div>
</body>
</html>`);
    return;
  }

  // POST /sessions/:id/load  — admin loads an agenda item (sets name + duration, resets timer)
  const loadMatch = req.url.match(/^\/sessions\/([^/]+)\/load$/);
  if (req.method === 'POST' && loadMatch) {
    const sessionId = loadMatch[1].toUpperCase().trim();
    const body = await readBody(req);
    let name, seconds;
    try { ({ name, seconds } = JSON.parse(body)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }
    const secs = parseInt(seconds);
    if (!secs || secs < 1 || secs > 18000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'seconds must be 1–18000' }));
      return;
    }
    const session = getSession(sessionId);
    session.state.roomName      = (name || '').slice(0, 60);
    session.state.totalTime     = secs;
    session.state.timeRemaining = secs;
    session.state.running       = false;
    session.state.overtime      = false;
    stopTick(session);
    broadcast(session);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /sessions/:id/release  — admin force-releases the current controller
  const releaseMatch = req.url.match(/^\/sessions\/([^/]+)\/release$/);
  if (req.method === 'POST' && releaseMatch) {
    const sessionId = releaseMatch[1].toUpperCase().trim();
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      return;
    }
    if (session.controller) {
      const ws = session.controller;
      const newWaitingId = generateId();
      session.waitingControllers.set(newWaitingId, { ws, name: '' });
      session.controller = null;
      session.state.controllerConnected = false;
      session.coHostWs = null;
      session.state.coHost = false;
      session.state.coHostName = '';
      syncWaitingList(session);
      sendMsg(ws, { type: 'control_denied', waitingId: newWaitingId });
      broadcast(session);
      broadcastMsg(session, { type: 'control_available' });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /sessions/:id/pass  — admin passes control to a waiting person
  const passMatch = req.url.match(/^\/sessions\/([^/]+)\/pass$/);
  if (req.method === 'POST' && passMatch) {
    const sessionId = passMatch[1].toUpperCase().trim();
    const body = await readBody(req);
    let targetId;
    try { ({ targetId } = JSON.parse(body)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      return;
    }
    const target = session.waitingControllers.get(targetId);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Target not found' }));
      return;
    }
    // Demote current controller to waiting (if any)
    if (session.controller) {
      const prevWs = session.controller;
      const newWaitingId = generateId();
      session.waitingControllers.set(newWaitingId, { ws: prevWs, name: '' });
      sendMsg(prevWs, { type: 'control_denied', waitingId: newWaitingId });
    }
    // Promote target
    session.waitingControllers.delete(targetId);
    session.controller = target.ws;
    session.state.controllerConnected = true;
    syncWaitingList(session);
    sendMsg(target.ws, { type: 'control_granted' });
    broadcast(session);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /sessions/:id/assign-cohost  — admin assigns a co-host
  const assignCohostMatch = req.url.match(/^\/sessions\/([^/]+)\/assign-cohost$/);
  if (req.method === 'POST' && assignCohostMatch) {
    const sessionId = assignCohostMatch[1].toUpperCase().trim();
    const body = await readBody(req);
    let targetId;
    try { ({ targetId } = JSON.parse(body)); } catch { targetId = undefined; }
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      return;
    }
    if (targetId) {
      // Promote a waiting person as co-host
      const target = session.waitingControllers.get(targetId);
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Target not found' }));
        return;
      }
      // Demote current controller (if any) to waiting
      if (session.controller) {
        const prevWs = session.controller;
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws: prevWs, name: '' });
        sendMsg(prevWs, { type: 'control_denied', waitingId: newWaitingId });
      }
      // Promote target as co-host
      session.waitingControllers.delete(targetId);
      session.controller = target.ws;
      session.coHostWs = target.ws;
      session.state.controllerConnected = true;
      session.state.coHost = true;
      session.state.coHostName = target.name || '';
      syncWaitingList(session);
      sendMsg(target.ws, { type: 'control_granted' });
      broadcast(session);
    } else {
      // Mark current controller as co-host
      if (!session.controller) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No active controller' }));
        return;
      }
      session.coHostWs = session.controller;
      session.state.coHost = true;
      session.state.coHostName = '';
      broadcast(session);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Speaker Timer WebSocket server running.');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const { query } = parse(req.url, true);
  const sessionId = (query.session || '').toUpperCase().trim();
  const role      = query.role || 'view'; // display | control | view

  if (!sessionId) { ws.close(1008, 'No session ID'); return; }

  const session = getSession(sessionId);
  session.clients.add(ws);

  // ── Track stats ──────────────────────────────────────────────────────────
  stats.uniqueSessions.add(sessionId);
  if (role === 'control' || role === 'display' || role === 'view') {
    stats.connections[role]++;
  }
  const totalNow = wss.clients.size;
  if (totalNow > stats.peakConcurrent) stats.peakConcurrent = totalNow;

  // Send current state immediately on join
  sendMsg(ws, { type: 'state', payload: session.state });

  // Key validation for control role
  let effectiveRole = role;
  if (role === 'control') {
    const providedKey = (query.key || '').toUpperCase().trim();
    const keyValid = !session.keyVerified || providedKey === session.controlKey;
    if (!keyValid) {
      effectiveRole = 'view';
      session.keyDenied = session.keyDenied || new Set();
      session.keyDenied.add(ws);
      sendMsg(ws, { type: 'key_required' });
    }
  }

  // Grant or deny control
  if (effectiveRole === 'control') {
    // Admin force-reclaim: presenter display kicks current operator back to waiting list.
    // Requires a valid key AND prior approval so only a vetted display can do this.
    if (query.force === 'true' && session.controller && session.keyVerified && session.state.operatorApproved) {
      const providedKey = (query.key || '').toUpperCase().trim();
      if (providedKey === session.controlKey) {
        const kicked = session.controller;
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws: kicked, name: 'Operator' });
        sendMsg(kicked, { type: 'control_denied', waitingId: newWaitingId });
        session.controller = null;
        session.state.controllerConnected = false;
        syncWaitingList(session);
      }
    }

    session.keyVerified = true;
    sendMsg(ws, { type: 'session_info', controlKey: session.controlKey });
    if (!session.controller) {
      session.controller = ws;
      session.state.controllerConnected = true;
      sendMsg(ws, { type: 'control_granted' });
      broadcast(session);
    } else {
      const waitingId = generateId();
      session.waitingControllers.set(waitingId, { ws, name: '' });
      syncWaitingList(session);
      sendMsg(ws, { type: 'control_denied', waitingId });
      broadcast(session);
    }
  }

  // Send controlKey to display clients so they can build the QR URL
  if (role === 'display') {
    sendMsg(ws, { type: 'session_info', controlKey: session.controlKey });
  }

  console.log(`[${sessionId}] ${role} connected. Clients: ${session.clients.size}`);

  ws.on('message', (raw) => {
    // Silently ignore all messages from key-denied connections
    if (session.keyDenied && session.keyDenied.has(ws)) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Messages any control-role client can send ─────────────────────────────

    if (msg.type === 'request_control') {
      const entry = session.waitingControllers.get(msg.waitingId);
      if (!entry || entry.ws !== ws) return;
      if (!session.controller) {
        // No active controller — grant directly
        session.waitingControllers.delete(msg.waitingId);
        session.controller = ws;
        session.state.controllerConnected = true;
        syncWaitingList(session);
        sendMsg(ws, { type: 'control_granted' });
        broadcast(session);
        return;
      }
      // If a co-host has control, don't forward requests to them — they can't approve
      if (session.coHostWs === session.controller) {
        sendMsg(ws, { type: 'request_pending' });
        return;
      }
      const fromName = entry.name || 'Someone';
      sendMsg(session.controller, { type: 'control_request', requestId: msg.waitingId, fromName });
      sendMsg(ws, { type: 'request_pending' });
      return;
    }

    if (msg.type === 'cancel_request') {
      if (session.controller) {
        sendMsg(session.controller, { type: 'control_request_cancelled', requestId: msg.waitingId });
      }
      sendMsg(ws, { type: 'request_cancelled' });
      return;
    }

    if (msg.type === 'claim_control') {
      if (!session.controller) {
        // Remove from waiting list if present
        for (const [wid, entry] of session.waitingControllers.entries()) {
          if (entry.ws === ws) { session.waitingControllers.delete(wid); break; }
        }
        session.controller = ws;
        session.state.controllerConnected = true;
        syncWaitingList(session);
        sendMsg(ws, { type: 'control_granted' });
        broadcast(session);
      }
      return;
    }

    if (msg.type === 'trusted_reclaim') {
      // Requires BOTH the session key AND a per-device token issued at approval time.
      // Having the QR URL (key) alone is not enough — the device token is never in
      // the URL, only in the approving device's localStorage.
      if (!session.keyVerified || !session.controlKey) return;
      const providedKey   = (msg.key || '').toUpperCase().trim();
      const deviceToken   = (msg.deviceToken || '').toUpperCase().trim();
      if (providedKey !== session.controlKey) return;
      if (!deviceToken || !session.approvedDeviceTokens.has(deviceToken)) return;
      // Must be in the waiting list
      let myWaitingId = null;
      for (const [wid, entry] of session.waitingControllers.entries()) {
        if (entry.ws === ws) { myWaitingId = wid; break; }
      }
      if (!myWaitingId) return;
      // Kick current controller back to waiting list
      if (session.controller) {
        const kicked = session.controller;
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws: kicked, name: 'Presenter' });
        sendMsg(kicked, { type: 'control_denied', waitingId: newWaitingId });
      }
      // Promote this ws
      session.waitingControllers.delete(myWaitingId);
      session.controller = ws;
      session.state.controllerConnected = true;
      syncWaitingList(session);
      sendMsg(ws, { type: 'control_granted' });
      broadcast(session);
      return;
    }

    if (msg.type === 'set_waiting_name') {
      const entry = session.waitingControllers.get(msg.waitingId);
      if (entry && entry.ws === ws) {
        entry.name = (msg.name || '').slice(0, 40);
        syncWaitingList(session);
        broadcast(session);
      }
      return;
    }

    // ── Controller-only messages ──────────────────────────────────────────────
    if (ws !== session.controller) return;

    // Co-host restrictions — cannot transfer or delegate control
    if (session.coHostWs === ws) {
      if (['pass_control_to', 'approve_request', 'deny_request', 'release_control', 'set_presenter_lock'].includes(msg.type)) return;
    }

    const s = session.state;

    switch (msg.type) {

      case 'start':
        if (!s.running) {
          s.running = true;
          session.everStarted = true;
          stats.timerStarts++;
          startTick(session, sessionId);
          broadcast(session);
        }
        break;

      case 'pause':
        if (s.running) {
          s.running = false;
          broadcast(session);
        }
        break;

      case 'reset':
        if (session.everStarted) s.runCount++;
        session.everStarted = false;
        s.running = false;
        s.timeRemaining = s.totalTime;
        s.overtime = false;
        stopTick(session);
        broadcast(session);
        break;

      case 'set_duration': {
        const secs = parseInt(msg.seconds);
        if (!secs || secs < 1 || secs > 18000) break; // 1s – 5hr
        s.totalTime = secs;
        s.timeRemaining = secs;
        s.running = false;
        s.overtime = false;
        stopTick(session);
        broadcast(session);
        break;
      }

      case 'set_room':
        s.roomName = (msg.name || '').slice(0, 60);
        broadcast(session);
        break;

      case 'set_presenter_lock':
        s.presenterLocked = !!msg.locked;
        broadcast(session);
        break;

      case 'set_message':
        s.message = (msg.text || '').slice(0, 200);
        if (s.message) { s.messageSeq++; stats.messagesSent++; }
        broadcast(session);
        break;

      case 'nudge': {
        const delta = parseInt(msg.delta);
        if (!delta || Math.abs(delta) > 3600) break;
        s.timeRemaining = Math.max(-1800, s.timeRemaining + delta);
        s.overtime = s.timeRemaining < 0;
        broadcast(session);
        break;
      }

      case 'approve_request': {
        const target = session.waitingControllers.get(msg.targetId);
        if (!target) break;
        const prevWs = ws;
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws: prevWs, name: 'Presenter Display' });
        sendMsg(prevWs, { type: 'control_denied', waitingId: newWaitingId });
        session.waitingControllers.delete(msg.targetId);
        session.controller = target.ws;
        session.state.controllerConnected = true;
        session.state.operatorApproved = true;
        // Mint a per-device token for this specific device — only this device can
        // use trusted_reclaim. Having the QR key alone is not sufficient.
        const deviceToken = generateId() + generateId() + generateId();
        session.approvedDeviceTokens.add(deviceToken);
        syncWaitingList(session);
        sendMsg(target.ws, { type: 'control_granted', deviceToken });
        broadcast(session);
        break;
      }

      case 'deny_request': {
        const target = session.waitingControllers.get(msg.targetId);
        if (!target) break;
        sendMsg(target.ws, { type: 'request_denied' });
        break;
      }

      case 'pass_control_to': {
        const target = session.waitingControllers.get(msg.targetId);
        if (!target) break;

        // Put current controller into the waiting list
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws, name: '' });
        sendMsg(ws, { type: 'control_denied', waitingId: newWaitingId });

        // Promote the target
        session.waitingControllers.delete(msg.targetId);
        session.controller = target.ws;
        syncWaitingList(session);
        sendMsg(target.ws, { type: 'control_granted' });
        broadcast(session);
        break;
      }

      case 'release_control': {
        // Put current controller into the waiting list
        const newWaitingId = generateId();
        session.waitingControllers.set(newWaitingId, { ws, name: '' });
        session.controller = null;
        session.state.controllerConnected = false;
        syncWaitingList(session);
        sendMsg(ws, { type: 'control_denied', waitingId: newWaitingId });
        broadcast(session);
        broadcastMsg(session, { type: 'control_available' });
        break;
      }
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.keyDenied) session.keyDenied.delete(ws);
    console.log(`[${sessionId}] ${role} disconnected. Clients: ${session.clients.size}`);

    // Release control if the controller disconnected
    if (session.controller === ws) {
      session.controller = null;
      session.state.controllerConnected = false;
      if (session.coHostWs === ws) {
        session.coHostWs = null;
        session.state.coHost = false;
        session.state.coHostName = '';
      }
      syncWaitingList(session);
      broadcast(session);
      broadcastMsg(session, { type: 'control_available' });
    }

    // Remove from waiting list if present
    for (const [wid, entry] of session.waitingControllers.entries()) {
      if (entry.ws === ws) {
        session.waitingControllers.delete(wid);
        syncWaitingList(session);
        broadcast(session);
        break;
      }
    }

    // Clean up idle sessions (no clients for 10 minutes)
    if (session.clients.size === 0) {
      setTimeout(() => {
        if (session.clients.size === 0) {
          stopTick(session);
          sessions.delete(sessionId);
          console.log(`[${sessionId}] Session cleaned up.`);
        }
      }, 10 * 60 * 1000);
    }
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] WS error:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Speaker Timer server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
