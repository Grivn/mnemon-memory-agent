#!/bin/bash
# Build the paper: regenerate tables and figures from data/, then compile main.pdf.
#   TECTONIC=/path/to/tectonic PYTHON=/path/to/python-with-matplotlib bash docs/paper/build.sh [--no-data]
#   TEXLIVE_IMAGE=texlive/texlive:TL2025-historic bash docs/paper/build.sh [--no-data]
# With --no-data the tables and figures already in tables/ and figures/ are used as they are.
# By default main.pdf is compiled with Tectonic (XeLaTeX). With TEXLIVE_IMAGE set, it is compiled with pdfLaTeX and
# BibTeX in that TeX Live Docker image instead, as arXiv compiles it (TeX Live 2025 by default).
set -euo pipefail
cd "$(dirname "$0")"
TECTONIC=${TECTONIC:-tectonic}
PYTHON=${PYTHON:-python3}
if [ "${1:-}" != "--no-data" ]; then
  "$PYTHON" scripts/tables.py > /dev/null
  "$PYTHON" scripts/figures.py > /dev/null
fi
if [ -n "${TEXLIVE_IMAGE:-}" ]; then
  # The historic TeX Live images are built for amd64 only; other hosts run them emulated.
  docker run --rm --platform "${TEXLIVE_PLATFORM:-linux/amd64}" -v "$PWD:/paper" -w /paper "$TEXLIVE_IMAGE" sh -c \
    'pdflatex -interaction=nonstopmode -halt-on-error main.tex > /dev/null && bibtex main > /dev/null &&
     pdflatex -interaction=nonstopmode -halt-on-error main.tex > /dev/null &&
     pdflatex -interaction=nonstopmode -halt-on-error main.tex | grep -E "Output written|Warning.*undefined" || true'
  rm -f main.aux main.bbl main.out
else
  "$TECTONIC" -X compile main.tex --keep-logs
fi
