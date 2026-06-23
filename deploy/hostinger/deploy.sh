#!/usr/bin/env bash
#
# Deploy the PHP build of the HLS player to wc.shakilanwar.com.
# (Hostinger shared hosting, LiteSpeed + PHP 8.1, server region: Singapore.)
#
# The subdomain runs on PHP, so the proxy is served by proxy.php (a port of the
# Node server's /proxy endpoint) and the UI is served as static files. Run this
# from your machine with SSH key access to the box:
#
#   bash deploy/hostinger/deploy.sh
#
set -euo pipefail

SSH_PORT="${SSH_PORT:-65002}"
SSH_HOST="${SSH_HOST:-u621525311@31.220.110.123}"
DOCROOT="${DOCROOT:-domains/shakilanwar.com/public_html/wc}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=20)
SCP_OPTS=(-P "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=20)

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/public/index.html" "$ROOT/public/app.js" "$ROOT/public/style.css" "$TMP/"
cp "$ROOT/deploy/hostinger/proxy.php" "$ROOT/deploy/hostinger/.htaccess"      "$TMP/"

echo "→ Linting proxy.php locally (if php present) …"
command -v php >/dev/null 2>&1 && php -l "$TMP/proxy.php"

echo "→ Uploading docroot to $SSH_HOST:~/$DOCROOT …"
scp "${SCP_OPTS[@]}" \
  "$TMP/index.html" "$TMP/app.js" "$TMP/style.css" "$TMP/proxy.php" "$TMP/.htaccess" \
  "$SSH_HOST:~/$DOCROOT/"

echo "→ Fixing perms + server-side lint …"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" "bash -s" <<REMOTE
set -e
cd "\$HOME/$DOCROOT"
chmod 644 index.html app.js style.css proxy.php .htaccess
php -l proxy.php
REMOTE

echo "✓ Deployed → https://wc.shakilanwar.com/"
