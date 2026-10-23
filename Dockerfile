FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8920 DATA_DIR=/app/data
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data /app/.local && chown -R node:node /app/data /app/.local
USER node
EXPOSE 8920
CMD ["node","--import","tsx","apps/api/src/main.ts"]
