// End-to-end test: boots the real server + an in-process SSH server, then
// drives a WebSocket client through login -> connect -> run commands -> exit.
// No external SSH dependency needed; fully deterministic.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ssh2Pkg from 'ssh2';
const { Server: SshServer } = ssh2Pkg.default ?? ssh2Pkg;
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT = 3773;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const PASSWORD = 'testpass123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try { return await fn(); } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

let exitCode = 0;
function fail(msg) { console.error(`  FAIL ${msg}`); exitCode = 1; }
function pass(msg) { console.log(`  ok   ${msg}`); }

// ---------- in-process sshd ----------
// Accepts: testuser/testpass (password) and keyuser (any public key).
function startFakeSshd() {
  return new Promise((resolve, reject) => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' }); // "BEGIN RSA PRIVATE KEY" — ssh2-compatible
    const sshd = new SshServer({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass') { client._fakeUser = ctx.username; return ctx.accept(); }
        if (ctx.method === 'publickey' && ctx.username === 'keyuser') { client._fakeUser = ctx.username; return ctx.accept(); }
        ctx.reject(['password', 'publickey']);
      });
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (accept) => { accept?.(); });
          session.on('window-change', (accept) => { accept?.(); });
          session.on('shell', (accept) => {
            const stream = accept();
            const user = client._fakeUser || 'testuser';
            stream.write('Welcome to fake sshd\r\n');
            let buf = '';
            stream.on('data', (d) => {
              buf += d.toString('utf8');
              let idx;
              while ((idx = buf.indexOf('\r')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                if (line.startsWith('echo ')) stream.write(`${line.slice(5)}\r\n`);
                else if (line === 'whoami') stream.write(`${user}\r\n`);
                else if (line === 'exit') { stream.write('bye\r\n'); try { stream.exit?.(0); } catch { /* noop */ } stream.close(); }
                else stream.write(`unknown command: ${line}\r\n`);
              }
            });
          });
        });
      });
    });
    sshd.on('error', reject);
    sshd.listen(0, '127.0.0.1', () => resolve({ server: sshd, port: sshd.address().port }));
  });
}

// ---------- helpers ----------
function startWebServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(WEB_PORT), BIND_HOST: '127.0.0.1', AUTH_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  return child;
}

async function hitServer() {
  const r = await fetch(`${BASE}/api/me`);
  if (!r.ok) throw new Error('not up');
  return r.json();
}

async function login(password) {
  return fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function wsConnect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, cookie ? { headers: { Cookie: cookie } } : {});
    let bin = '';
    const msgs = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) { bin += data.toString('utf8'); return; }
      try { msgs.push(JSON.parse(data.toString('utf8'))); } catch { /* ignore */ }
    });
    const api = {
      ws,
      text: () => bin,
      clearText: () => { bin = ''; },
      send: (o) => ws.send(JSON.stringify(o)),
      waitMsg: (pred, label, timeoutMs = 15_000) =>
        waitFor(() => {
          const found = msgs.find(pred);
          if (!found) throw new Error('not yet');
          return found;
        }, { timeoutMs, label }),
      waitText: (needle, timeoutMs = 15_000) =>
        waitFor(() => { if (bin.includes(needle)) return true; throw new Error('not yet'); }, { timeoutMs, label: `text "${needle}"` }),
      close: () => new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; res(); } };
        if (ws.readyState >= 2) return fin(); // CLOSING or CLOSED — 'close' already fired/will not re-fire
        ws.on('close', fin);
        try { ws.close(); } catch { fin(); }
        setTimeout(fin, 2000).unref?.(); // never hang the test on socket teardown
      }),
    };
    ws.on('open', () => resolve(api));
    ws.on('error', (e) => reject(e));
  });
}

async function runScenario({ label, port, username, auth }) {
  const res = await login(PASSWORD);
  assert.equal(res.status, 200, 'login should succeed');
  const setCookie = res.headers.getSetCookie?.()[0] || '';
  const cookie = setCookie.split(';')[0];
  assert.ok(cookie.includes('webssh_session='), 'session cookie set');

  const c = await wsConnect(cookie);
  c.send({ type: 'connect', host: '127.0.0.1', port, username, cols: 80, rows: 24, auth });
  await c.waitMsg((m) => m.type === 'connected', 'connected');
  pass(`${label}: SSH session established`);

  c.clearText();
  c.send({ type: 'data', data: 'echo WS_E2E_42\r' });
  await c.waitText('WS_E2E_42');
  pass(`${label}: terminal I/O (echo) works`);

  c.send({ type: 'data', data: 'whoami\r' });
  await c.waitText(username);
  pass(`${label}: command output received`);

  c.send({ type: 'resize', cols: 120, rows: 40 });
  c.send({ type: 'data', data: 'echo RESIZE_OK\r' });
  await c.waitText('RESIZE_OK');
  pass(`${label}: resize accepted, shell alive`);

  c.send({ type: 'data', data: 'exit\r' });
  await c.waitMsg((m) => m.type === 'closed', 'closed');
  pass(`${label}: session closed cleanly`);

  await c.close();
}

// ---------- main ----------
const child = startWebServer();
const watchdog = setTimeout(() => {
  console.error('E2E test timed out');
  child.kill('SIGKILL');
  process.exit(1);
}, 120_000);
watchdog.unref();

try {
  await waitFor(hitServer, { label: 'web server up' });
  console.log('web server is up');

  // auth checks
  const bad = await login('wrong-password');
  if (bad.status === 401) pass('wrong password rejected (401)');
  else fail(`wrong password returned ${bad.status}, expected 401`);

  const unauth = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
    ws.on('error', (e) => resolve(String(e.message)));
    ws.on('open', () => { resolve('connected-without-auth'); ws.close(); });
  });
  if (unauth.includes('401')) pass('unauthenticated WebSocket rejected (401)');
  else fail(`unauthenticated WebSocket: ${unauth}`);

  // scenario 1: password auth against in-process sshd
  const sshd1 = await startFakeSshd();
  try {
    await runScenario({
      label: 'password auth', port: sshd1.port, username: 'testuser',
      auth: { type: 'password', value: 'testpass' },
    });
  } catch (e) { fail(e.message); } finally { sshd1.server.close(); }

  // scenario 2: private-key auth against in-process sshd
  const sshd2 = await startFakeSshd();
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
    await runScenario({
      label: 'key auth', port: sshd2.port, username: 'keyuser',
      auth: { type: 'key', value: pem },
    });
  } catch (e) { fail(e.message); } finally { sshd2.server.close(); }

  console.log(exitCode === 0 ? '\nAll e2e checks passed' : '\nE2E test had failures');
} finally {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 500);
}