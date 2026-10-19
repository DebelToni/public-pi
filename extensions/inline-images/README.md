# Conversation image viewer

Local Markdown images, `![description](/absolute/image.png)`, render as compact `[IMAGE 00 - description]` labels. The existing registry assigns two-character base-36 IDs, reuses paths and resets for a new conversation. Option+I opens the newest registered image; `/image 00` selects one. The fullscreen tmux popup keeps its existing navigation and Kitty streaming path.

## Submitted image paths

The `input` handler attaches actual PNG/JPEG/WebP/GIF blocks for local image references from interactive, RPC and extension input, including `sendUserMessage`, steering and follow-up. It leaves `event.text` byte-exact and preserves the first incoming image block when deduplicating identical decoded bytes. Resolved path aliases and identical files/images attach once. Pi still owns prompt image normalization, model-specific resizing and its existing resize hints; no conversion service is added.

`~/images/<short-id>.jpg` resolves under the current user's home. Existing absolute references, including `/tmp/example-image.jpg`, remain supported. Short-path allocation and phone/X upload are owned by the other integration, not this extension.

Files must be regular, nonempty and at most 20 MiB. A submission permits at most 20 distinct images, at most 20 distinct reference spellings and 20 incoming blocks before content deduplication, and at most 50 MiB of unique compressed file bytes after base64 decoding. Header dimensions are bounded to 64 MP and 16384 pixels per side before Pi's exported worker decoder validates pixels. Pi's exported `detectSupportedImageMimeTypeFromFile` sniffs the already-opened file: valid PNG bytes in a `.JPG` file attach as PNG. Missing, corrupt, unsupported, oversized or nonregular references reject the whole submission with an error notification, or a stderr diagnostic without UI. Returning `handled` is intentional because Pi catches input-handler exceptions and otherwise continues with the original input.

## Shared browser parser contract

`image-paths.mjs` exports `findImageReferences(text): {path, start, end}[]`. It has no imports, Node APIs, filesystem access or side effects. `image-paths.d.mts` supplies TypeScript declarations.

- Results are in source order and deduplicate exact unwrapped/unescaped path spellings, keeping only the first span. `start` is inclusive and `end` exclusive, both JavaScript UTF-16 string indices, suitable for `text.slice(start, end)`.
- Spans cover the entire removable reference, including quotes, angle brackets, inline backticks or Markdown image/link syntax and optional title. `path` strips those wrappers and Markdown backslash escapes, without tilde/cwd resolution or URL decoding. The original text is never modified.
- Bare references require `/absolute`, `~/`, `./`, `../` or `directory/file` syntax. Bare filenames such as `photo.jpg` are prose. Explicit wrappers allow filename-only paths and spaces: `"./my photo.JPG"`, `<~/images/my photo.jpg>`, `![camera](<./my photo.jpg>)`.
- Suffix recognition is case-insensitive: PNG, JPG/JPEG, WebP, GIF, HEIC/HEIF, AVIF, BMP, TIF/TIFF, SVG and ICO. Recognition is not a promise of decodability; unsupported native content is rejected with advice to use X's existing camera-format normalization.
- HTTP, data, protocol-relative and other scheme references are ignored as whole references, including URL suffixes after parentheses. Raw paths containing spaces must be wrapped.

The phone app can import `../../.pi/agent/extensions/inline-images/image-paths.mjs`; its backend can import `../.pi/agent/extensions/inline-images/image-paths.mjs`. Consumers that remove references should note that duplicate occurrences intentionally have no additional returned spans.

## Uploaded user images

Plain local path references and native user-message image blocks get display-only Markdown references beneath the original text. Exact-byte duplicates from path plus native block share one label; visible legacy Markdown image references keep their original inline label. Fenced references, including blockquote/list-contained fences, get a separate visible label. Visibility follows Pi's Markdown grammar through an isolated unstyled inline-token scan that emits no image output or registry labels. If a historical source path is missing, the persisted native block still supplies a cached image. Image-only messages also get a visible label. This uses the same Markdown renderer and registry, without introducing another picker.

## Resized-image provenance

