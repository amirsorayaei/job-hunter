#!/bin/bash
# Prep's one-step render + verify (CLAUDE.md steps 5-6 in a single command):
#   render-check.sh <content.py> <out.pdf>
# Renders with tools/generate_pdf.py, prints the page count, then the PDF text
# (pdftotext -layout) so order, garbling and keywords can be checked in one turn.
set -u
JH="$(cd "$(dirname "$0")/../../.." && pwd)"
"$JH/.venv/bin/python" "$JH/tools/generate_pdf.py" --content "$1" --out "$2" || { echo "RENDER FAILED"; exit 1; }
pdfinfo "$2" | grep Pages
echo "--- pdftotext ---"
pdftotext -layout "$2" -
