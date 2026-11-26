SHELL := /bin/bash
.DEFAULT_GOAL := help

UV ?= uv
PYTHON ?= python3
COMPOSE ?= docker compose
PROJECT ?= wildstring
TEST_RUNTIME_IMAGE ?= wildstring:dev
TEST_BUILDER_IMAGE ?= wildstring-builder:dev
TEST_IMAGE ?= wildstring-tests:dev
SKIP_RUNTIME_BUILD ?= 0
SKIP_WEB_BUILD ?= 0
WEB_TEST_ARGS ?=
LOG_ARGS ?= -f --tail=100
SCAN_ARGS ?=
PYTEST_ARGS ?=
IOS_DEVELOPMENT_TEAM ?=
-include .env.ios-local
export UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
export PRE_COMMIT_HOME ?= $(CURDIR)/.cache/pre-commit
RUN = $(UV) run --frozen --project backend --extra community-sources
ANDROID_JAVA_HOME ?= $(shell \
	if [ -n "$${JAVA_HOME:-}" ] && [ -x "$${JAVA_HOME}/bin/java" ] && "$${JAVA_HOME}/bin/java" -version 2>&1 | grep -q 'version "21\.'; then \
		printf '%s' "$${JAVA_HOME}"; \
	elif [ -x /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java ]; then \
		printf '%s' /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; \
	elif [ -x /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java ]; then \
		printf '%s' /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; \
	else \
		candidate=$$(/usr/libexec/java_home -v 21 2>/dev/null || true); \
		if [ -n "$$candidate" ] && [ -x "$$candidate/bin/java" ] && "$$candidate/bin/java" -version 2>&1 | grep -q 'version "21\.'; then \
			printf '%s' "$$candidate"; \
		elif command -v java >/dev/null 2>&1 && java -version 2>&1 | grep -q 'version "21\.'; then \
			java -XshowSettings:properties -version 2>&1 | sed -n 's/^[[:space:]]*java\.home = //p' | head -n 1; \
		fi; \
	fi)
ANDROID_SDK_DIR ?= $(shell \
	for candidate in "$${ANDROID_HOME:-}" "$${ANDROID_SDK_ROOT:-}" "$$HOME/Android/Sdk" "$$HOME/Library/Android/sdk" "/usr/local/lib/android/sdk"; do \
		if [ -n "$$candidate" ] && [ -d "$$candidate/platform-tools" ]; then printf '%s' "$$candidate"; break; fi; \
	done)
ANDROID = test -x "$(ANDROID_JAVA_HOME)/bin/java" && "$(ANDROID_JAVA_HOME)/bin/java" -version 2>&1 | grep -q 'version "21\.' || { echo "Android Gradle requires JDK 21; install JDK 21 or set ANDROID_JAVA_HOME" >&2; exit 1; }; $(if $(ANDROID_SDK_DIR),ANDROID_HOME="$(ANDROID_SDK_DIR)" ANDROID_SDK_ROOT="$(ANDROID_SDK_DIR)",) JAVA_HOME="$(ANDROID_JAVA_HOME)" PATH="$(ANDROID_JAVA_HOME)/bin:$$PATH" ./frontend/android/gradlew -p frontend/android --console=plain
ANDROID_TEST_ARGS ?=
ANDROID_TEST_CLASSES ?=
ANDROID_TEST_REPEAT ?= 1
ANDROID_TEST_RETRIES ?= 1
ANDROID_TEST_BACKEND ?=
DEV_WEB_HOST ?= 127.0.0.1
DOCKER = $(COMPOSE) --project-directory "$(CURDIR)" --env-file .env -p "$(PROJECT)" -f deploy/compose.yaml

.PHONY: help env setup sync dev dev-web android-design scan import-music admin check hooks-check lint format format-check security test build-web icons browser-install test-web test-large-web test-browse-web test-transcoding-web web-test-server shots ci health docker-config docker-build docker-up docker-pull docker-down docker-status docker-logs docker-smoke docker-scan docker-import docker-admin docker-test fingerprint-check

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  make %-17s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Create local .env and directories without overwriting settings
	$(PYTHON) scripts/setup.py

