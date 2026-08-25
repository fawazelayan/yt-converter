const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

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

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// In-memory store for conversion jobs and SSE connections
const activeJobs = new Map();
const sseClients = new Map();

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

  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    cleanUrl
  ];

  execFile(ytDlpPath, args, { maxBuffer: 25 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp info error:', stderr || err.message);
      let userMsg = 'Could not find this video. Please make sure the video is public and the URL is correct.';
      if ((stderr || '').includes('Private video')) userMsg = 'This video is private and cannot be downloaded.';
      if ((stderr || '').includes('Video unavailable')) userMsg = 'This video is unavailable or has been removed.';
      if ((stderr || '').includes('is not a valid URL')) userMsg = 'Invalid YouTube URL provided.';
      return res.status(400).json({ error: userMsg, details: stderr || err.message });
    }

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
        const bytes = durationSec * ((kbps * 1000) / 8) + 120000;
        return { label: `${kbps} kbps`, quality: String(kbps), size: formatFileSize(bytes), bytes: Math.round(bytes) };
      });

      function estimateVideoSize(targetHeight, duration) {
        let matchedVideoFormat = null;
        let matchedAudioFormat = null;

        if (Array.isArray(data.formats)) {
          const videoCandidates = data.formats.filter(f => f.height && f.height <= targetHeight && f.vcodec !== 'none');
          if (videoCandidates.length > 0) {
            videoCandidates.sort((a, b) => {
              if (b.height !== a.height) return b.height - a.height;
              return (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0);
            });
            matchedVideoFormat = videoCandidates[0];
          }

          const audioCandidates = data.formats.filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none');
          if (audioCandidates.length > 0) {
            audioCandidates.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
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
            2160: 16000000,
            1440: 8000000,
            1080: 3500000,
            720: 1800000,
            480: 900000,
            360: 450000
          };
          const b = bitrateMap[targetHeight] || 3500000;
          videoBytes = (duration * b) / 8;
        }

        let audioBytes = 0;
        if (matchedVideoFormat && matchedVideoFormat.acodec === 'none') {
          if (matchedAudioFormat && matchedAudioFormat.filesize) {
            audioBytes = matchedAudioFormat.filesize;
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

  const args = [
    '--no-playlist',
    '--no-warnings',
    '-f', 'best[height<=720][ext=mp4]/best[height<=720]/b/best',
    '-g',
    url.trim()
  ];

  execFile(ytDlpPath, args, { timeout: 15000 }, (err, stdout) => {
    if (err || !stdout.trim()) {
      execFile(ytDlpPath, ['--no-playlist', '--no-warnings', '-g', url.trim()], { timeout: 15000 }, (fbErr, fbStdout) => {
        if (fbErr || !fbStdout.trim()) {
          return res.status(500).send('Could not extract preview stream URL.');
        }
        const directUrl = fbStdout.trim().split('\n')[0];
        if (directUrl) return res.redirect(directUrl);
        res.status(404).send('Preview stream not found.');
      });
      return;
    }
    const directUrl = stdout.trim().split('\n')[0];
    if (directUrl) {
      return res.redirect(directUrl);
    }
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

  const jobId = 'trim_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const finalOutputFile = path.join(TEMP_DIR, `${jobId}.${ext}`);

  const jobData = {
    id: jobId,
    format: ext,
    url: url.trim(),
    quality,
    status: 'downloading',
    percent: 5,
    startTime: Date.now(),
    lastStatus: { status: 'downloading', percent: 5, text: `Downloading ${isAudio ? 'audio' : '1080p video'} clip...` }
  };

  activeJobs.set(jobId, jobData);
  res.json({ jobId });

  const startClock = formatDuration(startSec);
  const endClock = formatDuration(endSec);
  const heightVal = parseInt(quality, 10) || 1080;

  // Single-pass high speed section download with yt-dlp & ffmpeg
  const ytdlArgs = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--ffmpeg-location', ffmpegPath,
    '--download-sections', `*${startClock}-${endClock}`
  ];

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

  ytdlArgs.push(url.trim());

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
          text: `Downloading ${isAudio ? 'audio' : '1080p'} clip: ${percent}%`
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
        text: `Processing 1080p clip: ${percent}% (${Math.round(curSec)}s / ${clipSeconds}s)`
      };
      sendJobEvent(jobId, jobData.lastStatus);
    }
  });

  dlProc.on('error', (err) => {
    console.error(`[Job ${jobId}] yt-dlp spawn error:`, err);
    jobData.lastStatus = { status: 'error', message: 'Could not start the clip download.' };
    sendJobEvent(jobId, jobData.lastStatus);
  });

  dlProc.on('close', (dlCode) => {
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

// Endpoint: Direct streaming download (no trim) — MP3 or MP4
app.get('/api/download', (req, res) => {
  const { url, format = 'mp3', quality = '320', title } = req.query;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).send('Please provide a valid YouTube link.');
  }

  const cleanUrl = url.trim();
  const isMp3 = String(format).toLowerCase() === 'mp3';
  const ext = isMp3 ? 'mp3' : 'mp4';
  const rawTitle = title || 'YouTube_Download';

  res.setHeader('Content-Disposition', getSafeFilenameHeader(rawTitle, ext));
  res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');

  const ytdlArgs = ['--no-playlist', '--no-warnings', '--ffmpeg-location', ffmpegPath];
  let ffmpegArgs;

  if (isMp3) {
    const bitrate = String(quality).replace(/\D/g, '') || '320';
    ytdlArgs.push('-f', 'bestaudio/best');
    ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-f', 'mp3', 'pipe:1'];
  } else {
    const heightVal = parseInt(quality, 10);
    const cap = !isNaN(heightVal) && heightVal > 0 ? `[height<=?${heightVal}]` : '';
    ytdlArgs.push(
      '-f', `bestvideo${cap}[vcodec^=avc1][protocol^=http]+bestaudio[acodec^=mp4a][protocol^=http]/bestvideo${cap}[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best${cap}[vcodec^=avc1]/best${cap}[ext=mp4]/best`
    );
    ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1'];
  }

  ytdlArgs.push('-o', '-', cleanUrl);

  console.log(`Direct download "${rawTitle}" (${ext}):`, ytdlArgs.join(' '));

  const dlProc = spawn(ytDlpPath, ytdlArgs);
  const ffProc = spawn(ffmpegPath, ffmpegArgs);

  dlProc.stdout.pipe(ffProc.stdin);
  ffProc.stdout.pipe(res);

  dlProc.stderr.on('data', (c) => console.log('[direct yt-dlp]:', c.toString().trim()));
  ffProc.stderr.on('data', (c) => console.log('[direct ffmpeg]:', c.toString().trim()));

  dlProc.stdin.on('error', () => {});
  ffProc.stdin.on('error', () => {});

  const stop = () => {
    for (const proc of [dlProc, ffProc]) {
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch (e) {}
      }
    }
  };

  const fail = (message) => {
    console.error('Direct download error:', message);
    stop();
    if (!res.headersSent) res.status(500).send('Could not complete this download.');
    else res.end();
  };

  dlProc.on('error', (err) => fail(`yt-dlp: ${err.message}`));
  ffProc.on('error', (err) => fail(`ffmpeg: ${err.message}`));

  ffProc.on('close', (code) => {
    console.log(`Direct download finished (ffmpeg exit ${code})`);
    stop();
    res.end();
  });

  req.on('close', stop);
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
app.get('/api/status', (req, res) => {
  let ytDlpAvailable = false;
  if (fs.existsSync(ytDlpPath)) {
    ytDlpAvailable = true;
  } else {
    try {
      const { execFileSync } = require('child_process');
      execFileSync(ytDlpPath, ['--version'], { stdio: 'ignore' });
      ytDlpAvailable = true;
    } catch (e) {
      ytDlpAvailable = false;
    }
  }

  res.json({
    status: 'online',
    ytDlpAvailable,
    ffmpegAvailable: !!ffmpegPath && fs.existsSync(ffmpegPath)
  });
});

// Start listening
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  YT Downloader running at:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`=================================================`);
});
