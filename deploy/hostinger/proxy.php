<?php
/**
 * proxy.php — PHP port of the Node server's /proxy endpoint (see ../../server.js).
 *
 * Mirrors the Node behaviour for Hostinger shared hosting (LiteSpeed + PHP):
 *   - adds permissive CORS headers (many live CDNs send none),
 *   - rewrites .m3u8 playlists so every segment/variant/key URI routes back here,
 *   - streams binary segments through untouched (with HTTP Range support),
 *   - retries transient upstream failures (network errors / 5xx) before the body.
 *
 * Extra hardening vs. the Node version (this runs on a PUBLIC domain): the target
 * host must resolve to a public IP, blocking SSRF to the internal network. An
 * optional PROXY_ALLOW_HOSTS env (comma-separated) locks it to specific hosts.
 */

declare(strict_types=1);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         . '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

$ALLOW_HOSTS = array_filter(array_map(
    'trim',
    explode(',', strtolower((string) (getenv('PROXY_ALLOW_HOSTS') ?: '')))
));

function send_cors(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Range, Origin, Accept, Content-Type');
    header('Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges');
}

function fail(int $code, string $msg): never {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

// ── Preflight / method ───────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { send_cors(); http_response_code(204); exit; }
if ($method !== 'GET')     { fail(405, 'Method not allowed'); }

// ── Validate target ──────────────────────────────────────────────────────────
$target = (string) ($_GET['url'] ?? '');
if ($target === '')                          { fail(400, 'Missing ?url= parameter'); }
if (!preg_match('#^https?://#i', $target))   { fail(400, 'Only http(s) URLs are allowed'); }

$host = parse_url($target, PHP_URL_HOST);
if (!is_string($host) || $host === '')       { fail(400, 'Bad URL'); }
$host = strtolower($host);

// Optional hostname allowlist (matches the host itself or any subdomain).
if (count($ALLOW_HOSTS) > 0) {
    $ok = false;
    foreach ($ALLOW_HOSTS as $a) {
        if ($host === $a || str_ends_with($host, '.' . $a)) { $ok = true; break; }
    }
    if (!$ok) { fail(403, 'Target host not in PROXY_ALLOW_HOSTS'); }
}

// SSRF guard: refuse targets that resolve to private/reserved IPs.
$ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
foreach ($ips as $ip) {
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
        fail(403, 'Target resolves to a private/reserved address');
    }
}

// ── URL helpers (port of rewritePlaylist) ────────────────────────────────────
function resolve_url(string $ref, string $base): ?string {
    $ref = trim($ref);
    if ($ref === '') return null;
    if (preg_match('#^[a-z][a-z0-9+.\-]*://#i', $ref)) return $ref;       // absolute

    $b = parse_url($base);
    if (!isset($b['scheme'], $b['host'])) return null;
    $authority = $b['scheme'] . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');

    if (str_starts_with($ref, '//')) return $b['scheme'] . ':' . $ref;   // protocol-relative
    if ($ref[0] === '/')             return $authority . $ref;           // absolute path

    $basePath = $b['path'] ?? '/';
    $dir = substr($basePath, 0, (int) strrpos($basePath, '/') + 1);
    if ($dir === '') $dir = '/';

    // Split off any query so "../" normalisation never touches it.
    $query = '';
    if (($q = strpos($ref, '?')) !== false) { $query = substr($ref, $q); $ref = substr($ref, 0, $q); }

    $out = [];
    foreach (explode('/', $dir . $ref) as $seg) {
        if ($seg === '..')               array_pop($out);
        elseif ($seg !== '.' && $seg !== '') $out[] = $seg;
    }
    return $authority . '/' . implode('/', $out) . $query;
}

function rewrite_playlist(string $body, string $base): string {
    $toProxy = static function (string $ref) use ($base): string {
        $abs = resolve_url($ref, $base);
        return $abs === null ? $ref : '/proxy?url=' . rawurlencode($abs);
    };
    $lines = explode("\n", $body);
    foreach ($lines as &$line) {
        $t = trim($line);
        if ($t === '') continue;
        if ($t[0] === '#') {
            // Tags may carry URI="..." (EXT-X-KEY / MEDIA / MAP / PART / PRELOAD-HINT …)
            $line = preg_replace_callback(
                '/URI="([^"]*)"/',
                static fn(array $m) => 'URI="' . $toProxy($m[1]) . '"',
                $line
            );
        } else {
            $line = $toProxy($t);                                        // segment / variant line
        }
    }
    unset($line);
    return implode("\n", $lines);
}

function is_playlist(string $url, string $ct): bool {
    $path = strtolower((string) parse_url($url, PHP_URL_PATH));
    if (str_ends_with($path, '.m3u8') || str_ends_with($path, '.m3u')) return true;
    return (bool) preg_match('/mpegurl/i', $ct);
}

