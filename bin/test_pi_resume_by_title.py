#!/usr/bin/env python3

import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

BIN_DIR = Path(__file__).resolve().parent
HELPER = BIN_DIR / "pi-resume-by-title"
WRAPPER = BIN_DIR / "pi"
HELPER_MODULE = runpy.run_path(str(HELPER))
default_session_dir = HELPER_MODULE["default_session_dir"]
resolve_session = HELPER_MODULE["resolve_session"]
title_from_window = HELPER_MODULE["title_from_window"]


class ResumeByTitleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        wiki_path = self.home / "Documents" / "wiki"
        self.agent_dir = self.home / ".pi" / "agent"
        wiki_path.mkdir(parents=True)
        self.wiki = wiki_path.resolve()
        self.agent_dir.mkdir(parents=True)
        self.session_dir = default_session_dir(str(self.wiki), self.agent_dir)
        self.session_dir.mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def add_session(self, filename, title, mtime_ns, cwd=None):
        path = self.session_dir / filename
        path.write_text('{}\n', encoding="utf8")
        os.utime(path, ns=(mtime_ns, mtime_ns))
        return path, {
            "title": title,
            "cwd": str(cwd or self.wiki),
            "updatedAt": mtime_ns // 1_000_000,
        }

    def write_map(self, sessions, titles=None):
        data = {"version": 1, "titles": titles or {}, "sessions": sessions}
        (self.agent_dir / "wiki-session-titles.json").write_text(json.dumps(data), encoding="utf8")

    def test_state_title_selects_newest_duplicate_by_session_mtime(self):
        older, older_metadata = self.add_session("older.jsonl", "gaussian", 10_000_000)
        newer, newer_metadata = self.add_session("newer.jsonl", "gaussian", 20_000_000)
        newer_metadata["updatedAt"] = 1
        self.write_map({str(older): older_metadata, str(newer): newer_metadata})

        selected = resolve_session(str(self.wiki), "● gaussian", "gaussian", agent_dir=self.agent_dir)

        self.assertEqual(selected, newer)

    def test_window_name_overrides_a_stale_tmux_base_and_matches_exactly(self):
        session, metadata = self.add_session("sd.jsonl", "SD", 10_000_000)
        self.write_map({str(session): metadata})

        self.assertEqual(title_from_window("SD", "old-title"), "SD")
        self.assertEqual(resolve_session(str(self.wiki), "SD", "old-title", agent_dir=self.agent_dir), session)
        self.assertIsNone(resolve_session(str(self.wiki), "sd", "", agent_dir=self.agent_dir))

    def test_candidate_requires_the_current_cwd_and_session_directory(self):
        outside = self.root / "outside.jsonl"
        outside.write_text('{}\n', encoding="utf8")
        missing_cwd = self.session_dir / "missing-cwd.jsonl"
        missing_cwd.write_text('{}\n', encoding="utf8")
        self.write_map({
            str(outside): {"title": "gaussian", "cwd": str(self.wiki), "updatedAt": 1},
            str(missing_cwd): {"title": "gaussian", "updatedAt": 2},
        })

        self.assertIsNone(resolve_session(str(self.wiki), "gaussian", agent_dir=self.agent_dir))

    def test_pi_continue_prepends_the_matching_session_and_preserves_arguments(self):
        older, older_metadata = self.add_session("older.jsonl", "gaussian", 10_000_000)
        newer, newer_metadata = self.add_session("newer.jsonl", "gaussian", 20_000_000)
        self.write_map({str(older): older_metadata, str(newer): newer_metadata})

        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        fake_tmux = fake_bin / "tmux"
        fake_tmux.write_text(
            "#!/bin/sh\n"
            "case \"$*\" in\n"
            "  *'@pi_title_base'*) printf '%s\\n' \"$PI_FAKE_BASE_TITLE\" ;;\n"
            "  *) printf '%s\\n' \"$PI_FAKE_WINDOW_TITLE\" ;;\n"
            "esac\n",
            encoding="utf8",
        )
        fake_tmux.chmod(0o755)
        args_file = self.root / "args"
        fake_pi = fake_bin / "real-pi"
        fake_pi.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PI_FAKE_ARGS"\n', encoding="utf8")
        fake_pi.chmod(0o755)

        env = os.environ.copy()
        env.update({
            "HOME": str(self.home),
            "PATH": f"{fake_bin}:{env['PATH']}",
            "TMUX": "test",
            "TMUX_PANE": "%test",
            "PI_CODING_AGENT_DIR": str(self.agent_dir),
            "PI_FAKE_ARGS": str(args_file),
            "PI_FAKE_WINDOW_TITLE": "○ gaussian",
            "PI_FAKE_BASE_TITLE": "gaussian",
            "PI_REAL_BIN": str(fake_pi),
            "PI_SKIP_LOCAL_PATCH_CHECK": "1",
        })

        subprocess.run([str(WRAPPER), "-c", "--thinking", "low"], cwd=self.wiki, env=env, check=True)

        self.assertEqual(
            args_file.read_text("utf8").splitlines(),
            ["--session", str(newer), "-c", "--thinking", "low"],
        )

        env.pop("TMUX_PANE")
        subprocess.run([str(WRAPPER), "-c"], cwd=self.wiki, env=env, check=True)
        self.assertEqual(args_file.read_text("utf8").splitlines(), ["-c"])


if __name__ == "__main__":
    unittest.main()
