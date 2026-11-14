# syntax=docker/dockerfile:1
#
# One Dockerfile for every image of a release (ADR-0001), one target each:
#
#   sentinel   ghcr.io/yuanying/penelope-sentinel
#   backend    ghcr.io/yuanying/penelope-backend
#   receivers  ghcr.io/yuanying/penelope-receivers
#   sandbox    ghcr.io/yuanying/penelope-sandbox (the runner inside)
#
# The build stages run on the builder's own platform and only their output is
# copied into the image of the target platform: Go cross-compiles, and what tsc
# writes is the same on every platform. VERSION is the release's tag.
#
# The Node here and the Node of setup-node in the workflows are the same
# version, kept so by Renovate's node group.

ARG VERSION=dev

FROM --platform=$BUILDPLATFORM golang:1.27.4-trixie AS sentinel-build
ARG TARGETOS TARGETARCH VERSION
WORKDIR /src
# Only go.mod, go.sum and the source. `go build` fetches the modules the
# Sentinel imports and not the tools go.mod also lists.
COPY go.mod go.sum ./
COPY cmd ./cmd
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/sentinel ./cmd/sentinel

FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS ts-build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build

# A static binary needs no more than this. nonroot runs it as UID 65532.
FROM gcr.io/distroless/static-debian13:nonroot AS sentinel
COPY --from=sentinel-build /out/sentinel /sentinel
ENTRYPOINT ["/sentinel"]

# The TypeScript images carry the package's package.json (it makes dist/ ES
# modules) and what tsc wrote. The packages have no runtime dependencies yet;
# the one that gets the first installs it here with npm ci --omit=dev.
FROM node:24.22.3-trixie-slim AS backend
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/backend/package.json ./
COPY --from=ts-build /src/packages/backend/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]

FROM node:24.22.3-trixie-slim AS receivers
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/receivers/package.json ./
COPY --from=ts-build /src/packages/receivers/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/main.js"]

# Only the runner for now. The development tools, the Sentinel's CA and the
# generic user and HOME (ADR-0011) come with the sandbox image's own work;
# until then it runs as the node image's user, UID 1000.
FROM node:24.22.3-trixie-slim AS sandbox
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /opt/penelope/runner
COPY --from=ts-build /src/packages/runner/package.json ./
COPY --from=ts-build /src/packages/runner/dist ./dist
USER node
ENTRYPOINT ["node", "/opt/penelope/runner/dist/main.js"]