// ── Build upstream request ───────────────────────────────────────────────────
$reqHeaders = ['User-Agent: ' . UA, 'Accept: */*'];
if (!empty($_SERVER['HTTP_RANGE'])) $reqHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
$o = parse_url($target);
if (isset($o['scheme'], $o['host'])) {
    $origin = $o['scheme'] . '://' . $o['host'] . (isset($o['port']) ? ':' . $o['port'] : '');
    $reqHeaders[] = 'Referer: ' . $origin . '/';
    $reqHeaders[] = 'Origin: ' . $origin;
}

@set_time_limit(120);
while (ob_get_level() > 0) ob_end_clean();   // stream segments without buffering the whole body

// Per-attempt streaming state (reset each retry).
$respHeaders = [];
$status      = 0;
$mode        = 'undecided';   // undecided | playlist | stream | swallow
$buf         = '';
$sentHeaders = false;
$byExt       = (function (string $u): bool {
    $p = strtolower((string) parse_url($u, PHP_URL_PATH));
    return str_ends_with($p, '.m3u8') || str_ends_with($p, '.m3u');
})($target);

$send_stream_headers = static function (int $status, array $h): void {
    send_cors();
    http_response_code($status ?: 200);
    header('Content-Type: ' . ($h['content-type'] ?? 'application/octet-stream'));
    foreach (['content-range' => 'Content-Range', 'accept-ranges' => 'Accept-Ranges', 'content-length' => 'Content-Length'] as $k => $out) {
        if (!empty($h[$k])) header($out . ': ' . $h[$k]);
    }
    header('Cache-Control: public, max-age=15');
};

$ATTEMPTS = 3;
$ch = curl_init();
$lastErr = '';

for ($attempt = 0; $attempt < $ATTEMPTS; $attempt++) {
    $respHeaders = [];
    $status = 0;
    $mode = 'undecided';
    $buf = '';

    curl_setopt_array($ch, [
        CURLOPT_URL            => $target,
        CURLOPT_HTTPHEADER     => $reqHeaders,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 90,
        CURLOPT_ENCODING       => '',
        CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$respHeaders, &$status): int {
            if (stripos($line, 'HTTP/') === 0) {        // (re)start on each response (handles redirects)
                $respHeaders = [];
                if (preg_match('#\s(\d{3})\s#', ' ' . trim($line) . ' ', $m)) $status = (int) $m[1];
            } elseif (($p = strpos($line, ':')) !== false) {
                $respHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($ch, string $data) use (&$mode, &$buf, &$sentHeaders, &$status, &$respHeaders, $byExt, $send_stream_headers): int {
            if ($mode === 'undecided') {
                $ct = $respHeaders['content-type'] ?? '';
                if ($status >= 500)                                $mode = 'swallow';   // buffer → allow retry
                elseif ($byExt || preg_match('/mpegurl/i', $ct))   $mode = 'playlist';  // buffer → rewrite
                else                                               $mode = 'stream';
            }
            if ($mode === 'stream') {
                if (!$sentHeaders) { $send_stream_headers($status, $respHeaders); $sentHeaders = true; }
                echo $data;
                flush();
            } else {                                                 // playlist | swallow
                $buf .= $data;
            }
            return strlen($data);
        },
    ]);

    $ok = curl_exec($ch);
    $errno = curl_errno($ch);
    if ($errno) $lastErr = curl_error($ch);
    if ($status === 0) $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

    // Retry only while nothing has been streamed to the client yet.
    if (!$sentHeaders && $attempt < $ATTEMPTS - 1 && ($errno !== 0 || $status >= 500)) {
        usleep(250000 * ($attempt + 1));
        continue;
    }
    break;
}

$effectiveUrl = (string) (curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) ?: $target);

// ── Emit ─────────────────────────────────────────────────────────────────────
if ($sentHeaders) {
    exit;                                   // binary already streamed
}
if ($status === 0) {                        // never got an HTTP response (network error / unreachable)
    fail(502, 'Upstream fetch failed: ' . ($lastErr ?: 'upstream unreachable'));
}
if ($mode === 'playlist' || ($mode === 'undecided' && is_playlist($effectiveUrl, $respHeaders['content-type'] ?? ''))) {
    send_cors();
    http_response_code(($status >= 200 && $status < 300) ? 200 : ($status ?: 200));
    header('Content-Type: application/vnd.apple.mpegurl');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    echo rewrite_playlist($buf, $effectiveUrl);
    exit;
}
if ($mode === 'swallow') {                  // exhausted retries on a 5xx
    $send_stream_headers($status, $respHeaders);
    echo $buf;
    exit;
}
if ($status === 0) {
    fail(502, 'Upstream fetch failed: ' . ($lastErr ?: 'upstream unreachable'));
}
// Non-playlist body that produced no stream (e.g. empty 204).
$send_stream_headers($status, $respHeaders);
echo $buf;
