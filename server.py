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
import socket
import errno

PORT = 8000
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT_DIR, "public")
SERVE_DIR = PUBLIC_DIR if os.path.isdir(PUBLIC_DIR) else ROOT_DIR

# Zajistíme správné MIME typy
mimetypes.add_type("application/epub+zip", ".epub")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("application/pdf", ".pdf")
mimetypes.add_type("application/json", ".json")

class ReaderHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SERVE_DIR, **kwargs)

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
        if len(args) > 1 and any(code in str(args[1]) for code in ["404", "500"]):
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

def get_local_ip():
    """Získá lokální IP adresu v síti LAN (např. 192.168.x.x)"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Nemusí dojít ke skutečnému přenosu paketů
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"

def main():
    if not os.path.exists(SERVE_DIR):
        print(f"Chyba: Adresář '{SERVE_DIR}' neexistuje!")
        sys.exit(1)

    os.chdir(SERVE_DIR)
    
    # Povolit znovupoužití adresy
    socketserver.TCPServer.allow_reuse_address = True
    
    # Podpora pro volitelný port předaný jako argument
    target_port = None
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        target_port = int(sys.argv[1])

    # Seznam kandidátních portů (začíná specifikovaným portem nebo 8000, 8080, pak další volné porty)
    candidate_ports = [target_port] if target_port else [PORT, 8080] + list(range(8001, 8020)) + list(range(8081, 8100))
    httpd = None
    active_port = None

    for port in candidate_ports:
        try:
            # Vazba na 0.0.0.0 umožňuje přístup i z jiných zařízení na stejné Wi-Fi (iPhone, iPad, notebook)
            httpd = socketserver.TCPServer(("0.0.0.0", port), ReaderHTTPRequestHandler)
            active_port = port
            break
        except OSError as e:
            if e.errno in (errno.EADDRINUSE, 48, 98):  # Address already in use
                continue
            else:
                raise e

    if not httpd:
        print("Chyba: Nepodařilo se nalézt žádný volný síťový port.")
        sys.exit(1)

    local_url = f"http://localhost:{active_port}"
    lan_ip = get_local_ip()
    lan_url = f"http://{lan_ip}:{active_port}"

    print("\n" + "=" * 60)
    print("  📖 LuminaReader Server běží")
    print(f"  • Obsluhovaný adresář: {SERVE_DIR}")
    print(f"  • Lokální přístup (Mac):  {local_url}")
    if lan_ip and lan_ip != "127.0.0.1":
        print(f"  • Síťový přístup (LAN):   {lan_url}")
        print(f"    (iPhone / iPad na stejné Wi-Fi: otevřete {lan_url})")
    else:
        print(f"  • Síťový přístup (LAN):   {lan_url}")
    print("  Stiskněte Ctrl+C pro ukončení serveru.")
    print("=" * 60 + "\n")

    # Otevřít prohlížeč po 0.8 sekundy
    threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer byl bezpečně ukončen.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
