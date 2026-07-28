#!/usr/bin/env bash
# Smoke test: verify the built scheduler CLI responds to --version.
set -euo pipefail

node dist/index.js --version
