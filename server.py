#!/usr/bin/env python3
"""
server.py
Lokální HTTP server pro LuminaReader.
Automaticky obsluhuje statické soubory ze složky 'public'
a při spuštění otevře výchozí webový prohlížeč.
"""

import http.server
import socketserver
import os
import sys
import webbrowser
import threading
import mimetypes

PORT = 8000
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = ROOT_DIR if os.path.exists(os.path.join(ROOT_DIR, "index.html")) else os.path.join(ROOT_DIR, "public")

# Zajistíme správné MIME typy
mimetypes.add_type("application/epub+zip", ".epub")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")

class ReaderHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        # Přidáme hlavičky proti nechtěnému cachování při vývoji
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # CORS pro lokální blob a worker operace
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, format, *args):
        # Tiché logování, nevypisujeme každý drobný dotaz
        if any(code in args[1] for code in ["404", "500"]):
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

def open_browser():
    url = f"http://localhost:{PORT}"
    print(f"Otevírám aplikaci v prohlížeči: {url}")
    webbrowser.open(url)

def main():
    if not os.path.exists(PUBLIC_DIR):
        print(f"Chyba: Adresář '{PUBLIC_DIR}' neexistuje!")
        sys.exit(1)

    os.chdir(PUBLIC_DIR)
    
    # Povolit znovupoužití adresy
    socketserver.TCPServer.allow_reuse_address = True
    
    # Seznam kandidátních portů (začíná 8000, 8080, pak další volné porty)
    candidate_ports = [8000, 8080] + list(range(8001, 8020)) + list(range(8081, 8100))
    httpd = None
    active_port = None

    for port in candidate_ports:
        try:
            httpd = socketserver.TCPServer(("", port), ReaderHTTPRequestHandler)
            active_port = port
            break
        except OSError as e:
            if e.errno == 48:  # Address already in use
                continue
            else:
                raise e

    if not httpd:
        print("Chyba: Nepodařilo se nalézt žádný volný síťový port v rozsahu 8000-8100.")
        sys.exit(1)

    url = f"http://localhost:{active_port}"
    print("\n" + "="*50)
    print("  📖 LuminaReader Server běží")
    print(f"  Adresa: {url}")
    print("  Stiskněte Ctrl+C pro ukončení serveru.")
    print("="*50 + "\n")

    # Otevřít prohlížeč po 0.8 sekundy
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer byl bezpečně ukončen.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
