#!/usr/bin/env python3
"""Fullscreen tmux image viewer. Graphics use the same direct Kitty path as shell cat."""

import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import termios
import tty

IMAGE_ID = 4294967294  # Reserved by the shell cat function.
GRAPHICS = re.compile(rb"\x1b_G.*?\x1b\\", re.DOTALL)
DELETE = f"\x1bPtmux;\x1b\x1b_Ga=d,d=I,i={IMAGE_ID},q=2\x1b\x1b\\\x1b\\".encode()


def send(data: bytes) -> None:
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def clear() -> None:
    send(DELETE + b"\x1b[2J\x1b[H")


def tmux_wrap(data: bytes, cols: int, rows: int) -> bytes:
    def wrap(match: re.Match[bytes]) -> bytes:
        command = match.group()
        if command.startswith(b"\x1b_Ga=T,"):
            header, payload = command.split(b";", 1)
            dimensions = dict((key, int(value)) for key, value in re.findall(rb"(?:^|,)([sv])=(\d+)", header))
            width, height = dimensions[b"s"], dimensions[b"v"]
            available_rows = max(1, rows - 2)
            # Only one axis: RootShell stretches images when both c and r are set.
            limit = f",c={cols}" if width * available_rows * 18 >= height * cols * 9 else f",r={available_rows}"
            command = header + limit.encode() + b";" + payload
        return b"\x1bPtmux;" + command.replace(b"\x1b", b"\x1b\x1b") + b"\x1b\\"

    return GRAPHICS.sub(wrap, data)


def kitten_args(path: str, cols: int, rows: int) -> list[str]:
    height = max(1, rows - 2)
    return [
        os.path.expanduser("~/bin/kitten"), "icat", "--align=left", "--fit=both", "--scale-up=yes", "--stdin=no",
        "--transfer-mode=stream", "--passthrough=none",
        f"--image-id={IMAGE_ID}",
        f"--use-window-size={cols},{rows},{cols * 9},{rows * 18}",
        f"--place={cols}x{height}@0x1", "--", path,
    ]


def draw(images: list[dict], position: int, note: str = "") -> None:
    clear()
    item = images[position]
    cols, rows = shutil.get_terminal_size()
    heading = f"IMAGE {item['id']} ({position + 1}/{len(images)})  {item['description']}"
    send(("\x1b[1;1H" + heading[:cols] + "\x1b[K").encode("utf-8", "replace"))
    try:
        result = subprocess.run(kitten_args(item["path"], cols, rows), capture_output=True, timeout=20)
        if result.returncode:
            note = result.stderr.decode("utf-8", "replace").strip() or f"kitten exit code {result.returncode}"
        else:
            send(tmux_wrap(result.stdout, cols, rows))
    except (OSError, subprocess.TimeoutExpired) as error:
        note = str(error)
    footer = note or "Up older | Down newer | type two-character ID | Esc closes"
    send((f"\x1b[{rows};1H" + footer[:cols] + "\x1b[K").encode("utf-8", "replace"))


def read_key(fd: int) -> str:
    key = os.read(fd, 1)
    if key != b"\x1b":
        return key.decode("ascii", "ignore")
    if not select.select([fd], [], [], 0.08)[0]:
        return "escape"
    sequence = key
    while len(sequence) < 16 and select.select([fd], [], [], 0.08)[0]:
        sequence += os.read(fd, 1)
        if len(sequence) >= 3 and 0x40 <= sequence[-1] <= 0x7E:
            break
    if sequence.startswith((b"\x1b[", b"\x1bO")):
        if sequence.endswith(b"A"):
            return "up"
        if sequence.endswith(b"B"):
            return "down"
    return "escape"


def run(manifest: str) -> None:
    data = json.loads(open(manifest, encoding="utf-8").read())
    images = data["images"]
    if not images:
        return
    index = next((i for i, item in enumerate(images) if item["id"] == data["selected"]), len(images) - 1)
    tty_fd = sys.stdin.fileno()
    original = termios.tcgetattr(tty_fd)
    for term_signal in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(term_signal, lambda _signum, _frame: sys.exit(0))
    try:
        tty.setcbreak(tty_fd)
        draw(images, index)
        typed = ""
        while True:
            key = read_key(tty_fd)
            if key in ("escape", "\x03", ""):
                break
            if key == "up":
                index = max(0, index - 1)
                typed = ""
                draw(images, index)
            elif key == "down":
                index = min(len(images) - 1, index + 1)
                typed = ""
                draw(images, index)
            elif key in ("\x7f", "\x08"):
                typed = typed[:-1]
            elif len(key) == 1 and key.lower() in "0123456789abcdefghijklmnopqrstuvwxyz":
                typed += key.lower()
                if len(typed) == 2:
                    match = next((i for i, item in enumerate(images) if item["id"] == typed), None)
                    if match is not None:
                        index = match
                        draw(images, index)
                    else:
                        draw(images, index, f"Unknown image ID: {typed}")
                    typed = ""
            if typed:
                cols, rows = shutil.get_terminal_size()
                status = f"ID: {typed}_  (type one more character)"
                send((f"\x1b[{rows};1H" + status[:cols] + "\x1b[K").encode())
    finally:
        clear()
        termios.tcsetattr(tty_fd, termios.TCSADRAIN, original)


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except KeyboardInterrupt:
        pass
