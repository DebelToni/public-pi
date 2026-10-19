# HTML widgets

Shared source parser and native terminal display fold. This extension never executes HTML, starts a browser, registers tools, or edits conversation/session messages.

## Format and parser contract

Use a top-level fenced code block with literal lowercase `html-widget` followed optionally by a space/tab and a plain title:

````markdown
```html-widget Counter
<!doctype html>
<button onclick="this.textContent = +this.textContent + 1">0</button>
```
````

`widget-format.mjs` is pure ESM with no imports:

- `widgetInfo(lang)` returns `{ title }` for the exact language or `undefined`. Outer whitespace is trimmed. Titles retain literal Markdown/HTML/backslashes, remove C0/C1 controls, Unicode line separators and bidi direction controls, trim surrounding whitespace, and stop at 120 Unicode code points. The empty-title default is `Interactive HTML`.
- `splitHtmlWidgets(text, lexer)` accepts the original message string and a synchronous caller-supplied `marked.lexer` function. It returns ordered `{ type: 'markdown', text }` and `{ type: 'widget', source, title, index }` parts. Widget indices start at zero for each call. Empty input returns `[]`; empty Markdown parts are omitted and adjacent Markdown is merged.
- `widgetTokenInfo(token)` is the shared completion/info helper for already-lexed code tokens. It does **not** establish top-level placement by itself.

Only completed, top-level fenced code tokens qualify. Backtick/tilde closers must use the opener's character, be at least as long, contain no suffix except spaces/tabs, and have at most three leading spaces. A closer at EOF counts as complete. Unclosed/partial fences, four-space/tab-indented code, list/quote children, examples inside outer documentation fences, HTML comments, and ordinary `html` fences remain Markdown. Escaped language spellings such as `html\-widget` are inert even when Marked unescapes `token.lang`.

The parser first lexes the complete newline-normalized message and selects only completed root widget tokens. With none, it returns the exact original prose immediately, without inspecting or aligning any ordinary token's `raw`. This makes heading/list/quote/reference raw transformations irrelevant to ordinary rendering.

Standalone intentional opening lines are collected without searching for ordinary token boundaries. A grouped full-context mask changes the first letter of `html-widget` to `xtml-widget` at a subset of these positions. This is fixed-width and changes no delimiters, so root grammar stays unchanged; the decrease in completed root widget count identifies how many genuine openings were masked. The all-candidate mask must remove the canonical root widget count. Recursive bisection skips zero-positive subsets and selects an entire subset when its positive count equals its size. A single real frame among K inert examples therefore needs O(log K) full-message validation lexes, not K prefix probes.

Only selected openings receive closing-line scans, using the original fence character, minimum length and indentation rules. Their spans must match the canonical root widget sequence exactly and must not overlap. A standalone lex of each selected fenced span verifies its body against the canonical `token.text`. No probe body or mutated text is returned. Invalid counts, spans or bodies throw atomically. Identical reference-title/documentation/math examples remain inert, and false unclosed markers inside HTML/comments cannot swallow a later selected frame. No non-widget offset mapping, forward raw-token search, suffix re-lexing or per-false-candidate prefix proof remains.

Accepted normalized positions are mapped monotonically back to original-source offsets, preserving all surrounding prose byte-for-byte, including CRLF/lone-CR endings and definitions. Widget removal ends at the last non-whitespace character of the closing fence; subsequent whitespace stays in Markdown. Bodies and titles come from the original full-source root tokens, with literal raw info used for titles. Consumers must escape titles when embedding them into HTML and apply their own HTML execution/isolation policy.

The synchronous lexer's results are read-only. Callers needing the root link table must retain the **first full-source result**, not overwrite it with a later full-context mask or selected-frame body validation. Lexer exceptions and inconsistent widget declarations propagate; ordinary raw-token normalization is never an error condition.

### Operational budgets

The pure module exports `MAX_HTML_WIDGETS = 32`, `MAX_LEXER_CALLS = 64`, and `MAX_LEXED_CHARS = 16 * 1024 * 1024`. These are per `splitHtmlWidgets` call. Character accounting uses JavaScript UTF-16 string lengths of the actual lexer inputs, including the initial normalized message, every grouped mask and every selected-frame validation. The next lexer call is refused **before** either work budget would be exceeded. More than 32 completed root widgets is rejected immediately after the initial lex.

Resource failures throw `Error` with `code: "HTML_WIDGET_LIMIT"`, `status: 413`, and a message naming the exhausted budget. No partial parts are returned. A frontend may catch **only** this identified error to display the original source inert with a visible limit hint; contract/lexer errors must not be silently hidden. The ordinary Markdown renderer is unchanged. A no-widget message within the initial input budget returns its exact original text after one lex; an initial input already above the character budget is rejected before lexing. These accounting caps bound parser validation work, not the internal runtime of a caller-supplied lexer.

## Native extension contract

`index.ts` installs the stateless patch at factory time because historical chat can render before `session_start`. The only wrapped method is the private TUI `Markdown.renderToken(token, width, nextTokenType, styleContext)` seam. Non-widget tokens delegate with their receiver and all four arguments intact. Reentrant child rendering is tracked per component so list/blockquote examples remain unchanged.

An eligible token returns one line, `[HTML widget · Title]`, truncated using Pi's `truncateToWidth` and styled using the component's current `theme.codeBlockBorder`. Width zero returns an empty line; narrow widths use Pi's ellipsis. No extra blank spacing is inserted. Theme evaluation occurs during rendering. `renderInlineTokens` remains untouched, including the existing `inline-images` wrapper.

Shutdown cleanup restores the captured method only when still the outer owner. A later wrapper is retained with our inner layer disabled. Reload reuses that layer, changes its ownership token, and cannot be undone by stale cleanup. Restarting a session within the same runtime reinstalls the patch.

### Private-seam limits

Verified against release `fd81f791cde9ae95cb740b2ab039f02f00e4e127`. This is deliberately an extension-only private-seam patch, not an SDK guarantee.

- Missing/non-callable `renderToken`: no patch; TUI `session_start` displays a warning. RPC/JSON/print modes receive no warning.
- Missing component `theme.codeBlockBorder`: delegate unchanged. Other future changes to a callable method's signature/semantics are not automatically detected; revalidate on Pi upgrades.
- A later wrapper that stops delegating, or replaces the method outright, can prevent folding. Cleanup never overwrites its method.
- Pi currently changes tabs to three spaces before tokenization and can apply source transforms. Display folding follows those tokens. In particular, a tab-indented fence can look folded even though the original-source parser leaves it inert. **Execution consumers must use `splitHtmlWidgets` on the original message, never terminal output or display tokens.**
- A component rendered before installation may retain cached output until normal invalidation. No global redraw or cache mutation is performed.

## Verification

With the Pi host packages available, run the retained extension/helper regressions:

```sh
node --test extensions/html-widgets/*.test.mjs
```

The retained tests cover parser intent, source preservation, streaming/nesting, native folding, widths, theme changes, reload/cleanup ownership, and extension loading. Host-application math-lexer, boundary, work-budget, and reviewer-corpus integration tests are omitted because their separate application source is not part of this mirror. Consumers should verify those boundaries against their own lexer and execution frontend.
