# 🎬 YT Downloader & Converter

A modern, fast, and private YouTube to MP3 / MP4 converter with custom video trimming capabilities, live progress tracking, and estimated file size calculation.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Ready-brightgreen.svg)

---

## ✨ Features

- 🎵 **MP3 Audio Extraction**: Convert YouTube videos to high-quality MP3 audio (320kbps, 256kbps, 192kbps, 128kbps).
- 🎥 **MP4 Video Download**: Download videos up to 1080p Full HD with real-time format and stream detection.
- ✂️ **Built-in Segment Trimmer**: Preview the video in-browser, set start and end timestamps, and crop/trim audio or video before downloading.
- 📊 **Live Progress & SSE**: Real-time conversion percentage and status updates.
- 💾 **Estimated File Sizes**: Shows real file size estimates for audio and video resolutions before starting the download.
- 🕒 **Local Download History**: Remembers your recent downloads locally in your browser.
- 🌐 **GitHub Pages + Cloud Backend Ready**: Host the frontend on GitHub Pages and connect to your free cloud backend (Render/Railway/Docker).
- 🔒 **Private & Ad-Free**: No third-party ads, no popups, no telemetry, no middleman servers.

---

## 🌐 Running on GitHub Pages

The frontend is live at **https://fawazelayan.github.io/yt-converter/** and needs no setup
from whoever opens it. Paste a link, pick a format, download. There is no backend URL to
configure — the page detects that it is running on Pages and points itself at the cloud
backend automatically.

1. Repo **Settings → Pages → Source** = **GitHub Actions**.
2. `.github/workflows/deploy.yml` publishes `public/` on every push to `main`.

The backend URL lives in one constant, `DEFAULT_CLOUD_BACKEND` at the top of
`public/app.js`. Change it there if you ever move hosts. (Alt+click the status badge to
override it just for your own browser — it is deliberately hidden behind a modifier key so
ordinary visitors never trip over it.)

---

## ☁️ Free Cloud Backend (Render)

Video and audio processing needs Node, `ffmpeg`, and `yt-dlp`, so the backend runs as a
Docker container on **[Render.com](https://render.com)**'s free plan:

1. Sign up on Render → **New + → Web Service** → pick the `yt-converter` repo.
2. Render detects the `Dockerfile` and builds it with `ffmpeg` + `yt-dlp`.
3. Leave **Auto-Deploy** on so pushes to `main` redeploy the backend.
4. Copy the live URL into `DEFAULT_CLOUD_BACKEND` in `public/app.js`.

### Staying awake (this part matters)

Render's free tier **spins a service down after 15 minutes of inactivity**, and the next
request then waits ~50 seconds for a cold start. To a normal user that is indistinguishable
from a broken site.

Two things handle it, both free:

- **`.github/workflows/keepalive.yml`** pings `/api/status` every 10 minutes so the instance
  effectively never sleeps. One always-on service uses ~744 of the 750 free instance hours
  per month, so it stays inside the free plan.
- **The frontend waits for the wake-up** instead of failing. The status badge shows
  `Waking server… 12s` and the request goes through once the backend answers.

If you host the backend somewhere else, set a repo variable `BACKEND_URL`
(**Settings → Secrets and variables → Actions → Variables**) and the keep-alive job will
use it. Note that GitHub disables scheduled workflows after 60 days with no repo activity —
if the site ever feels slow again, check that the keep-alive runs are still green, or point
a free [UptimeRobot](https://uptimerobot.com) monitor at `/api/status` as a backstop.

### Keeping yt-dlp current

YouTube changes its player constantly and a pinned `yt-dlp` breaks within weeks. This is
handled automatically: `docker-entrypoint.sh` fetches the latest `yt-dlp` on every container
start (falling back to the baked-in build if the download fails), and `server.js` re-runs
`yt-dlp -U` every 12 hours so a long-running warm instance does not go stale either.

### If YouTube starts bot-checking the server

Datacenter IPs occasionally get "Sign in to confirm you're not a bot". The server already
retries across several player clients before giving up. If it persists, add your YouTube
cookies as a Render environment variable `YOUTUBE_COOKIES` (Netscape `cookies.txt` format);
`server.js` writes it to disk on startup and passes it to `yt-dlp`. Use a throwaway Google
account — cookies used from a datacenter IP tend to get burned quickly.

---

## 🚀 Local Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (version 18 or higher recommended)
- `yt-dlp` executable placed in the root directory (Windows `yt-dlp.exe`) or installed on your system PATH.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/fawazelayan/yt-converter.git
   cd yt-converter
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Get yt-dlp:**
   Download the latest `yt-dlp.exe` binary from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest) and place it in the project root directory.

### Running Locally

- **On Windows:**
  Double-click `start.bat` or run:
  ```bash
  npm start
  ```

- Open your browser at [http://localhost:3000](http://localhost:3000).

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, `child_process` (`yt-dlp`, `ffmpeg-static`, `fluent-ffmpeg`, `Dockerfile`)
- **Frontend**: Vanilla HTML5, CSS3 (Modern Glassmorphism Design, Responsive), JavaScript (Fetch & SSE)

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
