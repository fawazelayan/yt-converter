FROM node:20-alpine

# ffmpeg  -> muxing and MP3 encoding (musl build, matches this image)
# python3 -> required by the yt-dlp release script
# curl    -> fetches yt-dlp at build time and on every cold start
# tini    -> reaps the yt-dlp/ffmpeg children so they cannot pile up as zombies
RUN apk add --no-cache ffmpeg python3 curl ca-certificates tini

# Baseline yt-dlp. docker-entrypoint.sh refreshes this on every container start,
# so the image never has to be rebuilt just to keep up with YouTube.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# getBinaryPath() prefers a binary sitting next to server.js. A Windows .exe or a
# host-built yt-dlp copied in by accident would win that lookup and break the
# container, so make sure only the Linux build under /usr/local/bin is reachable.
RUN rm -f /app/yt-dlp.exe /app/yt-dlp \
 && sed -i 's/\r$//' /app/docker-entrypoint.sh \
 && chmod +x /app/docker-entrypoint.sh

ENV PORT=3000 \
    NODE_ENV=production \
    YTDLP_AUTO_UPDATE=1

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
