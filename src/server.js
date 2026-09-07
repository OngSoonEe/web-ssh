// Web-SSH — single-app browser SSH terminal gateway.
// Env: PORT, BIND_HOST, AUTH_PASSWORD, SESSION_TTL_HOURS, TLS_CERT, TLS_KEY
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachSshBridge } from './ssh.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : dflt;
}

const PORT = intEnv('PORT', 3000);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const SESSION_TTL_MS = intEnv('SESSION_TTL_HOURS', 12) * 3600_000;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const USE_TLS = Boolean(TLS_CERT && TLS_KEY);
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';

// ---------- auth ----------
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || (() => {
  const p = crypto.randomBytes(12).toString('base64url');
  console.warn(`[warn] AUTH_PASSWORD not set - generated one-time password for this run: ${p}`);
  return p;
})();

const SESSION_COOKIE = 'webssh_session';
const sessions = new Map(); // token -> expiresAt ms

function newSessionToken() {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_TTL_MS);
  return t;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 10 * 60_000).unref();

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

// login rate limit: 5 failures per 15 min per IP
const failures = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of failures) if (e.resetAt < now) failures.delete(ip);
}, 60_000).unref();

function tooManyFailures(ip) {
  const e = failures.get(ip);
  return !!e && e.count >= 5 && e.resetAt > Date.now();
}

function recordFailure(ip) {
  const now = Date.now();
  let e = failures.get(ip);
  if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + 15 * 60_000 }; failures.set(ip, e); }
  e.count += 1;
}

function passwordMatches(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.post('/login', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  const password = req.body?.password;
  if (typeof password !== 'string' || !passwordMatches(password, AUTH_PASSWORD)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  res.cookie(SESSION_COOKIE, newSessionToken(), {
    httpOnly: true, sameSite: 'strict', secure: USE_TLS,
    maxAge: SESSION_TTL_MS, path: '/',
  });
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) sessions.delete(t);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: PUBLIC_MODE || isAuthed(req), publicMode: PUBLIC_MODE }));

// vendored frontend deps straight from node_modules (no CDN needed)
const XP = path.join(ROOT, 'node_modules', '@xterm', 'xterm');
app.get('/vendor/xterm.js', (req, res) => res.sendFile(path.join(XP, 'lib', 'xterm.js')));
app.get('/vendor/xterm.css', (req, res) => res.sendFile(path.join(XP, 'css', 'xterm.css')));
app.get('/vendor/xterm-fit.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js')));

app.use(express.static(path.join(ROOT, 'src', 'static')));

// ---------- websocket ----------
const server = USE_TLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
attachSshBridge(wss);

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // non-browser client
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

server.on('upgrade', (req, socket, head) => {
  if (req.url.split('?')[0] !== '/ws' || !originOk(req) || (!PUBLIC_MODE && !isAuthed(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[web-ssh] listening on ${USE_TLS ? 'https' : 'http'}://${BIND_HOST}:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));