# Bus times: small Node server, no extra packages.
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV HOST=0.0.0.0 PORT=3220 DATA_DIR=/data TZ=America/Edmonton
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3220
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD wget -qO- "http://localhost:${PORT}/healthz" || exit 1
CMD ["node", "server.js"]
