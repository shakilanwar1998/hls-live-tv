# Deploying to Hostinger (wc.shakilanwar.com)

This app is a **persistent Node.js server** (it serves the UI *and* runs the live
CORS proxy), not a static site — so it must run as a Node app, not just uploaded
files. On a Hostinger **shared / Cloud** plan with hPanel, Node apps run under
**Phusion Passenger** (LiteSpeed / CloudLinux). `server.js` already binds with
`server.listen(PORT, HOST)`, which Passenger intercepts automatically, and the app
has **zero npm dependencies**, so there is nothing to build.

> ⚠️ You **cannot** start this with `node server.js &` over SSH on shared hosting —
> long-running user processes get reaped and aren't wired to the domain/HTTPS.
> The Node app has to be registered in hPanel (once); after that, deploying is just
> syncing files + restarting.

---

## Step 1 — Create the Node.js app in hPanel (one time, web UI)

1. Make sure the subdomain **`wc.shakilanwar.com`** exists: hPanel → **Domains → Subdomains**.
2. hPanel → **Websites → (your site) → Advanced → Node.js → Create application**:
   | Field | Value |
   |---|---|
   | Node.js version | **18 or newer** (20 LTS recommended — the app uses global `fetch` + `Readable.fromWeb`) |
   | Application root | *(leave hPanel's suggestion, or pick a folder)* — **copy this exact path** |
   | Application URL | **wc.shakilanwar.com** |
   | Application startup file | **server.js** |
3. (Recommended) In the same app config, add an **Environment variable**:
   - `PROXY_ALLOW_HOSTS` = `toffeelive.com`
   This locks the proxy to the intended CDN so it isn't an open relay. Leave it off only if you deliberately want to proxy arbitrary hosts.
4. Leave **PORT / HOST unset** — Passenger assigns its own socket.

Note the **Application root** path — you'll pass it to the deploy script as `APP_ROOT`.

---

## Step 2 — Deploy the code over SSH

From **your own terminal** (where SSH to the box works):

```bash
ssh -p 65002 u621525311@31.220.110.123
# then, on the server:
curl -fsSL https://raw.githubusercontent.com/shakilanwar1998/hls-live-tv/main/deploy.sh -o deploy.sh
APP_ROOT=/paste/the/application-root/from/hpanel bash deploy.sh
```

The script clones the repo, copies `server.js` + `public/` + `package.json` into
the app root (preserving Passenger's files), and touches `tmp/restart.txt` to
reload the app. Re-run it any time to redeploy the latest `main`.

> No SSH key set up? Hostinger SSH uses your hosting **password** by default. Enable
> SSH access under hPanel → **Advanced → SSH Access** if it's off, and add a key
> there if you want passwordless logins.

---

## Step 3 — Verify

- Open **https://wc.shakilanwar.com/** — the player UI should load.
- It should serve over the existing LiteSpeed SSL cert; the proxy is same-origin,
  so there's no mixed-content issue.
- Paste an `.m3u8` URL into the box (or let the default stream load).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **503 / "Application failed to start"** | Wrong startup file or Node version. In the hPanel Node.js app, confirm startup file = `server.js` and Node ≥ 18, then **Restart**. |
| Changes don't show up | Click **Restart** on the hPanel Node.js app, or re-run `touch "$APP_ROOT/tmp/restart.txt"`. |
| Proxy returns **403 "Target host not in PROXY_ALLOW_HOSTS"** | The host you're playing isn't in the allowlist. Add it to `PROXY_ALLOW_HOSTS` (comma-separated) or unset the var. |
| Stream loads but won't play | Browsers block autoplay-with-sound — click ▶ / unmute. Also confirm the source CDN is reachable from the server. |
| `git`/`curl` missing on the server | Use hPanel **File Manager** or SFTP to upload `server.js`, `public/`, `package.json` into the Application root instead, then Restart. |

---

## Why not just SSH and run it?

Shared hosting has no `systemd`/root and reaps stray processes, so a manual
`node server.js` won't survive or get HTTPS/the domain. Passenger (via the hPanel
Node.js app) is the supported way to keep it running. If you later move to a
**Hostinger VPS**, you'd instead use `pm2` or a `systemd` unit behind nginx —
ask and I'll provide that variant.
