/**
 * YT Downloader
 * High-speed, crystal-clear 1080p video & music converter with live preview, full audio, and precision trimming.
 */

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const urlForm = $('urlForm');
  const urlInput = $('urlInput');
  const clearBtn = $('clearBtn');
  const pasteBtn = $('pasteBtn');
  const fetchBtn = $('fetchBtn');
  const fetchBtnText = $('fetchBtnText');

  const result = $('result');
  const videoThumb = $('videoThumb');
  const videoDuration = $('videoDuration');
  const videoTitle = $('videoTitle');
  const videoChannel = $('videoChannel');
  const videoViews = $('videoViews');
  const videoDimensions = $('videoDimensions');

  const formatGroup = $('formatGroup');
  const qualityChips = $('qualityChips');

  const trimToggle = $('trimToggle');
  const trimPanel = $('trimPanel');
  const previewVideo = $('previewVideo');
  const ytPlayerContainer = $('ytPlayerContainer');
  const playBtn = $('playBtn');
  const playIconUse = $('playIconUse');
  const muteBtn = $('muteBtn');
  const muteIconUse = $('muteIconUse');
  const currentTime = $('currentTime');
  const totalTime = $('totalTime');
  const playheadTime = $('playheadTime');
  const resetTrimBtn = $('resetTrimBtn');

  const seekSlider = $('seekSlider');
  const trimStart = $('trimStart');
  const trimEnd = $('trimEnd');
  const trimRange = $('trimRange');
  const playhead = $('playhead');
  const startTime = $('startTime');
  const endTime = $('endTime');
  const clipLength = $('clipLength');

  const downloadBtn = $('downloadBtn');
  const downloadLabel = $('downloadLabel');
  const downloadSize = $('downloadSize');

  const job = $('job');
  const jobText = $('jobText');
  const jobPercent = $('jobPercent');
  const jobFill = $('jobFill');
  const jobActions = $('jobActions');
  const jobSaveBtn = $('jobSaveBtn');
  const jobDismissBtn = $('jobDismissBtn');

  const recent = $('recent');
  const recentList = $('recentList');
  const clearRecentBtn = $('clearRecentBtn');
  const toasts = $('toasts');
  const serverState = $('serverState');
  const serverStateText = $('serverStateText');

  const SCRUB_STEPS = 1000;
  const HISTORY_KEY = 'ytdownloader_recent';

  let video = null;          // the /api/info payload
  let duration = 0;          // seconds
  let clipFrom = 0;
  let clipTo = 0;
  let activeStream = null;   // EventSource for the current trim job
  let ytPlayer = null;
  let ytPlayerReady = false;
  let playbackTimer = null;
  let isMuted = false;

  // ---------------------------------------------------------
  // Time and size formatting
  // ---------------------------------------------------------

  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function compact(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function toSeconds(text) {
    if (!text) return 0;
    const parts = String(text).trim().split(':').map((p) => parseInt(p, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function megabytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  }

  // ---------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------

  function toast(message, kind = 'info') {
    const icon = kind === 'error' ? 'i-alert' : kind === 'ok' ? 'i-check' : 'i-clock';
    const el = document.createElement('div');
    el.className = `toast${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;
    el.innerHTML = `<svg aria-hidden="true"><use href="#${icon}"/></svg><span></span>`;
    el.querySelector('span').textContent = message;
    toasts.appendChild(el);

    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    }, 4200);
  }

  // ---------------------------------------------------------
  // Server state & API base (the laptop running server.js, via Tailscale Funnel)
  // ---------------------------------------------------------

  // ===========================================================
  // THE ONLY LINE YOU EVER NEED TO CHANGE
  //
  // Public HTTPS address of the laptop running server.js, published by
  // Tailscale Funnel. Looks like: https://my-laptop.tail1234.ts.net
  // Get it by running:  tailscale funnel status
  // ===========================================================
  const BACKEND_URL = 'https://desktop-6h27mhs.tail3b4823.ts.net';

  // The backend runs on a home internet connection rather than a datacenter,
  // which is the whole point: YouTube bot-checks datacenter IPs and mostly
  // leaves residential ones alone.
  function getApiBase() {
    const custom = (localStorage.getItem('ytdownloader_backend_url') || '').trim();
    if (custom) return custom.replace(/\/+$/, '');
    // Served by server.js itself (localhost, or over the funnel) -> same origin.
    if (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.endsWith('.ts.net')) {
      return '';
    }
    return BACKEND_URL.replace(/\/+$/, '');
  }

  function apiUrl(path) {
    const base = getApiBase();
    if (!path.startsWith('/')) path = '/' + path;
    return `${base}${path}`;
  }

  // A laptop backend is either up or it is not -- there is no cold start to wait
  // out. Retry briefly to ride over a Wi-Fi blip or a tunnel reconnect, then say
  // plainly that the machine is off rather than spinning forever.
  const WAKE_BUDGET_MS = 20000;

  let backendReady = false;
  let wakePromise = null;

  function setBadge(state, text) {
    serverState.dataset.state = state;
    serverStateText.textContent = text;
  }

  function pingStatus(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(apiUrl('/api/status'), { signal: controller.signal, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unhealthy'))))
      .finally(() => clearTimeout(timer));
  }

  function wakeBackend() {
    if (backendReady) return Promise.resolve(true);
    if (wakePromise) return wakePromise;

    const startedAt = Date.now();
    setBadge('checking', 'Connecting…');

    wakePromise = (async () => {
      while (Date.now() - startedAt < WAKE_BUDGET_MS) {
        try {
          const s = await pingStatus(60000);
          if (s.ytDlpAvailable && s.ffmpegAvailable) {
            backendReady = true;
            setBadge('online', 'Ready');
            return true;
          }
          // Answering but not yet reporting healthy means the container is still
          // warming its binaries, not that it is broken. Keep waiting rather
          // than locking the user out of a server that is seconds from ready.
          const warming = Math.round((Date.now() - startedAt) / 1000);
          setBadge('checking', `Starting up… ${warming}s`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        } catch {
          const secs = Math.round((Date.now() - startedAt) / 1000);
          setBadge('checking', `Connecting… ${secs}s`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      setBadge('offline', 'Laptop is offline');
      return false;
    })();

    wakePromise.finally(() => { wakePromise = null; });
    return wakePromise;
  }

  // Start warming the instance the moment the page opens, so by the time a link
  // is pasted the server is usually already up.
  wakeBackend();

  // A tab left open for hours will find the instance asleep again.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !backendReady) wakeBackend();
  });

  // Plain click just re-checks. The backend override is deliberately tucked
  // behind Alt/Shift-click so an ordinary user tapping the badge never gets an
  // unexplained prompt asking for a server URL.
  serverState.style.cursor = 'pointer';
  serverState.title = 'Click to re-check the server (Alt+click to set a custom backend)';
  serverState.addEventListener('click', (event) => {
    if (!event.altKey && !event.shiftKey) {
      backendReady = false;
      wakeBackend();
      return;
    }

    const current = getApiBase();
    const input = prompt(
      `Backend Server URL (currently: ${current || 'localhost'}):\nLeave blank to reset to the default cloud backend:`,
      localStorage.getItem('ytdownloader_backend_url') || ''
    );
    if (input !== null) {
      const trimmed = input.trim();
      if (trimmed) {
        localStorage.setItem('ytdownloader_backend_url', trimmed);
        toast(`Backend set to ${trimmed}`, 'ok');
      } else {
        localStorage.removeItem('ytdownloader_backend_url');
        toast('Using default cloud backend', 'info');
      }
      backendReady = false;
      wakeBackend();
    }
  });

  // ---------------------------------------------------------
  // Link intake
  // ---------------------------------------------------------

  urlInput.addEventListener('input', () => {
    clearBtn.classList.toggle('is-hidden', !urlInput.value.trim());
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.classList.add('is-hidden');
    urlInput.focus();
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      urlInput.value = text;
      clearBtn.classList.remove('is-hidden');
      loadVideo();
    } catch {
      toast('Paste with Ctrl+V into the box.', 'info');
      urlInput.focus();
    }
  });

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    loadVideo();
  });

  async function loadVideo() {
    const url = urlInput.value.trim();
    if (!url) {
      toast('Paste a YouTube link first.', 'error');
      urlInput.focus();
      return;
    }

    fetchBtn.disabled = true;
    fetchBtnText.textContent = backendReady ? 'Finding…' : 'Waking server…';

    try {
      const awake = await wakeBackend();
      if (!awake) {
        throw new Error('The download server is offline. Ask Fawaz to open his laptop.');
      }
      fetchBtnText.textContent = 'Finding…';

      // A first extraction on a freshly woken instance can be slow; cap it so a
      // hung request eventually surfaces as an error instead of spinning forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let response;
      try {
        response = await fetch(apiUrl('/api/info'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'That link could not be read.');

      video = data;
      duration = data.duration_raw || 0;
      clipFrom = 0;
      clipTo = duration;

      renderVideo();
      renderQuality();
      resetTrimUI();
      resetJobUI();

      result.classList.remove('is-hidden');
    } catch (err) {
      // A failure may well mean the instance went back to sleep, so make the
      // next attempt re-run the wake handshake.
      backendReady = false;
      toast(
        err.name === 'AbortError'
          ? 'The server took too long to answer. Please try again.'
          : err.message,
        'error'
      );
    } finally {
      fetchBtn.disabled = false;
      fetchBtnText.textContent = 'Find it';
    }
  }

  function renderVideo() {
    if (video.thumbnail) videoThumb.src = video.thumbnail;
    videoThumb.alt = `Thumbnail for ${video.title}`;
    videoDuration.textContent = compact(duration);
    videoTitle.textContent = video.title;
    videoChannel.textContent = video.uploader || '';
    videoViews.textContent = video.views || '';
    videoDimensions.textContent = video.width && video.height ? `${video.width}×${video.height}` : '';
  }

  // ---------------------------------------------------------
  // Format and quality
  // ---------------------------------------------------------

  function currentFormat() {
    const checked = formatGroup.querySelector('input:checked');
    return checked ? checked.value : 'mp4';
  }

  function renderQuality() {
    if (!video) return;
    const isAudio = currentFormat() === 'mp3';
    const options = isAudio ? video.audio_qualities || [] : video.resolutions || [];
    const has1080 = options.some(o => o.quality === '1080');
    const preferred = isAudio ? '320' : (has1080 ? '1080' : (options[0] ? options[0].quality : '720'));

    qualityChips.innerHTML = options
      .map((item) => {
        const bytes = item.rawBytes || item.bytes || 0;
        const tag = item.quality === preferred ? '<span class="chip-tag">Best</span>' : '';
        return `
          <label class="chip">
            <input type="radio" name="quality" value="${item.quality}" data-bytes="${bytes}" ${
          item.quality === preferred ? 'checked' : ''
        } />
            <div class="chip-header">
              <span class="chip-title">${item.label}</span>
              ${tag}
            </div>
            <span class="chip-size mono">${item.size || ''}</span>
          </label>`;
      })
      .join('');

    if (!qualityChips.querySelector('input:checked')) {
      const first = qualityChips.querySelector('input');
      if (first) first.checked = true;
    }

    updateCommit();
  }

  function selectedQuality() {
    const checked = qualityChips.querySelector('input:checked');
    return {
      value: checked ? checked.value : '1080',
      bytes: checked ? parseInt(checked.dataset.bytes, 10) || 0 : 0
    };
  }

  formatGroup.addEventListener('change', () => {
    renderQuality();
    if (currentFormat() === 'mp3') pausePlayer();
  });

  qualityChips.addEventListener('change', updateCommit);

  // ---------------------------------------------------------
  // YouTube Iframe & Video Player Integration
  // ---------------------------------------------------------

  function initPlayer() {
    if (!video) return;

    const vidId = video.videoId || video.id;

    if (window.YT && window.YT.Player && vidId) {
      previewVideo.classList.add('is-hidden');
      ytPlayerContainer.classList.remove('is-hidden');

      if (ytPlayer && ytPlayer.destroy) {
        try { ytPlayer.destroy(); } catch (e) {}
      }

      ytPlayer = new YT.Player('ytPlayerContainer', {
        height: '100%',
        width: '100%',
        videoId: vidId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: Math.round(clipFrom)
        },
        events: {
          onReady: (e) => {
            ytPlayerReady = true;
            ytPlayer.unMute();
            ytPlayer.setVolume(100);
            updateMuteButtonUI(false);
          },
          onStateChange: (e) => {
            const isPlaying = e.data === YT.PlayerState.PLAYING;
            setPlayIcon(isPlaying);
            if (isPlaying) startPlaybackPolling();
            else stopPlaybackPolling();
          }
        }
      });
    } else {
      // Fallback to HTML5 video if YT Iframe API isn't available
      ytPlayerContainer.classList.add('is-hidden');
      previewVideo.classList.remove('is-hidden');
      previewVideo.src = video.preview_url || apiUrl(`/api/stream-preview?url=${encodeURIComponent(video.url)}`);
      if (video.thumbnail) previewVideo.poster = video.thumbnail;
      previewVideo.muted = false;
    }
  }

  function getPlayerCurrentTime() {
    if (ytPlayer && ytPlayerReady && ytPlayer.getCurrentTime) {
      return ytPlayer.getCurrentTime() || 0;
    }
    return previewVideo.currentTime || 0;
  }

  function seekPlayerTo(seconds) {
    if (ytPlayer && ytPlayerReady && ytPlayer.seekTo) {
      ytPlayer.seekTo(seconds, true);
    } else if (previewVideo) {
      previewVideo.currentTime = seconds;
    }
  }

  function playPlayer() {
    if (ytPlayer && ytPlayerReady && ytPlayer.playVideo) {
      const cur = getPlayerCurrentTime();
      if (cur < clipFrom || cur >= clipTo) {
        seekPlayerTo(clipFrom);
      }
      ytPlayer.playVideo();
    } else if (previewVideo) {
      const cur = previewVideo.currentTime;
      if (cur < clipFrom || cur >= clipTo) {
        previewVideo.currentTime = clipFrom;
      }
      previewVideo.play().catch(() => {});
    }
  }

  function pausePlayer() {
    if (ytPlayer && ytPlayerReady && ytPlayer.pauseVideo) {
      ytPlayer.pauseVideo();
    } else if (previewVideo) {
      previewVideo.pause();
    }
    setPlayIcon(false);
    stopPlaybackPolling();
  }

  function startPlaybackPolling() {
    stopPlaybackPolling();
    playbackTimer = setInterval(() => {
      const at = getPlayerCurrentTime();
      currentTime.textContent = compact(at);
      playheadTime.textContent = clock(at);

      if (duration > 0) {
        const pct = Math.min(1000, Math.round((at / duration) * SCRUB_STEPS));
        seekSlider.value = pct;
        playhead.classList.add('is-live');
        playhead.style.left = `calc(${Math.min(100, (at / duration) * 100)}% - 1px)`;
      }

      // Auto-loop within trimmed boundaries
      if (clipTo > clipFrom && at >= clipTo) {
        seekPlayerTo(clipFrom);
      }
    }, 250);
  }

  function stopPlaybackPolling() {
    if (playbackTimer) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
  }

  playBtn.addEventListener('click', () => {
    if (ytPlayer && ytPlayerReady && ytPlayer.getPlayerState) {
      const state = ytPlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) pausePlayer();
      else playPlayer();
    } else {
      if (previewVideo.paused) playPlayer();
      else pausePlayer();
    }
  });

  function setPlayIcon(playing) {
    playIconUse.setAttribute('href', playing ? '#i-pause' : '#i-play');
    playBtn.title = playing ? 'Pause' : 'Play';
  }

  function updateMuteButtonUI(muted) {
    isMuted = muted;
    muteIconUse.setAttribute('href', muted ? '#i-muted' : '#i-sound');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  muteBtn.addEventListener('click', () => {
    if (ytPlayer && ytPlayerReady) {
      if (ytPlayer.isMuted && ytPlayer.isMuted()) {
        ytPlayer.unMute();
        ytPlayer.setVolume(100);
        updateMuteButtonUI(false);
        toast('Sound unmuted.', 'info');
      } else {
        ytPlayer.mute();
        updateMuteButtonUI(true);
        toast('Sound muted.', 'info');
      }
    } else {
      previewVideo.muted = !previewVideo.muted;
      updateMuteButtonUI(previewVideo.muted);
    }
  });

  // ---------------------------------------------------------
  // Seek / Playhead Scrubber Slider
  // ---------------------------------------------------------

  seekSlider.addEventListener('input', () => {
    const scrubVal = parseFloat(seekSlider.value) / SCRUB_STEPS;
    const targetSec = scrubVal * duration;
    seekPlayerTo(targetSec);
    currentTime.textContent = compact(targetSec);
    playheadTime.textContent = clock(targetSec);

    if (duration > 0) {
      playhead.classList.add('is-live');
      playhead.style.left = `calc(${Math.min(100, scrubVal * 100)}% - 1px)`;
    }
  });

  // ---------------------------------------------------------
  // Trim Boundaries & UI Sync
  // ---------------------------------------------------------

  trimToggle.addEventListener('change', () => {
    trimPanel.classList.toggle('is-collapsed', !trimToggle.checked);

    if (trimToggle.checked) {
      initPlayer();
    } else {
      pausePlayer();
    }

    updateCommit();
  });

  function resetTrimUI() {
    clipFrom = 0;
    clipTo = duration;
    pausePlayer();
    trimToggle.checked = false;
    trimPanel.classList.add('is-collapsed');
    totalTime.textContent = compact(duration);
    currentTime.textContent = compact(0);
    playheadTime.textContent = clock(0);
    seekSlider.value = 0;
    playhead.classList.remove('is-live');
    syncTrimUI();
  }

  function syncTrimUI() {
    const from = duration > 0 ? (clipFrom / duration) * SCRUB_STEPS : 0;
    const to = duration > 0 ? (clipTo / duration) * SCRUB_STEPS : SCRUB_STEPS;

    trimStart.value = from;
    trimEnd.value = to;
    trimRange.style.left = `${(from / SCRUB_STEPS) * 100}%`;
    trimRange.style.width = `${((to - from) / SCRUB_STEPS) * 100}%`;

    startTime.value = clock(clipFrom);
    endTime.value = clock(clipTo);
    clipLength.textContent = clock(Math.max(0, clipTo - clipFrom));

    updateCommit();
  }

  function scrubToSeconds(input) {
    return (parseFloat(input.value) / SCRUB_STEPS) * duration;
  }

  trimStart.addEventListener('input', () => {
    const next = scrubToSeconds(trimStart);
    clipFrom = Math.min(next, clipTo - 1);
    seekPlayerTo(clipFrom);
    seekSlider.value = (clipFrom / duration) * SCRUB_STEPS;
    syncTrimUI();
  });

  trimEnd.addEventListener('input', () => {
    const next = scrubToSeconds(trimEnd);
    clipTo = Math.max(next, clipFrom + 1);
    seekPlayerTo(clipTo);
    seekSlider.value = (clipTo / duration) * SCRUB_STEPS;
    syncTrimUI();
  });

  function commitTimeField(input, which) {
    let value = Math.max(0, Math.min(duration, toSeconds(input.value)));
    if (which === 'start') clipFrom = Math.min(value, clipTo - 1);
    else clipTo = Math.max(value, clipFrom + 1);

    seekPlayerTo(which === 'start' ? clipFrom : clipTo);
    syncTrimUI();
  }

  startTime.addEventListener('blur', () => commitTimeField(startTime, 'start'));
  endTime.addEventListener('blur', () => commitTimeField(endTime, 'end'));
  [startTime, endTime].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  });

  document.querySelectorAll('.time-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const at = Math.round(getPlayerCurrentTime());
      if (btn.dataset.set === 'start') {
        clipFrom = Math.min(at, clipTo - 1);
        toast(`Start locked to ${clock(clipFrom)}`, 'ok');
      } else {
        clipTo = Math.max(at, clipFrom + 1);
        toast(`End locked to ${clock(clipTo)}`, 'ok');
      }
      syncTrimUI();
    });
  });

  resetTrimBtn.addEventListener('click', () => {
    clipFrom = 0;
    clipTo = duration;
    seekSlider.value = 0;
    seekPlayerTo(0);
    syncTrimUI();
  });

  // ---------------------------------------------------------
  // Download Actions
  // ---------------------------------------------------------

  function estimatedBytes() {
    const { bytes } = selectedQuality();
    if (!bytes) return 0;
    if (!trimToggle.checked || duration <= 0) return bytes;
    const ratio = Math.min(1, Math.max(0, (clipTo - clipFrom) / duration));
    return Math.round(bytes * ratio);
  }

  function updateCommit() {
    const isAudio = currentFormat() === 'mp3';
    const trimming = trimToggle.checked;

    downloadLabel.textContent = trimming
      ? `Trim and download ${isAudio ? 'audio' : 'video'}`
      : `Download ${isAudio ? 'audio' : 'video'}`;

    downloadSize.textContent = megabytes(estimatedBytes());
  }

  downloadBtn.addEventListener('click', () => {
    if (!video || !video.url) {
      toast('Find a video first.', 'error');
      return;
    }
    if (trimToggle.checked) startTrimJob();
    else startDirectDownload();
  });

  async function startDirectDownload() {
    const format = currentFormat();
    const { value: quality } = selectedQuality();
    const title = video.title || 'YouTube download';
    const qualityLabel = format === 'mp3' ? 'audio' : `${quality}p`;

    showJob(`Downloading ${qualityLabel}…`);
    downloadBtn.disabled = true;

    try {
      const awake = await wakeBackend();
      if (!awake) {
        backendReady = false;
        throw new Error('The download server is offline. Ask Fawaz to open his laptop.');
      }

      const response = await fetch(apiUrl('/api/convert-full'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          format,
          quality,
          title
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The download job could not start.');

      followJob(data.jobId, title, format);
    } catch (err) {
      failJob(err.message);
    }
  }

  async function startTrimJob() {
    const format = currentFormat();
    const { value: quality } = selectedQuality();
    const title = `${video.title || 'Clip'} (${clock(clipFrom)}-${clock(clipTo)})`;
    const qualityLabel = format === 'mp3' ? 'audio' : `${quality}p`;

    showJob(`Downloading ${qualityLabel} clip…`);
    downloadBtn.disabled = true;

    try {
      const awake = await wakeBackend();
      if (!awake) {
        backendReady = false;
        throw new Error('The download server is offline. Ask Fawaz to open his laptop.');
      }

      const response = await fetch(apiUrl('/api/convert-trim'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: video.url,
          format,
          quality,
          startTime: Math.round(clipFrom),
          endTime: Math.round(clipTo),
          title
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The trim job could not start.');

      followJob(data.jobId, title, format);
    } catch (err) {
      failJob(err.message);
    }
  }

  function followJob(jobId, title, format) {
    activeStream = new EventSource(apiUrl(`/api/progress/${jobId}`));

    activeStream.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      const percent = Math.min(100, Math.max(5, Math.round(data.percent || 0)));
      jobFill.style.transform = `scaleX(${percent / 100})`;
      jobPercent.textContent = `${percent}%`;
      if (data.text) jobText.textContent = data.text;

      if (data.status === 'completed') {
        closeStream();
        job.classList.add('is-done');
        jobFill.style.transform = 'scaleX(1)';
        jobPercent.textContent = '100%';
        jobText.textContent = `Ready · ${data.size || megabytes(estimatedBytes())}`;

        const rawHref = data.downloadUrl || `/api/download/${jobId}?title=${encodeURIComponent(title)}`;
        const href = rawHref.startsWith('http') ? rawHref : apiUrl(rawHref);
        jobSaveBtn.href = href;
        jobSaveBtn.setAttribute('download', `${title}.${format}`);
        jobActions.classList.remove('is-hidden');
        downloadBtn.disabled = false;

        triggerSave(href, `${title}.${format}`);
        toast(`Your ${format.toUpperCase()} is saved to downloads!`, 'ok');

        remember({ title, kind: format.toUpperCase(), meta: data.size || megabytes(estimatedBytes()) });
      } else if (data.status === 'error') {
        closeStream();
        failJob(data.message || 'Download failed.');
      }
    };

    activeStream.onerror = () => {
      closeStream();
      failJob('Lost contact with the server during download.');
    };
  }

  function closeStream() {
    if (activeStream) {
      activeStream.close();
      activeStream = null;
    }
  }

  function showJob(text) {
    job.classList.remove('is-hidden', 'is-done', 'is-failed');
    jobActions.classList.add('is-hidden');
    jobFill.style.transform = 'scaleX(0.05)';
    jobPercent.textContent = '5%';
    jobText.textContent = text;
  }

  function failJob(message) {
    job.classList.add('is-failed');
    jobFill.style.transform = 'scaleX(1)';
    jobText.textContent = message;
    jobPercent.textContent = '';
    jobActions.classList.remove('is-hidden');
    jobSaveBtn.classList.add('is-hidden');
    downloadBtn.disabled = false;
    toast(message, 'error');
  }

  function resetJobUI() {
    closeStream();
    job.classList.add('is-hidden');
    job.classList.remove('is-done', 'is-failed');
    jobSaveBtn.classList.remove('is-hidden');
    downloadBtn.disabled = false;
  }

  jobDismissBtn.addEventListener('click', resetJobUI);

  function triggerSave(href, filename) {
    const link = document.createElement('a');
    link.href = href;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // ---------------------------------------------------------
  // Recent History
  // ---------------------------------------------------------

  function readRecent() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch {
      return [];
    }
  }

  function remember(entry) {
    const items = [{ ...entry, at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
      .concat(readRecent())
      .slice(0, 8);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    } catch {
      /* pass */
    }
    renderRecent();
  }

  function renderRecent() {
    const items = readRecent();
    recent.classList.toggle('is-hidden', items.length === 0);

    recentList.innerHTML = items
      .map(
        (item) => `
        <li class="recent-item">
          <span class="recent-kind">${item.kind}</span>
          <span class="recent-title"></span>
          <span class="recent-meta">${item.meta || ''} · ${item.at || ''}</span>
        </li>`
      )
      .join('');

    recentList.querySelectorAll('.recent-title').forEach((node, i) => {
      node.textContent = items[i].title;
      node.title = items[i].title;
    });
  }

  clearRecentBtn.addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderRecent();
  });

  renderRecent();
});
