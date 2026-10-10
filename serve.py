#!/usr/bin/env python3
"""Serve this folder for local testing.

    python3 serve.py            http://localhost:8000   (Mac webcam works: localhost counts as secure)
    python3 serve.py --https    https://<mac-ip>:8443   (for the iPhone on the same Wi-Fi)

--https makes a self-signed certificate with openssl the first time and keeps it in .cert/.
The iPhone will warn about the certificate once: tap "Show Details", then "visit this website".
"""
import argparse
import http.server
import pathlib
import socket
import ssl
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
CERT_DIR = ROOT / ".cert"


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    stamp = CERT_DIR / "ip.txt"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == ip:
        return cert, key
    CERT_DIR.mkdir(exist_ok=True)
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
         "-keyout", str(key), "-out", str(cert), "-subj", "/CN=squat-depth-local",
         "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
        check=True, capture_output=True)
    stamp.write_text(ip)
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".mjs": "text/javascript", ".task": "application/octet-stream"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # always pick up edits to index.html
        super().end_headers()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--https", action="store_true", help="serve HTTPS with a self-signed certificate")
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    ip = lan_ip()
    port = args.port or (8443 if args.https else 8000)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    if args.https:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f"On the iPhone (same Wi-Fi):  https://{ip}:{port}/")
        print(f"On this Mac:                 https://localhost:{port}/")
    else:
        print(f"On this Mac:   http://localhost:{port}/   (camera works here)")
        print(f"On the iPhone: http://{ip}:{port}/   (video-file test mode only; the camera needs --https)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
