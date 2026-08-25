const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');

// Resolve ffmpeg. Inside the Alpine container the distro build (installed via
// apk) is the safest choice; ffmpeg-static is the fallback for local dev.
function resolveFfmpegPath() {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (e) {}
  return 'ffmpeg';
}
const ffmpegPath = resolveFfmpegPath();

// Global error handlers to prevent process crashing on stream aborts
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.message || err));
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Path to yt-dlp binary (cross-platform: local yt-dlp.exe, local yt-dlp, or system yt-dlp in PATH)
function getBinaryPath() {
  const localExe = path.join(__dirname, 'yt-dlp.exe');
  if (fs.existsSync(localExe)) return localExe;
  const localBin = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localBin)) return localBin;
  return process.env.YT_DLP_PATH || 'yt-dlp';
}
const ytDlpPath = getBinaryPath();
const TEMP_DIR = path.join(__dirname, 'downloads_temp');

// Path to cookies file if provided (via file or YOUTUBE_COOKIES env variable)
const cookiesFilePath = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES && !fs.existsSync(cookiesFilePath)) {
  try {
    fs.writeFileSync(cookiesFilePath, process.env.YOUTUBE_COOKIES, 'utf8');
  } catch (e) {
    console.error('Failed to write YOUTUBE_COOKIES env to file:', e.message);
  }
}

function getCookiesArgs() {
  if (fs.existsSync(cookiesFilePath)) {
    return ['--cookies', cookiesFilePath];
  }
  return [];
}

// ---------------------------------------------------------------------------
// YouTube extraction strategy
//
// Two things decide whether extraction works and at what quality:
//
// 1. A JavaScript runtime. Modern yt-dlp needs one to solve YouTube's
//    signature/nsig challenges. Without it formats silently vanish and
//    downloads get throttled. We already ship Node, so Node is the runtime --
//    configured synchronously on startup to prevent cold-start race conditions.
//
// 2. The player client. YouTube bot-checks datacenter IPs on some videos but
//    not others, so a single client is never enough. Clients are not
//    interchangeable either -- they differ in the formats they expose:
//
//      default      1080p avc1 + aac   best quality, first choice
//      tv_embedded  1080p avc1 + aac   full quality AND dodges many bot checks
//      web_embedded 1080p avc1 + aac   same idea, different surface
//      android_vr     360p avc1        degraded, but works when others do not
//      android,web    360p avc1        last resort
//
//    Order therefore runs best-quality-first and only degrades once the
//    full-quality clients are exhausted, so a bot check costs resolution only
//    when there is genuinely no alternative.
// ---------------------------------------------------------------------------
const CLIENT_CHAIN = (process.env.YTDLP_CLIENTS || 'default|tv_embedded|web_embedded|android_vr|android,web')
  .split('|')
  .map((c) => c.trim())
  .filter(Boolean);

let jsRuntimeArgs = ['--js-runtimes', process.env.YTDLP_JS_RUNTIME || 'node'];
if (process.env.YTDLP_JS_RUNTIME === 'off') {
  jsRuntimeArgs = [];
} else {
  try {
    const helpOutput = execFileSync(ytDlpPath, ['--help'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (!helpOutput.includes('--js-runtimes')) {
      jsRuntimeArgs = [];
      console.log('[yt-dlp] --js-runtimes not supported by this build, skipping');
    } else {
      console.log('[yt-dlp] using JS runtime:', jsRuntimeArgs[1]);
    }
  } catch (e) {
    console.log('[yt-dlp] using default JS runtime:', jsRuntimeArgs[1]);
  }
}

// Args shared by every yt-dlp invocation, for one client strategy.
function buildBaseArgs(client) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '20',
    '--retries', '5',
    '--fragment-retries', '5',
    '--extractor-retries', '3',
    '--http-chunk-size', '10M',
    '--buffer-size', '16M',
    '--resize-buffer',
    ...jsRuntimeArgs,
    ...getCookiesArgs()
  ];
  if (client && client !== 'default') {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }
  return args;
}

// Translate a raw yt-dlp stderr blob into something a non-technical user can act on.
function describeYtDlpError(stderr) {
  const s = (stderr || '').toString();
  if (/Sign in to confirm|not a bot/i.test(s)) {
    return 'YouTube is rate-limiting this server right now. Please wait a minute and try again.';
  }
  if (/Private video/i.test(s)) return 'This video is private and cannot be downloaded.';
  if (/Video unavailable|removed by the uploader/i.test(s)) return 'This video is unavailable or has been removed.';
  if (/age-restricted|confirm your age/i.test(s)) return 'This video is age-restricted, so it cannot be downloaded.';
  if (/live event will begin|is live/i.test(s)) return 'This is a live stream. Wait until it ends, then try again.';
  if (/is not a valid URL|Unsupported URL/i.test(s)) return 'That does not look like a valid YouTube link.';
  return 'Could not read this video. Make sure it is public and the link is correct.';
}

