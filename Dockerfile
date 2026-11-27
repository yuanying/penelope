# syntax=docker/dockerfile:1
#
# One Dockerfile for every image of a release (ADR-0001), one target each:
#
#   sentinel   ghcr.io/yuanying/penelope-sentinel
#   backend    ghcr.io/yuanying/penelope-backend
#   receivers  ghcr.io/yuanying/penelope-receivers
#   sandbox    ghcr.io/yuanying/penelope-sandbox (the runner inside)
#   house      ghcr.io/yuanying/penelope-house
#
# The build stages run on the builder's own platform and only their output is
# copied into the image of the target platform: Go cross-compiles, and what tsc
# writes is the same on every platform. The exceptions are the final stages
# of the backend, which installs git, and of the sandbox, which installs
# Debian's packages, and the stage that builds porkadot's gem with its native
# extensions; building those for another platform needs QEMU.
# VERSION is the release's tag.
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
COPY internal ./internal
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

# The backend's runtime dependencies, without the dev tools. The links npm
# makes to the workspaces are dropped: the final stage copies the backend's
# dist, and the contract's and the avatar's package.json and dist in place of
# their links.
FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS backend-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @penelope/backend && rm -rf node_modules/@penelope

# A static binary needs no more than this. nonroot runs it as UID 65532.
FROM gcr.io/distroless/static-debian13:nonroot AS sentinel
COPY --from=sentinel-build /out/sentinel /sentinel
ENTRYPOINT ["/sentinel"]

# The TypeScript images carry the package's package.json (it makes dist/ ES
# modules) and what tsc wrote, and the runtime dependencies of those that have
# any, installed with npm ci --omit=dev.
#
# Each container of the Pod runs as a UID of its own (docs/pod.md): the
# sandbox's outbound traffic is sent to the Sentinel by its UID, so no other
# container may share it. backend is 1001 and receivers 1002, by number with
# no user entry; the volumes they share are made writable by the Pod's
# fsGroup.
#
# The backend runs git to commit /memory (ADR-0006). This RUN is the only one
# in a final stage, so the release builds it for arm64 under QEMU. The
# warning that node:sqlite is experimental is turned off: there is nothing to
# act on in it. The built Web UI is served from /app/web (the default of
# PENELOPE_WEB_DIR). The repository's avatars are in /app/avatars, which the
# backend copies the chosen one from into /memory/avatar/ (docs/backend.md).
FROM node:24.22.3-trixie-slim AS backend
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/backend/package.json ./
COPY --from=backend-deps /src/node_modules ./node_modules
COPY --from=ts-build /src/packages/contract/package.json ./node_modules/@penelope/contract/
COPY --from=ts-build /src/packages/contract/dist ./node_modules/@penelope/contract/dist
COPY --from=ts-build /src/packages/avatar/package.json ./node_modules/@penelope/avatar/
COPY --from=ts-build /src/packages/avatar/dist ./node_modules/@penelope/avatar/dist
COPY --from=ts-build /src/packages/service-account-auth/package.json ./node_modules/@penelope/service-account-auth/
COPY --from=ts-build /src/packages/service-account-auth/dist ./node_modules/@penelope/service-account-auth/dist
COPY --from=ts-build /src/packages/backend/dist ./dist
COPY --from=ts-build /src/packages/web/dist ./web
COPY assets/avatars ./avatars
USER 1001:1001
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/dist/main.js"]
CMD ["serve"]

FROM node:24.22.3-trixie-slim AS house
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/house/package.json ./
COPY --from=ts-build /src/packages/house/dist ./dist
COPY --from=ts-build /src/packages/contract/package.json ./node_modules/@penelope/contract/
COPY --from=ts-build /src/packages/contract/dist ./node_modules/@penelope/contract/dist
COPY --from=ts-build /src/packages/service-account-auth/package.json ./node_modules/@penelope/service-account-auth/
COPY --from=ts-build /src/packages/service-account-auth/dist ./node_modules/@penelope/service-account-auth/dist
USER 1000:1000
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/dist/main.js"]

