---
name: baby-monitor
description: User-invoked monitoring with a system-specific failure protocol agreed before supervision begins.
disable-model-invocation: true
---

# Baby monitor

Run only through `/skill:baby-monitor`. Editing this skill does not start monitoring.

## Agree on the job

1. Ask which model, agent or workload to monitor and where it runs, unless the invocation already specifies it.
2. Inspect that system read-only: project instructions, processes, logs, progress signals, restart/resume mechanism, limits and deadlines. Identify its actual failure points before proposing recovery.
3. Use an available structured question tool or chat to agree on a short, system-specific protocol: what counts as unhealthy, what to do at each relevant failure point, retry limits, when to ask/notify instead of acting, and when monitoring ends. Default check interval is 30 minutes. Ask only relevant questions: an OOM might need a smaller batch or stopping; a billing failure might require waiting for the user. These are examples to discuss, not default permissions. Do not re-ask decisions already supplied.
4. Start only once the protocol is settled. Invocation alone does not authorize arbitrary repairs, spending, account changes or deadline extensions.

## Monitor

- Actually sleep between checks using foreground tool calls, with sufficient timeout. Keep looping until the agreed endpoint or the user stops you; no final reply while monitoring is active.
- Check fresh progress and logs, not process existence alone. Expected waits, completed work and scheduled cutoffs are not crashes; verify whether visible errors already recovered.
- On failure, preserve evidence, diagnose the cause and follow the agreed response. An uncovered failure means ask, not invent a recovery policy. While awaiting input, stay read-only.
- Before intervention, verify the exact target and process ownership. Never duplicate surviving work or disturb unrelated jobs. Verify recovery through fresh progress.
- Report meaningful changes concisely. Stopping this monitor does not stop the workload or leave a background watcher running.