// Run yt-dlp, walking the client chain until one returns usable output.
function runYtDlpWithFallback(makeArgs, execOpts, done) {
  let lastStderr = '';
  const attempt = (i) => {
    if (i >= CLIENT_CHAIN.length) return done(new Error('all player clients failed'), '', lastStderr, null);
    const client = CLIENT_CHAIN[i];
    execFile(ytDlpPath, makeArgs(client), execOpts, (err, stdout, stderr) => {
      if (!err && stdout && stdout.trim()) return done(null, stdout, stderr, client);
      lastStderr = stderr || (err && err.message) || lastStderr;
      const tail = String(lastStderr).trim().slice(-200);
      console.warn(`[yt-dlp] client "${client}" failed: ${tail}`);
      attempt(i + 1);
    });
  };
  attempt(0);
}

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// In-memory store for conversion jobs and SSE connections
const activeJobs = new Map();
const sseClients = new Map();

// The free cloud instance runs on 0.1 CPU and 512 MB. Two or three simultaneous
// 1080p jobs are enough to OOM it, and a crash kills every in-flight download
// rather than just the surplus one. Turning away the extra request is the far
// kinder failure, so cap the heavy work and shed load early.
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
let activeHeavyJobs = 0;

function acquireJobSlot() {
  if (activeHeavyJobs >= MAX_CONCURRENT_JOBS) return false;
  activeHeavyJobs++;
  return true;
}

function releaseJobSlot() {
  activeHeavyJobs = Math.max(0, activeHeavyJobs - 1);
}

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Clean up stale files in TEMP_DIR every 15 minutes
setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    console.error('Error cleaning temp files:', err.message);
  }
}, 15 * 60 * 1000);

// Helper: Format seconds to HH:MM:SS
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper: Parse HH:MM:SS or seconds string to seconds number
function parseTimeToSeconds(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const str = val.toString().trim();
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  return parseFloat(str) || 0;
}

// Helper: Format numbers to compact strings
function formatViews(num) {
  if (!num || isNaN(num)) return 'N/A';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M views';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K views';
  return num.toLocaleString() + ' views';
}

