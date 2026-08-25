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
- 🌐 **GitHub Pages + Your Own Laptop**: Frontend on GitHub Pages, backend on your laptop via Tailscale Funnel — a home IP, which is what keeps YouTube from bot-blocking downloads.
- 🔒 **Private & Ad-Free**: No third-party ads, no popups, no telemetry, no middleman servers.

---

## 🌐 How this is hosted

The frontend is on **GitHub Pages** (free, always up). The backend — the part that actually
runs `yt-dlp` and `ffmpeg` — runs **on your own laptop**, published to the internet by
**Tailscale Funnel**.

```
friend's phone  →  fawazelayan.github.io/yt-converter  →  your laptop  →  YouTube
```

**Why not a cloud host?** Because YouTube bot-checks datacenter IP addresses, which is what
every free cloud host gives you. Running the backend on a home connection is the single
biggest factor in downloads actually working — far more than which host you pick.

### One-time setup

1. **Install Tailscale** on the laptop: <https://tailscale.com/download> — sign in with Google.
2. **Enable HTTPS + Funnel** once in the [admin console](https://login.tailscale.com/admin/dns):
   turn on MagicDNS and HTTPS Certificates, then approve Funnel when first prompted.
3. **Double-click `START-SERVER.bat`.** It starts the server, opens the tunnel, and prints
   your permanent address, e.g. `https://my-laptop.tail1234.ts.net`.
4. **Paste that address** into `public/app.js` as `BACKEND_URL` — it is the first constant
   in the file and clearly marked. Commit and push; GitHub Pages redeploys itself.

That address never changes, so step 4 happens exactly once.

### Daily use

Double-click **`START-SERVER.bat`** and leave the window open. That's it.

- Window open + laptop awake → the site works for anyone, anywhere, on any network.
- Window closed / laptop asleep → the site says *"The download server is offline"*.

Set the laptop to **not sleep when the lid closes** (Settings → System → Power & battery →
"When I close the lid" → Do nothing), or it will keep dropping offline.

### What your friends need

Nothing. Just the link — no Tailscale account, no app, no setup.

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
