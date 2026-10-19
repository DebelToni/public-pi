# public-pi

Reusable source from a working Pi configuration: extensions, skills, command-line tools, session cataloguing, and runtime patches. The snapshot provenance is in [`PUBLICATION.json`](PUBLICATION.json). This is a curated source mirror, not the private configuration's Git history.

## Use selected components

The root package exports no Pi resources, so installing the Git package does not activate the catalog. Review and copy only what you need:

```bash
git clone https://github.com/DebelToni/public-pi.git
mkdir -p ~/.pi/agent/extensions
cp -R public-pi/extensions/lib public-pi/extensions/modes ~/.pi/agent/extensions/
cp -R public-pi/extensions/zz-btw ~/.pi/agent/extensions/
```

`lib` and `modes/shared.ts` are non-loading helpers. Session search and subagents also need the shared catalog implementation:

```bash
mkdir -p ~/.pi/agent/lib
cp -R public-pi/lib/session-catalog ~/.pi/agent/lib/
cd ~/.pi/agent/lib/session-catalog
npm ci --omit=dev --ignore-scripts
```

If a selected extension contains a package lock, install its dependencies in that directory. Root `npm ci --ignore-scripts --omit=peer` installs only the mirror's development/runtime support dependencies; Pi provides the host peer packages. Reload Pi after changing your installed extensions.

These sources target a customized Pi fork. Some require its session-store API, continuation events, model aliases, or provider behavior and will not work unchanged on every upstream release. Review each component's README and imports. tmux-based components require tmux; the external prompt editor also requires Neovim. Do not copy all extensions or apply every runtime patch indiscriminately.

## Extension catalog

| Area | Components |
| --- | --- |
| Delegation and interaction | `subagent`, `ask-user`, `action-fusion`, `ask-past-session` |
| Sessions and context | `search-session`, `ordered-context`, `session-recency`, `max-context`, `zzz-context-inspect` |
| Input and terminal UI | `zz-btw`, `zz-prompt-tabs`, `pi-prompt-editor`, `custom-tui`, `modern-latex`, `scrollback-goto`, `tool-hide`, `tool-switchboard`, `clip-copy` |
| Rich content | `inline-images`, `html-widgets` |
| Models and requests | `model-shortcuts`, `manage-reasoning`, `cli-fast`, `openai-plus` |
| Workflow and tmux | `fork-tmux`, `move-session`, `delete-session`, `tmux-title`, `zz-phone-name`, `zzz-close-on-done`, `goal`, `spec-driven`, `steering-continuity` |
| Search | `exa-search`, `google-search` |
| Observability and safety | `agent-time-telemetry`, `harness-timing`, `agents-inbox`, `safety`, `compatible-skills` |

`zz-btw` diagnostics are off by default. Enabling `PI_BTW_DIAGNOSTICS=1` can log complete prompts and responses locally. The inbox, catalog, and telemetry tools read local session information; review their data access before enabling them. `zz-phone-name` uses a hidden model request to name opted-in phone sessions.

`google-search` includes reusable browser/container source with generic setup instructions. Credentials and browser profiles are operator-owned local state. `inline-images` uses `python3` by default; set `PI_IMAGE_VIEWER_PYTHON` if necessary.

## Other reusable source

- `lib/session-catalog/`: indexed session discovery and search, with a custom-runtime adapter.
- `bin/`: selected session, token, GPU, and patching utilities with regression tests. Review runtime and platform assumptions before installation; these are not all standalone programs.
- `core-patches/` and `portable/codex-runtime-compat/`: runtime-specific patch source and a separately documented compatibility bundle.
- `agents/`: general and researcher subagent templates.
- `skills/`: generalized teaching, UI preferences, monitoring, Computer Use, Cloudflare entry-point, and strict code review protocols. The bundled `impeccable` skill retains its upstream Apache-2.0 license and provenance. Cloudflare's official skills must be obtained separately.
- `docs/codex-usage-api.md`: notes on the undocumented Codex quota endpoint.

Copy reviewed skills into `~/.pi/agent/skills/` and templates into `~/.pi/agent/agents/` as needed. Generalized skill copies intentionally omit private workspace and service instructions.

## Privacy boundary

Excluded: credentials, personal context and memory, private wiki material, sessions and exported conversations, runtime databases, logs, recovery archives, private settings/models/trust, service deployments, private sharing infrastructure, and phone-chat endpoints. The old account/seat-automation bundle, proactive seat rotation, and friend-specific setup prompt were removed because they are no longer in the current reusable source set. Their removal does not change any installed service.

Generic machine paths in retained source are sanitized. Public-only documentation and skill variants live in `scripts/overrides/`; the live private configuration is not rewritten to produce them.

## Mirror maintenance

`scripts/public-files.txt` is the reviewed, exact source allowlist. From a clean mirror checkout, run:

```bash
PI_PRIVATE_CONFIG=/path/to/private/config ./scripts/sync-from-private.sh
python3 -m unittest discover -s scripts -p 'test_*.py'
```

The exporter reads committed Git blobs only, rejects invalid paths and symlinks, applies reviewed overrides and path sanitization, and checks for private endpoints and common credential literals before replacing the managed source trees. Unlisted additions are never published automatically. Review the complete diff and run a dedicated secret scanner before committing or pushing. The built-in checks are guardrails, not a complete privacy audit.

Most extension tests use Bun. Run files separately with an isolated `PI_CODING_AGENT_DIR` and temporary directory; some tests inspect the installed custom runtime or require its environment. CLI and pure helper regressions also use Node and Python. A source sync does not assert that the entire catalog passes on an arbitrary host.
