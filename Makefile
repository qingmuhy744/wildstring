SHELL := /bin/bash
.DEFAULT_GOAL := help

UV ?= uv
PYTHON ?= python3
COMPOSE ?= docker compose
PROJECT ?= wildstring
TEST_RUNTIME_IMAGE ?= wildstring:dev
TEST_BUILDER_IMAGE ?= wildstring-builder:dev
TEST_IMAGE ?= wildstring-tests:dev
LOG_ARGS ?= -f --tail=100
SCAN_ARGS ?=
export UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
export PRE_COMMIT_HOME ?= $(CURDIR)/.cache/pre-commit
RUN = $(UV) run --frozen --project backend --extra community-sources
ANDROID = ./frontend/android/gradlew -p frontend/android --console=plain
ANDROID_TEST_ARGS ?=
DOCKER = $(COMPOSE) --project-directory "$(CURDIR)" --env-file .env -p "$(PROJECT)" -f deploy/compose.yaml

.PHONY: help env setup sync dev dev-web android-design scan import-music admin check hooks-check lint format format-check security test build-web icons browser-install test-web test-large-web test-browse-web test-transcoding-web web-test-server ci health docker-config docker-build docker-up docker-pull docker-down docker-status docker-logs docker-smoke docker-scan docker-import docker-admin docker-test fingerprint-check

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  make %-17s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Create local .env and directories without overwriting settings
	$(PYTHON) scripts/setup.py

sync: ## Install locked Python and Web dependencies
	$(UV) sync --locked --project backend --extra community-sources
	npm --prefix frontend/web ci

.PHONY: source-plugins source-providers-check
source-providers-check: ## Verify provider subsets against integrity-pinned upstream archives
	$(RUN) python scripts/vendor_source_providers.py --check

source-plugins: ## Package independently importable community source ZIPs
	npm --prefix plugins/node-runtime ci --ignore-scripts
	npm --prefix plugins/node-runtime test
	node scripts/build_source_runtimes.mjs
	$(RUN) python scripts/package_source_plugins.py

setup: env sync ## Set up dependencies and install the local Git hook
	$(RUN) pre-commit install --install-hooks

dev: env ## Run the Python API at 127.0.0.1:18780 with reload
	$(RUN) python -m wildstring

dev-web: ## Run React at 127.0.0.1:18781 with an API proxy
	npm --prefix frontend/web run dev

android-design: ## Preview the Android design at http://127.0.0.1:18782/android-v1.html
	$(RUN) python -m http.server 18782 --bind 127.0.0.1 --directory docs/design

.PHONY: android-check android-test android-assemble android-codeql android-package android-ci android-connected-test android-locks android-release android-release-smoke
android-check: ## Run Android Lint (requires JDK 21 and Android SDK 37)
	$(ANDROID) :app:lintDebug

android-test: ## Run Android unit tests
	$(ANDROID) :app:testDebugUnitTest

android-assemble: ## Build an installable debug APK
	$(ANDROID) :app:assembleDebug

android-codeql: ## Compile Kotlin without incremental or build caches for CodeQL extraction
	$(ANDROID) --no-daemon --no-build-cache --rerun-tasks -Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process :app:assembleDebug

android-package: android-assemble ## Copy APK and SHA256SUMS into artifacts/android
	$(PYTHON) scripts/package_android.py

android-ci: ## Check, test and package the native Android application
	$(ANDROID) :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
	$(ANDROID) :app:assembleRelease :app:lintRelease
	$(PYTHON) scripts/package_android.py

android-release: ## Build and verify a signed release APK (requires ANDROID signing environment)
	@test -n "$$ANDROID_KEYSTORE_PATH" -a -n "$$ANDROID_KEYSTORE_PASSWORD" -a -n "$$ANDROID_KEY_ALIAS" -a -n "$$ANDROID_KEY_PASSWORD" || (echo "Missing Android release signing configuration" >&2; exit 1)
	$(ANDROID) :app:assembleRelease :app:lintRelease
	"$(ANDROID_HOME)/build-tools/36.1.0/apksigner" verify --verbose --print-certs frontend/android/app/build/outputs/apk/release/app-release.apk
	$(PYTHON) scripts/package_android.py --variant release

