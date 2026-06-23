'use strict';

// The World Cup live feed. (URL loader removed — this is a dedicated player.)
const DEFAULT_STREAM =
  'https://prod-cdn01-live.toffeelive.com/live/FIFA-2026-4/1/master_1800.m3u8';

  // const DEFAULT_STREAM =
  // 'https://live.thebosstv.com:30443/dwlive/Somoy-TV/chunks.m3u8';

  

// Every stream goes through our local proxy (adds CORS, rewrites the playlist).
const proxied = (url) => '/proxy?url=' + encodeURIComponent(url);

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), player: $('player'),
  playOverlay: $('playOverlay'), spinner: $('spinner'),
  liveBadge: $('liveBadge'), behindBadge: $('behindBadge'), reconnectBadge: $('reconnectBadge'),
  errorPanel: $('errorPanel'), errorMsg: $('errorMsg'), retryBtn: $('retryBtn'),
  playPause: $('playPause'), muteBtn: $('muteBtn'), volSlider: $('volSlider'),
  goLiveBtn: $('goLiveBtn'), statsBtn: $('statsBtn'), stats: $('stats'),
  pipBtn: $('pipBtn'), fsBtn: $('fsBtn'),
};

let hls = null;
let currentUrl = '';
let statsOn = false;

/* ── Recovery model ──────────────────────────
 * Live streams hiccup (CDN blips, playlist-refresh timeouts, segment gaps),
 * especially on flaky connections. The golden rule here: while the video is
 * still playing — or has buffered content to play from — we NEVER show the
 * blocking error panel. Transient errors are absorbed by retrying in the
 * background with exponential backoff, surfacing only a small, non-blocking
 * "Reconnecting…" badge. The blocking panel appears solely when a health
 * check proves playback is genuinely dead (stalled, with an empty buffer) or
 * the stream never started at all. Recovery is driven by real playback
 * progress, not by counting errors. */
let recoverTimer = null;
let recoverDelay = 0;      // grows 1s → 2s → … → 8s, resets on real progress
let mediaRecovers = 0;     // consecutive decoder recoveries without progress
let hasPlayed = false;     // has the video ever actually played?
let lastCt = 0;            // last observed video.currentTime (any change = alive)
let lastProgressAt = 0;    // perf timestamp the playhead last moved
let initLoadAt = 0;        // perf timestamp the current source started loading
const DEAD_MS = 10000;     // stalled + empty buffer this long ⇒ show the panel
const INIT_MS = 18000;     // never-started this long ⇒ show the panel
const now = () => performance.now();

/* ── UI helpers ──────────────────────────── */
function showError(title, detail) {
  els.spinner.hidden = true;
  els.errorMsg.innerHTML = `<strong>${title}</strong>${detail ? '<br>' + detail : ''}`;
  els.errorPanel.hidden = false;
}
function clearError() { els.errorPanel.hidden = true; }
function showSpinner(on) { els.spinner.hidden = !on; }
function showReconnecting(on) { els.reconnectBadge.hidden = !on; }

function destroy() {
  if (hls) { hls.destroy(); hls = null; }
}

function bufferedAhead() {
  const v = els.video;
  for (let i = 0; i < v.buffered.length; i++)
    if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i))
      return v.buffered.end(i) - v.currentTime;
  return 0;
}

/* ── Recovery primitives ─────────────────── */
function clearRecoverTimer() {
  if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
}

// Playback is genuinely healthy again → wipe every recovery/error indicator
// and re-baseline the stall clock to *now* (critical after a rebuild, whose new
// live edge is a fresh timeline value — see healthCheck).
function markHealthy() {
  recoverDelay = 0;
  mediaRecovers = 0;
  clearRecoverTimer();
  showReconnecting(false);
  showSpinner(false);
  clearError();
  lastCt = els.video.currentTime;
  lastProgressAt = now();
}

// Run a recovery action after a backoff. Never shows the blocking panel — that
// is the health check's job. Guarded so overlapping triggers don't pile up.
function scheduleRecover(action) {
  if (recoverTimer) return;
  if (hasPlayed) showReconnecting(true);
  const delay = recoverDelay;
  recoverDelay = Math.min(recoverDelay ? recoverDelay * 2 : 1000, 8000);
  recoverTimer = setTimeout(() => {
    recoverTimer = null;
    try { action(); } catch { rebuild(); }
  }, delay);
}

