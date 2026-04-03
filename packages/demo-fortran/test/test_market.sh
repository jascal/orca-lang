#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
make run 2>&1
echo "demo-fortran: PASS"
