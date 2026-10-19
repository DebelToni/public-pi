#!/usr/bin/env python3
"""Regression tests for bin/runpod-gpu without creating pods."""

from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("runpod-gpu")
LOADER = importlib.machinery.SourceFileLoader("runpod_gpu", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
runpod_gpu = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(runpod_gpu)


def arguments(*extra: str):
    return runpod_gpu.parser().parse_args(["create", "--gpu", "test-gpu", *extra])


class RunpodGpuTests(unittest.TestCase):
    def test_repository_preserves_ssh_and_rejects_credentials(self):
        self.assertEqual(
            runpod_gpu.repo_url("git@github.com:owner/private.git"),
            "git@github.com:owner/private.git",
        )
        with self.assertRaisesRegex(SystemExit, "must not contain credentials"):
            runpod_gpu.repo_url("https://user:token@github.com/owner/private.git")

    def test_custom_environment_accepts_only_runpod_secret_references(self):
        runpod_gpu.validate_custom_environment(
            {"API_TOKEN": "{{ RUNPOD_SECRET_api_token }}"}, "--env"
        )
        with self.assertRaisesRegex(SystemExit, "must use a"):
            runpod_gpu.validate_custom_environment({"API_TOKEN": "secret"}, "--env")

    def test_dry_run_redacts_every_environment_value(self):
        template = {
            "name": "GeneralContainer",
            "imageName": "example/image",
            "env": {
                "API_TOKEN": "{{ RUNPOD_SECRET_api_token }}",
                "VISIBLE": "should-not-print",
            },
        }
        output = io.StringIO()
        with patch.object(runpod_gpu, "json_command", return_value=template):
            with contextlib.redirect_stdout(output):
                self.assertEqual(runpod_gpu.create(arguments("--dry-run")), 0)
        rendered = output.getvalue()
        self.assertNotIn("should-not-print", rendered)
        self.assertNotIn("RUNPOD_SECRET_api_token", rendered)
        self.assertIn('"VISIBLE": "<set>"', rendered)

    def test_wait_preflight_happens_before_creation(self):
        template = {"env": {}}
        with patch.object(runpod_gpu, "json_command", return_value=template):
            with patch.object(runpod_gpu.shutil, "which", return_value=None):
                with patch.object(runpod_gpu.subprocess, "run") as run:
                    with self.assertRaisesRegex(SystemExit, "ready-check"):
                        runpod_gpu.create(arguments("--wait"))
        run.assert_not_called()

    def test_malformed_create_output_recovers_exact_new_pod(self):
        template = {"env": {}}
        catalogs = iter([[], [{"id": "pod-123", "name": "recover-me"}]])

        def json_command(command):
            if command[1:3] == ["template", "get"]:
                return template
            if command[1:3] == ["pod", "list"]:
                return next(catalogs)
            raise AssertionError(command)

        created = subprocess.CompletedProcess([], 0, stdout="not-json", stderr="")
        output = io.StringIO()
        with patch.object(runpod_gpu, "json_command", side_effect=json_command):
            with patch.object(runpod_gpu.subprocess, "run", return_value=created) as run:
                with contextlib.redirect_stdout(output):
                    self.assertEqual(
                        runpod_gpu.create(arguments("--name", "recover-me", "--id-only")),
                        0,
                    )
        self.assertEqual(output.getvalue().strip(), "pod-123")
        self.assertEqual(run.call_count, 1)

    def test_error_redaction_handles_whole_environment_and_empty_values(self):
        env = {"SAFE": "visible", "EMPTY": ""}
        command_echo = runpod_gpu.create_command(arguments(), "test-gpu", env)[-3]
        text = f"failed argv: {command_echo}; value=visible"
        redacted = runpod_gpu.redacted_output(text, env)
        self.assertNotIn("visible", redacted)
        self.assertNotIn(command_echo, redacted)
        self.assertTrue(redacted)


if __name__ == "__main__":
    unittest.main()
