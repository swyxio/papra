FROM node:26.8.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg poppler-utils tesseract-ocr tesseract-ocr-eng util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs ./server.mjs
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