// Helper: Format file sizes
function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return 'Estimating...';
  if (bytes < 1024 * 1024) {
    return `~ ${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `~ ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `~ ${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Helper: Sanitize filenames for HTTP headers
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: Get safe RFC-compliant Content-Disposition header
function getSafeFilenameHeader(rawTitle, ext) {
  const safeAscii = (rawTitle || 'download')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\;:\/|?*<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'download';
  
  const encoded = encodeURIComponent((rawTitle || 'download').replace(/[\/\\?%*:|"<>]/g, '_').trim() || 'download');
  return `attachment; filename="${safeAscii}.${ext}"; filename*=UTF-8''${encoded}.${ext}`;
}

// Helper: Send SSE event to a specific job client
function sendJobEvent(jobId, data) {
  const client = sseClients.get(jobId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Helper: Extract YouTube video ID
function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?\/\s]{11})/i);
  return match ? match[1] : '';
}

// Endpoint: Fetch video information
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  const cleanUrl = url.trim();

  const isYouTube = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)/i.test(cleanUrl);
  if (!isYouTube) {
    return res.status(400).json({ error: 'Please enter a valid YouTube or YouTube Shorts link.' });
  }

  const videoId = extractVideoId(cleanUrl);
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : cleanUrl;

  const makeArgs = (client) => [
    ...buildBaseArgs(client),
    '--dump-single-json',
    '--skip-download',
    targetUrl
  ];

  runYtDlpWithFallback(makeArgs, { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr, client) => {
    if (err) {
      console.error('yt-dlp info error:', stderr);
      // `error` is the only field the UI renders. `details` carries the raw
      // yt-dlp tail so a failure can be diagnosed against the live backend
      // without shell access to the container.
      return res.status(400).json({
        error: describeYtDlpError(stderr),
        details: String(stderr || '').trim().slice(-600)
      });
    }
    console.log(`[info] resolved via player client "${client}"`);

    try {
      const data = JSON.parse(stdout);
      const durationSec = (data.duration && typeof data.duration === 'number') ? data.duration : 180;

      const availableHeights = new Set();
      let bestPlayableUrl = '';

      if (Array.isArray(data.formats)) {
        data.formats.forEach(f => {
          if (f.height && typeof f.height === 'number') {
            availableHeights.add(f.height);
          }
          if (!bestPlayableUrl && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none' && f.url && f.height <= 720) {
            bestPlayableUrl = f.url;
          }
        });
      }

      const audioBitrates = [320, 256, 192, 128].map((kbps) => {
        const bytes = Math.round(durationSec * ((kbps * 1000) / 8));
        return { label: `${kbps} kbps`, quality: String(kbps), size: formatFileSize(bytes), bytes };
      });

      function estimateVideoSize(targetHeight, duration) {
        let matchedVideoFormat = null;
        let matchedAudioFormat = null;

        if (Array.isArray(data.formats)) {
          // Prioritize actual AVC1/MP4 formats that yt-dlp downloads with real filesize
          const videoCandidates = data.formats.filter(f => f.height && f.height <= targetHeight && f.vcodec && f.vcodec !== 'none');
          if (videoCandidates.length > 0) {
            videoCandidates.sort((a, b) => {
              if (b.height !== a.height) return b.height - a.height;
              const aHasSize = (a.filesize || a.filesize_approx) ? 1 : 0;
              const bHasSize = (b.filesize || b.filesize_approx) ? 1 : 0;
              if (bHasSize !== aHasSize) return bHasSize - aHasSize;
              const aIsAvc = (a.vcodec && a.vcodec.startsWith('avc1')) ? 1 : 0;
              const bIsAvc = (b.vcodec && b.vcodec.startsWith('avc1')) ? 1 : 0;
              if (bIsAvc !== aIsAvc) return bIsAvc - aIsAvc;
              return (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0);
            });
            matchedVideoFormat = videoCandidates[0];
          }

          // Prioritize standard AAC/M4A audio track
          const audioCandidates = data.formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
          if (audioCandidates.length > 0) {
            audioCandidates.sort((a, b) => {
              const aHasSize = (a.filesize || a.filesize_approx) ? 1 : 0;
              const bHasSize = (b.filesize || b.filesize_approx) ? 1 : 0;
              if (bHasSize !== aHasSize) return bHasSize - aHasSize;
              const aIsAac = (a.acodec && a.acodec.startsWith('mp4a')) ? 1 : 0;
              const bIsAac = (b.acodec && b.acodec.startsWith('mp4a')) ? 1 : 0;
              if (bIsAac !== aIsAac) return bIsAac - aIsAac;
              return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
            });
            matchedAudioFormat = audioCandidates[0];
          }
        }

        let videoBytes = null;
        if (matchedVideoFormat) {
          if (matchedVideoFormat.filesize && matchedVideoFormat.filesize > 0) {
            videoBytes = matchedVideoFormat.filesize;
          } else if (matchedVideoFormat.filesize_approx && matchedVideoFormat.filesize_approx > 0) {
            videoBytes = matchedVideoFormat.filesize_approx;
          } else if (matchedVideoFormat.vbr && matchedVideoFormat.vbr > 0) {
            videoBytes = (matchedVideoFormat.vbr * 1000 / 8) * duration;
          } else if (matchedVideoFormat.tbr && matchedVideoFormat.tbr > 0) {
            videoBytes = (matchedVideoFormat.tbr * 1000 / 8) * duration;
          }
        }

        if (!videoBytes || videoBytes <= 0) {
          const bitrateMap = {
            2160: 12000000,
            1440: 6000000,
            1080: 2500000,
            720: 1200000,
            480: 600000,
            360: 350000
          };
          const b = bitrateMap[targetHeight] || 2500000;
          videoBytes = (duration * b) / 8;
        }

        let audioBytes = 0;
        if (matchedVideoFormat && matchedVideoFormat.acodec === 'none') {
          if (matchedAudioFormat && matchedAudioFormat.filesize && matchedAudioFormat.filesize > 0) {
            audioBytes = matchedAudioFormat.filesize;
          } else if (matchedAudioFormat && matchedAudioFormat.filesize_approx && matchedAudioFormat.filesize_approx > 0) {
            audioBytes = matchedAudioFormat.filesize_approx;
          } else if (matchedAudioFormat && (matchedAudioFormat.abr || matchedAudioFormat.tbr)) {
            audioBytes = ((matchedAudioFormat.abr || matchedAudioFormat.tbr || 128) * 1000 / 8) * duration;
          } else {
            audioBytes = duration * (128000 / 8);
          }
        }

        const totalBytes = videoBytes + audioBytes;

        return {
          formatted: formatFileSize(totalBytes),
          bytes: Math.round(totalBytes)
        };
      }

      const buildResolution = (height, label) => {
        const s = estimateVideoSize(height, durationSec);
        return { height, label, quality: String(height), size: s.formatted, rawBytes: s.bytes };
      };

      const standardResolutions = [
        buildResolution(1080, '1080p (Full HD)'),
        buildResolution(720, '720p (HD)'),
        buildResolution(480, '480p (SD)'),
        buildResolution(360, '360p (Data Saver)')
      ];

      const tallest = availableHeights.size ? Math.max(...availableHeights) : 1080;
      const ceiling = Math.min(1080, tallest);

      let supportedResolutions = standardResolutions.filter(r => r.height <= ceiling);

      if (supportedResolutions.length === 0) {
        supportedResolutions = [buildResolution(tallest, `${tallest}p`)];
      }

      let nativeWidth = (data.width && typeof data.width === 'number') ? data.width : null;
      let nativeHeight = (data.height && typeof data.height === 'number') ? data.height : null;

      if (!nativeWidth || !nativeHeight) {
        if (Array.isArray(data.formats)) {
          data.formats.forEach(f => {
            if (f.width && f.height && f.vcodec !== 'none') {
              if (!nativeWidth || f.width > nativeWidth) nativeWidth = f.width;
              if (!nativeHeight || f.height > nativeHeight) nativeHeight = f.height;
            }
          });
        }
      }
      nativeWidth = nativeWidth || 1920;
      nativeHeight = nativeHeight || 1080;

      res.json({
        id: data.id,
        videoId: videoId || data.id,
        title: data.title || 'YouTube Video',
        uploader: data.uploader || data.channel || 'Unknown Creator',
        duration: formatDuration(data.duration),
        duration_raw: data.duration || 180,
        thumbnail: data.thumbnail || (data.thumbnails && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1].url : ''),
        views: formatViews(data.view_count),
        upload_date: data.upload_date ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` : '',
        url: cleanUrl,
        width: nativeWidth,
        height: nativeHeight,
        aspect_ratio: data.aspect_ratio || (nativeWidth / nativeHeight),
        fps: data.fps || 30,
        preview_url: bestPlayableUrl || `/api/stream-preview?url=${encodeURIComponent(cleanUrl)}`,
        resolutions: supportedResolutions,
        audio_qualities: audioBitrates
      });
    } catch (parseErr) {
      console.error('Failed to parse yt-dlp json:', parseErr);
      res.status(500).json({ error: 'Failed to parse video details.' });
    }
  });
});

