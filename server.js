'use strict';

/**
 * Tiny zero-dependency HLS player server.
 *
 *  - Serves the static player UI from ./public
 *  - Exposes /proxy?url=<absolute http(s) url> which:
 *      • adds permissive CORS headers (many live CDNs send none, which
 *        otherwise blocks hls.js from fetching the manifest/segments)
 *      • rewrites .m3u8 playlists so every segment / variant / key URI
 *        is routed back through this proxy (handles relative + absolute refs)
 *      • streams binary segments through untouched (with Range support)
 *
 * Run:  node server.js     (Node 18+; uses global fetch + Readable.fromWeb)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional SSRF guard: comma-separated hostname allowlist for the proxy.
// Empty (default) = allow any host. A host matches itself or any subdomain.
const ALLOW_HOSTS = (process.env.PROXY_ALLOW_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// A browser-ish UA — some CDNs reject the default Node fetch UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Accept, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function hostAllowed(targetUrl) {
  if (ALLOW_HOSTS.length === 0) return true;
  let host;
  try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  return ALLOW_HOSTS.some((a) => host === a || host.endsWith('.' + a));
}

function isPlaylist(url, contentType) {
  const p = url.split('?')[0].toLowerCase();
  if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return true;
  return /mpegurl/i.test(contentType || '');
}

// Rewrite every URI in an HLS playlist to flow back through /proxy,
// resolving relative references against the playlist's own URL.
function rewritePlaylist(body, playlistUrl) {
  const toProxy = (ref) => {
    let abs;
    try { abs = new URL(ref, playlistUrl).href; } catch { return ref; }
    return '/proxy?url=' + encodeURIComponent(abs);
  };
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;
      if (t.startsWith('#')) {
        // Tags may carry URI="..." (EXT-X-KEY/MEDIA/MAP/PART/PRELOAD-HINT/etc.)
        return line.replace(/URI="([^"]*)"/g, (_m, uri) => `URI="${toProxy(uri)}"`);
      }
      return toProxy(t); // segment or variant-playlist line
    })
    .join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch the upstream, retrying transient failures (network errors and 5xx)
// with a short backoff. This is safe because we retry only before reading the
// body, and GET (incl. Range) is idempotent — it keeps a momentary CDN blip
// from surfacing to hls.js as a fatal manifest/segment error.
async function fetchUpstream(target, headers) {
  const ATTEMPTS = 3;
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const resp = await fetch(target, { headers, redirect: 'follow' });
      if (resp.status >= 500 && i < ATTEMPTS - 1) { await sleep(250 * (i + 1)); continue; }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < ATTEMPTS - 1) await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error('upstream unreachable');
}

async function handleProxy(req, res, target) {
  if (!target) { res.writeHead(400); return res.end('Missing ?url= parameter'); }
  if (!/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('Only http(s) URLs are allowed'); }
  if (!hostAllowed(target)) { res.writeHead(403); return res.end('Target host not in PROXY_ALLOW_HOSTS'); }

  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    const o = new URL(target);
    headers.Referer = o.origin + '/';
    headers.Origin = o.origin;
  } catch { /* ignore */ }

  let upstream;
  try {
    upstream = await fetchUpstream(target, headers);
  } catch (err) {
    res.writeHead(502);
    return res.end('Upstream fetch failed: ' + err.message);
  }

  setCors(res);
  const contentType = upstream.headers.get('content-type') || '';
  const finalUrl = upstream.url || target;

  if (isPlaylist(finalUrl, contentType)) {
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.writeHead(upstream.ok ? 200 : upstream.status);
    return res.end(rewritePlaylist(text, finalUrl));
  }

  // Binary passthrough (segments / keys / fMP4 init) — stream it.
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  const passthrough = ['content-range', 'accept-ranges', 'content-length'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h.replace(/\b\w/g, (c) => c.toUpperCase()), v);
  }
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.writeHead(upstream.status);

  if (!upstream.body) return res.end();
  try {
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }

  if (url.pathname === '/proxy') return handleProxy(req, res, url.searchParams.get('url'));
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  HLS player running →  http://${HOST}:${PORT}\n`);
  if (ALLOW_HOSTS.length) console.log(`  Proxy restricted to: ${ALLOW_HOSTS.join(', ')}\n`);
});
