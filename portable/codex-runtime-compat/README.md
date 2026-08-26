# Codex runtime compatibility for Pi 0.84.3

Pi 0.84.3 starts its bundled CLI by default. The Codex recovery continuation and cache-affinity fixes patch the retained modular runtime, so friend installations must run `dist/cli.js` through the included wrapper.

## Install

Use this directory only from an immutable, checksum-verified release. Confirm Pi is already exactly `0.84.3`, no account switch or seat operation is running, and the active provider/model has been recorded without changing it.

```bash
umask 077
./install.sh
```

The installer:

- discovers and validates the installed coding-agent package;
- creates an owner-only full package backup under `~/tmp`;
- installs the wrapper and idempotent patch restorer under `~/.pi/agent/bin`;
- patches only awaited extension `sendMessage()` and Codex cache/WebSocket affinity;
- verifies the awaitable runtime, patch markers, version, and model loading.

Prepend the wrapper directory after any NVM initialization in the shell startup file:

```bash
export PATH="$HOME/.pi/agent/bin:$PATH"
```

Open a fresh shell and require:

```bash
command -v pi
# ~/.pi/agent/bin/pi

pi --version
# 0.84.3
```

Do not continue if `pi` resolves to the npm package's `dist/bundle/cli.js`. The wrapper automatically restores the reviewed patches after future package replacement, but the next Pi release still requires a fresh compatibility audit before updating.

Existing Pi processes retain their loaded core runtime. Preserve their session, then exit and resume them normally; `/reload` alone cannot activate this compatibility layer. Do not inject input or restart another user's active process.

Verification must remain read-only: run `pi --list-models`, the release tests, `/codex-usage`, `/codex-auto-recovery status`, and one signed unknown-ID `seat.status` request. Never use `/as --auto` or `/seat-cycle-check` as a probe.
