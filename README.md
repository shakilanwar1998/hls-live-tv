# 📺 Live HLS Player

A small web app that plays live HLS (`.m3u8`) streams in the browser — built for
the FIFA 2026 feed but works with any HLS URL.

## Why the proxy?

The target CDN (`toffeelive.com`) returns **no CORS headers**, so a browser
running `hls.js` can't fetch the playlist/segments directly. This app ships a
tiny zero-dependency Node server that:

- adds permissive CORS headers,
- rewrites the `.m3u8` so every segment/key/variant routes back through it,
- streams the binary `.ts` segments through (with HTTP Range support).

The frontend uses [hls.js](https://github.com/video-dev/hls.js) (and native HLS
on Safari) with autoplay handling, a live-edge indicator, "Go Live", stats
overlay, PiP, fullscreen, and keyboard shortcuts.

## Run

```bash
cd hls-live-player
npm start          # or: node server.js
```

Open <http://127.0.0.1:3000>. The FIFA stream loads automatically; paste any
other `.m3u8` URL into the box to switch.

> Browsers block autoplay **with sound**, so the first frames may play muted —
> click the ▶ overlay (or press the speaker) to unmute.

## Configuration (env vars)

| Variable             | Default     | Purpose                                                        |
| -------------------- | ----------- | -------------------------------------------------------------- |
| `PORT`               | `3000`      | Listen port                                                    |
| `HOST`               | `127.0.0.1` | Bind address                                                   |
| `PROXY_ALLOW_HOSTS`  | *(empty)*   | Comma-separated hostname allowlist for the proxy (SSRF guard)  |

Example (lock the proxy to the toffee CDN):

```bash
PROXY_ALLOW_HOSTS=toffeelive.com node server.js
```

## Notes

- Keep this bound to `127.0.0.1`. The proxy is open by default — if you expose it
  on a public interface, set `PROXY_ALLOW_HOSTS` to avoid running an open relay.
- Shortcuts: `space`/`k` play · `m` mute · `f` fullscreen · `l` live · `i` stats.
- Only plays streams you're authorized to access; respect the source's terms.
