import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const PORT = process.env.PORT || 3000;

// ── Session store ────────────────────────────────────────────────────────────
// Each session: { state, clients: Set<WebSocket>, tickInterval }
const sessions = new Map();

function createSession(id) {
  return {
    state: {
      running: false,
      timeRemaining: 600, // default 10 min
      totalTime: 600,
      speakerName: '',
      overtime: false,
      controllerConnected: false,
    },
    clients: new Set(),
    tickInterval: null,
    controller: null, // WebSocket of the current controller
  };
}

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, createSession(id));
  return sessions.get(id);
}

// ── Broadcast state to all clients in a session ───────────────────────────────
function broadcast(session) {
  const msg = JSON.stringify({ type: 'state', payload: session.state });
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
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

// ── HTTP server (health check + static file hint) ─────────────────────────────
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
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
  ws.send(JSON.stringify({ type: 'state', payload: session.state }));

  // Grant or deny control
  if (role === 'control') {
    if (!session.controller) {
      session.controller = ws;
      session.state.controllerConnected = true;
      ws.send(JSON.stringify({ type: 'control_granted' }));
      broadcast(session);
    } else {
      ws.send(JSON.stringify({ type: 'control_denied' }));
    }
  }

  console.log(`[${sessionId}] ${role} connected. Clients: ${session.clients.size}`);

  ws.on('message', (raw) => {
    // Only the active controller can send commands
    if (ws !== session.controller) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const s = session.state;

    switch (msg.type) {

      case 'start':
        if (!s.running) {
          s.running = true;
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

      case 'set_speaker':
        s.speakerName = (msg.name || '').slice(0, 60);
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

      case 'claim_control':
        if (!session.controller) {
          session.controller = ws;
          session.state.controllerConnected = true;
          ws.send(JSON.stringify({ type: 'control_granted' }));
          broadcast(session);
        }
        break;

      case 'release_control':
        session.controller = null;
        session.state.controllerConnected = false;
        broadcast(session);
        broadcastMsg(session, { type: 'control_available' });
        break;
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[${sessionId}] ${role} disconnected. Clients: ${session.clients.size}`);

    // Release control if the controller disconnected
    if (session.controller === ws) {
      session.controller = null;
      session.state.controllerConnected = false;
      broadcast(session);
      broadcastMsg(session, { type: 'control_available' });
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
