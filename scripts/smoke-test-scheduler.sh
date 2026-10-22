#!/usr/bin/env bash
# Smoke test: verify the built scheduler CLI responds to --version.
set -euo pipefail

node apps/cli/dist/index.js --version
