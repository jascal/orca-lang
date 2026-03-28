#!/usr/bin/env bash
set -euo pipefail

# Find a suitable Python >= 3.10, preferring explicit versioned binaries.
# Usage: scripts/setup-python.sh
#   Creates .venv and installs runtime-python + demo-python (+ demo-nanolab if present).

MIN_MAJOR=3
MIN_MINOR=10

find_python() {
  # Try versioned binaries from newest to oldest, then fall back to python3
  for cmd in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$cmd" &>/dev/null; then
      echo "$cmd"
      return 0
    fi
  done
  return 1
}

check_version() {
  local cmd="$1"
  local version
  version=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null) || return 1
  local major minor
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)

  if [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }; then
    echo "$version"
    return 0
  fi
  return 1
}

PYTHON=$(find_python) || {
  echo "Error: No Python interpreter found. Install Python >= ${MIN_MAJOR}.${MIN_MINOR}."
  exit 1
}

VERSION=$(check_version "$PYTHON") || {
  actual=$("$PYTHON" --version 2>&1)
  echo "Error: $PYTHON is $actual but Python >= ${MIN_MAJOR}.${MIN_MINOR} is required."
  exit 1
}

echo "Using $PYTHON ($VERSION)"

# Create or re-use virtual environment
if [ -d .venv ]; then
  echo "Virtual environment .venv already exists, re-using it."
else
  echo "Creating virtual environment..."
  "$PYTHON" -m venv .venv
fi

echo "Installing packages..."
.venv/bin/pip install -q -e ./packages/runtime-python
.venv/bin/pip install -q -e ./packages/demo-python

# Install demo-nanolab if it exists
if [ -d ./packages/demo-nanolab ]; then
  .venv/bin/pip install -q -e ./packages/demo-nanolab
fi

echo "Done. Python environment ready at .venv/ (Python $VERSION)"