android-release-smoke: ## Install and smoke-test the signed release APK on a disposable device
	$(PYTHON) scripts/smoke_android_release.py

android-connected-test: ## Run native UI/playback tests on a connected emulator/device
	$(ANDROID) :app:connectedDebugAndroidTest $(ANDROID_TEST_ARGS)

android-locks: ## Refresh Android dependency locks and SHA-256 verification metadata
	$(ANDROID) :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest --write-locks --write-verification-metadata sha256
	$(ANDROID) :app:assembleRelease :app:lintRelease --write-locks --write-verification-metadata sha256

.PHONY: ios-gen ios-build
ios-gen: ## Generate the iOS Xcode project from frontend/ios/project.yml (requires XcodeGen)
	cd frontend/ios && xcodegen generate

ios-build: ios-gen ## Build the iOS app for the simulator
	xcodebuild -project frontend/ios/WildString.xcodeproj -scheme WildString -destination 'generic/platform=iOS Simulator' build

scan: env ## Rescan the managed library; use SCAN_ARGS=--full to refresh all tags
	$(RUN) python -m wildstring.scan $(SCAN_ARGS)

import-music: env ## Copy and organize source music into the managed library, then scan
	$(RUN) python -m wildstring.import_music $(SCAN_ARGS)

admin: env ## Set/reset admin password interactively; revoke existing sessions
	$(RUN) python -m wildstring.admin

hooks-check: ## Check tracked and new project files
	$(RUN) python scripts/run_pre_commit.py

check: hooks-check ## Run pre-commit, including Ruff, security and Web checks

lint: ## Lint Python without modifying files
	$(RUN) ruff check --config backend/pyproject.toml backend scripts

format: ## Format Python and Web sources
	$(RUN) ruff format --config backend/pyproject.toml backend scripts
	npm --prefix frontend/web run format

format-check: ## Check formatting without modifying files
	$(RUN) ruff format --config backend/pyproject.toml --check backend scripts
	npm --prefix frontend/web run format:check

security: ## Scan Python application and maintenance scripts
	$(RUN) bandit -r backend/src scripts -ll -c backend/pyproject.toml

test: ## Run backend tests without external services
	$(RUN) pytest -c backend/pyproject.toml backend/tests

build-web: ## Build the versioned Web release input
	npm --prefix frontend/web run build

icons: ## Regenerate the transparent favicon from its SVG source (requires Chromium)
	npm --prefix frontend/web run icons

browser-install: ## Install Chromium for the Web integration tests
	npm --prefix frontend/web exec -- playwright install chromium

test-web: build-web ## Test login, search, playback and mobile UI with an isolated fixture library
	npm --prefix frontend/web run test

test-large-web: build-web ## Verify real API pagination and continuous playback with 257 album tracks
	WILDSTRING_TEST_LARGE_LIBRARY=1 npm --prefix frontend/web run test -- multipage-real.spec.ts

test-browse-web: build-web ## Verify continuous browsing, pinyin jumps and compact album rows against a real API
	WILDSTRING_TEST_BROWSE_LIBRARY=1 npm --prefix frontend/web run test -- browse-real.spec.ts

test-transcoding-web: build-web ## Verify real AAC playback and seeking (requires FFmpeg)
	@if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then WILDSTRING_TEST_TRANSCODING=1 npm --prefix frontend/web run test -- transcoding.spec.ts; else echo "AAC browser tests skipped: install FFmpeg or run on CI."; fi

web-test-server: ## Internal: serve a disposable library for browser tests
	$(RUN) python scripts/serve_web_tests.py

