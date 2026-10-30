#!/usr/bin/env bash
# start.sh - Spuštění aplikace LuminaReader
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Ukončíme případné předchozí visící instance server.py, aby se uvolnily porty
pkill -f "python3.*server\.py" 2>/dev/null || true

echo "Spouštím server LuminaReader..."
python3 server.py "$@"

