#!/usr/bin/env python3
"""Serve ``_preview/`` with caching disabled.

The stock ``python -m http.server`` sends Last-Modified and no cache policy,
and browsers then reuse cached ES modules and stylesheets across reloads --
so you edit a file, refresh, and see the old page with no indication that
anything is stale. That wastes more time than it saves.

    python3 tools/serve.py [port]
"""

import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "_preview"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):        # keep the terminal readable
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    if not ROOT.is_dir():
        print(f"{ROOT} does not exist -- run tools/preview.py first")
        return 1
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {ROOT} at http://localhost:{port}/  (caching disabled)")
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
