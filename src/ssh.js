// Bridges each authenticated WebSocket to an ssh2 client session.
// Protocol (JSON text client->server):
//   {type:'connect', host, port, username, auth:{type:'password'|'key', value, passphrase?}, cols, rows}
//   {type:'data', data}        keyboard input
//   {type:'resize', cols, rows}
//   {type:'disconnect'}
// Server->client: JSON text {type:'status'|'connected'|'error'|'closed', ...},
// binary frames = raw SSH terminal output.
import { Client } from 'ssh2';

const MAX_HOST_LEN = 253;
const HOST_RE = /^[A-Za-z0-9._\-:[\]]+$/;
const USER_RE = /^[A-Za-z0-9._\-@]+$/;

const intEnv = (name, dflt) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : dflt;
};

// capacity guards — protect the box, esp. on open instances
const MAX_SESSIONS = intEnv('MAX_SESSIONS', 100);
const MAX_SESSIONS_PER_IP = intEnv('MAX_SESSIONS_PER_IP', 3);
const MAX_CONNECTS_PER_IP = intEnv('MAX_CONNECTS_PER_IP', 20);
const CONNECT_WINDOW_MS = 5 * 60_000;
const connectWindow = new Map(); // ip -> recent connect timestamps
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of connectWindow) {
    const keep = arr.filter((t) => now - t < CONNECT_WINDOW_MS);
    if (keep.length) connectWindow.set(ip, keep); else connectWindow.delete(ip);
  }
}, 60_000).unref?.();

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function attachSshBridge(wss) {
  // liveness ping: drop dead sockets
  const ping = setInterval(() => {
    for (const c of wss.clients) {
      if (c.isAlive === false) { c.terminate(); continue; }
      c.isAlive = false;
      c.ping();
    }
  }, 30_000);
  ping.unref?.();

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let conn = null;
    let stream = null;

    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    // capacity guards (per-IP + global) — behind a proxy, trust X-Forwarded-For
    const fwd = typeof req?.headers?.['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : '';
    const ip = fwd || req?.socket?.remoteAddress || 'unknown';
    ws._ip = ip;
    let total = 0;
    let perIp = 0;
    for (const c of wss.clients) { total++; if (c !== ws && c._ip === ip) perIp++; }
    if (total > MAX_SESSIONS) {
      send({ type: 'error', message: 'Server at capacity — try again later.' });
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    if (perIp >= MAX_SESSIONS_PER_IP) {
      send({ type: 'error', message: 'Too many concurrent sessions from your address.' });
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    const nowTs = Date.now();
    const recent = (connectWindow.get(ip) || []).filter((t) => nowTs - t < CONNECT_WINDOW_MS);
    if (recent.length >= MAX_CONNECTS_PER_IP) {
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    recent.push(nowTs);
    connectWindow.set(ip, recent);

    const cleanup = () => {
      try { stream?.end(); } catch { /* noop */ }
      try { conn?.end(); } catch { /* noop */ }
      stream = null;
      conn = null;
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // output only flows server->client
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'connect': return handleConnect(msg);
        case 'data': {
          if (!stream) return;
          const data = String(msg.data ?? '');
          if (data && data.length <= 8192) stream.write(data);
          return;
        }
        case 'resize': {
          if (!stream) return;
          const cols = clampInt(msg.cols, 10, 500, 0);
          const rows = clampInt(msg.rows, 5, 200, 0);
          if (cols && rows) { try { stream.setWindow(rows, cols, 0, 0); } catch { /* noop */ } }
          return;
        }
        case 'disconnect': {
          send({ type: 'closed', reason: 'Disconnected by user.' });
          cleanup();
          try { ws.close(); } catch { /* noop */ }
          return;
        }
        default: return;
      }
    });

    function handleConnect(msg) {
      if (conn) return send({ type: 'error', message: 'A session is already active on this socket.' });
      const host = String(msg.host ?? '').trim();
      const port = Math.round(Number(msg.port ?? 22));
      const username = String(msg.username ?? '').trim();
      const auth = msg.auth ?? {};
      const cols = clampInt(msg.cols, 10, 500, 80);
      const rows = clampInt(msg.rows, 5, 200, 24);

      if (!host || host.length > MAX_HOST_LEN || !HOST_RE.test(host))
        return send({ type: 'error', message: 'Invalid host.' });
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return send({ type: 'error', message: 'Invalid port.' });
      if (!username || username.length > 64 || !USER_RE.test(username))
        return send({ type: 'error', message: 'Invalid username.' });

      const opts = {
        host, port, username,
        readyTimeout: 20_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 5,
      };
      if (auth?.type === 'password') {
        const p = String(auth.value ?? '');
        if (!p || p.length > 1024) return send({ type: 'error', message: 'Invalid password.' });
        opts.password = p;
      } else if (auth?.type === 'key') {
        const k = String(auth.value ?? '');
        if (!k.includes('PRIVATE KEY') || k.length > 65_536)
          return send({ type: 'error', message: 'Invalid private key.' });
        opts.privateKey = k;
        if (auth.passphrase) opts.passphrase = String(auth.passphrase).slice(0, 1024);
      } else {
        return send({ type: 'error', message: 'Unsupported auth type.' });
      }

      send({ type: 'status', message: `Connecting to ${username}@${host}:${port}...` });
      conn = new Client();
      conn.on('ready', () => {
        send({ type: 'status', message: 'Authenticated, opening shell...' });
        conn.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
          if (err) {
            send({ type: 'error', message: `Shell error: ${err.message}` });
            cleanup();
            return;
          }
          stream = s;
          s.on('data', (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); });
          s.on('close', () => {
            send({ type: 'closed', reason: 'Remote session ended.' });
            cleanup();
            try { ws.close(); } catch { /* noop */ }
          });
          send({ type: 'connected', host, username });
        });
      });
      conn.on('error', (e) => {
        send({ type: 'error', message: `SSH error: ${e.message}` });
        cleanup();
      });
      conn.connect(opts);
    }
  });
}