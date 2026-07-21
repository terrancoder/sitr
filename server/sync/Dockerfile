# Build and run the Sitr sync server. Build context = repository root:
#   docker build -f server/sync/Dockerfile -t sitr-sync .
#   docker run -p 8787:8787 -v sitr-sync-data:/data -e SITR_SYNC_DB=/data/blobs.sqlite sitr-sync
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/sync/package.json server/sync/
COPY extension/package.json extension/
COPY tools/compiler/package.json tools/compiler/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json* ./
COPY server/sync server/sync
RUN npx tsc -p server/sync/tsconfig.json

FROM node:22-alpine
RUN adduser -D -H sitr
USER sitr
WORKDIR /app
COPY --from=build /src/server/sync/dist dist
ENV SITR_SYNC_PORT=8787 SITR_SYNC_DB=/data/blobs.sqlite
EXPOSE 8787
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "dist/server.js"]
