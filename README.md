# 🎬 YT Downloader & Converter

A modern, fast, and private YouTube to MP3 / MP4 converter with custom video trimming capabilities, live progress tracking, and estimated file size calculation.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)

---

## ✨ Features

- 🎵 **MP3 Audio Extraction**: Convert YouTube videos to high-quality MP3 audio (320kbps, 256kbps, 192kbps, 128kbps).
- 🎥 **MP4 Video Download**: Download videos up to 1080p Full HD with real-time format and stream detection.
- ✂️ **Built-in Segment Trimmer**: Preview the video in-browser, set start and end timestamps, and crop/trim audio or video before downloading.
- 📊 **Live Progress & SSE**: Real-time conversion percentage and status updates.
- 💾 **Estimated File Sizes**: Shows real file size estimates for audio and video resolutions before starting the download.
- 🕒 **Local Download History**: Remembers your recent downloads locally in your browser.
- 🔒 **Private & Ad-Free**: No third-party ads, no popups, no telemetry, no middleman servers.

---

## 🚀 Getting Started

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

### Running the App

- **On Windows:**
  Double-click `start.bat` or run:
  ```bash
  npm start
  ```

- Open your browser at [http://localhost:3000](http://localhost:3000).

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, `child_process` (`yt-dlp`, `ffmpeg-static`, `fluent-ffmpeg`)
- **Frontend**: Vanilla HTML5, CSS3 (Modern Glassmorphism Design, Responsive), JavaScript (Fetch & SSE)

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
