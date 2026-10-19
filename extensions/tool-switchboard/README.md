# Model tools

`/tools` opens a height-limited, searchable list of model-callable tools. Enter or Space toggles the selected tool; Esc closes the list. `/tools set_reasoning on` and `/tools set_reasoning off` work without the selector.

The blocked names are saved globally in `~/.pi/agent/disabled-tools.json` (or `PI_CODING_AGENT_DIR/disabled-tools.json`). Changes apply immediately in the current session and on the next model request in other running sessions. Tool implementations and extension shortcuts remain loaded. A separate tool loadout or CLI restriction can still keep an allowed tool inactive.

`/hide-tools` only hides tool calls from the terminal transcript; it does not change what the model can call.
