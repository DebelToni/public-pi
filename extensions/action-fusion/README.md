# Action Fusion

Personal Pi extension at `~/.pi/agent/extensions/action-fusion/index.ts`.
Overrides the native `write` and `edit` tools, preserving their schemas,
argument preparation, file-mutation queues, prompt guidelines and renderers.
Adds optional `then_run: { command, timeout? }` to both tools.

Execution is sequential: mutate the file successfully, then invoke the active
`bash` tool through `ctx.executeTool`. This preserves bash permission/result
hooks, session working directory, shell settings, timeout, cancellation,
output truncation and nested-call accounting. The mutation and command output
are returned together and displayed with Pi's native components.

Mutation failure skips the command. Command failure, timeout or permission
rejection marks the combined result as an error but does not revert the file.
Without `then_run`, the native mutation result is returned unchanged. The
mutation queue is not held while the command runs; this is not a transaction
or a lock against other tools or external writers.

Example:

```json
{
  "path": "example.py",
  "content": "print('hello')\n",
  "then_run": { "command": "uv run --no-project python example.py", "timeout": 30 }
}
```

For `edit`, use the normal `edits: [{ oldText, newText }]` array and the same
optional field. Requires the Pi version that exports the native tool-definition
factories and provides `ExtensionToolContext.executeTool`.

Run tests:

```sh
node --test ~/.pi/agent/extensions/action-fusion/index.test.ts
```

The tests use temporary files under `~/tmp`, actual native mutation/bash tools,
and a real in-memory Pi SDK session to check loading, permission hooks and
shell settings. They make no model requests. `/reload` activates changes in an
idle interactive session; other running sessions remain unchanged until they
reload.
