FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md README_ZH.md README_EN.md LICENSE AGENTS.md ./

ENV NODE_ENV=production
ENV CODEX_SYNC_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "./src/cli.js", "cloud-server", "--host", "0.0.0.0", "--port", "8787", "--data-dir", "/data"]
