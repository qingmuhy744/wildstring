SHELL := /bin/bash
.DEFAULT_GOAL := help

UV ?= uv
PYTHON ?= python3
COMPOSE ?= docker compose
PROJECT ?= wildstring
LOG_ARGS ?= -f --tail=100
export UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
export PRE_COMMIT_HOME ?= $(CURDIR)/.cache/pre-commit
RUN = $(UV) run --frozen --project backend
DOCKER = $(COMPOSE) --project-directory "$(CURDIR)" --env-file .env -p "$(PROJECT)" -f deploy/compose.yaml

.PHONY: help env setup sync dev dev-web check hooks-check lint format format-check security test build-web ci health docker-config docker-build docker-up docker-pull docker-down docker-status docker-logs docker-smoke

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

ci: check test build-web ## Run the same checks as GitHub Actions
	$(UV) lock --check --project backend

health: ## Check the locally configured API readiness
	$(RUN) python -m wildstring.healthcheck

docker-config: env ## Validate resolved Compose configuration
	$(DOCKER) config --quiet

docker-build: env ## Build backend image with the React Web UI
	$(DOCKER) build

docker-up: docker-build ## Build and start the local container; wait for health
	$(DOCKER) up -d --no-build --wait --wait-timeout 60

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
