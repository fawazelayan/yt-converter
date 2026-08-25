#!/bin/sh
# YouTube changes its player constantly, so a yt-dlp baked into the image goes
# stale within weeks and starts failing extractions. Refresh it on every cold
# start, but never let a failed refresh stop the server from booting -- a
# slightly old yt-dlp is far better than no backend at all.
set -u

TARGET=/usr/local/bin/yt-dlp
TMP=/tmp/yt-dlp.new
URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp

if [ "${YTDLP_AUTO_UPDATE:-1}" = "1" ]; then
  echo "[entrypoint] refreshing yt-dlp..."
  if curl -fsSL --max-time 90 "$URL" -o "$TMP"; then
    chmod a+rx "$TMP"
    # Only swap it in if the download actually runs; a truncated or rate-limited
    # response would otherwise replace a working binary with a broken one.
    if "$TMP" --version >/dev/null 2>&1; then
      mv "$TMP" "$TARGET"
      echo "[entrypoint] yt-dlp updated"
    else
      echo "[entrypoint] downloaded yt-dlp failed its smoke test, keeping the baked-in build"
      rm -f "$TMP"
    fi
  else
    echo "[entrypoint] yt-dlp download failed, keeping the baked-in build"
  fi
fi

echo "[entrypoint] yt-dlp version: $("$TARGET" --version 2>/dev/null || echo unknown)"
echo "[entrypoint] ffmpeg version: $(ffmpeg -version 2>/dev/null | head -n 1 || echo unknown)"

exec node server.js
