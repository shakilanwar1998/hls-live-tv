# Deploying to Hostinger (wc.shakilanwar.com)

This app does two things: serves the player UI, and runs a `/proxy` endpoint that
fetches HLS playlists/segments server-side and adds CORS. The proxy needs a
server-side runtime — the UI alone is just static files.

`wc.shakilanwar.com` is a **Hostinger shared** subdomain on **LiteSpeed + PHP 8.1**
(server region: Singapore). There are two ways to run it; **option A is what's
currently live.**

---

## Option A — PHP build (currently deployed) ✅

The proxy is reimplemented in PHP ([deploy/hostinger/proxy.php](deploy/hostinger/proxy.php),
a faithful port of [server.js](server.js)) and the UI is served as static files.
No Node app / hPanel setup needed — it runs on the PHP that already serves the
subdomain.

**Docroot:** `~/domains/shakilanwar.com/public_html/wc/` containing:
`index.html`, `app.js`, `style.css`, `proxy.php`, `.htaccess`
(the `.htaccess` rewrites `/proxy?url=…` → `proxy.php`, so the frontend is unchanged).

**Deploy / re-deploy** (from your machine, needs SSH key access):

```bash
bash deploy/hostinger/deploy.sh
```

That lints `proxy.php`, uploads the five docroot files over SSH, fixes perms, and
re-lints on the server. Verify at <https://wc.shakilanwar.com/>.

**proxy.php parity with the Node version**

- CORS headers + OPTIONS preflight
- `.m3u8`/`.m3u` (and `mpegurl` content-type) detection → rewrites every segment /
  variant / `URI="…"` reference back through `/proxy`
- binary segment passthrough with **HTTP Range** (verified `206` + `Content-Range`)
- retries transient upstream failures (network / 5xx) before sending the body;
  total upstream failure returns `502`
- optional `PROXY_ALLOW_HOSTS` allowlist **plus** an SSRF guard that refuses targets
  resolving to private/reserved IPs (it's public-facing now — verified `403` on the
  cloud-metadata IP)

> ⚠️ The proxy fetches **server-side from Singapore.** A source that is geo-blocked
> or unreachable from that region won't play for anyone, regardless of where the
> viewer is. (The hard-coded default `toffeelive.com` FIFA feed is unreachable from
> SG — see [README](README.md)/`app.js` to change `DEFAULT_STREAM`.)

---

## Option B — Node.js via hPanel (alternative, not used)

Keeps `server.js` running as-is. Requires a one-time app creation in the hPanel web
UI (the CloudLinux Node selector CLI is not exposed over SSH on this account, so the
app can't be registered purely via SSH).

1. hPanel → **Websites → Advanced → Node.js → Create application**: Node 18+ (20 LTS),
   Application URL `wc.shakilanwar.com`, startup file `server.js`. Optionally set env
   `PROXY_ALLOW_HOSTS`. Leave PORT/HOST unset (Passenger assigns a socket;
   `server.listen(PORT, HOST)` is intercepted automatically).
2. Then sync the repo into the app root over SSH and restart, e.g. via
   [deploy.sh](deploy.sh) (`APP_ROOT=/path/from/hpanel bash deploy.sh`).

A plain `node server.js &` over SSH will **not** work on shared hosting — the process
gets reaped and isn't wired to the domain/HTTPS.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| A specific stream shows `502` / won't load | The source is unreachable/geo-blocked from the **Singapore** server. Try a source reachable from SG. |
| Proxy returns `403 "private/reserved"` | The target resolved to a private/internal IP — blocked on purpose. |
| Proxy returns `403 "not in PROXY_ALLOW_HOSTS"` | A host allowlist is set; add the host or unset the env. |
| UI loads but won't play | Browsers block autoplay-with-sound — click ▶ / unmute. |
| Old placeholder still showing | Hostinger CDN cache — hard-refresh or append `?cb=1`. The original `default.php` is backed up at `~/wc-deploy-tmp/default.php.bak`. |
