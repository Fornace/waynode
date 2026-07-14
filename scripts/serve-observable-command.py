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
    protocol_version = "HTTP/1.1"

    def write_chunk(self, value: str):
        data = value.encode()
        self.wfile.write(f"{len(data):X}\r\n".encode())
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path != f"/run/{TOKEN}":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
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
                self.write_chunk(line)
            code = process.wait()
            self.write_chunk(f"__EXIT__={code}\n")
            if code == 0:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                # An incomplete chunked response makes curl fail too, so the
                # durable workflow cannot mistake a failed child for success.
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            process.terminate()
            process.wait(timeout=10)
        finally:
            self.server.shutdown()

    def log_message(self, format, *args):
        sys.stderr.write((format % args) + "\n")


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
