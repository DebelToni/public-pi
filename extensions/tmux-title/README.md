# Pi tmux titles and session exclusion

Start with `pi --unlisted`, or run `/unlisted` (`/unlisted on`) to exclude the current Pi session. `/unlisted off` restores participation; `/unlisted status` reports without changing it.

Excluded sessions keep their plain title with no running, idle, done or question marker. The leader+v marked-window picker omits them from groups and counts. The phone app hides every active discovery fallback, refuses direct access and stops pending notification retries. Saved history stays searchable, and hidden processes remain owners for duplicate-writer protection. Phone resume of an unlisted saved session is refused; resume it natively and use `/unlisted off` first.

The latest valid `pi-unlisted` custom entry `{enabled: boolean}` persists the setting across reload and resume, outside model context and across branch navigation. A fresh explicit startup flag enables it; reload respects a later `/unlisted off`. A new session with no saved preference starts listed. Native `/park`, lifecycle updates and any loaded `/tick` or name-change handler cannot restore markers while exclusion is enabled.

## Integration contract

- Publish `@pi_unlisted=1` or `0` on the owning **pane**. A listed startup resets stale pane state.
- Set window `@pi_title_state=excluded` and retain `@pi_title_base` while hidden, including shutdown. The existing read hook only changes `done` windows.
- The app verifies pane-only options using `tmux show-options -p -t <pane> -qv @pi_unlisted`, without `-A`; format lookup inherits options and is insufficient alone.
- Tmux titles and leader+v operate at window granularity. Multiple Pi panes in one window retain the existing last-title-writer behavior; app exclusion is pane-local, never tmux-session-wide.

New Pi processes load the extension automatically. Existing agents require an owner-controlled `/reload` when idle; installation does not send input or reload them.

## Verification

`node --test extensions/tmux-title/index.test.ts extensions/tmux-title/unlisted.test.ts`

Tests use an isolated SDK session and owned tmux sockets, without model inference or input to working agents. If a local `tick.test.ts` exists, include it for that feature's regression coverage.
