# --- build stage ---
# runs on the build host's own platform: the Nitro output is plain JavaScript,
# so multi-arch images don't need to run npm under emulation
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- runtime stage ---
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0
COPY --from=build --chown=node:node /app/.output ./.output
# project metadata, favorites and MCP presets live in /app/.data: mount a
# volume there. Pre-created so a fresh named volume inherits node ownership.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${NITRO_PORT}/api/health || exit 1
CMD ["node", ".output/server/index.mjs"]
