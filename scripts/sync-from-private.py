#!/usr/bin/env python3
"""Publish only reviewed, committed paths, with public-only documentation overrides."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent.parent
ROOTS = {"extensions", "agents", "bin", "core-patches", "docs", "lib", "portable", "skills", "prompts"}
PRIVATE = {"CONTEXT", "sessions", "cache", "archive", "recovery", "services", "launchd"}


def validate_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value or len(path.parts) < 2:
        raise ValueError(f"Invalid publication path: {value}")
    if path.parts[0] not in ROOTS or any(part in PRIVATE for part in path.parts):
        raise ValueError(f"Private or unsupported publication path: {value}")
    if any(part in {"node_modules", "__pycache__", ".venv"} for part in path.parts):
        raise ValueError(f"Runtime publication path: {value}")
    return path


def sanitize(path, text):
    # Generic machine-path redaction, never a map of private literals.
    if path == "extensions/action-fusion/index.test.ts":
        text = re.sub(r'mkdtemp\("/home/[^/]+/tmp/action-fusion-test-"\)',
                      'mkdtemp(join(tmpdir(), "action-fusion-test-"))', text)
        text = 'import { tmpdir } from "node:os";\n' + text
    if path == "extensions/inline-images/index.ts":
        text = re.sub(r'process\.platform === "darwin" \? "[^"]+" : join\(homedir\(\), "\.local/bin/python3"\)',
                      'process.env.PI_IMAGE_VIEWER_PYTHON ?? "python3"', text)
    if path == "extensions/zz-btw/lifecycle.test.ts":
        text = re.sub(r'"/Users/[^/]+/\.local/share/pi-codex-ultra/current"',
                      'join(homedir(), ".local/share/pi-codex-ultra/current")', text)
    text = re.sub(r"/home/[^/\s`\"'<>]+", "/home/user", text)
    text = re.sub(r"/Users/[^/\s`\"'<>]+", "/Users/user", text)
    text = re.sub(r"/Volumes/[^/\s`\"'<>]+", "/Volumes/example", text)
    if path == "extensions/html-widgets/README.md":
        text = re.sub(r"^Evidence:.*\n?", "", text, flags=re.MULTILINE)
        text = text.replace("/home/user/pi-chat/node_modules/marked", "node_modules/marked").rstrip() + "\n"
    if path == "extensions/inline-images/README.md":
        text = re.sub(r"/home/user/\.local/state/[^`]+\.jpg", "/tmp/example-image.jpg", text)
    if path == "extensions/inline-images/image-paths.test.mjs":
        text = re.sub(r"/home/user/\.local/state/[^\"]+\.jpg", "/tmp/example-image.jpg", text)
    return text


def check_privacy(path, text):
    patterns = [
        r"[\w.-]+\.ts\.net", r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b",
        r"[\w.+-]+@(?:gmail|icloud|outlook)\.com",
        r"BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY", r"-----BEGIN PRIVATE KEY",
        r"\b(?:sk-proj-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{16,}",
        r"/home/(?!user(?:/|\b))[^/\s`\"'<>]+/", r"/Users/(?!user(?:/|\b))[^/\s`\"'<>]+/",
    ]
    for pattern in patterns:
        if re.search(pattern, text):
            raise ValueError(f"Privacy-sensitive literal in {path}; review before publication")


def git(src, *args):
    return subprocess.check_output(["git", "-C", str(src), *args])


def main():
    src = Path(os.environ.get("PI_PRIVATE_CONFIG", Path.home() / ".pi/agent")).resolve()
    revision = git(src, "rev-parse", "HEAD").decode().strip()
    paths = (REPO / "scripts/public-files.txt").read_text().splitlines()
    if paths != sorted(set(paths)) or not paths:
        raise ValueError("Publication manifest must be nonempty, sorted and unique")
    records = {}
    for row in git(src, "ls-tree", "-rz", revision).split(b"\0"):
        if row:
            metadata, name = row.split(b"\t", 1)
            mode, kind, blob = metadata.decode().split()
            records[name.decode()] = (mode, kind, blob)
    overrides = REPO / "scripts/overrides"
    override_paths = []
    for file in overrides.rglob("*"):
        if file.is_symlink():
            raise ValueError("Symlinks are forbidden in publication overrides")
        if file.is_file():
            override_paths.append(file.relative_to(overrides).as_posix())
    selected = sorted(set(paths) | set(override_paths))
    with tempfile.TemporaryDirectory(prefix="pi-publication-", dir=REPO) as temporary:
        staging = Path(temporary) / "new"
        backup = Path(temporary) / "old"
        staging.mkdir()
        backup.mkdir()
        for path in selected:
            validate_path(path)
            override = overrides / path
            if override.is_file():
                data, mode = override.read_bytes(), override.stat().st_mode & 0o777
            else:
                record = records.get(path)
                if record is None or record[0] not in {"100644", "100755"} or record[1] != "blob":
                    raise ValueError(f"Missing regular committed source: {path}")
                data, mode = git(src, "cat-file", "blob", record[2]), int(record[0], 8) & 0o777
            text = sanitize(path, data.decode("utf-8"))
            check_privacy(path, text)
            target = staging / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            target.chmod(mode)
        moved = []
        try:
            for root in sorted(ROOTS):
                current = REPO / root
                if current.exists():
                    current.rename(backup / root)
                moved.append(root)
                if (staging / root).exists():
                    (staging / root).rename(current)
        except BaseException:
            for root in reversed(moved):
                if (REPO / root).exists():
                    shutil.rmtree(REPO / root)
                if (backup / root).exists():
                    (backup / root).rename(REPO / root)
            raise
    (REPO / "PUBLICATION.json").write_text(json.dumps({
        "sourceCommit": revision,
        "files": len(selected),
        "policy": "Committed allowlist only; public-only overrides; no private Git history",
    }, indent=2) + "\n")
    print(f"Published {len(selected)} reviewed files from committed snapshot {revision[:12]}")


if __name__ == "__main__":
    main()
