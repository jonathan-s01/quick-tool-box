# Quick Tool Box for a Linux home server.
# Built and started by docker-compose.yml: docker compose up -d --build

# ---------------------------------------------------------------- speech to text (whisper.cpp)
# Built from source here, because Debian has no package for it. The image is built on the computer
# that runs it, so it is tuned for that processor (WHISPER_NATIVE=OFF makes a portable build instead).
FROM debian:trixie-slim AS whisper
ARG WHISPER_VERSION=v1.7.6
ARG WHISPER_NATIVE=ON
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake build-essential \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp /src \
  && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
       -DGGML_NATIVE="$WHISPER_NATIVE" -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build /src/build --config Release -j"$(nproc)" --target whisper-cli \
  && install -m 755 /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

# ---------------------------------------------------------------- the app
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl zip unzip \
      python3 python3-pip \
      poppler-utils ghostscript qpdf \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
      ocrmypdf unpaper pngquant \
      imagemagick \
      pandoc libimage-exiftool-perl ffmpeg \
      chromium fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      libreoffice-writer-nogui \
      wamerican \
  && rm -rf /var/lib/apt/lists/*

# PyMuPDF (redactor and the shared document model) and yt-dlp.
RUN pip3 install --no-cache-dir --break-system-packages pymupdf yt-dlp

# Older ImageMagick only has "convert"; the tools call "magick". Also allow ImageMagick to write PDFs.
RUN if ! command -v magick >/dev/null; then printf '#!/bin/sh\nexec convert "$@"\n' > /usr/local/bin/magick && chmod +x /usr/local/bin/magick; fi \
  && for f in /etc/ImageMagick-*/policy.xml; do [ -f "$f" ] && sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' "$f"; done; true

COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0 \
    PORT=3210 \
    DATA_DIR=/data \
    NO_OPEN=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PYMUPDF_PYTHON=python3

# Run as the unprivileged "node" user that comes with the image.
RUN mkdir -p /data/whisper-models && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3210
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD curl -fsS "http://localhost:${PORT}/healthz" || exit 1
CMD ["node", "server.js"]