// Endpoint: Stream direct video preview fallback
app.get('/api/stream-preview', (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).send('Please provide a valid video URL.');
  }
  const videoId = extractVideoId(url);
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url.trim();

  const makeArgs = (client) => [
    ...buildBaseArgs(client),
    '-f', 'best[height<=720][ext=mp4]/best[height<=720]/b/best',
    '-g',
    targetUrl
  ];

  runYtDlpWithFallback(makeArgs, { timeout: 30000 }, (err, stdout) => {
    if (err) return res.status(502).send('Could not extract preview stream URL.');
    const directUrl = stdout.trim().split(/\r?\n/)[0];
    if (directUrl) return res.redirect(directUrl);
    res.status(404).send('Preview stream not found.');
  });
});

// Endpoint: Server-Sent Events (SSE) for real-time progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.set(jobId, res);

  if (activeJobs.has(jobId)) {
    const job = activeJobs.get(jobId);
    res.write(`data: ${JSON.stringify(job.lastStatus || { status: 'starting', percent: 0 })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(jobId);
  });
});

// Endpoint: Fast, High-Quality Clip Trim & Download with Real-Time Progress Tracking
app.post('/api/convert-trim', (req, res) => {
  const {
    url,
    format = 'mp4',
    quality = '1080',
    startTime = 0,
    endTime = 0,
    title = 'Clip'
  } = req.body;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Please provide a valid video link.' });
  }

  const startSec = Math.max(0, parseTimeToSeconds(startTime));
  const endSec = parseTimeToSeconds(endTime);

  if (!(endSec > startSec)) {
    return res.status(400).json({ error: 'The clip end time must come after the start time.' });
  }

  const isAudio = String(format).toLowerCase() === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const clipSeconds = endSec - startSec;

  if (!acquireJobSlot()) {
    return res.status(503).json({
      error: 'The server is busy with other downloads right now. Please try again in a few seconds.'
    });
  }

  const jobId = 'trim_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const finalOutputFile = path.join(TEMP_DIR, `${jobId}.${ext}`);

  const startClock = formatDuration(startSec);
  const endClock = formatDuration(endSec);
  const heightVal = parseInt(quality, 10) || 1080;

  // Describe what was actually requested. This used to say "1080p" regardless of
  // the chosen quality, so a 720p clip reported itself as 1080p all the way through.
  const qualityLabel = isAudio ? 'audio' : `${heightVal}p`;

  const jobData = {
    id: jobId,
    format: ext,
    url: url.trim(),
    quality,
    status: 'downloading',
    percent: 5,
    startTime: Date.now(),
    lastStatus: { status: 'downloading', percent: 5, text: `Downloading ${qualityLabel} clip...` }
  };

  activeJobs.set(jobId, jobData);
  res.json({ jobId });

  // Single-pass high speed section download with yt-dlp & ffmpeg
  const videoId = extractVideoId(url);
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url.trim();

  const ytdlArgs = [
    ...buildBaseArgs(CLIENT_CHAIN[0]),
    '--newline',
    '--concurrent-fragments', '5',
    '--download-sections', `*${startClock}-${endClock}`,
    '--force-keyframes-at-cuts',
  ];
  if (ffmpegPath) {
    ytdlArgs.push('--ffmpeg-location', ffmpegPath);
  }

  if (isAudio) {
    const audioBitrate = String(quality).replace(/\D/g, '') || '320';
    ytdlArgs.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${audioBitrate}k`,
      '-o', finalOutputFile
    );
  } else {
    ytdlArgs.push(
      '-f', `bestvideo[height<=?${heightVal}]+bestaudio/best[height<=?${heightVal}]/best`,
      '--merge-output-format', 'mp4',
      '-o', finalOutputFile
    );
  }

  ytdlArgs.push(targetUrl);

  console.log(`[Job ${jobId}] Starting Clip Download (${startClock} to ${endClock}):`, ytdlArgs.join(' '));
  const dlProc = spawn(ytDlpPath, ytdlArgs);

  dlProc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const dlMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
      if (dlMatch) {
        const percent = Math.min(99, Math.round(parseFloat(dlMatch[1])));
        jobData.lastStatus = {
          status: 'downloading',
          percent,
          text: `Downloading ${qualityLabel} clip: ${percent}%`
        };
        sendJobEvent(jobId, jobData.lastStatus);
      }
    }
  });

  // Track FFmpeg time progress from stderr during section extraction
  dlProc.stderr.on('data', (chunk) => {
    const str = chunk.toString();
    const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch && clipSeconds > 0) {
      const curSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
      const percent = Math.min(99, Math.max(5, Math.round((curSec / clipSeconds) * 100)));
      jobData.lastStatus = {
        status: 'downloading',
        percent,
        text: `Processing ${qualityLabel} clip: ${percent}% (${Math.round(curSec)}s / ${clipSeconds}s)`
      };
      sendJobEvent(jobId, jobData.lastStatus);
    }
  });

  // A failed spawn emits both 'error' and 'close', so release through a latch
  // rather than from each handler -- double-releasing would inflate the free
  // slot count and defeat the concurrency cap.
  let slotFreed = false;
  const freeSlot = () => {
    if (slotFreed) return;
    slotFreed = true;
    releaseJobSlot();
  };

  dlProc.on('error', (err) => {
    console.error(`[Job ${jobId}] yt-dlp spawn error:`, err);
    freeSlot();
    jobData.lastStatus = { status: 'error', message: 'Could not start the clip download.' };
    sendJobEvent(jobId, jobData.lastStatus);
  });

  dlProc.on('close', (dlCode) => {
    freeSlot();
    // Check if yt-dlp saved under the expected or part filename
    let finalFile = fs.existsSync(finalOutputFile) ? finalOutputFile : null;
    if (!finalFile) {
      const stray = fs.readdirSync(TEMP_DIR).find((f) => f.startsWith(jobId) && !f.endsWith('.part'));
      if (stray) finalFile = path.join(TEMP_DIR, stray);
    }

    if (dlCode !== 0 || !finalFile || !fs.existsSync(finalFile)) {
      console.error(`[Job ${jobId}] Clip download failed with code ${dlCode}`);
      jobData.lastStatus = {
        status: 'error',
        message: 'Could not complete the clip extraction. Check your connection and try again.'
      };
      sendJobEvent(jobId, jobData.lastStatus);
      return;
    }

    const stat = fs.statSync(finalFile);
    const size = formatFileSize(stat.size);

    jobData.fileName = `${jobId}.${ext}`;
    jobData.filePath = finalFile;
    jobData.fileSize = size;
    jobData.lastStatus = {
      status: 'completed',
      percent: 100,
      jobId,
      fileName: `${jobId}.${ext}`,
      size,
      downloadUrl: `/api/download/${jobId}?title=${encodeURIComponent(title || 'Clip')}`,
      text: `Clip ready · ${size}`
    };
    sendJobEvent(jobId, jobData.lastStatus);
  });
});

