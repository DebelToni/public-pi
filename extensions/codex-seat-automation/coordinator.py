#!/Volumes/SSD/v/py/bin/python
"""Atomic state coordinator for opt-in Codex account recovery."""

import argparse
import fcntl
import json
import os
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Optional


RECOVERY_TIMEOUT_MS = 20 * 60 * 1000


class CoordinatorError(RuntimeError):
    pass


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise CoordinatorError(f"Invalid coordinator file: {path.name}") from error
    if not isinstance(value, dict):
        raise CoordinatorError(f"Invalid coordinator file: {path.name}")
    return value


def atomic_write_json(path: Path, value: Dict[str, Any]) -> None:
    ensure_private_directory(path.parent)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


@contextmanager
def coordinator_lock(runtime: Path):
    ensure_private_directory(runtime)
    lock_path = runtime / "coordinator.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.chmod(lock_path, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def validate_config(value: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if value is None:
        return {"version": 1, "enabled": False}
    if value.get("version") != 1 or not isinstance(value.get("enabled"), bool):
        raise CoordinatorError("Invalid coordinator file: config.json")
    return value


def validate_state(value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if (
        value.get("version") != 1
        or not isinstance(value.get("generation"), int)
        or value.get("generation", -1) < 0
        or value.get("status") not in {"idle", "switching", "succeeded", "failed"}
    ):
        raise CoordinatorError("Invalid coordinator file: state.json")
    return value


def read_sync(path: Path) -> Optional[Dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("provider"), str):
        return None
    change_id = value.get("changeId")
    if isinstance(change_id, str) and change_id:
        identity = change_id[:200]
    else:
        updated_at = value.get("updatedAt") if isinstance(value.get("updatedAt"), int) else 0
        pid = value.get("pid") if isinstance(value.get("pid"), int) else 0
        model_id = value.get("modelId") if isinstance(value.get("modelId"), str) else ""
        identity = f"legacy:{updated_at}:{pid}:{value['provider']}:{model_id}"[:500]
    return {
        "id": identity,
        "provider": value["provider"],
        "model": value.get("modelId") if isinstance(value.get("modelId"), str) else "",
    }


def sync_identity(path: Path) -> Optional[str]:
    value = read_sync(path)
    return value["id"] if value else None


def new_incident(previous: Optional[Dict[str, Any]], args: argparse.Namespace, current_sync_id: Optional[str]) -> Dict[str, Any]:
    generation = (previous.get("generation", 0) if previous else 0) + 1
    state = {
        "version": 1,
        "generation": generation,
        "status": "switching",
        "incidentId": str(uuid.uuid4()),
        "failedProvider": args.provider,
        "failedModel": args.model,
        "failedSyncId": args.request_sync_id or current_sync_id,
        "startedAt": now_ms(),
        "leaderPid": args.pid,
    }
    return {key: value for key, value in state.items() if value is not None}


def should_start_after_completed(
    state: Dict[str, Any],
    provider: str,
    model: str,
    request_sync_id: Optional[str],
    current_sync: Optional[Dict[str, str]],
) -> bool:
    current_sync_id = current_sync["id"] if current_sync else None
    request_matches_current = bool(
        current_sync
        and current_sync["provider"] == provider
        and (not current_sync["model"] or current_sync["model"] == model)
    )
    if request_sync_id and current_sync_id:
        if request_sync_id != current_sync_id or not request_matches_current:
            return False
        if state["status"] == "failed" and current_sync_id == state.get("failedSyncId"):
            return False
        return True

    if not request_matches_current:
        return False
    if state["status"] == "failed":
        if current_sync_id and state.get("failedSyncId"):
            return current_sync_id != state.get("failedSyncId")
        return provider != state.get("failedProvider")

    if current_sync_id and state.get("selectedSyncId"):
        if current_sync_id != state.get("selectedSyncId"):
            return True
        return provider == state.get("selectedProvider")
    return provider == state.get("selectedProvider")


def command_set_enabled(args: argparse.Namespace, runtime: Path) -> Dict[str, Any]:
    config_path = runtime / "config.json"
    with coordinator_lock(runtime):
        config = {
            "version": 1,
            "enabled": args.enabled == "true",
            "updatedAt": now_ms(),
            "updatedBy": args.pid,
        }
        atomic_write_json(config_path, config)
        return {"config": config}


def expire_switching_state(
    state: Optional[Dict[str, Any]], state_path: Path
) -> Optional[Dict[str, Any]]:
    if state is None or state["status"] != "switching":
        return state
    started_at = state.get("startedAt")
    if not isinstance(started_at, int) or now_ms() - started_at < RECOVERY_TIMEOUT_MS:
        return state
    expired = {
        **state,
        "status": "failed",
        "completedAt": now_ms(),
        "failureCode": "recovery-timeout",
    }
    atomic_write_json(state_path, expired)
    return expired


def command_status(runtime: Path, sync_path: Path) -> Dict[str, Any]:
    with coordinator_lock(runtime):
        config = validate_config(read_json(runtime / "config.json"))
        state_path = runtime / "state.json"
        state = expire_switching_state(validate_state(read_json(state_path)), state_path)
        return {"config": config, "state": state, "syncId": sync_identity(sync_path)}


def command_join(args: argparse.Namespace, runtime: Path, sync_path: Path) -> Dict[str, Any]:
    config_path = runtime / "config.json"
    state_path = runtime / "state.json"
    with coordinator_lock(runtime):
        config = validate_config(read_json(config_path))
        if not config["enabled"]:
            return {"action": "disabled", "state": validate_state(read_json(state_path))}

        state = expire_switching_state(validate_state(read_json(state_path)), state_path)
        current_sync = read_sync(sync_path)
        current_sync_id = current_sync["id"] if current_sync else None
        if state and state["status"] == "switching":
            return {"action": "wait", "state": state}
        if state and state["status"] in {"succeeded", "failed"} and not should_start_after_completed(
            state,
            args.provider,
            args.model,
            args.request_sync_id,
            current_sync,
        ):
            return {"action": "wait", "state": state}
        if not state and current_sync:
            sync_mismatch = (
                current_sync["provider"] != args.provider
                or (current_sync["model"] and current_sync["model"] != args.model)
            )
            if sync_mismatch or (args.request_sync_id and args.request_sync_id != current_sync_id):
                return {"action": "stale", "state": None}

        state = new_incident(state, args, current_sync_id)
        atomic_write_json(state_path, state)
        return {"action": "leader", "state": state}


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def command_abandon(args: argparse.Namespace, runtime: Path) -> Dict[str, Any]:
    state_path = runtime / "state.json"
    with coordinator_lock(runtime):
        state = expire_switching_state(validate_state(read_json(state_path)), state_path)
        if state is None or state["status"] != "switching" or state["generation"] != args.generation:
            return {"abandoned": False, "state": state}
        leader_pid = state.get("leaderPid")
        if not isinstance(leader_pid, int) or process_alive(leader_pid):
            return {"abandoned": False, "state": state}
        completed = {
            **state,
            "status": "failed",
            "completedAt": now_ms(),
            "failureCode": "leader-exited",
        }
        atomic_write_json(state_path, completed)
        return {"abandoned": True, "state": completed}


def command_complete(args: argparse.Namespace, runtime: Path, sync_path: Path) -> Dict[str, Any]:
    state_path = runtime / "state.json"
    with coordinator_lock(runtime):
        state = expire_switching_state(validate_state(read_json(state_path)), state_path)
        if (
            state is None
            or state["status"] != "switching"
            or state["generation"] != args.generation
            or state.get("leaderPid") != args.pid
        ):
            return {"committed": False, "state": state}

        status = args.result
        failure_code = args.failure_code
        if status == "succeeded":
            current_sync_id = sync_identity(sync_path)
            if not args.selected_provider or not args.selected_model or not args.selected_sync_id:
                status = "failed"
                failure_code = "invalid-success"
            elif current_sync_id != args.selected_sync_id:
                status = "failed"
                failure_code = "provider-sync-changed"

        completed = {
            **state,
            "status": status,
            "completedAt": now_ms(),
        }
        if status == "succeeded":
            completed.update(
                {
                    "selectedProvider": args.selected_provider,
                    "selectedModel": args.selected_model,
                    "selectedSyncId": args.selected_sync_id,
                }
            )
            completed.pop("failureCode", None)
        else:
            completed["failureCode"] = failure_code or "account-selection-failed"
            completed.pop("selectedProvider", None)
            completed.pop("selectedModel", None)
            completed.pop("selectedSyncId", None)
        atomic_write_json(state_path, completed)
        return {"committed": True, "state": completed}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--sync-state", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    enabled = subparsers.add_parser("set-enabled")
    enabled.add_argument("enabled", choices=("true", "false"))
    enabled.add_argument("--pid", type=int, required=True)

    subparsers.add_parser("status")

    join = subparsers.add_parser("join")
    join.add_argument("--provider", required=True)
    join.add_argument("--model", required=True)
    join.add_argument("--request-sync-id")
    join.add_argument("--pid", type=int, required=True)

    abandon = subparsers.add_parser("abandon")
    abandon.add_argument("--generation", type=int, required=True)

    complete = subparsers.add_parser("complete")
    complete.add_argument("--generation", type=int, required=True)
    complete.add_argument("--pid", type=int, required=True)
    complete.add_argument("--result", choices=("succeeded", "failed"), required=True)
    complete.add_argument("--selected-provider")
    complete.add_argument("--selected-model")
    complete.add_argument("--selected-sync-id")
    complete.add_argument("--failure-code")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runtime = Path(args.runtime).expanduser().resolve()
    sync_path = Path(args.sync_state).expanduser().resolve()
    if args.command == "set-enabled":
        result = command_set_enabled(args, runtime)
    elif args.command == "status":
        result = command_status(runtime, sync_path)
    elif args.command == "join":
        result = command_join(args, runtime, sync_path)
    elif args.command == "abandon":
        result = command_abandon(args, runtime)
    else:
        result = command_complete(args, runtime, sync_path)
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CoordinatorError as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(2)
