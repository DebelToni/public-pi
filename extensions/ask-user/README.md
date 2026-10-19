# Questionnaire (`ask_user`)

A personal Pi extension for structured, multi-round user input. The model sees one tool, `ask_user`; the extension owns navigation, branching, revision, persistence, and UI state.

## Model contract

```ts
ask_user({
  questionnaire_id?: string, // reuse the ID returned by the previous round
  title?: string,            // optional subtitle; UI title is always Questionnaire
  message?: string,          // pending clarification reply, otherwise general context
  questions?: [{
    id: string,
    prompt: string,
    label?: string,
    kind?: "single" | "multi" | "text", // default: single
    options?: [{ value: string, label: string, description?: string }],
    allow_other?: boolean,    // choice questions default to true
    show_if?: [{
      question_id: string,
      operator?: "equals" | "includes" | "not_equals" | "not_includes",
      value: string,
    }],
  }],
  remove_question_ids?: string[],
  final?: boolean,
})
```

Questions are upserted by ID and new IDs append in order. Updating a question invalidates its answer and every transitive dependent answer. Revising an answer in the UI does the same. Every `show_if` condition must match for a question to become active; missing references and cycles are rejected.

Choice questions offer model-authored options plus a written answer by default. `multi` uses Space to toggle and Enter to commit. A pristine text question opens directly in a wrapped multiline editor, so typing starts immediately. Answered text questions and questions with clarification history stay in question view; typing starts answer editing, while `C` remains available for another follow-up. A highlighted written-choice alternative also starts editing on the first typed character; Enter opens it without inserting text. Clarification uses the same editor inline beneath the active question, preserving its prompt, options, answer context, and full earlier thread. All currently active questions must be answered, so navigation cannot be used to skip them.

## Multi-round flow

1. Call `ask_user` with initial questions.
2. The user answers reachable questions and chooses the review action.
3. Without `final: true`, the result is `needs_more_questions`. The main agent may research with normal tools, then calls `ask_user` again with future questions or `final: true`.
4. `C` opens an inline clarification editor for the active question. Its result is `needs_clarification`; the main agent may use normal tools or research, then answers through `message` in another `ask_user` call.
5. The extension automatically binds that `message` to the latest pending clarification and its question. The panel returns to question actions with `C follow-up`; the user can repeat this exchange any number of times before or after answering. Clarification never answers, advances, or submits the questionnaire.
6. When no clarification is pending, `message` is general questionnaire-round context. With `final: true`, only the review action submits and returns `completed`.

There is no helper-model path. `needs_more_questions` and `needs_clarification` return directly to the same main agent. A clarification result names its associated question ID, but the next call does not need a target parameter. Each question retains only its own clarification and reply thread while navigating next/back and during model work. Removing or changing a question, or making a conditional question inactive, removes that question's stale thread. Model-visible result text includes each answer's stable option `value` alongside its human label; consumers do not need access to tool-result details to interpret choices.

Example:

```json
{
  "title": "Deployment",
  "questions": [
    {
      "id": "target",
      "prompt": "Where should this run?",
      "label": "Target",
      "options": [
        { "value": "a", "label": "A" },
        { "value": "b", "label": "B" },
        { "value": "c", "label": "C" }
      ]
    },
    {
      "id": "b_details",
      "prompt": "What must B preserve?",
      "kind": "text",
      "show_if": [{ "question_id": "target", "value": "b" }]
    }
  ]
}
```

## Controls

| Key | Outside text editor | Inside text editor |
|---|---|---|
| Arrow keys | Move through options or between questions | Move the text cursor, including wrapped visual lines |
| Space | Toggle a multi-select option | Insert a space |
| Enter | Select an option or submit review | Save the answer or clarification |
| Shift+Enter / Ctrl+J | | Insert a newline |
| C | Ask for clarification, or another follow-up on the current question | Insert `c` |
| PageUp / PageDown | Scroll a long question-specific thread | Move through long editor content |
| Escape | Open abort confirmation | Leave editing and keep the draft; `C` is then available |
| Alt+Q / `/questionnaire` | Switch focus between Pi and the persistent panel | Same |

Shift+Enter recognition depends on terminal key reporting; Ctrl+J is the reliable newline fallback. Abort is distinct from skip. It closes the questionnaire and returns `cancelled`, while keeping the last snapshot in session history.

## Lifecycle and persistence

The first tool call briefly uses `ctx.ui.custom()` only to obtain Pi's current `TUI` and theme. The questionnaire itself is mounted with the public `TUI.showOverlay()` API as a full-viewport overlay (`100%` width and height, zero margin) that adapts to the current terminal dimensions. Long questionnaire content is windowed and scrolled inside the questionnaire. This overlay does not add terminal transcript/history scrolling.

When a round returns to the model, `OverlayHandle.unfocus()` returns input to Pi while the questionnaire stays visible. Alt+Q or `/questionnaire` moves focus between Pi and the persistent overlay without changing answers or clarification state. No prompt promise is left pending, no user message is synthesized, and no steering/follow-up message is queued.

Snapshots are branch-local custom session entries and are also copied into tool-result details. New clarification records carry their question ID and response time. Existing version-1 snapshots with legacy unscoped clarification records remain readable; those records are not attached to an arbitrary active question. Reload, restart, resume, fork, and session-tree reconstruction use only the newly active branch. Tree navigation first settles an active tool call without writing cancellation into either branch, disposes the old overlay, and then binds a passive panel to the selected branch. Session shutdown likewise settles a pending call before disposal and performs no shutdown-time persistence.

Pi cannot resume an interrupted JavaScript tool promise after process restart or `/reload`. The extension restores the visible read-only panel and saved answers, then the main agent must call `ask_user` again to resume interaction. This is intentionally reported rather than presented as seamless continuation.

The full UI is TUI-only. RPC's `custom()` is documented to return `undefined`, so RPC, JSON, and print modes return `unavailable` instead of degrading to a misleading partial questionnaire.

## Tests

```bash
NODE_OPTIONS='--conditions=import' npx --yes tsx --test extensions/ask-user/*.test.ts
npx --yes tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck --allowImportingTsExtensions \
  extensions/ask-user/state.ts extensions/ask-user/ui.ts \
  extensions/ask-user/index.ts extensions/ask-user/*.test.ts
```

The suite covers graph visibility, transitive invalidation, reserved-ID/prototype safety, strict and legacy snapshot validation, no-skip validation, immediate and multiline editing, narrow wrapping, editor arrow isolation, per-question draft restoration, inline clarification layout, repeated same-question follow-ups before and after answering, independent other-question threads, long-thread page scrolling, stale-thread pruning, model-reply refocus, grouped final review, full-viewport narrow/wide sizing, focused and global Alt+Q behavior, explicit abort, repeated main-agent rounds with one retained panel, multi-exchange reload reconstruction, model-visible stable values, branch-tree rebinding, shutdown waiter settlement, flatten-session validation, and non-TUI behavior.
