SHELL := /bin/bash
.DEFAULT_GOAL := help

UV ?= uv
PYTHON ?= python3
COMPOSE ?= docker compose
PROJECT ?= wildstring
LOG_ARGS ?= -f --tail=100
SCAN_ARGS ?=
export UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
export PRE_COMMIT_HOME ?= $(CURDIR)/.cache/pre-commit
RUN = $(UV) run --frozen --project backend
ANDROID = ./frontend/android/gradlew -p frontend/android --console=plain
DOCKER = $(COMPOSE) --project-directory "$(CURDIR)" --env-file .env -p "$(PROJECT)" -f deploy/compose.yaml

.PHONY: help env setup sync dev dev-web android-design scan import-music admin check hooks-check lint format format-check security test build-web icons browser-install test-web web-test-server ci health docker-config docker-build docker-up docker-pull docker-down docker-status docker-logs docker-smoke docker-scan docker-import docker-admin docker-test

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  make %-17s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Create local .env and directories without overwriting settings
	$(PYTHON) scripts/setup.py

sync: ## Install locked Python and Web dependencies
	$(UV) sync --locked --project backend
	npm --prefix frontend/web ci

setup: env sync ## Set up dependencies and install the local Git hook
	$(RUN) pre-commit install --install-hooks

dev: env ## Run the Python API at 127.0.0.1:18780 with reload
	$(RUN) python -m wildstring

dev-web: ## Run React at 127.0.0.1:18781 with an API proxy
	npm --prefix frontend/web run dev

android-design: ## Preview the Android design at http://127.0.0.1:18782/android-v1.html
	$(RUN) python -m http.server 18782 --bind 127.0.0.1 --directory docs/design

.PHONY: android-check android-test android-assemble android-package android-ci android-connected-test android-locks
android-check: ## Run Android Lint (requires JDK 21 and Android SDK 36.1)
	$(ANDROID) :app:lintDebug

android-test: ## Run Android unit tests
	$(ANDROID) :app:testDebugUnitTest

android-assemble: ## Build an installable debug APK
	$(ANDROID) :app:assembleDebug

android-package: android-assemble ## Copy APK and SHA256SUMS into artifacts/android
	$(PYTHON) scripts/package_android.py

android-ci: ## Check, test and package the native Android application
	$(ANDROID) :app:lintDebug :app:testDebugUnitTest :app:assembleDebug
	$(PYTHON) scripts/package_android.py

android-connected-test: ## Run native UI/playback tests on a connected emulator/device
	$(ANDROID) :app:connectedDebugAndroidTest

android-locks: ## Refresh Android dependency locks and SHA-256 verification metadata
	$(ANDROID) :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest --write-locks --write-verification-metadata sha256

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

web-test-server: ## Internal: serve a disposable library for browser tests
	$(RUN) python scripts/serve_web_tests.py

ci: check test test-web ## Run checks, backend tests, Web build and browser tests (install Chromium first)
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
	WILDSTRING_IMAGE=wildstring:dev $(DOCKER) build
	docker build --target builder -f deploy/Dockerfile -t wildstring-builder:dev .
	$(DOCKER) -f deploy/compose.tests.yaml build tests
	$(DOCKER) -f deploy/compose.tests.yaml run --rm --no-deps tests

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
