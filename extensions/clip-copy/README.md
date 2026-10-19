# clip-copy

Personal clipboard integration for the last assistant message. Ctrl+X and `/copy` pipe the exact message to `~/bin/clip` over stdin, without shell interpolation or Pi's OSC 52 size ceiling.

The router remains authoritative: local copying uses `pbcopy`; SSH uses `osc52`. When Pi predates an SSH attachment, the extension consults its own tmux pane's session environment for the missing SSH marker. It does not modify Pi's environment or any tmux settings.

Tree copying and fullscreen text-selection copying retain their built-in behavior. Because Pi reserves its copy shortcut, this extension narrowly wraps the interactive last-message handler rather than replacing keybindings. It restores that handler on shutdown/reload and warns if the internal API is unavailable.

Load with `/reload` or a new Pi process. No active sessions are automatically reloaded.

Tests: `bun test ~/.pi/agent/extensions/clip-copy/index.test.ts`. Tests run the actual router scripts against synthetic clipboard/tmux commands; they never change the real clipboard. End-device delivery still depends on the attached terminal accepting OSC 52.
