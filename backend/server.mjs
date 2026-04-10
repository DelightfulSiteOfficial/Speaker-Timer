import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 3000;

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
      runCount: 0,     // increments each time reset is called after a timer was started
    },
    clients: new Set(),
    tickInterval: null,
    controller: null,             // WebSocket of the current controller
    waitingControllers: new Map(), // waitingId → { ws, name }
    everStarted: false,           // internal flag — tracks if current timer was ever started
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

  // Send current state immediately on join
  sendMsg(ws, { type: 'state', payload: session.state });

  // Grant or deny control
  if (role === 'control') {
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

  console.log(`[${sessionId}] ${role} connected. Clients: ${session.clients.size}`);

  ws.on('message', (raw) => {
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

    const s = session.state;

    switch (msg.type) {

      case 'start':
        if (!s.running) {
          s.running = true;
          session.everStarted = true;
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

      case 'set_message':
        s.message = (msg.text || '').slice(0, 200);
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
        session.waitingControllers.set(newWaitingId, { ws: prevWs, name: '' });
        sendMsg(prevWs, { type: 'control_denied', waitingId: newWaitingId });
        session.waitingControllers.delete(msg.targetId);
        session.controller = target.ws;
        session.state.controllerConnected = true;
        syncWaitingList(session);
        sendMsg(target.ws, { type: 'control_granted' });
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
    console.log(`[${sessionId}] ${role} disconnected. Clients: ${session.clients.size}`);

    // Release control if the controller disconnected
    if (session.controller === ws) {
      session.controller = null;
      session.state.controllerConnected = false;
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
