FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 needs a build toolchain when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY vendor ./vendor
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    DB_PATH=/app/data/messages.db \
    AUTH_DIR=/app/data/auth

# The bridge is the default. The MCP server runs as a separate command.
CMD ["node", "src/bridge.js"]
