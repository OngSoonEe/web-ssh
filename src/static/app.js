(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const loginOverlay = $('login-overlay');
  const loginForm = $('login-form');
  const loginError = $('login-error');
  const connForm = $('conn-form');
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const termEl = $('terminal');
  const btnConnect = $('btn-connect');
  const btnDisconnect = $('btn-disconnect');
  const recentChips = $('recent-chips');
  const f = {
    host: $('f-host'), port: $('f-port'), username: $('f-username'),
    authType: $('f-auth-type'), password: $('f-password'),
    key: $('f-key'), passphrase: $('f-passphrase'),
  };

  let term = null, fit = null, ws = null, connected = false, decoder = null;

  const setStatus = (cls, text) => { statusDot.className = 'dot ' + cls; statusText.textContent = text; };

  function initTerm() {
    if (term) return;
    term = new window.Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace",
      fontSize: 14,
      theme: {
        background: '#0f1116',
        foreground: '#e2e8f0',
        cursor: '#7ee787',
        selectionBackground: 'rgba(59, 66, 82, 0.8)',
      },
      scrollback: 5000,
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    fitTerminal();
    term.onData((d) => { if (ws && connected) ws.send(JSON.stringify({ type: 'data', data: d })); });
    term.writeln('Web-SSH ready. Fill in the connection details above and press Connect.');
    new ResizeObserver(() => fitTerminal()).observe(termEl);
  }

  function fitTerminal() {
    if (!fit) return;
    try {
      fit.fit();
      if (ws && connected) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch { /* not visible yet */ }
  }

  // ---- web auth ----
  async function checkSession() {
    try {
      const r = await fetch('/api/me');
      const j = await r.json();
      if (j.authed) { loginOverlay.classList.add('hidden'); initTerm(); }
      else loginOverlay.classList.remove('hidden');
    } catch { loginOverlay.classList.remove('hidden'); }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      const r = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('l-password').value }),
      });
      if (r.ok) { loginOverlay.classList.add('hidden'); initTerm(); }
      else loginError.textContent = (await r.json().catch(() => ({}))).error || 'Login failed.';
    } catch { loginError.textContent = 'Network error.'; }
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await fetch('/logout', { method: 'POST' }); } catch { /* noop */ }
    location.reload();
  });

  // ---- connection form ----
  f.authType.addEventListener('change', () => {
    const isKey = f.authType.value === 'key';
    f.password.classList.toggle('hidden', isKey);
    f.key.classList.toggle('hidden', !isKey);
    f.passphrase.classList.toggle('hidden', !isKey);
  });

  function readForm() {
    const host = f.host.value.trim();
    const port = parseInt(f.port.value, 10) || 22;
    const username = f.username.value.trim();
    const authType = f.authType.value;
    if (!host || !username) { setStatus('error', 'Host and username are required.'); return null; }
    if (authType === 'password' && !f.password.value) { setStatus('error', 'Password required.'); return null; }
    if (authType === 'key' && !f.key.value.includes('PRIVATE KEY')) { setStatus('error', 'Paste a valid private key.'); return null; }
    return { host, port, username, authType };
  }

  function connect() {
    if (connected) return;
    const p = readForm();
    if (!p) return;
    saveRecent(p);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    setStatus('connecting', `Connecting to ${p.username}@${p.host}...`);
    term.reset();
    decoder = new TextDecoder();
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'connect', host: p.host, port: p.port, username: p.username,
        cols: term.cols, rows: term.rows,
        auth: p.authType === 'password'
          ? { type: 'password', value: f.password.value }
          : { type: 'key', value: f.key.value, passphrase: f.passphrase.value || undefined },
      }));
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(decoder.decode(new Uint8Array(ev.data), { stream: true }));
        return;
      }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'connected') {
        connected = true;
        setStatus('connected', `${m.username}@${m.host}`);
        btnConnect.disabled = true; btnDisconnect.disabled = false;
      } else if (m.type === 'status') {
        term.writeln(`\r\n[ ${m.message} ]`);
      } else if (m.type === 'error') {
        term.writeln(`\r\n[!] ${m.message}`);
        setStatus('error', m.message);
      } else if (m.type === 'closed') {
        term.writeln(`\r\n[ ${m.reason} ]`);
        disconnectUi();
      }
    };
    ws.onclose = () => { disconnectUi(); };
    ws.onerror = () => { /* error surfaces via close */ };
  }

  function disconnectUi() {
    connected = false;
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
    if (statusDot.classList.contains('connected')) setStatus('idle', 'Disconnected');
  }

  function disconnect() {
    if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    disconnectUi();
  }

  connForm.addEventListener('submit', (e) => { e.preventDefault(); connect(); });
  btnDisconnect.addEventListener('click', () => {
    try { ws?.send(JSON.stringify({ type: 'disconnect' })); } catch { /* noop */ }
    disconnect();
  });

  // ---- recent connections (client-side only, no secrets stored) ----
  const LS_KEY = 'webssh.recent';
  function saveRecent(p) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { list = []; }
    list = list.filter((x) => !(x.host === p.host && x.port === p.port && x.username === p.username));
    list.unshift(p);
    list = list.slice(0, 5);
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    renderRecent();
  }
  function renderRecent() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { list = []; }
    recentChips.innerHTML = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${r.username}@${r.host}:${r.port}`;
      b.addEventListener('click', () => {
        f.host.value = r.host; f.port.value = r.port; f.username.value = r.username;
        f.authType.value = r.authType || 'password';
        f.authType.dispatchEvent(new Event('change'));
      });
      recentChips.appendChild(b);
    }
  }

  checkSession();
  renderRecent();
})();