sync: ## Install locked Python and Web dependencies
	$(UV) sync --locked --project backend --extra community-sources
	npm --prefix frontend/web ci

.PHONY: source-plugins source-providers-check test-native-plugin
source-providers-check: ## Verify provider subsets against integrity-pinned upstream archives
	$(RUN) python scripts/vendor_source_providers.py --check

source-plugins: ## Package independently importable community source ZIPs
	npm --prefix plugins/node-runtime ci --ignore-scripts
	npm --prefix plugins/node-runtime test
	node scripts/build_source_runtimes.mjs
	$(RUN) python scripts/package_source_plugins.py

test-native-plugin: ## Compile a synthetic Nuitka module and test ZIP installation, invocation and upgrade
	$(UV) run --no-project --python 3.12 --with Nuitka==2.8.10 python -m nuitka --module --output-dir=.cache/plugin-native --remove-output --no-pyi-file tests/fixtures/plugins/native_core.py
	WILDSTRING_NATIVE_PLUGIN_DIR="$(CURDIR)/.cache/plugin-native" $(RUN) pytest -c backend/pyproject.toml backend/tests/test_source_plugins.py -k native_module -q

setup: env sync ## Set up dependencies and install the local Git hook
	$(RUN) pre-commit install --install-hooks

dev: env ## Run the Python API at 127.0.0.1:18780 with reload
	$(RUN) python -m wildstring

dev-web: ## Run React at 127.0.0.1:18781 with an API proxy
	npm --prefix frontend/web run dev -- --host "$(DEV_WEB_HOST)"

android-design: ## Preview the Android design at http://127.0.0.1:18782/android-v1.html
	$(RUN) python -m http.server 18782 --bind 127.0.0.1 --directory docs/design

.PHONY: android-check android-test android-assemble android-codeql android-package android-ci android-connected-test android-instrumented-test android-test-api android-locks android-release android-release-smoke
android-check: ## Run Android Lint (requires JDK 21 and Android SDK 37)
	$(ANDROID) :app:lintDebug

android-test: ## Run Android unit tests and compile instrumented tests
	$(ANDROID) :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin

android-assemble: ## Build an installable debug APK
	$(ANDROID) :app:assembleDebug

android-codeql: ## Compile Kotlin without incremental or build caches for CodeQL extraction
	$(ANDROID) --no-daemon --no-build-cache --rerun-tasks -Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process :app:assembleDebug

android-package: android-assemble ## Copy APK and SHA256SUMS into artifacts/android
	$(PYTHON) scripts/package_android.py

android-ci: ## Check, test and package the native Android application
	$(ANDROID) :app:assembleDebug :app:testDebugUnitTest :app:compileDebugAndroidTestKotlin :app:lintDebug :app:assembleRelease :app:lintRelease
	$(PYTHON) scripts/package_android.py

android-release: ## Build and verify a signed release APK (requires ANDROID signing environment)
	@test -n "$$ANDROID_KEYSTORE_PATH" -a -n "$$ANDROID_KEYSTORE_PASSWORD" -a -n "$$ANDROID_KEY_ALIAS" -a -n "$$ANDROID_KEY_PASSWORD" || (echo "Missing Android release signing configuration" >&2; exit 1)
	$(ANDROID) :app:assembleRelease :app:lintRelease
	"$(ANDROID_HOME)/build-tools/36.1.0/apksigner" verify --verbose --print-certs frontend/android/app/build/outputs/apk/release/app-release.apk
	$(PYTHON) scripts/package_android.py --variant release

android-release-smoke: ## Install and smoke-test the signed release APK on a disposable device
	$(PYTHON) scripts/smoke_android_release.py

android-test-api: ## Start a disposable synthetic API for local Android regression
	WILDSTRING_WEB_TEST_PORT=19885 WILDSTRING_TEST_LARGE_LIBRARY=1 WILDSTRING_TEST_API_ONLY=1 $(RUN) python scripts/serve_web_tests.py