At input time, `provenance.ts` predicts normalized bytes and resize hints using the public SDK `resizeImage`/`formatDimensionNote` exports and `ctx.model.inputLimits.images.resize`. It keeps raw blocks unchanged. On the supported `message_start` event, only an exact match of the complete ordered MIME/hash vector and unmodified text or SDK-generated hints establishes correspondence. A custom `inline-images-source-v1` entry stores the specific message fingerprint, source paths/raw hashes and derived image indices/hashes outside model context. Startup and branch changes restore entries from the active branch. The interactive renderer also lazily hydrates persisted provenance from its actual session manager before constructing chat, because Pi's reload rebuild precedes `session_start`. This path establishes the current cwd/registry session and preserves pending queued-input metadata.

Rendering suppresses only the proven derived slot when that source path still has its original hash. An unrelated native image at another index stays visible even if its normalized bytes happen to equal the photo's. No perceptual matching, payload metadata, model text edits or normalization-core patches participate. Resize-disabled and streaming raw-image behavior retains exact-byte dedup. Missing or changed historical source paths keep native/cache fallback available.

Older messages without provenance, expanded/changed text, or a later model/profile change whose actual bytes do not match prediction conservatively retain both labels. Pending metadata is capped at 100 cancelled/queued inputs; ambiguous matches refuse association.

## Phone acceptance preflight

`extensions/pi-chat/index.ts` awaits the same path/native validation before clearing drafts, arming fast mode or appending an accepted receipt. Refusals return HTTP 409 with the original draft intact. Session/branch ownership and the terminal draft are rechecked after validation. The supported `inline-images:prepare-input` event gives the native extension a one-shot byte snapshot tied to the exact text, image object identities, cwd and session; asynchronous input handling consumes that snapshot without reopening source paths. Source deletion after acceptance therefore cannot turn a valid phone submission into a consumed/missing prompt. Without the inline-images extension, direct shared validation still supplies actual native blocks to Pi.

`attachments.ts` wraps the interactive `addMessageToChat` renderer once, appending a separate Markdown component after ordinary user rendering. It does not alter messages, add transcript entries, change provider payloads or put references into prompt recall/history. Separate Markdown keeps an unclosed fence in user text from hiding the image labels. Startup/reload use Pi's own SDK aliases; shutdown restores the original renderer without overwriting a later wrapper. Unsupported renderer shapes leave existing behavior intact with a warning.

Images are materialized from their native base64 blocks into `~/.local/state/pi-inline-images/attachments/`. MIME/content hashes provide deterministic PNG/JPEG/WebP/GIF paths; identical images reuse files. Writes use private temporary files and atomic rename, with 0700 directories and 0600 files. This cache is persistent, derived and unencrypted, not an independent backup. A missing cache file is regenerated when its message is rendered again, including resumed conversations. An unavailable cache produces an inline unavailable marker rather than breaking transcript rendering.

New Pi processes load the update. Existing processes need owner-controlled idle `/reload`; no working agent is automatically reloaded. Phone rendering and attachment resizing are unchanged.

## Verification

```sh
cd /home/user/.pi/agent
node --test extensions/inline-images/*.test.ts extensions/inline-images/*.test.mjs extensions/pi-chat/*.test.ts
```

Checks use owned temporary images and SDK sessions, real Pi user/Markdown rendering and mocked tmux calls. Shared grammar tests also run the parser in a browser-like realm. Input tests cover all sources, existing native images, decoded content/MIME validation, missing and nonregular files, limits, SDK prompt normalization and real steering/follow-up queues at an intercepted inference boundary. They cover byte-preserving private cache files, missing-file recovery, MIME/failure handling, narrow widths, placement beneath text, image-only messages, unclosed fences, repeated installation, unchanged prompt history, actual Option+I manifests, shutdown restoration and SDK/jiti owned reload with unchanged transcript/model context. Additional review checks cover actual TUI `/reload` ordering with pre-`session_start` chat rebuilds for absolute/relative paths, nested blockquote/list fences versus visible Markdown, pending provenance surviving render-time hydration, real SDK resizing, unchanged hints/context, branch-restored provenance, unrelated native slots with identical normalized bytes, phone HTTP refusal without draft/receipt/fast side effects, draft races and accepted snapshot delivery after source deletion. No model request or real popup is used. Physical Kitty display remains the existing viewer's responsibility.
