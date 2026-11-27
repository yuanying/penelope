# penelope
#
# The one entry point for both languages: the Sentinel is Go, everything else
# is TypeScript (ADR-0001). CI calls these targets and nothing else, so there is
# nothing that can be run in CI but not on a laptop.
#
# `make test` passes with nothing but the Go and Node toolchains and is the loop
# to stay in while developing. Tests that need more than that (a cluster, root,
# an outside service) go behind a target or a build tag of their own, so that
# `make test` never picks them up.
#
# golangci-lint, govulncheck and kustomize are declared in go.mod's tool
# directive and run through `go tool`, so every checkout runs the same version
# and nothing is installed globally.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

GO ?= go
NPM ?= npm

# The version written into the binaries and the images. The release workflow
# passes the tag.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS ?= -s -w -X main.version=$(VERSION)

# The Go packages with tests behind the netns build tag, and how to get root.
NETNS_PKGS ?= ./internal/origdst ./internal/proxy
SUDO ?= sudo

##@ General

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# The npm workspaces are installed from the lock whenever it or a package.json
# is newer than the last install, so the TypeScript targets work on a fresh
# checkout without a separate step. npm writes node_modules/.package-lock.json
# on every install.
node_modules/.package-lock.json: package.json package-lock.json $(wildcard packages/*/package.json)
	$(NPM) ci

##@ Build

.PHONY: build
build: build-go build-ts ## Build everything.

.PHONY: build-go
build-go: ## Build the Sentinel into bin/.
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/sentinel ./cmd/sentinel

.PHONY: build-ts
build-ts: node_modules/.package-lock.json ## Compile every npm workspace into its dist/.
	$(NPM) run build

# The targets of the Dockerfile, one image each.
IMAGES ?= sentinel backend receivers sandbox house

.PHONY: images
images: ## Build every image for this machine's platform, as penelope-<target>:$(VERSION).
	for target in $(IMAGES); do \
		docker build --target "$$target" --build-arg VERSION="$(VERSION)" \
			--tag "penelope-$$target:$(VERSION)" . ; \
	done

# The Web UI over a mock of the backend, rebuilt as its files change
# (packages/web/dev.ts). Nothing in CI calls it.
.PHONY: web-dev
web-dev: node_modules/.package-lock.json ## Serve the Web UI over a mock backend at 127.0.0.1:5173 (PORT=), rebuilt on change. Pick a scene with ?scene=<name>.
	$(NPM) run dev --workspace=@penelope/web

# The house's screen over the real house server with made-up residents
# (packages/house-web/dev.ts). Nothing in CI calls it.
.PHONY: house-web-dev
house-web-dev: node_modules/.package-lock.json ## Serve the house's screen over a made-up house at 127.0.0.1:5174 (PORT=), rebuilt on change.
	$(NPM) run dev --workspace=@penelope/house-web

##@ Check

# gofmt is given the module's package directories rather than `.`, so that it
# skips what go.mod ignores (node_modules/ and packages/).
.PHONY: fmt
fmt: ## Format the Go source.
	$(GO) fmt ./...

.PHONY: fmt-check
fmt-check: ## Fail if any Go file is not gofmt'd.
	@unformatted="$$(gofmt -l $$($(GO) list -f '{{.Dir}}' ./...))"; \
	if [ -n "$$unformatted" ]; then \
		echo "Not gofmt'd. Run \`make fmt\`:"; \
		echo "$$unformatted" | sed 's/^/  /'; \
		exit 1; \
	fi

.PHONY: vet
vet: ## Run go vet over every package.
	$(GO) vet ./...

# There is no TypeScript linter yet: the type check catches what has gone
# wrong so far. Add one when a class of mistake it would catch shows up.
.PHONY: typecheck
typecheck: node_modules/.package-lock.json ## Type-check every npm workspace.
	$(NPM) run typecheck

.PHONY: lint
lint: ## Run golangci-lint.
	$(GO) tool golangci-lint run ./...

.PHONY: lint-fix
lint-fix: ## Run golangci-lint and apply the fixes it can make itself.
	$(GO) tool golangci-lint run --fix ./...

.PHONY: vuln
vuln: ## Report known vulnerabilities in the code paths the Go module calls.
	$(GO) tool govulncheck ./...

##@ Test

.PHONY: test
test: test-go test-ts test-renovate test-release test-deploy ## Unit tests, Renovate extraction, the plan of the release without a person and deployment example checks. Need nothing but the toolchains.

.PHONY: test-renovate
test-renovate: ## Check the sandbox tools' Renovate extraction and release tag formats.
	node --test .github/scripts/renovate-tools.test.mjs

.PHONY: test-release
test-release: ## Check which bot changes the release without a person releases, on a throwaway git repository.
	node --test .github/scripts/plan-release.test.mjs

# The Kubernetes example (deploy/kubernetes/) has to stay buildable by
# kustomize; go test ./... checks that its settings agree with each other.
# The backup decision and the tool to migrate natsumi's schedules are checked here too.
.PHONY: test-deploy
test-deploy: ## Build the Kubernetes example and migrate Pod, and test the backup and migrate tools.
	$(GO) tool kustomize build deploy/kubernetes/example > /dev/null
	$(GO) tool kustomize build deploy/kubernetes/migrate > /dev/null
	node --test deploy/kubernetes/migrate/move-schedules.test.mjs deploy/kubernetes/components/backup/select-backup.test.mjs

.PHONY: test-go
test-go: ## Unit tests of the Go module.
	$(GO) test ./...

.PHONY: test-ts
test-ts: node_modules/.package-lock.json ## Unit tests of every npm workspace, with node --test.
	$(NPM) test

# The tests behind the netns build tag redirect real connections with
# iptables, so they need root. They run, through sudo, in a network namespace
# of their own that is thrown away afterwards.
.PHONY: test-netns
test-netns: ## Go tests that redirect with iptables. Need root (through sudo); run in a network namespace of their own.
	mkdir -p bin/netns
	for pkg in $(NETNS_PKGS); do \
		$(GO) test -c -tags netns -o "bin/netns/$$(basename "$$pkg").test" "$$pkg"; \
	done
	$(SUDO) unshare --net sh -eu -c 'ip link set lo up; for pkg in $(NETNS_PKGS); do t="bin/netns/$${pkg##*/}.test"; echo "== $$t"; "$$t" -test.count=1; done'

