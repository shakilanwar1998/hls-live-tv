'use strict';

// Live TV channel list (Free-TV/IPTV). Fetched + parsed at boot into the channel
// picker. It's served with permissive CORS, so the browser fetches it directly.
const PLAYLIST_URL = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8';
// Last-resort single stream if the playlist can't be fetched/parsed.
const FALLBACK_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

// Many live CDNs send no CORS headers, so hls.js — Chrome / Android /
// Firefox, which fetch via XHR — can't read them cross-origin and must go through a
// CORS proxy. Toffee also geo-restricts to Bangladesh, so for those browsers the
// proxy has to be hosted *in* Bangladesh. Point PROXY_BASE at that BD proxy (running
// proxy.php); '' = this same-origin server (fine for streams not geo-blocked from it).
// Safari / iOS use native HLS, which is NOT CORS-gated — they load the stream
// directly from the viewer's location, so Toffee plays from BD with no proxy at all.
const PROXY_BASE = ''; // e.g. 'https://your-bd-proxy.example.com'
const proxied = (url) => PROXY_BASE.replace(/\/+$/, '') + '/proxy?url=' + encodeURIComponent(url);

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), player: $('player'),
  playOverlay: $('playOverlay'), spinner: $('spinner'),
  liveBadge: $('liveBadge'), behindBadge: $('behindBadge'), reconnectBadge: $('reconnectBadge'),
  errorPanel: $('errorPanel'), errorMsg: $('errorMsg'), retryBtn: $('retryBtn'),
  playPause: $('playPause'), muteBtn: $('muteBtn'), volSlider: $('volSlider'),
  goLiveBtn: $('goLiveBtn'), statsBtn: $('statsBtn'), stats: $('stats'),
  pipBtn: $('pipBtn'), fsBtn: $('fsBtn'),
  channelsToggle: $('channelsToggle'), channelPanel: $('channelPanel'),
  channelSearch: $('channelSearch'), channelClose: $('channelClose'),
  channelList: $('channelList'), channelCount: $('channelCount'), nowPlaying: $('nowPlaying'),
};

let hls = null;
let currentUrl = '';
let useProxy = false; // load direct first; flip true if a direct load fails (e.g. CORS)
let statsOn = false;
let channels = [];          // parsed playable channels from the playlist
let currentChannelIdx = -1; // index into channels of what's playing
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

// The first attempt loads the source directly (works for Safari/iOS native HLS and
// any CORS-enabled stream). If a direct load fails before playback starts — e.g.
// hls.js blocked by missing CORS headers — switch to the proxy once and rebuild.
function fallbackToProxy() {
  if (useProxy || hasPlayed) return false;
  useProxy = true;
  setTimeout(rebuild, 0); // defer: don't tear down hls inside its own error handler
  return true;
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
        if (fallbackToProxy()) break; // direct fetch blocked (e.g. CORS) → try the proxy
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
    useProxy = false; // each new stream starts direct-first
    lastProgressAt = now();
    initLoadAt = now();
  }
  clearRecoverTimer();

  const src = useProxy ? proxied(url) : url;
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
    // Native HLS (Safari / iOS): not CORS-gated, so load the stream directly from
    // the viewer's location — geo-locked feeds like Toffee play from BD with no proxy.
    video.src = src;
    video.addEventListener('loadedmetadata', () => { showSpinner(false); tryPlay(); }, { once: true });
    video.addEventListener('error', () => {
      if (fallbackToProxy()) return;        // direct load failed → try the proxy once
      scheduleRecover(rebuild);             // otherwise absorb as a transient blip
    }, { once: true });
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
    case 'c': toggleChannels(); break;
    case 'escape': closeChannels(); break;
  }
});

setInterval(() => { updateLiveState(); renderStats(); healthCheck(); }, 1000);

/* ── Channel browser ─────────────────────────── */
// Parse an M3U/IPTV playlist into {name, logo, group, url} entries.
function parseM3U(text) {
  const out = [];
  let meta = null;
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name = (line.split(',').slice(1).join(',') || '').trim();
      const logo = (line.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
      const group = (line.match(/group-title="([^"]*)"/) || [])[1]
                 || (line.match(/tvg-country="([^"]*)"/) || [])[1] || '';
      meta = { name, logo, group };
    } else if (!line.startsWith('#')) {
      if (meta) { meta.url = line; out.push(meta); meta = null; }
    }
  }
  return out;
}