# The receivers' runtime dependencies (ws, for Slack's Socket Mode), as
# for the backend. The Slack plugin's package is copied in place of its link.
FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS receivers-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts --workspace=@penelope/receivers && rm -rf node_modules/@penelope

FROM node:24.22.3-trixie-slim AS receivers
ARG VERSION
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION}
WORKDIR /app
COPY --from=ts-build /src/packages/receivers/package.json ./
COPY --from=receivers-deps /src/node_modules ./node_modules
COPY --from=ts-build /src/packages/slack/package.json ./node_modules/@penelope/slack/
COPY --from=ts-build /src/packages/slack/dist ./node_modules/@penelope/slack/dist
COPY --from=ts-build /src/packages/receivers/dist ./dist
USER 1002:1002
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]

# The runner's runtime dependencies. None of them is built for a platform, so
# they are installed here on the builder's own and copied as they are. The
# link to the contract is dropped, as for the backend.
FROM --platform=$BUILDPLATFORM node:24.22.3-trixie-slim AS runner-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts --workspace=@penelope/runner \
    && rm -rf node_modules/@penelope

# The single-binary tools of the sandbox, fetched for the target's
# architecture and checked against their releases' checksums. Renovate reads
# these ARGs from GitHub releases, preserving the fetch script's tag/asset format.
FROM --platform=$BUILDPLATFORM golang:1.27.4-trixie AS sandbox-tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG HELM_VERSION=v4.3.2
ARG KUSTOMIZE_VERSION=v5.8.3
ARG SOPS_VERSION=v3.13.3
ARG GH_VERSION=2.105.0
ARG VMCTL_VERSION=v0.2.0
ARG A2A_VERSION=0.5.0
COPY packages/runner/image/fetch-tools.sh /fetch-tools.sh
RUN KUBECTL_VERSION=$KUBECTL_VERSION HELM_VERSION=$HELM_VERSION KUSTOMIZE_VERSION=$KUSTOMIZE_VERSION \
    SOPS_VERSION=$SOPS_VERSION GH_VERSION=$GH_VERSION VMCTL_VERSION=$VMCTL_VERSION A2A_VERSION=$A2A_VERSION \
    /fetch-tools.sh "$TARGETARCH" /out

# sdctl, the CLI of Stable Diffusion's WebUI, which the agents draw with
# (ADR-0032). Its releases carry no binary, so it is built here from its Go
# module at the release's tag, for the target's architecture; go install
# checks the module against Go's checksum database. Renovate reads
# SDCTL_VERSION from the repository's GitHub releases.
FROM --platform=$BUILDPLATFORM golang:1.27.4-trixie AS sandbox-sdctl
ARG TARGETOS TARGETARCH
ARG SDCTL_VERSION=v0.5.1
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go install -trimpath -ldflags "-s -w" "github.com/yuanying/sdctl@${SDCTL_VERSION}" \
    && mkdir -p /out \
    && install -m 0755 "$(find /go/bin -type f -name sdctl | head -n 1)" /out/sdctl

# The Go toolchain of the target platform, copied whole.
FROM golang:1.27.4-trixie AS sandbox-go

# porkadot, the CLI that builds and runs the cluster, is not on RubyGems: its
# gem is built from the tag of its repository, whose gemspec lists the files
# with git. Two of its dependencies have native extensions, so this stage
# runs on the target platform, from the same Debian and Ruby as the sandbox,
# and the release builds it for arm64 under QEMU. What `gem install` writes,
# the gems under /var/lib/gems and the command in /usr/local/bin, is copied
# into the sandbox at the same paths. Renovate raises PORKADOT_VERSION from
# the repository's tags.
FROM node:24.22.3-trixie-slim AS sandbox-porkadot
ARG PORKADOT_VERSION=v0.37.7
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates git ruby ruby-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet --depth 1 --branch "$PORKADOT_VERSION" https://github.com/yuanying/porkadot /src/porkadot \
    && cd /src/porkadot \
    && gem build porkadot.gemspec \
    && gem install --no-document --bindir /usr/local/bin ./porkadot-*.gem \
    && porkadot help >/dev/null