# What only a browser can tell of the two screens: the widths of the Web UI
# over a stub of the backend (packages/web/browser/), and the focus, the
# layout and the comings and goings of the house's screen over the real house
# server (packages/house-web/browser/). happy-dom lays nothing out. It needs a
# Chromium or Chrome, given as CHROMIUM, so `make test` never runs it.
.PHONY: test-browser
test-browser: node_modules/.package-lock.json ## Check the Web UI and the house's screen in Chromium. Needs CHROMIUM=<path to chrome>.
	$(NPM) run build --workspace=@penelope/web --workspace=@penelope/house-web
	CHROMIUM="$(CHROMIUM)" $(NPM) run test-browser --workspace=@penelope/web --workspace=@penelope/house-web

# The end-to-end test lays the four containers of the Pod out with Docker
# Compose, with fakes for the model and GitHub, and drives them from the UI's
# API (e2e/README.md). It needs Docker, so `make test` never runs it.
.PHONY: e2e
e2e: images node_modules/.package-lock.json ## Run the Pod end to end with Docker Compose and fakes. Needs Docker.
	PENELOPE_E2E_TAG="$(VERSION)" $(NPM) run e2e --workspace=@penelope/e2e

##@ iPhone app

# The iPhone app (apple/) is Swift, outside the Go module and the npm
# workspaces, so `make test` never runs these. The core's tests need only a
# Swift toolchain and run on Linux too; the app needs macOS with Xcode. It is
# built for the simulator and unsigned, so no team or certificate is needed.
.PHONY: apple-test
apple-test: ## Unit tests of the iPhone app's core, with swift test. Needs a Swift toolchain.
	swift test --package-path apple/PenelopeCore

.PHONY: apple-build
apple-build: ## Build the iPhone app for the simulator, unsigned. Needs macOS with Xcode.
	xcodebuild build -project apple/Penelope.xcodeproj -scheme PenelopePhone \
		-destination 'generic/platform=iOS Simulator' -derivedDataPath apple/build \
		CODE_SIGNING_ALLOWED=NO

##@ Housekeeping

.PHONY: tidy
tidy: ## Tidy go.mod and go.sum.
	$(GO) mod tidy

.PHONY: clean
clean: ## Remove build artifacts.
	rm -rf bin packages/*/dist apple/build apple/PenelopeCore/.build