// Keep only channels hls.js can play (HLS); drop YouTube/Twitch/Facebook/DASH.
function isPlayable(url) {
  const u = (url || '').toLowerCase();
  if (/youtube\.com|youtu\.be|twitch\.tv|facebook\.com|\.mpd(\?|$)/.test(u)) return false;
  return u.includes('m3u8');
}

// Prefer a globally-reliable channel as the initial pick; else the first one.
const PREFERRED = [/al jazeera/i, /france 24/i, /euronews/i, /\bdw\b/i, /red bull/i, /nasa/i];
function pickDefault(list) {
  for (const re of PREFERRED) { const i = list.findIndex((c) => re.test(c.name)); if (i >= 0) return i; }
  return 0;
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function initChannels() {
  showSpinner(true);
  let text = '';
  try { text = await fetchText(PLAYLIST_URL); }
  catch { try { text = await fetchText(proxied(PLAYLIST_URL)); } catch { /* offline */ } }

  channels = parseM3U(text).filter((c) => isPlayable(c.url));
  if (!channels.length) {
    channels = [{ name: 'Test stream', group: '', logo: '', url: FALLBACK_STREAM }];
  }
  renderChannels();
  selectChannel(pickDefault(channels));
}

// Build the channel list with the DOM API (never innerHTML — playlist is untrusted).
function renderChannels() {
  const frag = document.createDocumentFragment();
  channels.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'ch-item';
    btn.type = 'button';
    btn.dataset.idx = String(i);
    btn.dataset.search = (c.name + ' ' + c.group).toLowerCase();

    if (c.logo) {
      const img = document.createElement('img');
      img.className = 'ch-logo';
      img.loading = 'lazy';
      img.alt = '';
      img.src = c.logo;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      btn.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'ch-logo';
      btn.appendChild(ph);
    }

    const text = document.createElement('span');
    text.className = 'ch-text';
    const name = document.createElement('span');
    name.className = 'ch-name';
    name.textContent = c.name;
    const group = document.createElement('span');
    group.className = 'ch-group';
    group.textContent = c.group;
    text.append(name, group);
    btn.appendChild(text);

    frag.appendChild(btn);
  });
  els.channelList.replaceChildren(frag);
  els.channelCount.textContent = channels.length + ' channels';
}

function selectChannel(idx) {
  const c = channels[idx];
  if (!c) return;
  currentChannelIdx = idx;
  els.nowPlaying.textContent = c.name;
  document.title = c.name + ' · Live TV';
  for (const el of els.channelList.children) {
    el.classList.toggle('active', el.dataset.idx === String(idx));
  }
  closeChannels();
  load(c.url);
}

function filterChannels(q) {
  const query = q.trim().toLowerCase();
  let shown = 0;
  for (const el of els.channelList.children) {
    const match = !query || el.dataset.search.includes(query);
    el.style.display = match ? '' : 'none';
    if (match) shown++;
  }
  els.channelCount.textContent = shown + (query ? ' matches' : ' channels');
}

function openChannels() {
  els.channelPanel.hidden = false;
  const active = els.channelList.querySelector('.ch-item.active');
  if (active) active.scrollIntoView({ block: 'center' });
  els.channelSearch.focus();
}
function closeChannels() { els.channelPanel.hidden = true; }
function toggleChannels() { els.channelPanel.hidden ? openChannels() : closeChannels(); }

els.channelsToggle.addEventListener('click', toggleChannels);
els.channelClose.addEventListener('click', closeChannels);
els.channelSearch.addEventListener('input', () => filterChannels(els.channelSearch.value));
els.channelSearch.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChannels(); });
els.channelList.addEventListener('click', (e) => {
  const item = e.target.closest('.ch-item');
  if (item) selectChannel(Number(item.dataset.idx));
});

// Boot
if (!document.pictureInPictureEnabled && !els.video.webkitSupportsPresentationMode) els.pipBtn.hidden = true;
syncPlayUI();
syncMuteUI();
wakeControls();   // reveal the chrome (incl. the Channels button) on first load
initChannels();
