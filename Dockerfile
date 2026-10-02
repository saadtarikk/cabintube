FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements-resolver.txt /tmp/requirements-resolver.txt
RUN python3 -m venv /opt/resolver && /opt/resolver/bin/pip install --no-cache-dir -r /tmp/requirements-resolver.txt
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 YTDLP_BIN=/opt/resolver/bin/yt-dlp SESSION_FILE=/data/sessions.enc NODE_OPTIONS=--max-old-space-size=192
USER node
EXPOSE 4318
CMD ["node", "--import", "tsx", "server/index.ts"]