// Tear down and recreate the whole hls pipeline against the current URL,
// preserving the backoff/progress state so the health check stays accurate.
function rebuild() {
  if (currentUrl) load(currentUrl, { preserveRetries: true });
}

function onHlsError(_evt, data) {
  if (!data.fatal) return; // non-fatal errors (buffer stalls, gaps) self-resolve
  const D = Hls.ErrorDetails;
  switch (data.type) {
    case Hls.ErrorTypes.NETWORK_ERROR:
      // If the playlist itself can't be fetched/parsed there's nothing to
      // resume from → rebuild. Segment/level errors resume in place.
      if (data.details === D.MANIFEST_LOAD_ERROR ||
          data.details === D.MANIFEST_LOAD_TIMEOUT ||
          data.details === D.MANIFEST_PARSING_ERROR ||
          data.details === D.LEVEL_EMPTY_ERROR) {
        scheduleRecover(rebuild);
      } else {
        scheduleRecover(() => hls.startLoad());
      }
      break;
    case Hls.ErrorTypes.MEDIA_ERROR:
      scheduleRecover(() => {
        mediaRecovers++;
        if (mediaRecovers >= 2 && typeof hls.swapAudioCodec === 'function') hls.swapAudioCodec();
        hls.recoverMediaError();
      });
      break;
    default:
      // KEY_SYSTEM / MUX / OTHER — rebuild from scratch.
      scheduleRecover(rebuild);
  }
}

// Runs once a second. The single source of truth for player health and for
// which (if any) status UI is shown.
function healthCheck() {
  const v = els.video;
  const t = now();

  // ANY movement of the playhead means the pipeline is alive — including the
  // downward jump to a fresh live edge after a rebuild. (A monotonic check
  // against a preserved high-water mark would stay false forever post-rebuild
  // and falsely declare a playing stream dead.)
  if (Math.abs(v.currentTime - lastCt) > 0.05) {
    if (v.currentTime > 0) hasPlayed = true;
    markHealthy(); // re-baselines lastCt + lastProgressAt
    return;
  }

  if (v.paused || v.ended) { showReconnecting(false); return; } // intentional pause

  const stalled = t - (lastProgressAt || t);
  const buf = bufferedAhead();

  if (hasPlayed) {
    if (stalled > DEAD_MS && buf < 0.5) {
      // Truly stalled with nothing left to play → blocking panel, but keep
      // trying in the background so it self-heals when the feed returns.
      showError('Stream interrupted',
        'The live feed dropped. Reconnecting automatically… if it doesn’t come back it may be offline.');
      scheduleRecover(rebuild);
    } else if (stalled > 2500) {
      // Brief stall while we still have buffer → just nudge the loader.
      showReconnecting(true);
      scheduleRecover(() => { if (hls) hls.startLoad(); else rebuild(); });
    }
  } else if (t - initLoadAt > INIT_MS) {
    // Never started after a generous grace period.
    showError('Could not start the stream',
      'Still trying to connect… the stream may be offline, geo-blocked, or unavailable right now.');
    scheduleRecover(rebuild);
  }
}

/* ── Loading ─────────────────────────────── */
function load(rawUrl, opts = {}) {
  const url = (rawUrl || '').trim();
  if (!url) return;
  currentUrl = url;
  clearError();
  showReconnecting(false);
  showSpinner(true);
  destroy();

  // A fresh pipeline always starts its playhead at ~0.
  lastCt = 0;
  // Manual loads (Retry / boot) start fresh; auto-rebuilds keep their tally so
  // the dead-stream timers keep accumulating across reconnect attempts.
  if (!opts.preserveRetries) {
    recoverDelay = 0;
    mediaRecovers = 0;
    hasPlayed = false;
    lastProgressAt = now();
    initLoadAt = now();
  }
  clearRecoverTimer();

  const src = proxied(url);
  const video = els.video;

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      backBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
      enableWorker: true,
    });

    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
    hls.on(Hls.Events.MANIFEST_PARSED, () => { showSpinner(false); tryPlay(); });
    hls.on(Hls.Events.FRAG_BUFFERED, () => showSpinner(false));
    hls.on(Hls.Events.ERROR, onHlsError);

    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari / iOS). Same-origin via proxy → no CORS issue.
    video.src = src;
    video.addEventListener('loadedmetadata', () => { showSpinner(false); tryPlay(); }, { once: true });
    // Transient native failures are absorbed by the health check / rebuild.
    video.addEventListener('error', () => scheduleRecover(rebuild), { once: true });
  } else {
    showError('Unsupported browser', 'HLS is not supported here. Try Chrome, Edge, Firefox, or Safari.');
  }
}

