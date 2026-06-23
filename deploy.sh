#!/usr/bin/env bash
#
# Deploy the HLS live player to Hostinger (shared / Cloud + hPanel, Passenger).
# Run this INSIDE your Hostinger SSH session, e.g.:
#
#   ssh -p 65002 u621525311@31.220.110.123
#   curl -fsSL https://raw.githubusercontent.com/shakilanwar1998/hls-live-tv/main/deploy.sh -o deploy.sh
#   APP_ROOT=/full/path/from/hpanel bash deploy.sh
#
# ── ONE-TIME PREREQUISITE (in hPanel — cannot be done over SSH on shared) ──────
#   hPanel → Websites → wc.shakilanwar.com → Advanced → Node.js → Create application
#     • Node.js version         : 18 or newer (20 LTS recommended)
#     • Application root         : (copy this exact path → use it as APP_ROOT below)
#     • Application URL          : wc.shakilanwar.com
#     • Application startup file : server.js
#   (Optional, recommended) Environment variables:
#     • PROXY_ALLOW_HOSTS = toffeelive.com   ← stops the proxy being an open relay
#   Leave PORT / HOST UNSET — Passenger assigns its own socket.
# ───────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Absolute "Application root" path shown in the hPanel Node.js app. Pass it in via
# the environment (APP_ROOT=/... bash deploy.sh) or hard-code it on the next line.
APP_ROOT="${APP_ROOT:-}"

REPO="https://github.com/shakilanwar1998/hls-live-tv.git"
BRANCH="main"

if [[ -z "$APP_ROOT" ]]; then
  echo "ERROR: APP_ROOT is not set." >&2
  echo "  Copy the 'Application root' path from the hPanel Node.js app, then run:" >&2
  echo "    APP_ROOT=/home/$USER/domains/wc.shakilanwar.com/public_html bash deploy.sh" >&2
  echo "  (use the exact path hPanel shows — it may differ from the example above)" >&2
  exit 1
fi
if [[ ! -d "$APP_ROOT" ]]; then
  echo "ERROR: APP_ROOT does not exist: $APP_ROOT" >&2
  echo "  Create the Node.js app in hPanel first (see the header of this script)." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Cloning $REPO ($BRANCH) …"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP/app"

echo "→ Syncing app files into $APP_ROOT …"
rm -rf "$APP_ROOT/public"
cp -R  "$TMP/app/public"        "$APP_ROOT/public"
cp -f  "$TMP/app/server.js"     "$APP_ROOT/server.js"
cp -f  "$TMP/app/package.json"  "$APP_ROOT/package.json"
cp -f  "$TMP/app/README.md"     "$APP_ROOT/README.md" 2>/dev/null || true

# This app has ZERO runtime dependencies, so `npm install` is not needed.
# If you add deps later: activate the Node env hPanel shows, then run `npm install`.

echo "→ Triggering Passenger restart …"
mkdir -p "$APP_ROOT/tmp"
touch "$APP_ROOT/tmp/restart.txt"

echo
echo "✓ Deployed to $APP_ROOT"
echo "  If it doesn't pick up within ~30s, click 'Restart' on the hPanel Node.js app."
echo "  Verify:  https://wc.shakilanwar.com/"
