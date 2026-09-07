# >_ Web-SSH

> **The Termius-on-a-tiny-screen era is over.**

Your whole terminal, in a browser tab. Host it once on any VPS, open it from any
device — phone, tablet, laptop, a locked-down corporate machine — and drive a
real shell on any machine your server can reach. No SSH apps. No port
forwarding. No exposed home IPs.

```
browser (anywhere) ──HTTPS──> VPS: web-ssh + tailscale ──tailnet──> home lab (dynamic IP, sshd)
```

![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![build](https://img.shields.io/badge/build-none-orange)

## Why

Phones make terrible SSH terminals. Tiny screens, fiddly keyboards, apps that
drop sessions when you blink. Meanwhile your real machines — the home lab, the
NAS, the Raspberry Pi cluster — hide behind dynamic IPs and NAT, reachable only
through a VPN client.

Web-SSH fixes both at once:

1. Park this app on a cheap VPS.
2. Join that VPS to your overlay network (Tailscale is the obvious pick).
3. From any browser, log in and terminal into anything the VPS can reach.

One URL. One password. Every machine.

## Features

- 🔒 Password-gated web UI — rate-limited logins, HttpOnly SameSite=Strict session cookie
- 🔑 SSH auth via password or pasted private key (used in-memory, never stored)
- ⌨️ Real terminal — xterm.js with live resize, keepalives, 5000-line scrollback; works on mobile too
- 🔁 Recent-connection shortcuts (stored client-side, secrets never saved)
- 🔐 HTTPS your way — built-in TLS env vars, or park Caddy/nginx in front
- 🐳 Ships with a Dockerfile; happy under systemd, screen, or your favorite supervisor
- 🧪 Self-contained e2e test suite — no external SSH server needed
- 🌍 Multiple concurrent sessions — every browser tab is its own isolated terminal (per-IP and global caps keep it fair)

## 🌉 Free public bridge

A live instance runs at **https://ssh.ewizt.com** — no signup, free to use.

Open it in any browser, point it at any SSH server you administer, enter your
credentials, and work. Handy from locked-down corporate networks, internet
cafés, or your phone. Fair use: concurrent sessions are capped and
connection-rate limited, and your SSH credentials are never stored.

## How it works

One Node.js process. No build step, no CDN.

- **Express** serves the static UI (xterm.js vendored from node_modules)
- One **WebSocket** endpoint per session — cookie-authenticated at upgrade, then
  raw terminal bytes flow straight through to an `ssh2` client
- The server only needs to reach your machines' SSH port; everything else is
  browser ↔ server

## Quick start

```bash
git clone https://github.com/OngSoonEe/web-ssh.git
cd web-ssh
npm install
AUTH_PASSWORD=*** PORT=3000 npm start
# open http://localhost:3000
```

### Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `BIND_HOST` | `0.0.0.0` | Bind address (use `127.0.0.1` behind a reverse proxy) |
| `AUTH_PASSWORD` | random (printed once in logs) | Login password for the web UI |
| `SESSION_TTL_HOURS` | `12` | Web session lifetime |
| `TLS_CERT` / `TLS_KEY` | unset | Serve HTTPS directly with these PEM files |

## Deploy on any VPS + Tailscale

Any provider works — Hostinger, DigitalOcean, Hetzner, Vultr, Linode, OVH,
AWS Lightsail, Oracle Cloud's always-free tier, or that spare box at the office.

1. Install Node.js 18+, clone this repo, `npm install`.
2. Install Tailscale on the VPS and join your tailnet:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale status   # verify you can see your machines
   ```

3. Run the app under systemd:

   ```ini
   # /etc/systemd/system/web-ssh.service
   [Unit]
   Description=Web-SSH terminal gateway
   After=network-online.target tailscaled.service

   [Service]
   User=ubuntu
   WorkingDirectory=/opt/web-ssh
   Environment=PORT=3000
   Environment=BIND_HOST=127.0.0.1
   Environment=AUTH_PASSWORD=***
   ExecStart=/usr/bin/node src/server.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

4. HTTPS with Caddy (recommended; point a domain at the VPS):

   ```
   ssh.example.com {
       bind <public-ip>
       reverse_proxy 127.0.0.1:3000
   }
   ```

   The `bind <public-ip>` line matters when Tailscale also listens on :443
   (e.g. `tailscale serve`) — bind Caddy to the public IP so both coexist.

5. On your machines at home: keep `sshd` running and Tailscale up. Public IP
   does not matter — they can sit behind NAT with a dynamic address. In
   Web-SSH, use the machine's Tailscale IP (`100.x.y.z`) or MagicDNS name as
   the Host.

Now any browser — phone or desktop — reaches the VPS over HTTPS and drives a
terminal on any tailnet machine.

### Docker

```bash
docker build -t web-ssh .
docker run -d --name web-ssh -p 3000:3000 -e AUTH_PASSWORD=*** --restart unless-stopped web-ssh
```

## Security notes

- Use a long, unique `AUTH_PASSWORD`; sessions are HttpOnly + SameSite=Strict.
- Login is rate-limited (5 failures per 15 min per IP).
- WebSocket upgrades require a valid session cookie; cross-origin upgrades are rejected.
- SSH credentials live in memory per session only — nothing is written to disk.
- Prefer HTTPS in production (Caddy/nginx, or set `TLS_CERT`/`TLS_KEY`).
- Your machines stay hidden: no port forwarding, no public exposure — only the
  overlay network can reach them.

## Operations

- **Live usage:** `curl https://ssh.ewizt.com/api/stats` → active sessions, unique IPs, busiest client, configured caps.
- **Capacity guards:** connections over the caps are auto-rejected with an error (auto-kill at the door) and logged server-side as `[guard] ...`.
- **Kill switch:** `POST /admin/kill` with header `x-admin-token: <ADMIN_TOKEN>` terminates all active sessions; JSON body `{"ip":"1.2.3.4"}` targets a single address. Disabled unless `ADMIN_TOKEN` is set.

## Test

```bash
npm test
```

Boots the real server plus an in-process SSH server and verifies: login auth
(wrong password rejected), unauthenticated WebSocket rejection, password-auth
SSH session, key-auth SSH session, terminal I/O, resize, and clean disconnect.

## FAQ

**Why not just use Tailscale SSH?**
Tailscale SSH is great — from devices that have Tailscale installed. Web-SSH
works from *any browser*, including other people's machines and locked-down
corporate laptops.

**Why not just use an SSH app?**
You can. But this gives you a real keyboard, real screen estate, saved
connections, and zero app installs — in a browser tab.

## Stack

Express + ws + ssh2 + @xterm/xterm — no build step, no CDN.

## License

Apache-2.0 — see [LICENSE](LICENSE).