/* ── Playback / autoplay ─────────────────── */
// Drive the overlay prompt. mode: 'unmute' (playing muted), 'play' (paused), or
// null (hide). It adapts the icon + label so the prompt is never misleading.
function setOverlay(mode) {
  if (!mode) { els.playOverlay.hidden = true; return; }
  const isPlay = mode === 'play';
  els.playOverlay.classList.toggle('is-play', isPlay);
  els.playOverlay.querySelector('.ub-label').textContent = isPlay ? 'Play' : 'Tap to unmute';
  els.playOverlay.setAttribute('aria-label', isPlay ? 'Play' : 'Unmute');
  els.playOverlay.hidden = false;
}

function tryPlay() {
  els.video.play().then(() => {
    setOverlay(null);
  }).catch(() => {
    // Autoplay with sound is blocked → play muted and invite the user to unmute.
    els.video.muted = true;
    syncMuteUI();
    els.video.play().then(() => {
      setOverlay('unmute'); // playing, but muted → offer sound
    }).catch(() => { setOverlay('play'); }); // even muted autoplay blocked → offer play
  });
}

function togglePlay() {
  if (els.video.paused) tryPlay();
  else els.video.pause();
}

// Clicking the video: while sound hasn't been granted yet, the first tap grants
// it (rather than pausing). Otherwise toggle play/pause. On touch, the first tap
// just reveals the hidden chrome.
function onVideoClick() {
  if (!els.player.classList.contains('show-controls')) { wakeControls(); return; }
  if (els.video.muted) {
    els.video.muted = false;
    syncMuteUI();
    if (els.video.paused) tryPlay();
    return;
  }
  togglePlay();
}

/* ── Live edge ───────────────────────────── */
function liveEdge() {
  if (hls && hls.liveSyncPosition != null) return hls.liveSyncPosition;
  const seek = els.video.seekable;
  return seek && seek.length ? seek.end(seek.length - 1) : null;
}
function secondsBehind() {
  const edge = liveEdge();
  return edge == null ? null : Math.max(0, edge - els.video.currentTime);
}
function goLive() {
  const edge = liveEdge();
  if (edge != null) els.video.currentTime = edge;
  if (els.video.paused) tryPlay();
}

/* ── UI sync ─────────────────────────────── */
// NOTE: use toggleAttribute(), not `.hidden =`. These icons are <svg> elements,
// and SVGElement doesn't reflect the `hidden` IDL property to the content
// attribute — so `.hidden = …` would silently fail to show/hide them.
function syncPlayUI() {
  const paused = els.video.paused;
  els.playPause.querySelector('.i-play').toggleAttribute('hidden', !paused);
  els.playPause.querySelector('.i-pause').toggleAttribute('hidden', paused);
}
function syncMuteUI() {
  const muted = els.video.muted || els.video.volume === 0;
  els.muteBtn.querySelector('.i-vol').toggleAttribute('hidden', muted);
  els.muteBtn.querySelector('.i-mute').toggleAttribute('hidden', !muted);
  els.volSlider.value = els.video.muted ? 0 : els.video.volume;
  // Once the user has sound, the unmute prompt is no longer needed.
  if (!muted) setOverlay(null);
}

function updateLiveState() {
  const behind = secondsBehind();
  const isLive = hls ? !!hls.levels && hls.media && hls.liveSyncPosition != null
                     : (els.video.seekable && els.video.seekable.length > 0 && !els.video.duration);
  const live = hls && hls.levels && hls.levels[hls.currentLevel || 0]
    ? hls.levels[hls.currentLevel || 0].details && hls.levels[hls.currentLevel || 0].details.live
    : isLive;

  els.liveBadge.hidden = !live;
  if (live && behind != null && behind > 6) {
    els.behindBadge.hidden = false;
    els.behindBadge.textContent = `−${behind.toFixed(0)}s behind`;
    els.goLiveBtn.classList.remove('at-live');
  } else {
    els.behindBadge.hidden = true;
    els.goLiveBtn.classList.toggle('at-live', live && behind != null && behind <= 6);
  }
}

