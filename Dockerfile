FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node shared ./shared
COPY --chown=node:node proto ./proto
COPY --chown=node:node services ./services
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node tests ./tests
USER node
CMD ["sh", "-c", "exec node services/$SERVICE/src/index.js"]
