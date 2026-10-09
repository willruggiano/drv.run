set quiet
set script-interpreter := ["bash", "-euo", "pipefail"]

# List available recipes
default:
    just --list

# Run lightweight, Nix-agnostic checks
check:
    just --fmt --check
    treefmt --quiet --fail-on-change
    markdownlint-cli2 >/dev/null
    ast-grep scan --error --report-style=short
    tsc -p nix/packages/pi/extensions/tsconfig.json
    oxlint --type-aware --format=unix
    ruff format --quiet --check
    ruff check --quiet
    basedpyright --threads=4 --warnings **/*.py

# Run the CI suite, including full Nix validation
ci: check test
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v nix >/dev/null 2>&1; then
        printf '%s\n' \
            'Nix verification not run: nix is unavailable.' \
            'Run outside the jail: nix flake check' >&2
        exit 1
    fi
    nix flake check -L

# Apply the fixable variants of the check commands
fix:
    oxlint --type-aware --format=unix --fix
    markdownlint-cli2 --fix >/dev/null
    treefmt --quiet
    just --fmt
    ruff format --quiet
    ruff check --quiet --fix

# Run Node tests and Nix evaluation (requires nix)
test:
    #!/usr/bin/env bash
    set -euo pipefail
    ast-grep test --skip-snapshot-tests
    node --test "**/*.test.ts"
    python3 -B -m unittest discover -s nix.packages.bench.tests -p '*_test.py'
    if ! command -v nix >/dev/null 2>&1; then
        printf '%s\n' \
            'Nix verification not run: nix is unavailable.' \
            'Run outside the jail: nix flake check --no-build' >&2
        exit 1
    fi
    nix flake check --no-build

# Run updater scripts
update:
    ./scripts/update.sh
