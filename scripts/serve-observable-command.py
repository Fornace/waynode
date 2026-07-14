#!/usr/bin/env python3
"""One-shot, loopback-only streaming bridge for a preconfigured command.

The reverse SSH tunnel binds the remote endpoint to loopback. A random path
token and a fixed command prevent this helper from becoming a general shell.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import subprocess
import sys


PORT = int(os.environ["WAYNODE_OBS_PORT"])
TOKEN = os.environ["WAYNODE_OBS_TOKEN"]
COMMAND = os.environ["WAYNODE_OBS_COMMAND"]
WORKDIR = os.environ["WAYNODE_OBS_WORKDIR"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != f"/run/{TOKEN}":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        process = subprocess.Popen(
            COMMAND,
            cwd=WORKDIR,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        try:
            for line in process.stdout:
                self.wfile.write(line.encode())
                self.wfile.flush()
            code = process.wait()
            self.wfile.write(f"__EXIT__={code}\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            process.terminate()
            process.wait(timeout=10)
        finally:
            self.server.shutdown()

    def log_message(self, format, *args):
        sys.stderr.write((format % args) + "\n")


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