.PHONY: dependency-audit
dependency-audit: ## Audit complete Web and provider npm lockfiles, including build dependencies
	npm --prefix frontend/web audit --audit-level=low
	npm --prefix plugins/node-runtime audit --audit-level=low

ci: check source-plugins dependency-audit test test-web test-large-web test-browse-web test-transcoding-web ## Run checks, backend tests, Web build and browser tests (install Chromium first)
	$(UV) lock --check --project backend

health: ## Check the locally configured API readiness
	$(RUN) python -m wildstring.healthcheck

docker-config: env ## Validate resolved Compose configuration
	$(DOCKER) config --quiet

docker-build: env ## Build backend image with the React Web UI
	$(DOCKER) build

docker-up: docker-build ## Build and start the local container; wait for health
	$(DOCKER) up -d --no-build --wait --wait-timeout 60

docker-test: env ## Run all backend tests with the container FFmpeg
	WILDSTRING_IMAGE=$(TEST_RUNTIME_IMAGE) $(DOCKER) build
	docker build --target builder -f deploy/Dockerfile --build-arg HTTP_PROXY="$(DOCKER_HTTP_PROXY)" --build-arg HTTPS_PROXY="$(DOCKER_HTTPS_PROXY)" -t $(TEST_BUILDER_IMAGE) .
	WILDSTRING_TEST_RUNTIME_IMAGE=$(TEST_RUNTIME_IMAGE) WILDSTRING_TEST_BUILDER_IMAGE=$(TEST_BUILDER_IMAGE) WILDSTRING_TEST_IMAGE=$(TEST_IMAGE) $(DOCKER) -f deploy/compose.tests.yaml build tests
	WILDSTRING_TEST_RUNTIME_IMAGE=$(TEST_RUNTIME_IMAGE) WILDSTRING_TEST_BUILDER_IMAGE=$(TEST_BUILDER_IMAGE) WILDSTRING_TEST_IMAGE=$(TEST_IMAGE) $(DOCKER) -f deploy/compose.tests.yaml run --rm --no-deps tests

docker-pull: env ## Pull and run WILDSTRING_IMAGE configured in .env
	$(DOCKER) pull
	$(DOCKER) up -d --no-build --wait --wait-timeout 60

docker-down: env ## Stop the project; preserve its data volume
	$(DOCKER) down

docker-status: env ## Show project container status
	$(DOCKER) ps

docker-logs: env ## Follow application logs
	$(DOCKER) logs $(LOG_ARGS)

docker-smoke: env ## Verify HTTP, packaged Web, FFmpeg, UID and music mount
	$(DOCKER) exec -T api python -m wildstring.smokecheck

docker-scan: env ## Rescan the persistent managed library
	$(DOCKER) exec -T api python -m wildstring.scan $(SCAN_ARGS)

docker-import: env ## Import from the read-only source into the persistent managed library
	$(DOCKER) exec -T api python -m wildstring.import_music $(SCAN_ARGS)

docker-admin: env ## Set/reset the container administrator password interactively
	$(DOCKER) exec api python -m wildstring.admin

fingerprint-check: ## Check the optional native Chromaprint fingerprint tool
	fpcalc -version

.PHONY: mcp test-agent test-network
mcp: ## Run the stdio MCP bridge (URL and scoped token must be environment variables)
	@$(RUN) python -m wildstring.mcp_bridge

test-agent: ## Verify controlled tools, drafts, notifications, inspection and the real MCP protocol
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_agent*.py backend/tests/test_mcp_bridge.py backend/tests/test_diagnostics.py backend/tests/test_task_notifications.py

test-network: ## Verify probes and production requests share actual proxy and model clients
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_outbound.py backend/tests/test_provider_network.py backend/tests/test_ai_config.py

.PHONY: test-research
test-research: ## Verify model protocols, live-search contracts, summaries and user-owned memories
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_agent_research.py
