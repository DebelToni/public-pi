#!/usr/bin/env python3
import contextlib
import io
import json
import os
import runpy
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name("pi-session-finder")


class PiSessionFinderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.module = runpy.run_path(str(SCRIPT), run_name="pi_session_finder_test")
        self.globals = self.module["run_catalog"].__globals__

    def tearDown(self):
        self.temp.cleanup()

    def catalog(self, body: str):
        path = self.root / "catalog"
        path.write_text("#!/usr/bin/env python3\n" + body, "utf8")
        path.chmod(0o755)
        self.globals["CATALOG_CLI"] = path
        return path

    def test_catalog_reconciles_fresh_then_searches_normalized_contract(self):
        log = self.root / "calls.jsonl"
        row = {
            "path": "/tmp/catalog-session.jsonl",
            "id": "catalog-session",
            "cwd": "/tmp/project",
            "name": "Catalog result",
            "created": "2026-01-01T00:00:00.000Z",
            "modified": "2026-01-02T00:00:00.000Z",
            "messageCount": 7,
            "firstMessage": "first",
            "excerpt": "matching needle excerpt",
            "matchedEntryId": "match-1",
            "matchedRole": "assistant",
            "matchedEntryRef": {"id": "match-1", "ordinal": 1, "byteStart": 123, "byteEnd": 150, "sourceSha256": "sha"},
        }
        self.catalog(
            "import json, sys\n"
            f"log = {str(log)!r}\n"
            "with open(log, 'a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            f"row = {row!r}\n"
            "print(json.dumps({'results': [row]} if sys.argv[1] in ('list', 'search') else {'fresh': True}))\n"
        )
        results = self.module["ranked_sessions"]("needle")
        self.assertEqual(results[0]["title"], "Catalog result")
        self.assertEqual(results[0]["matchedEntryId"], "match-1")
        calls = [json.loads(line) for line in log.read_text("utf8").splitlines()]
        self.assertEqual(calls[0][0:2], ["reconcile", "--all"])
        self.assertEqual(calls[1][0], "search")
        self.assertNotIn("--role", calls[1])
        self.assertEqual(calls[1][calls[1].index("--mode") + 1], "bm25")
        self.assertEqual(calls[1][calls[1].index("--matches") + 1], "3")
        self.assertLess(calls[1].index("--compact"), calls[1].index("--"))
        self.assertEqual(calls[1][-1], "needle")

    def test_reconcile_failure_is_visible_and_never_falls_back(self):
        self.catalog("import sys\nsys.stderr.write('catalog stale\\n')\nsys.exit(3)\n")
        with self.assertRaisesRegex(self.module["CatalogError"], "catalog stale"):
            self.module["ranked_sessions"]("needle")
        self.assertNotIn("INDEX_PATH", self.globals)
        self.assertNotIn("session_info", self.module)

    def test_incomplete_reconcile_uses_explicit_partial_query_and_preserves_coverage(self):
        log = self.root / "calls.jsonl"
        self.catalog(
            "import json, sys\n"
            f"log = {str(log)!r}\n"
            "with open(log, 'a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1] == 'reconcile':\n"
            " print(json.dumps({'scopeComplete': False, 'failures': [{'path': 'bad'}]}))\n"
            " sys.exit(2)\n"
            "print(json.dumps({'results': [], 'coverage': {'scopeComplete': False, 'excludedFiles': 1}}))\n"
            "sys.exit(1)\n"
        )
        sessions, freshness, coverage, partial = self.module["catalog_sessions"]("needle")
        self.assertEqual(sessions, [])
        self.assertTrue(partial)
        self.assertFalse(coverage["scopeComplete"])
        calls = [json.loads(line) for line in log.read_text("utf8").splitlines()]
        self.assertIn("--allow-partial", calls[1])

    def test_partial_query_is_requested_even_after_complete_reconciliation(self):
        self.catalog(
            "import json, sys\n"
            "if sys.argv[1] == 'reconcile': print(json.dumps({'scopeComplete': True}))\n"
            "else:\n"
            " assert '--allow-partial' in sys.argv\n"
            " print(json.dumps({'results': [], 'coverage': {'scopeComplete': False}}))\n"
            " sys.exit(1)\n"
        )
        sessions, freshness, coverage, partial = self.module["catalog_sessions"]("needle")
        self.assertEqual(sessions, [])
        self.assertTrue(freshness["scopeComplete"])
        self.assertTrue(partial)

    def test_incomplete_exit_is_rejected_without_opt_in_or_valid_receipt(self):
        self.catalog("import json, sys\nprint(json.dumps({'scopeComplete': False, 'failures': []}))\nsys.exit(2)\n")
        with self.assertRaises(self.module["CatalogError"]):
            self.module["reconcile_catalog"](["--all"])
        for body in [
            "print('{}')\nsys.exit(2)\n",
            "print('not json')\nsys.exit(2)\n",
            "print(json.dumps({'scopeComplete': False, 'failures': []}))\nsys.exit(7)\n",
            "print(json.dumps({'scopeComplete': False, 'failures': []}))\nsys.stderr.write('real error')\nsys.exit(2)\n",
        ]:
            self.catalog("import json, sys\n" + body)
            with self.assertRaises(self.module["CatalogError"]):
                self.module["reconcile_catalog"](["--all"], allow_partial=True)

    def test_catalog_timeout_is_bounded_and_reported(self):
        self.catalog("import time\ntime.sleep(2)\n")
        with self.assertRaisesRegex(self.module["CatalogError"], "timed out"):
            self.module["run_catalog"](["status"], timeout=0.05)

    def test_catalog_stdout_limit_is_enforced(self):
        catalog = self.catalog("import sys\nsys.stdout.write('x' * 10000)\n")
        with self.assertRaisesRegex(self.module["CatalogError"], "stdout limit"):
            self.module["_bounded_process"]([str(catalog)], 2, stdout_limit=100, stderr_limit=100)

    def test_selected_workspace_reads_cli_source_window_with_later_corrections(self):
        log = self.root / "calls.jsonl"
        self.catalog(
            "import json, sys\n"
            f"log = {str(log)!r}\n"
            "with open(log, 'a') as handle: handle.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "print(json.dumps({'entries': ["
            "{'id':'match','parentId':None,'type':'message','role':'assistant','text':'initial answer'},"
            "{'id':'correction','parentId':'match','type':'message','role':'assistant','text':'later correction'}"
            "], 'coverage': {'complete': True}}))\n"
        )
        self.globals["TMP_SEARCH_DIR"] = self.root / "workspace"
        selected = [{
            "display": "row", "path": "/tmp/missing.jsonl", "id": "session-1",
            "cwd": "/tmp/project", "title": "Selected", "modified": 2,
            "messages": 2, "first": "first", "matchedEntryId": "match",
            "matchedEntryRef": {"id": "match", "ordinal": 1, "byteStart": 321, "byteEnd": 350, "sourceSha256": "sha"},
        }]
        workspace = self.module["write_selected_workspace"]("needle", selected)
        evidence = (workspace / "selected-excerpts.md").read_text("utf8")
        self.assertIn("initial answer", evidence)
        self.assertIn("later correction", evidence)
        calls = [json.loads(line) for line in log.read_text("utf8").splitlines()]
        self.assertEqual(calls[0][0:3], ["reconcile", "--path", "/tmp/missing.jsonl"])
        read = calls[1]
        self.assertEqual(read[0], "read")
        self.assertEqual(read[read.index("--path") + 1], "/tmp/missing.jsonl")
        self.assertEqual(read[read.index("--entry") + 1], "match")
        self.assertEqual(read[read.index("--byte-start") + 1], "321")
        self.assertNotIn("--leaf", read)
        self.assertIn("--after", read)

    def test_preview_uses_private_metadata_cache_without_cli_or_jsonl(self):
        self.globals["TMP_SEARCH_DIR"] = self.root / "tmp"
        session = {
            "path": "/tmp/does-not-exist.jsonl", "cwd": "/tmp/project",
            "name": "Fast preview", "first": "first message", "title": "Fast preview",
            "modified": 1767312000, "messages": 9, "score": 0, "excerpt": "needle excerpt",
        }
        temporary, cache = self.module["make_preview_cache"]([session])
        try:
            self.assertEqual(stat.S_IMODE(os.stat(cache).st_mode), 0o600)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.module["preview"](session["path"], cache)
            self.assertIn("Fast preview", output.getvalue())
            self.assertIn("needle excerpt", output.getvalue())
        finally:
            temporary.cleanup()

    def test_no_match_agent_search_requires_explicit_confirmation(self):
        calls = []
        confirm = self.module["confirm_agent_search"]
        self.assertFalse(confirm("needle", lambda _prompt: "", calls.append))
        self.assertEqual(calls, [])
        self.assertTrue(confirm("needle", lambda _prompt: "yes", calls.append))
        self.assertEqual(calls, ["needle"])

    def test_main_partial_search_enter_opens_selected_session(self):
        self.globals["TMP_SEARCH_DIR"] = self.root / "tmp"
        self.catalog(
            "import json, sys\n"
            "if sys.argv[1] == 'reconcile':\n"
            " print(json.dumps({'scopeComplete': False, 'failures': [{'path': 'bad'}]}))\n"
            " sys.exit(2)\n"
            "print(json.dumps({'results': [{'path': '/tmp/healthy.jsonl', 'cwd': '/tmp/project', 'name': 'Healthy'}], 'coverage': {'scopeComplete': False}}))\n"
            "sys.exit(1)\n"
        )
        opened = []
        self.globals["open_session"] = lambda *args: opened.append(args)
        output = subprocess.CompletedProcess([], 0, "\nHealthy\t/tmp/healthy.jsonl\t/tmp/project\n", "")
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"TMUX": "test"}), mock.patch("builtins.input", return_value="needle"), mock.patch.object(self.globals["subprocess"], "run", return_value=output), contextlib.redirect_stderr(stderr):
            self.assertEqual(self.module["main"](), 0)
        self.assertEqual(opened, [("/tmp/healthy.jsonl", "/tmp/project")])
        self.assertIn("coverage is partial", stderr.getvalue())

    def test_fzf_failure_is_visible_and_does_not_report_success(self):
        self.globals["TMP_SEARCH_DIR"] = self.root / "tmp"
        self.globals["catalog_sessions"] = lambda _query: ([{"path": "/tmp/healthy.jsonl", "cwd": "/tmp", "title": "Healthy", "modified": 0}], {}, {}, False)
        output = subprocess.CompletedProcess([], 2, "", "fzf startup failed")
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"TMUX": "test"}), mock.patch("builtins.input", return_value="needle"), mock.patch.object(self.globals["subprocess"], "run", return_value=output), contextlib.redirect_stderr(stderr):
            self.assertEqual(self.module["main"](), 2)
        self.assertIn("fzf startup failed", stderr.getvalue())

    def test_tmux_launch_failure_is_not_silently_ignored(self):
        with mock.patch.object(self.globals["subprocess"], "run", side_effect=subprocess.CalledProcessError(1, "tmux")):
            with self.assertRaises(subprocess.CalledProcessError):
                self.module["tmux_new_window"]("test", "/tmp", "true")

    def test_launch_and_open_preserve_arbitrary_arguments(self):
        self.globals["PI_LAUNCHER"] = Path("/tmp/Pi Ultra/pi")
        session_path = "/tmp/session 'quoted'\n$(touch should-not-run);.jsonl"
        command = self.module["pi_launch_command"]("--session", session_path)
        self.assertEqual(shlex.split(command), ["/tmp/Pi Ultra/pi", "--session", session_path])
        calls = []
        self.globals["tmux_new_window"] = lambda *args: calls.append(args)
        self.module["open_session"]("/tmp/session file.jsonl", "/tmp/project")
        self.assertEqual(calls, [("pi:project", "/tmp/project", "'/tmp/Pi Ultra/pi' --session '/tmp/session file.jsonl'")])

    def test_tmux_window_uses_interactive_shell_and_retains_it_after_pi_exits(self):
        shell = "/tmp/My Shell/zsh"
        command = self.module["pi_launch_command"]("prompt 'quoted'\n$(touch should-not-run);")
        with mock.patch.dict(os.environ, {"SHELL": shell}), mock.patch.object(self.globals["subprocess"], "run") as run:
            self.module["tmux_new_window"]("pi:project", "/tmp/project", command)
        self.assertTrue(run.call_args.kwargs["check"])
        args = run.call_args.args[0]
        self.assertEqual(args[:-1], ["tmux", "new-window", "-n", "pi:project", "-c", "/tmp/project"])
        retained = f"{command}; exec {shlex.quote(shell)} -i"
        self.assertEqual(shlex.split(args[-1]), ["exec", shell, "-ic", retained])


if __name__ == "__main__":
    unittest.main()