# The sandbox (ADR-0011): Debian, Node, the development tools and the runner.
# The user is `agent`, UID 1000, with HOME /home/agent; it takes the place of
# the node image's user of the same UID. /home/agent, /memory and Pi's
# directory under HOME are mounted from the Pod's persistent volumes.
#
# /memory/.git belongs to the backend, which commits it (ADR-0006); git is
# told the directory is safe, so that `agent` can read the history.
#
# The Sentinel's CA is added at start by the entrypoint, from a volume, to the
# system bundle (docs/pod.md, "CA"). The bundle is kept writable by `agent`
# for that, with Debian's own copy beside it to start from each time.
FROM node:24.22.3-trixie-slim AS sandbox
ARG VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl fd-find file git jq less make openssh-client procps \
        python3 python3-venv ripgrep ruby unzip vim xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && userdel --remove node \
    && useradd --uid 1000 --user-group --create-home --home-dir /home/agent --shell /bin/bash agent \
    && mkdir -p /usr/share/penelope /etc/penelope/ca \
    && cp /etc/ssl/certs/ca-certificates.crt /usr/share/penelope/ca-certificates.crt \
    && chown agent:agent /etc/ssl/certs/ca-certificates.crt \
    && git config --system --add safe.directory /memory
COPY --from=sandbox-go /usr/local/go /usr/local/go
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/
COPY --from=sandbox-tools /out/ /usr/local/bin/
# sdctl itself is beside the wrapper that gives it her avatar's params.
COPY --from=sandbox-sdctl /out/sdctl /usr/local/libexec/penelope/sdctl
COPY packages/runner/image/sdctl /usr/local/bin/sdctl
COPY --from=sandbox-porkadot /var/lib/gems/ /var/lib/gems/
COPY --from=sandbox-porkadot /usr/local/bin/porkadot /usr/local/bin/porkadot
COPY packages/runner/image/entrypoint.sh /usr/local/bin/penelope-sandbox
COPY --chmod=0755 packages/runner/image/ask-agent /usr/local/bin/ask-agent
COPY --chmod=0755 packages/runner/image/x-search /usr/local/bin/x-search
COPY --chmod=0755 packages/runner/image/penelope-memory-eval /usr/local/bin/penelope-memory-eval
WORKDIR /opt/penelope/runner
COPY --from=ts-build /src/packages/runner/package.json ./
COPY --from=ts-build /src/packages/runner/dist ./dist
COPY --from=runner-deps /src/node_modules ./node_modules
COPY --from=ts-build /src/packages/contract/package.json ./node_modules/@penelope/contract/
COPY --from=ts-build /src/packages/contract/dist ./node_modules/@penelope/contract/dist
# The Slack plugin's drawing, which the runner draws Slack's events with, and
# its reading CLI (ADR-0029). It has no dependency at run time.
COPY --from=ts-build /src/packages/slack/package.json ./node_modules/@penelope/slack/
COPY --from=ts-build /src/packages/slack/dist ./node_modules/@penelope/slack/dist
COPY --from=ts-build /src/packages/slack/package.json /opt/penelope/slack/
COPY --from=ts-build /src/packages/slack/dist /opt/penelope/slack/dist
COPY packages/slack/bin/slackctl /usr/local/bin/slackctl
# The skills that come with the image whatever the deployment: the use of the
# image's tools and the skills every agent has. The runner lists them after
# the owner's and the memory's (docs/pod.md, "skill").
COPY packages/runner/image/skills /opt/penelope/skills
# `avatar check`, which reads /memory/avatar/ with the backend's own rules
# (ADR-0036). It has no dependency.
COPY --from=ts-build /src/packages/avatar/package.json /opt/penelope/avatar/
COPY --from=ts-build /src/packages/avatar/dist /opt/penelope/avatar/dist
COPY packages/avatar/bin/avatar /usr/local/bin/avatar
ENV NODE_ENV=production PENELOPE_VERSION=${VERSION} \
    HOME=/home/agent USER=agent \
    PATH=/home/agent/.local/bin:/home/agent/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/penelope-sandbox"]
CMD ["run"]