/* ── Stats ───────────────────────────────── */
function renderStats() {
  if (!statsOn) return;
  const v = els.video;
  const lvl = hls && hls.levels ? hls.levels[hls.currentLevel] : null;
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  const behind = secondsBehind();
  const rows = [
    ['Resolution', lvl ? `${lvl.width}×${lvl.height}` : `${v.videoWidth}×${v.videoHeight}`],
    ['Bitrate', lvl && lvl.bitrate ? `${(lvl.bitrate / 1000).toFixed(0)} kbps` : '—'],
    ['Buffer', `${bufferedAhead().toFixed(1)} s`],
    ['Behind live', behind == null ? '—' : `${behind.toFixed(1)} s`],
    ['Dropped', q ? `${q.droppedVideoFrames}/${q.totalVideoFrames}` : '—'],
    ['Engine', hls ? `hls.js ${Hls.version}` : 'native'],
  ];
  els.stats.innerHTML = rows
    .map(([k, val]) => `<div class="row"><span>${k}</span><b>${val}</b></div>`)
    .join('');
}

/* ── Auto-hiding chrome ──────────────────── */
let idleTimer = null;
function wakeControls() {
  els.player.classList.add('show-controls');
  els.player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!els.video.paused) {
      els.player.classList.remove('show-controls');
      els.player.classList.add('idle');
    }
  }, 2800);
}

/* ── Events ──────────────────────────────── */
els.playOverlay.addEventListener('click', () => { els.video.muted = false; syncMuteUI(); tryPlay(); });
els.retryBtn.addEventListener('click', () => load(currentUrl));
els.playPause.addEventListener('click', togglePlay);
els.goLiveBtn.addEventListener('click', goLive);

els.muteBtn.addEventListener('click', () => { els.video.muted = !els.video.muted; syncMuteUI(); });
els.volSlider.addEventListener('input', () => {
  els.video.volume = Number(els.volSlider.value);
  els.video.muted = els.video.volume === 0;
  syncMuteUI();
});

els.statsBtn.addEventListener('click', () => {
  statsOn = !statsOn;
  els.stats.hidden = !statsOn;
  renderStats();
});

els.pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await els.video.requestPictureInPicture();
  } catch { /* not supported */ }
});

els.fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (els.player.requestFullscreen) els.player.requestFullscreen().catch(() => {});
  else if (els.video.webkitEnterFullscreen) els.video.webkitEnterFullscreen(); // iOS Safari
});

els.video.addEventListener('play', () => { syncPlayUI(); lastCt = els.video.currentTime; lastProgressAt = now(); });
els.video.addEventListener('pause', () => { syncPlayUI(); showReconnecting(false); wakeControls(); });
els.video.addEventListener('volumechange', syncMuteUI);
els.video.addEventListener('waiting', () => showSpinner(true));
els.video.addEventListener('playing', () => { hasPlayed = true; markHealthy(); });
els.video.addEventListener('click', onVideoClick);

// Reveal controls on movement or touch, hide them after a moment of stillness.
els.player.addEventListener('mousemove', wakeControls);
els.player.addEventListener('pointerdown', wakeControls);
els.player.addEventListener('mouseleave', () => {
  if (!els.video.paused) { els.player.classList.remove('show-controls'); els.player.classList.add('idle'); }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return; // don't hijack the volume slider
  switch (e.key.toLowerCase()) {
    case ' ': case 'k': e.preventDefault(); togglePlay(); break;
    case 'm': els.video.muted = !els.video.muted; syncMuteUI(); break;
    case 'f': els.fsBtn.click(); break;
    case 'l': goLive(); break;
    case 'i': els.statsBtn.click(); break;
  }
});

setInterval(() => { updateLiveState(); renderStats(); healthCheck(); }, 1000);

// Boot
if (!document.pictureInPictureEnabled && !els.video.webkitSupportsPresentationMode) els.pipBtn.hidden = true;
syncPlayUI();
syncMuteUI();
load(DEFAULT_STREAM);