// Endpoint: Ultra Fast Full Video/Audio Download with Real-Time Progress Tracking
app.post('/api/convert-full', (req, res) => {
  const {
    url,
    format = 'mp4',
    quality = '1080',
    title = 'Download'
  } = req.body;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Please provide a valid video link.' });
  }

  const isAudio = String(format).toLowerCase() === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';

  if (!acquireJobSlot()) {
    return res.status(503).json({
      error: 'The server is busy with other downloads right now. Please try again in a few seconds.'
    });
  }

  const jobId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const finalOutputFile = path.join(TEMP_DIR, `${jobId}.${ext}`);
  const heightVal = parseInt(quality, 10) || 1080;
  const qualityLabel = isAudio ? 'audio' : `${heightVal}p`;

  const jobData = {
    id: jobId,
    format: ext,
    url: url.trim(),
    quality,
    status: 'downloading',
    percent: 5,
    startTime: Date.now(),
    lastStatus: { status: 'downloading', percent: 5, text: `Downloading ${qualityLabel}...` }
  };

  activeJobs.set(jobId, jobData);
  res.json({ jobId });

  const videoId = extractVideoId(url);
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url.trim();

  const ytdlArgs = [
    ...buildBaseArgs(CLIENT_CHAIN[0]),
    '--newline',
    '--concurrent-fragments', '5',
  ];
  if (ffmpegPath) {
    ytdlArgs.push('--ffmpeg-location', ffmpegPath);
  }

  if (isAudio) {
    const audioBitrate = String(quality).replace(/\D/g, '') || '320';
    ytdlArgs.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${audioBitrate}k`,
      '-o', finalOutputFile
    );
  } else {
    ytdlArgs.push(
      '-f', `bestvideo[height<=?${heightVal}]+bestaudio/best[height<=?${heightVal}]/best`,
      '--merge-output-format', 'mp4',
      '-o', finalOutputFile
    );
  }

  ytdlArgs.push(targetUrl);

  console.log(`[Job ${jobId}] Starting Full High-Speed Download (${qualityLabel}):`, ytdlArgs.join(' '));
  const dlProc = spawn(ytDlpPath, ytdlArgs);

  dlProc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const dlMatch = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
      if (dlMatch) {
        const percent = Math.min(99, Math.round(parseFloat(dlMatch[1])));
        jobData.lastStatus = {
          status: 'downloading',
          percent,
          text: `Downloading ${qualityLabel}: ${percent}%`
        };
        sendJobEvent(jobId, jobData.lastStatus);
      }
    }
  });

  dlProc.stderr.on('data', (chunk) => {
    const str = chunk.toString();
    const dlMatch = str.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
    if (dlMatch) {
      const percent = Math.min(99, Math.round(parseFloat(dlMatch[1])));
      jobData.lastStatus = {
        status: 'downloading',
        percent,
        text: `Downloading ${qualityLabel}: ${percent}%`
      };
      sendJobEvent(jobId, jobData.lastStatus);
    }
  });

  let slotFreed = false;
  const freeSlot = () => {
    if (slotFreed) return;
    slotFreed = true;
    releaseJobSlot();
  };

  dlProc.on('error', (err) => {
    console.error(`[Job ${jobId}] yt-dlp spawn error:`, err);
    freeSlot();
    jobData.lastStatus = { status: 'error', message: 'Could not start the download.' };
    sendJobEvent(jobId, jobData.lastStatus);
  });

  dlProc.on('close', (dlCode) => {
    freeSlot();
    let finalFile = fs.existsSync(finalOutputFile) ? finalOutputFile : null;
    if (!finalFile) {
      const stray = fs.readdirSync(TEMP_DIR).find((f) => f.startsWith(jobId) && !f.endsWith('.part'));
      if (stray) finalFile = path.join(TEMP_DIR, stray);
    }

    if (dlCode !== 0 || !finalFile || !fs.existsSync(finalFile)) {
      console.error(`[Job ${jobId}] Download failed with code ${dlCode}`);
      jobData.lastStatus = {
        status: 'error',
        message: 'Could not complete the download. Check your connection and try again.'
      };
      sendJobEvent(jobId, jobData.lastStatus);
      return;
    }

    const stat = fs.statSync(finalFile);
    const size = formatFileSize(stat.size);

    jobData.fileName = `${jobId}.${ext}`;
    jobData.filePath = finalFile;
    jobData.fileSize = size;
    jobData.lastStatus = {
      status: 'completed',
      percent: 100,
      jobId,
      fileName: `${jobId}.${ext}`,
      size,
      downloadUrl: `/api/download/${jobId}?title=${encodeURIComponent(title || 'Download')}`,
      text: `Ready · ${size}`
    };
    sendJobEvent(jobId, jobData.lastStatus);
  });
});

// Endpoint: Direct streaming download (no trim) — MP3 or MP4
app.get('/api/download', (req, res) => {
  const { url, format = 'mp3', quality = '320', title } = req.query;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).send('Please provide a valid YouTube link.');
  }

  const cleanUrl = url.trim();
  const videoId = extractVideoId(cleanUrl);
  const targetUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : cleanUrl;
  const isMp3 = String(format).toLowerCase() === 'mp3';
  const ext = isMp3 ? 'mp3' : 'mp4';
  const rawTitle = title || 'YouTube_Download';

  if (!acquireJobSlot()) {
    res.setHeader('Retry-After', '30');
    return res.status(503).send('The server is busy with other downloads right now. Please try again in a few seconds.');
  }
  // The slot covers the whole request, retries included. Both events fire on
  // every exit path, so release exactly once from whichever lands first.
  let slotReleased = false;
  const releaseOnce = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseJobSlot();
  };
  res.on('close', releaseOnce);
  res.on('finish', releaseOnce);

  // Response headers are deliberately NOT set yet. This is a browser-initiated
  // navigation, so once a byte goes out we are committed to that response and
  // can no longer fall back to another player client. We hold the headers until
  // ffmpeg produces real output, which lets a failed attempt retry silently.
  let clientAborted = false;
  req.on('close', () => { clientAborted = true; });

  const attempt = (index) => {
    if (clientAborted) return;

    if (index >= CLIENT_CHAIN.length) {
      console.error(`Direct download failed for "${rawTitle}" on every player client`);
      if (!res.headersSent) {
        res.status(502).send('Could not download this video right now. Please wait a minute and try again.');
      } else {
        res.end();
      }
      return;
    }

    const client = CLIENT_CHAIN[index];
    const ytdlArgs = [...buildBaseArgs(client)];
    if (ffmpegPath) {
      ytdlArgs.push('--ffmpeg-location', ffmpegPath);
    }
    let ffmpegArgs;

    if (isMp3) {
      const bitrate = String(quality).replace(/\D/g, '') || '320';
      ytdlArgs.push('-f', 'bestaudio/best');
      ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', '0', '-i', 'pipe:0',
        '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-f', 'mp3', 'pipe:1'];
    } else {
      const heightVal = parseInt(quality, 10);
      const cap = !isNaN(heightVal) && heightVal > 0 ? `[height<=?${heightVal}]` : '';
      ytdlArgs.push(
        '-f', `bestvideo${cap}[vcodec^=avc1][protocol^=http]+bestaudio[acodec^=mp4a][protocol^=http]/bestvideo${cap}[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best${cap}[vcodec^=avc1]/best${cap}[ext=mp4]/best`
      );
      ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-threads', '0', '-i', 'pipe:0',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1'];
    }

    ytdlArgs.push('-o', '-', targetUrl);

    console.log(`Direct download "${rawTitle}" (${ext}) via client "${client}"`);

    const dlProc = spawn(ytDlpPath, ytdlArgs);
    const ffProc = spawn(ffmpegPath, ffmpegArgs);

    let streaming = false;
    let settled = false;
    let lastError = '';

    const stop = () => {
      for (const proc of [dlProc, ffProc]) {
        if (proc && !proc.killed) {
          try { proc.kill('SIGKILL'); } catch (e) {}
        }
      }
    };

    // Called once per attempt, whichever way it ends.
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      stop();
      if (clientAborted) return;

      if (ok) {
        res.end();
      } else if (streaming) {
        // Bytes are already on the wire, so neither a retry nor an error status
        // is possible. Destroy the connection rather than end() it: a clean end
        // looks like a completed download and would quietly hand the user a
        // truncated file. Aborting makes the browser flag it as failed.
        console.error(`[download] stream died mid-transfer: ${lastError.slice(-200)}`);
        res.destroy();
      } else {
        console.warn(`[download] client "${client}" produced no data: ${lastError.slice(-200)}`);
        attempt(index + 1);
      }
    };

    dlProc.stdout.pipe(ffProc.stdin);

    // The moment ffmpeg emits its first byte we know the pipeline is healthy,
    // so commit the headers and stream the rest straight through.
    ffProc.stdout.once('data', (first) => {
      if (clientAborted) return;
      streaming = true;
      res.setHeader('Content-Disposition', getSafeFilenameHeader(rawTitle, ext));
      res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.write(first);
      ffProc.stdout.pipe(res, { end: false });
    });

    dlProc.stderr.on('data', (c) => {
      const text = c.toString();
      lastError += text;
      console.log('[direct yt-dlp]:', text.trim());
    });
    ffProc.stderr.on('data', (c) => {
      const text = c.toString();
      lastError += text;
      console.log('[direct ffmpeg]:', text.trim());
    });

    dlProc.stdin.on('error', () => {});
    ffProc.stdin.on('error', () => {});
    dlProc.stdout.on('error', () => {});

    dlProc.on('error', (err) => { lastError += `yt-dlp spawn: ${err.message}`; settle(false); });
    ffProc.on('error', (err) => { lastError += `ffmpeg spawn: ${err.message}`; settle(false); });

    ffProc.on('close', (code) => {
      console.log(`Direct download attempt finished (ffmpeg exit ${code}, streamed=${streaming})`);
      settle(code === 0 && streaming);
    });

    req.on('close', () => { stop(); });
  };

  attempt(0);
});

// Endpoint: Download the converted file by jobId
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const customTitle = req.query.title ? sanitizeFilename(req.query.title) : null;

  try {
    const files = fs.readdirSync(TEMP_DIR);
    const matchedFile = files.find(f => f.startsWith(jobId) && !f.endsWith('.part'));

    if (!matchedFile) {
      return res.status(404).send('Download file not found or has expired. Please try again.');
    }

    const filePath = path.join(TEMP_DIR, matchedFile);
    const ext = path.extname(matchedFile);
    const downloadName = customTitle ? `${customTitle}${ext}` : matchedFile;

    res.download(filePath, downloadName, (err) => {
      if (err) {
        console.error('Error during file transfer:', err.message);
      }
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            activeJobs.delete(jobId);
          }
        } catch (e) {}
      }, 120000);
    });
  } catch (err) {
    console.error('Download route error:', err);
    res.status(500).send('Internal server error while serving file.');
  }
});

// Endpoint: Health status
// Probe both binaries by actually running them. Checking only that a file
// exists reports "healthy" for a binary that cannot execute, which is exactly
// the failure this endpoint exists to catch. Results are cached so the
// keep-alive ping stays cheap.
let healthCache = { at: 0, payload: null };

// yt-dlp is a Python zip, and its first run on a cold 0.1-CPU instance can take
// well over a minute. A short timeout here reports a perfectly good binary as
// missing, which the frontend then refuses to work against -- so be patient.
const PROBE_TIMEOUT_MS = 45000;

function probeBinary(bin, args, cb) {
  execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    cb(!err, (stdout || '').toString().trim().split(/\r?\n/)[0] || '');
  });
}

function runProbes(cb) {
  probeBinary(ytDlpPath, ['--version'], (ytOk, ytVersion) => {
    probeBinary(ffmpegPath, ['-version'], (ffOk, ffVersion) => {
      const probes = {
        ytOk,
        ffOk,
        ytVersion,
        ffVersion: ffVersion ? ffVersion.replace(/^ffmpeg version /, '').split(' ')[0] : null
      };
      // Cache a healthy result, but let a failure expire almost immediately:
      // during a cold start the answer is "not yet", not "broken", and pinning
      // that for a full minute is what keeps users locked out the longest.
      healthCache = { at: Date.now(), payload: probes, ttl: ytOk && ffOk ? 60000 : 5000 };
      cb(probes);
    });
  });
}

// Pay the interpreter's first-run cost at boot instead of making the first real
// visitor wait for it.
runProbes((p) => console.log(`[boot] yt-dlp=${p.ytOk ? p.ytVersion : 'FAILED'} ffmpeg=${p.ffOk ? p.ffVersion : 'FAILED'}`));

app.get('/api/status', (req, res) => {
  // Only the binary probes are cached -- they cost two process spawns and never
  // change between deploys. Live counters are always computed fresh, because the
  // client uses activeJobs to decide whether a slot is free before starting a
  // download, and a stale count there would be worse than useless.
  const respond = (probes) => {
    res.json({
      status: 'online',
      ytDlpAvailable: probes.ytOk,
      ffmpegAvailable: probes.ffOk,
      ytDlpVersion: probes.ytVersion || null,
      ffmpegVersion: probes.ffVersion || null,
      jsRuntime: jsRuntimeArgs.length ? jsRuntimeArgs[1] : null,
      cookies: fs.existsSync(cookiesFilePath),
      clients: CLIENT_CHAIN,
      activeJobs: activeHeavyJobs,
      maxJobs: MAX_CONCURRENT_JOBS,
      uptime: Math.round(process.uptime())
    });
  };

  if (healthCache.payload && Date.now() - healthCache.at < (healthCache.ttl || 60000)) {
    return respond(healthCache.payload);
  }

  runProbes(respond);
});

// YouTube changes constantly, so a yt-dlp binary goes stale within weeks. The
// container refreshes it at boot, but the keep-alive ping means it may never
// cold-start again, so refresh on a timer too rather than relying on deploys.
function refreshYtDlp() {
  if (process.env.YTDLP_AUTO_UPDATE === '0') return;
  if (process.platform === 'win32') return; // local dev: the bundled .exe is yours to manage
  execFile(ytDlpPath, ['-U'], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`.trim().slice(-200);
    if (err) console.warn('[yt-dlp] self-update skipped:', out || err.message);
    else console.log('[yt-dlp] self-update:', out);
    healthCache = { at: 0, payload: null };
  });
}
setInterval(refreshYtDlp, 12 * 60 * 60 * 1000);

// Start listening
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  YT Downloader running at:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`=================================================`);
});
