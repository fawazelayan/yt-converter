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

The frontend is ready to run on GitHub Pages!

1. Go to your repo settings on GitHub: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions** (the automated workflow in `.github/workflows/deploy.yml` will deploy automatically on push).
3. Open your GitHub Pages link: `https://fawazelayan.github.io/yt-converter/`
4. Click the **"Set Backend"** badge in the header to enter your backend URL (e.g. your free Render server `https://yt-converter.onrender.com` or local tunnel).

---

## ☁️ 1-Click Free Cloud Backend (Render / Railway)

Because video/audio processing requires Node.js, `ffmpeg`, and `yt-dlp`, you can host the backend 100% free on **[Render.com](https://render.com)**:

1. Sign up on [Render.com](https://render.com) and click **New + → Web Service**.
2. Select your `yt-converter` repository.
3. Render will automatically detect the `Dockerfile` and build it with `ffmpeg` + `yt-dlp` installed.
4. Copy your live backend URL (e.g. `https://yt-converter-xxx.onrender.com`) and paste it into your GitHub Pages app!

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