android-connected-test: ## Run native UI/playback tests on a connected emulator/device
	rm -rf frontend/android/app/build/outputs/androidTest-results/connected/debug
	$(ANDROID) :app:connectedDebugAndroidTest $(ANDROID_TEST_ARGS)
	$(PYTHON) scripts/check_android_test_results.py

android-instrumented-test: ## Run native UI tests one class per process with class-level retries (device required)
	$(ANDROID) :app:assembleDebug :app:assembleDebugAndroidTest
	$(PYTHON) scripts/run_android_instrumented.py --classes "$(ANDROID_TEST_CLASSES)" --repeat $(ANDROID_TEST_REPEAT) --retries $(ANDROID_TEST_RETRIES) $(if $(ANDROID_TEST_BACKEND),--arg realBackend=$(ANDROID_TEST_BACKEND))

ANDROID_EMU_AVD ?= wildstring-phone
ANDROID_EMU_PORT ?= 5566
ANDROID_EMU_WINDOW ?= 0

.PHONY: android-emu android-emu-pad android-emu-stop
android-emu: ## Start/reuse Phone emulator (headless, 4 cores) and install debug APK
	@set -euo pipefail; \
	sdk="$(ANDROID_SDK_DIR)"; \
	emu="$$sdk/emulator/emulator"; adb="$$sdk/platform-tools/adb"; \
	test -x "$$emu" || { echo "Android emulator not found under ANDROID_SDK_DIR (got '$$sdk')" >&2; exit 1; }; \
	test -x "$$adb" || { echo "adb not found under ANDROID_SDK_DIR (got '$$sdk')" >&2; exit 1; }; \
	serial="emulator-$(ANDROID_EMU_PORT)"; \
	"$$adb" start-server; \
	if ! "$$adb" devices | awk 'NR > 1 && $$2 == "device" { print $$1 }' | grep -qx "$$serial"; then \
		test -f "$$HOME/.android/avd/$(ANDROID_EMU_AVD).avd/config.ini" || { echo "AVD $(ANDROID_EMU_AVD) not found in $$HOME/.android/avd/" >&2; exit 1; }; \
		echo "Starting AVD $(ANDROID_EMU_AVD) on $$serial (window=$(ANDROID_EMU_WINDOW))..."; \
		nohup "$$emu" -avd "$(ANDROID_EMU_AVD)" -port "$(ANDROID_EMU_PORT)" -cores 4 \
			-gpu swiftshader -feature -Vulkan -no-snapshot -no-boot-anim -no-metrics \
			$(if $(filter 1,$(ANDROID_EMU_WINDOW)),,-no-window) \
			>"/tmp/$(ANDROID_EMU_AVD).log" 2>&1 & \
		"$$adb" -s "$$serial" wait-for-device; \
		deadline=$$((SECONDS + 180)); \
		while [ "$$SECONDS" -lt "$$deadline" ]; do \
			if [ "$$("$$adb" -s "$$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && \
				"$$adb" -s "$$serial" shell am get-started-user-state 0 2>/dev/null | tr -d '\r' | grep -qx RUNNING_UNLOCKED && \
				"$$adb" -s "$$serial" shell pm path android >/dev/null 2>&1; then \
				break; \
			fi; \
			sleep 2; \
		done; \
		"$$adb" -s "$$serial" shell pm path android >/dev/null 2>&1 || { echo "AVD $(ANDROID_EMU_AVD) did not become ready within 180s; see /tmp/$(ANDROID_EMU_AVD).log" >&2; exit 1; }; \
		"$$adb" -s "$$serial" shell wm dismiss-keyguard >/dev/null 2>&1 || true; \
		"$$adb" -s "$$serial" shell input keyevent 82 >/dev/null 2>&1 || true; \
	fi
	$(ANDROID) :app:assembleDebug
	@"$(ANDROID_SDK_DIR)/platform-tools/adb" -s "emulator-$(ANDROID_EMU_PORT)" install -r -t -g frontend/android/app/build/outputs/apk/debug/app-debug.apk
	@"$(ANDROID_SDK_DIR)/platform-tools/adb" -s "emulator-$(ANDROID_EMU_PORT)" shell am start -n com.wildstring.app.dev/com.wildstring.app.MainActivity
	@echo "Ready: emulator-$(ANDROID_EMU_PORT) ($(ANDROID_EMU_AVD)) -> com.wildstring.app.dev"

android-emu-pad: ## Start/reuse Pad emulator (2560x1600) and install debug APK
	$(MAKE) android-emu ANDROID_EMU_AVD=wildstring-pad ANDROID_EMU_PORT=5568

android-emu-stop: ## Stop running local Android emulators
	@adb_bin="$(ANDROID_SDK_DIR)/platform-tools/adb"; \
	test -x "$$adb_bin" || adb_bin="$$(command -v adb || true)"; \
	test -n "$$adb_bin" || { echo "adb not found" >&2; exit 1; }; \
	for s in $$("$$adb_bin" devices | awk 'NR > 1 && $$1 ~ /^emulator-/ { print $$1 }'); do \
		echo "Stopping $$s..."; \
		"$$adb_bin" -s "$$s" emu kill >/dev/null 2>&1 || true; \
	done

android-locks: ## Refresh Android dependency locks and SHA-256 verification metadata
	$(ANDROID) :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest --write-locks --write-verification-metadata sha256
	$(ANDROID) :app:assembleRelease :app:lintRelease --write-locks --write-verification-metadata sha256

.PHONY: ios-gen ios-test ios-build
ios-gen: ## Generate the iOS Xcode project from frontend/ios/project.yml (requires XcodeGen)
	cd frontend/ios && WILDSTRING_DEVELOPMENT_TEAM="$(IOS_DEVELOPMENT_TEAM)" xcodegen generate

ios-test: ## Run the iOS core package unit tests
	swift test --package-path frontend/ios/WildStringKit

ios-build: ios-gen ## Build the iOS app for the simulator
	xcodebuild -project frontend/ios/WildString.xcodeproj -scheme WildString -destination 'generic/platform=iOS Simulator' -derivedDataPath artifacts/ios-derived.noindex build

.PHONY: ios-ui-test
IOS_TEST_DESTINATION ?= platform=iOS Simulator,name=iPhone 17 Pro
ios-ui-test: ios-gen ## Render iOS player states and sample transport motion on a simulator
	xcodebuild -project frontend/ios/WildString.xcodeproj -scheme WildString -destination '$(IOS_TEST_DESTINATION)' -derivedDataPath artifacts/ios-ui-tests.noindex CODE_SIGNING_ALLOWED=NO -parallel-testing-enabled NO test

.PHONY: macos-gen macos-build macos-dmg macos-test
MACOS_CONFIGURATION ?= Debug

macos-gen: ## Generate the Mac Xcode project from frontend/macos/project.yml (requires XcodeGen)
	cd frontend/macos && xcodegen generate

macos-build: macos-gen ## Build the Mac app
	xcodebuild -project frontend/macos/WildStringMac.xcodeproj -scheme WildString -destination 'platform=macOS' -configuration $(MACOS_CONFIGURATION) -derivedDataPath artifacts/macos-derived.noindex CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES ENABLE_HARDENED_RUNTIME=YES build

macos-dmg: ## Pack the Mac app into a DMG under artifacts/
	$(MAKE) macos-build MACOS_CONFIGURATION=Release
	bash scripts/package_macos_dmg.sh

macos-test: macos-gen ## Run native Mac assistant regression tests
	xcodebuild -project frontend/macos/WildStringMac.xcodeproj -scheme WildString -destination 'platform=macOS' -configuration Debug -derivedDataPath artifacts/macos-test-derived.noindex CODE_SIGN_IDENTITY=- test

.PHONY: clean-macos clean
clean-macos: ## Remove macOS build outputs and unregister debug apps
	rm -rf artifacts/macos-derived* artifacts/macos-test-derived* frontend/macos/DerivedData*
	@/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u artifacts/macos-derived*/Build/Products/*/*.app 2>/dev/null || true

clean: clean-macos ## Clean build artifacts
	rm -rf artifacts/*.noindex dist/ build/

scan: env ## Rescan the managed library; use SCAN_ARGS=--full to refresh all tags
	$(RUN) python -m wildstring.scan $(SCAN_ARGS)

import-music: env ## Copy and organize source music into the managed library, then scan
	$(RUN) python -m wildstring.import_music $(SCAN_ARGS)

upload-music: ## Upload a local folder or file via CLI (e.g. make upload-music TARGET=/path/to/music)
	@test -n "$(TARGET)" || (echo "Usage: make upload-music TARGET=/path/to/music [SERVER=http://127.0.0.1:8000]" >&2; exit 1)
	$(PYTHON) scripts/upload_music.py "$(TARGET)" $${SERVER:+--server "$$SERVER"}

admin: env ## Set/reset admin password interactively; revoke existing sessions
	$(RUN) python -m wildstring.admin

hooks-check: ## Check tracked and new project files
	$(RUN) python scripts/run_pre_commit.py

check: hooks-check ## Run pre-commit, including Ruff, security and Web checks

CODEQL_LANGS ?=

.PHONY: codeql-local
codeql-local: ## Run CodeQL locally with the CI query configuration
	python3 scripts/run_codeql_local.py $(if $(CODEQL_LANGS),--languages "$(CODEQL_LANGS)")

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

test: ## Run backend tests without external services (PYTEST_ARGS="-n auto" runs them in parallel)
	$(RUN) pytest -c backend/pyproject.toml backend/tests $(PYTEST_ARGS)

build-web: ## Build the versioned Web release input
	if [ "$(SKIP_WEB_BUILD)" != "1" ]; then npm --prefix frontend/web run build; fi

icons: ## Regenerate the transparent favicon from its SVG source (requires Chromium)
	npm --prefix frontend/web run icons

browser-install: ## Install Chromium for the Web integration tests
	npm --prefix frontend/web exec -- playwright install chromium

.PHONY: test-affected test-affected-desktop
test-affected: ## Detect stale test assertions and run backend/Web tests affected by current git changes
	$(RUN) python scripts/test_affected.py --fail-on-stale --run

test-affected-desktop: ## Fast local run of affected backend tests and desktop Playwright specs
	$(RUN) python scripts/test_affected.py --fail-on-stale --run --desktop-only

test-web: build-web ## Test login, search, playback and mobile UI with an isolated fixture library
	npm --prefix frontend/web run test $(if $(WEB_TEST_ARGS),-- $(WEB_TEST_ARGS))

.PHONY: test-podcast-web
.PHONY: test-podcast-publishers test-publisher-web
test-podcast-publishers: ## Verify shared podcast publisher assignments and account isolation
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_podcast_publishers.py backend/tests/test_podcasts.py backend/tests/test_podcast_progress.py

test-publisher-web: build-web ## Verify publisher confirmation, correction and browsing on desktop/mobile
	WILDSTRING_TEST_PODCAST=1 WILDSTRING_TEST_PUBLISHERS=1 npm --prefix frontend/web run test -- podcast-publishers.spec.ts $(WEB_TEST_ARGS)

.PHONY: test-storage test-multiple-libraries test-libraries-web
test-storage: ## Verify safe managed-directory migrations and personal podcast resource collection
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_storage_resources.py

test-multiple-libraries: ## Verify grants, cross-library playlists, personal follows and shared cache retention
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_multiple_libraries.py backend/tests/test_storage_resources.py backend/tests/test_podcast_follows.py backend/tests/test_podcast_progress.py backend/tests/test_podcast_user_settings.py

test-libraries-web: build-web ## Verify library selection, owner configuration, grants and personal podcast follows
	WILDSTRING_TEST_LIBRARIES=1 WILDSTRING_TEST_PODCAST=1 npm --prefix frontend/web run test -- music-libraries.spec.ts $(WEB_TEST_ARGS)

test-podcast-web: build-web ## Verify radio playback, episode downloads, directory search, OPML and identity management
	WILDSTRING_TEST_PODCAST=1 npm --prefix frontend/web run test -- podcast-continuation.spec.ts podcast-player.spec.ts podcast-presentation.spec.ts podcast-episode.spec.ts podcast-progress.spec.ts personal-settings.spec.ts podcast-search.spec.ts podcast-search-settings.spec.ts podcast-opml.spec.ts podcast-identity-admin.spec.ts ui-design-standards.spec.ts $(WEB_TEST_ARGS)

test-large-web: build-web ## Verify real API pagination and continuous playback with 257 album tracks
	WILDSTRING_TEST_LARGE_LIBRARY=1 npm --prefix frontend/web run test -- multipage-real.spec.ts $(WEB_TEST_ARGS)

test-browse-web: build-web ## Verify continuous browsing, pinyin jumps and compact album rows against a real API
	WILDSTRING_TEST_BROWSE_LIBRARY=1 npm --prefix frontend/web run test -- browse-real.spec.ts $(WEB_TEST_ARGS)

test-catalog-web: build-web ## Verify sorting, remembered preferences and continuous multi-disc playback
	WILDSTRING_TEST_DISC_LIBRARY=1 npm --prefix frontend/web run test -- catalog-sort-real.spec.ts $(WEB_TEST_ARGS)

test-transcoding-web: build-web ## Verify real AAC playback and seeking (requires FFmpeg)
	@if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then WILDSTRING_TEST_TRANSCODING=1 npm --prefix frontend/web run test -- transcoding.spec.ts $(WEB_TEST_ARGS); else echo "AAC browser tests skipped: install FFmpeg or run on CI."; fi

web-test-server: ## Internal: serve a disposable library for browser tests
	$(RUN) python scripts/serve_web_tests.py

shots: ## Capture screenshots through scripts/agent_shot.sh
	bash scripts/agent_shot.sh $(ARGS)

.PHONY: dependency-audit
dependency-audit: ## Audit complete Web and provider npm lockfiles, including build dependencies
	$(PYTHON) scripts/audit_web_dependencies.py
	npm --prefix plugins/node-runtime audit --audit-level=low

ci: check source-plugins dependency-audit test test-web test-podcast-web test-publisher-web test-libraries-web test-large-web test-browse-web test-catalog-web test-transcoding-web ## Run checks, backend tests, Web build and browser tests (install Chromium first)
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
	if [ "$(SKIP_RUNTIME_BUILD)" != "1" ]; then WILDSTRING_IMAGE=$(TEST_RUNTIME_IMAGE) $(DOCKER) build; fi
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

.PHONY: mcp mcp-remote-smoke test-agent test-network
mcp: ## Run the stdio MCP bridge (URL and scoped token must be environment variables)
	@$(RUN) python -m wildstring.mcp_bridge

mcp-remote-smoke: ## Check a deployed Streamable HTTP MCP endpoint with a scoped token
	$(RUN) python scripts/mcp_remote_smoke.py

test-agent: ## Verify controlled tools, drafts, notifications, inspection and the real MCP protocol
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_agent*.py backend/tests/test_mcp*.py backend/tests/test_diagnostics.py backend/tests/test_task_notifications.py

test-network: ## Verify probes and production requests share actual proxy and model clients
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_outbound.py backend/tests/test_provider_network.py

.PHONY: test-research
test-research: ## Verify model protocols, live-search contracts, summaries and user-owned memories
	$(RUN) pytest -c backend/pyproject.toml backend/tests/test_agent_research.py

.PHONY: test-mcp-setup
test-mcp-setup: ## Check external-client MCP templates without credentials or external services
	node --experimental-strip-types --test frontend/web/tests/mcp-setup.node.mjs
