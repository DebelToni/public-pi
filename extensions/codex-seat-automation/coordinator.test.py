import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from tempfile import TemporaryDirectory


MODULE_PATH = Path(__file__).with_name("coordinator.py")
SPEC = importlib.util.spec_from_file_location("codex_seat_coordinator", MODULE_PATH)
coordinator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coordinator)


class RecoveryLeaseTests(unittest.TestCase):
    def test_expired_live_pid_fails_generation_rejects_late_completion_and_allows_new_sync(self):
        with TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            sync_path = Path(temporary) / "sync.json"
            runtime.mkdir()
            coordinator.atomic_write_json(
                runtime / "config.json", {"version": 1, "enabled": True}
            )
            coordinator.atomic_write_json(
                runtime / "state.json",
                {
                    "version": 1,
                    "generation": 1,
                    "status": "switching",
                    "failedProvider": "codex-old",
                    "failedModel": "gpt-5.6-sol",
                    "failedSyncId": "sync-1",
                    "startedAt": 1_000,
                    "leaderPid": os.getpid(),
                },
            )
            sync_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "provider": "codex-old",
                        "modelId": "gpt-5.6-sol",
                        "changeId": "sync-1",
                    }
                ),
                encoding="utf-8",
            )
            original_now = coordinator.now_ms
            coordinator.now_ms = lambda: 1_000 + coordinator.RECOVERY_TIMEOUT_MS + 1
            try:
                status = coordinator.command_status(runtime, sync_path)
                self.assertEqual(status["state"]["status"], "failed")
                self.assertEqual(
                    status["state"]["failureCode"], "recovery-timeout"
                )

                late = coordinator.command_complete(
                    SimpleNamespace(
                        generation=1,
                        pid=os.getpid(),
                        result="succeeded",
                        selected_provider="codex-new",
                        selected_model="gpt-5.6-sol",
                        selected_sync_id="sync-2",
                        failure_code=None,
                    ),
                    runtime,
                    sync_path,
                )
                self.assertFalse(late["committed"])

                waiting = coordinator.command_join(
                    SimpleNamespace(
                        provider="codex-old",
                        model="gpt-5.6-sol",
                        request_sync_id="sync-1",
                        pid=os.getpid(),
                    ),
                    runtime,
                    sync_path,
                )
                self.assertEqual(waiting["action"], "wait")

                sync_path.write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "provider": "codex-old",
                            "modelId": "gpt-5.6-sol",
                            "changeId": "sync-2",
                        }
                    ),
                    encoding="utf-8",
                )
                replacement = coordinator.command_join(
                    SimpleNamespace(
                        provider="codex-old",
                        model="gpt-5.6-sol",
                        request_sync_id="sync-2",
                        pid=os.getpid(),
                    ),
                    runtime,
                    sync_path,
                )
                self.assertEqual(replacement["action"], "leader")
                self.assertEqual(replacement["state"]["generation"], 2)
            finally:
                coordinator.now_ms = original_now


if __name__ == "__main__":
    unittest.main()
