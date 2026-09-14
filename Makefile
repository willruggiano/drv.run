.DEFAULT_GOAL := help

.PHONY: help check test fix update

help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-8s %s\n", $$1, $$2}'

check: ## Run lightweight, Nix-agnostic checks
	@treefmt --quiet --fail-on-change
	@markdownlint-cli2 >/dev/null
	@tsc -p nix/packages/pi/extensions/tsconfig.json
	@oxlint --type-aware --format=unix

fix: ## Apply the fixable variants of the check commands
	@oxlint --type-aware --format=unix --fix
	@markdownlint-cli2 --fix >/dev/null
	@treefmt --quiet

pre-commit: check test ## Run pre-commit checks
	@nix flake check

test: ## Run the test suite
	@node --test "**/*.test.ts"
	@nix flake check --no-build

update: ## Run updater scripts
	@./scripts/update.sh
