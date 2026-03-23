<p align="center">
  <img src="apps/inspector/public/logo-dark.svg" width="80" />
</p>

<h1 align="center">WorksLocal</h1>
<p align="center">
  <em>Free, open-source localhost tunneling. It works on my local.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/workslocal"><img src="https://img.shields.io/npm/v/workslocal" /></a>
  <a href="https://github.com/workslocal/workslocal/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" /></a>
</p>

## Quick Start

```bash
npx workslocal http 3000
```

That's it. Your localhost:3000 is now live at `https://xyz.workslocal.exposed`.

## Install

```bash
npm install -g workslocal
```

## Features

### Tunnel any local server
```bash
workslocal http 3000
# ✔ Tunnel is live!
# Public URL: https://myapp.workslocal.exposed
# Inspector:  http://localhost:4040
```

### Catch webhooks without code
```bash
workslocal catch --name stripe
# Paste URL in Stripe dashboard
# All payloads appear in your terminal + inspector
```

### Inspect every request
Open `localhost:4040` — dark/light theme, JSON formatting, copy as cURL, filters.

[screenshot of inspector here]

### Persistent subdomains (free)
```bash
workslocal login          # One-time GitHub auth
workslocal http 3000 --name myapp
# https://myapp.workslocal.exposed — same URL every time
```

### WebSocket passthrough
Socket.io, ws, WebRTC signaling — all work through the tunnel.

## Why WorksLocal?

| Feature | WorksLocal | ngrok (free) | Cloudflare Tunnel |
|---------|-----------|-------------|-------------------|
| Price | Free forever | Free (limited) | Free |
| Bandwidth | No cap | 1 GB/month | No cap (fair-use TOS) |
| Request limit | Rate-limited per tunnel | 20K/month | No published limit |
| Custom subdomain | ✅ You choose, free | ❌ Auto-assigned only | Requires your own domain |
| Persistent URL | ✅ Survives restart | ✅ 1 dev domain | ✅ Named tunnels |
| Catch mode | ✅ Webhook capture, no server needed | ❌ | ❌ |
| Web inspector | ✅ localhost:4040 | ✅ localhost:4040 + replay | ❌ Metrics/logs only |
| Request replay | Planned | ✅ With modifications | ❌ |
| Open source | ✅ MIT | ❌ Proprietary | Client only (Apache 2.0) |
| No account required | ✅ Anonymous first use | ❌ Required since Dec 2023 | ❌ (except quick tunnels) |
| WebSocket passthrough | ✅ | ✅ | ✅ |
| Interstitial warning | ❌ None | ✅ On all browser traffic | ❌ None |
| Self-hostable | Planned | ❌ | Client local, infra is Cloudflare's |
| Setup | `npm install -g workslocal` | Download binary + account | Install cloudflared + domain + config |
| Endpoints | 5 persistent (auth) | 3 concurrent | 1,000 tunnels |
| DDoS protection | Via Cloudflare edge | ❌ Free tier | ✅ Full Cloudflare |

> **Honest note:** ngrok's inspector has request replay with modifications — we don't (yet).
> Cloudflare Tunnel offers quick tunnels (`cloudflared tunnel --url`) with no account needed,
> but URLs are random and ephemeral with a 200 concurrent request limit.

## Commands

| Command | Description |
|---------|-------------|
| `workslocal http <port>` | Tunnel localhost to a public URL |
| `workslocal catch` | Capture webhooks (no local server needed) |
| `workslocal login` | Authenticate with GitHub |
| `workslocal logout` | Sign out |
| `workslocal whoami` | Show current user |
| `workslocal list` | List persistent subdomains |

## Options

```
workslocal http <port> [options]
  -n, --name <subdomain>   Custom subdomain
  -d, --domain <domain>    Tunnel domain (default: workslocal.exposed)
  --server <url>           Custom relay server URL
  -v, --verbose            Verbose logging

workslocal catch [options]
  -n, --name <subdomain>   Custom subdomain
  -s, --status <code>      Response status code (default: 200)
  -b, --body <json>        Response body (default: {"ok":true})
```

## How It Works

```
Your machine                  Cloudflare Edge              Internet
┌───────────┐    WebSocket   ┌───────────┐    HTTPS     ┌──────────┐
│ localhost │◄──────────────►│  Worker   │◄────────────►│ Browser  │
│   :3000   │                │ + Durable │              │  / curl  │
│           │                │  Object   │              │          │
└───────────┘                └───────────┘              └──────────┘
     CLI                       $0/month                  Public URL
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).