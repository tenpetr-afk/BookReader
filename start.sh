#!/usr/bin/env bash
# start.sh - Spuštění aplikace LuminaReader
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Zkontrolujeme existenci ukázkové knihy
if [ ! -f "public/sample-books/rur.epub" ]; then
    echo "Generuji vzorovou knihu..."
    python3 generate_sample_book.py
fi

# Ukončíme případné předchozí visící instance server.py, aby se uvolnily porty
pkill -f "python3.*server\.py" 2>/dev/null || true

echo "Spouštím server LuminaReader..."
python3 server.py "$@"

