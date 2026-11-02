#!/usr/bin/env python3
"""
bump_version.py - Nástroj pro správu verze a cache-busting v LuminaReader.
Aktualizuje APP_VERSION v app.js a dotazy ?v=<verze> ve všech HTML a JS importech
jak v kořenovém adresáři, tak v adresáři 'public/'.
"""

import re
import sys
import os

FILES_TO_UPDATE = [
    "index.html",
    "public/index.html",
    "js/app.js",
    "public/js/app.js",
    "js/supabase-sync.js",
    "public/js/supabase-sync.js",
    "js/tracker.js",
    "public/js/tracker.js",
    "js/epub-parser.js",
    "public/js/epub-parser.js",
    "js/storage.js",
    "public/js/storage.js",
    "js/pdf-loader.js",
    "public/js/pdf-loader.js",
]

def bump_version(new_version: str):
    new_version = new_version.lstrip("v")
    print(f"Aktualizuji verzi projektu na: v{new_version}")

    base_dir = os.path.dirname(os.path.abspath(__file__))

    for rel_path in FILES_TO_UPDATE:
        path = os.path.join(base_dir, rel_path)
        if not os.path.isfile(path):
            print(f"Varování: Soubor {rel_path} nenalezen, přeskakuji.")
            continue

        with open(path, "r", encoding="utf-8") as f:
            content = f.read()

        orig_content = content

        # 1. HTML soubory
        if rel_path.endswith(".html"):
            # Aktualizace CSS: href="./css/style.css?v=..." nebo href="css/style.css?v=..."
            content = re.sub(
                r'href="(\.?/css/[^"?]+)(?:\?v=[^"]*)?"',
                rf'href="\1?v={new_version}"',
                content
            )
            # Aktualizace JS scriptu: src="./js/app.js?v=..."
            content = re.sub(
                r'src="(\.?/js/app\.js)(?:\?v=[^"]*)?"',
                rf'src="\1?v={new_version}"',
                content
            )

        # 2. JS soubory
        elif rel_path.endswith(".js"):
            # APP_VERSION = "v..."
            content = re.sub(
                r'export const APP_VERSION\s*=\s*"v[^"]*";',
                f'export const APP_VERSION = "v{new_version}";',
                content
            )
            # Statické importy: from "./xxx.js?v=..." nebo from './xxx.js?v=...'
            content = re.sub(
                r'(from\s+[\'"]\./[^\'"]+?\.js)(?:\?v=[^\'"]*)?([\'"])',
                rf'\1?v={new_version}\2',
                content
            )
            # Dynamické importy: import("./xxx.js?v=...") nebo import('./xxx.js?v=...')
            content = re.sub(
                r'(import\(\s*[\'"]\./[^\'"]+?\.js)(?:\?v=[^\'"]*)?([\'"]\s*\))',
                rf'\1?v={new_version}\2',
                content
            )

        if content != orig_content:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"✓ Upraveno: {rel_path}")
        else:
            print(f"- Beze změny: {rel_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Použití: python3 bump_version.py <verze> (např. 2.2.6)")
        sys.exit(1)
    bump_version(sys.argv[1])
