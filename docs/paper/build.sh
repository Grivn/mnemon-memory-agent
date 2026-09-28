#!/bin/bash
# Build the paper: regenerate tables and figures from data/, then compile main.pdf with Tectonic.
#   TECTONIC=/path/to/tectonic PYTHON=/path/to/python-with-matplotlib bash docs/paper/build.sh [--no-data]
# With --no-data the tables and figures already in tables/ and figures/ are used as they are.
set -euo pipefail
cd "$(dirname "$0")"
TECTONIC=${TECTONIC:-tectonic}
PYTHON=${PYTHON:-python3}
if [ "${1:-}" != "--no-data" ]; then
  "$PYTHON" scripts/tables.py > /dev/null
  "$PYTHON" scripts/figures.py > /dev/null
fi
"$TECTONIC" -X compile main.tex --keep-logs
