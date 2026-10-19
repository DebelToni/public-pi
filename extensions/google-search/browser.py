#!/usr/bin/env python3
"""Headed, private Chromium desktop and container-local CDP/VNC bridges."""
import os
import select
import socket
import socketserver
import subprocess
import time


class Bridge(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            upstream = socket.create_connection(("127.0.0.1", 9223), timeout=5)
        except OSError:
            return
        with upstream:
            sockets = (self.request, upstream)
            while True:
                ready, _, _ = select.select(sockets, [], [], 30)
                if not ready:
                    return
                for source in ready:
                    try:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
                    except OSError:
                        return


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(*args):
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    os.environ["DISPLAY"] = ":99"
    processes = [start("Xvfb", ":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp")]
    try:
        time.sleep(0.4)
        processes += [
            start("fluxbox"),
            start("x11vnc", "-display", ":99", "-rfbport", "5900", "-localhost",
                  "-rfbauth", "/secrets/vnc.pass", "-forever", "-shared", "-noxdamage"),
            start("websockify", "--web", "/usr/share/novnc", "0.0.0.0:6080", "127.0.0.1:5900"),
            start("/usr/lib/chromium/chromium", "--no-sandbox", "--disable-dev-shm-usage",
                  "--no-first-run", "--no-default-browser-check", "--user-data-dir=/profile",
                  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223",
                  "--window-size=1400,850", "https://www.google.com/"),
        ]
        with Server(("0.0.0.0", 9222), Bridge) as server:
            server.timeout = 2
            while all(process.poll() is None for process in processes):
                server.handle_request()
            raise RuntimeError("Browser desktop component stopped")
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in reversed(processes):
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
