# Built-in components

Part of the [`@octocodeai/octocode-tui` guide](../README.md). To write your own, see [Writing a component](../README.md#writing-a-component). Styling arguments are functions `(text) => string`.

| Component                                       | Constructor                                                                | Notes                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Container`                                     | `new Container()`                                                          | `addChild`, `removeChild`                                                                                       |
| `Box`                                           | `new Box(paddingX = 1, paddingY = 1, bgFn?)`                               | Padding and background for children; `setBgFn`                                                                  |
| `Text`                                          | `new Text(text, paddingX = 1, paddingY = 1, bgFn?)`                        | Wraps words; `setText`, `setCustomBgFn`, `setHangingIndent(true)` keeps a line's leading spaces on wrapped rows |
| `TruncatedText`                                 | `new TruncatedText(text, paddingX = 0, paddingY = 0)`                      | One line cut to the width: status lines, headers                                                                |
| `Spacer`                                        | `new Spacer(lines = 1)`                                                    | Empty lines                                                                                                     |
| `Input`                                         | `new Input(options?)`                                                      | Options `secret`, `prompt` (`"> "`), `placeholder`, `placeholderStyle`; `onSubmit`, `setValue`, `getValue`      |
| `Editor`                                        | `new Editor(tui, theme, options?)`                                         | `tui` is required for height-aware scrolling                                                                    |
| `Markdown`                                      | `new Markdown(text, paddingX, paddingY, theme, defaultStyle?, options?)`   | `setText`                                                                                                       |
| `StreamingText`                                 | `new StreamingText(text, paddingX, style?, transform?)`                    | Markdown source as plain wrapped text while it streams; `setText`                                               |
| `Loader`                                        | `new Loader(tui, spinnerFn, messageFn, message = "Loading…", indicator?)`  | `start`, `stop`, `setMessage`                                                                                   |
| `CancellableLoader`                             | Same as `Loader`                                                           | Escape aborts: `signal`, `aborted`, `onAbort`                                                                   |
| `SelectList`                                    | `new SelectList(items, maxVisible, theme, layout?, options?)`              | `onSelect`, `onCancel`, `onSelectionChange`, `setFilter`                                                        |
| `SettingsList`                                  | `new SettingsList(items, maxVisible, theme, onChange, onCancel, options?)` | `updateValue(id, value)`                                                                                        |
| `Image`                                         | `new Image(base64, mimeType, theme, options?)`                             | PNG, JPEG, GIF, WebP; see [images](#image)                                                                      |
| `ScrollView`, `VStack`, `HStack`, `MouseRegion` | —                                                                          | [Core API](core-api.md#alternate-screen-layouts)                                                                |

`Text`, `Markdown` and the other components write escape sequences in their text to the terminal as they are; sanitize untrusted text first ([Core API](core-api.md#component-interface)). `Input` never holds a control character: typed and pasted text drop them, and `setValue` strips C0, DEL and C1 controls (line breaks become spaces, a tab four spaces), so a stored label cannot write a terminal sequence.

## Key bindings

| Key                                        |       `Input`       |                        `Editor`                        |
| ------------------------------------------ | :-----------------: | :----------------------------------------------------: |
| `Enter`                                    |       Submit        |                         Submit                         |
| `Shift+Enter` / `Ctrl+Enter` / `Alt+Enter` |          —          | New line (terminal-dependent; Alt+Enter most reliable) |
| `Tab`                                      |          —          |                      Autocomplete                      |
| `Ctrl+A` / `Ctrl+E`                        |   Line start/end    |                     Line start/end                     |
| `Ctrl+W` or `Alt+Backspace`                |  Delete word back   |                    Delete word back                    |
| `Alt+D` or `Alt+Delete`                    |          —          |                  Delete word forward                   |
| `Ctrl+U` / `Ctrl+K`                        | Delete to start/end |                  Delete to start/end                   |
| `Ctrl+Left/Right`, `Alt+Left/Right`        |      Word move      |                   Arrows, word move                    |
| `Ctrl+]` / `Ctrl+Alt+]`                    |          —          |   Jump forward/backward to the next typed character    |

In alternate-screen mode, clicking positions the cursor and focuses an `Input`, and `Editor` also accepts clicks on autocomplete rows.

## Editor

```typescript
const editor = new Editor(tui, { borderColor: (s) => chalk.blue(s), selectList: selectTheme }, { paddingX: 1 });
editor.onSubmit = (text) => send(text);
editor.onChange = (text) => draft(text);
editor.disableSubmit = true; // temporarily
editor.setAutocompleteProvider(provider);
editor.borderDecorator = (edge, width, hiddenLineCount, standard) =>
	hiddenLineCount > 0 ? standard() : chalk.blue("─".repeat(width));
```

| Member                                     | Purpose                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `EditorOptions`                            | `paddingX` (default 0), `autocompleteMaxVisible`                                |
| `borderColor`, `setPaddingX`/`getPaddingX` | Change style and padding at runtime                                             |
| `borderDecorator`                          | Draws a border row itself; `standard()` draws the editor's own (scroll markers) |
| `visibleLineCount`                         | Text rows drawn between the borders in the last render                          |

Pastes over 10 lines become a `[paste #1 +50 lines]` marker (shorter long pastes show `[paste #N <chars> chars]`); control characters other than newlines are removed from pasted text. Autocomplete (`/` commands, mid-text `/` skills, `@` files): see [input](input-and-terminal.md#autocomplete).

## Markdown

Supports headings, emphasis, code blocks, lists, links, blockquotes, tables (rule under the header, rules between rows only when a row wraps) and task lists (`☐` / `✔`, done items struck through). HTML tags render as text. Rendered lines are cached.

| Theme field (`MarkdownTheme`)                                        | Styles                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `heading`, `link`, `linkUrl`, `code`, `codeBlock`, `codeBlockBorder` | Headings, links, code                                       |
| `quote`, `quoteBorder`, `hr`, `listBullet`                           | Blocks                                                      |
| `bold`, `italic`, `strikethrough`, `underline`                       | Inline styles                                               |
| `highlightCode?(code, lang?)`                                        | Syntax highlighting; long lines wrap under the block indent |
| `codeBlockLabel?`, `alert?`, `codeBlockIndent?`                      | Language label, GitHub alerts, indent (`"  "`)              |

`MarkdownOptions`: `preserveOrderedListMarkers` (also keeps task lists as source `[ ]`/`[x]`), `preserveBackslashEscapes`, `transform(markdown, availableWidth)`. `DefaultTextStyle`: `color`, `bgColor`, `bold`, `italic`, `strikethrough`, `underline`.

Markdown does not render streamed text incrementally. Show text that is still streaming with `StreamingText`: plain wrapped text, no Markdown parsing, where an append re-wraps only the text after the last line break. Replace it with a `Markdown` once the text is final. Parsed tokens are held weakly, so a re-render after a theme or width change can reuse them until they are collected.

## SelectList and SettingsList

```typescript
const list = new SelectList([{ value: "a", label: "Option A", description: "First" }], 5, theme);
list.onSelect = (item) => use(item);

const settings = new SettingsList(
	[
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "model", label: "Model", currentValue: "gpt-4", submenu: (value, done) => modelPicker(value, done) },
	],
	10,
	theme,
	(id, value) => save(id, value),
	() => close(),
);
```

| List           | Theme fields                                                                                    | Controls                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SelectList`   | `selectedText`, `description`, `scrollInfo`, `noMatch` (optional `matchHighlight`, `directory`) | Arrows move, `Enter` selects, `Escape` cancels; mouse move/wheel highlights, click selects (alternate screen) |
| `SettingsList` | `label(text, selected)`, `value(text, selected)`, `description`, `cursor`, `hint`               | Arrows move, `Enter`/`Space` cycles `values` or opens the `submenu`, `Escape` cancels; mouse as above         |

## Image

Inline images use the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images; other terminals, and data that is not plain base64, get a text placeholder. `ImageOptions`: `maxWidthCells`, `maxHeightCells`, `filename`. Dimensions come from the header; `setImageTranscoder()` converts formats a terminal cannot show.

- `getCapabilities().images` is `"kitty"`, `"iterm2"` or `null`, from environment hints such as `TERM=xterm-kitty`.
- On interactive stdin and stdout, `ProcessTerminal` sends a one-pixel Kitty query that shares the device-attributes sentinel. `OK` enables Kitty; an error or an unacknowledged reply disables it; no reply keeps the environment guess. Nothing is shown or stored. Redirected streams, tmux/screen, Rex and iTerm2 terminals skip it.
- `OCTOCODE_IMAGE_PROTOCOL=kitty|iterm2|none` forces a choice (`auto` keeps detection); explicit capability overrides win.
- A capability change (the `Terminal.start` third callback) invalidates components, re-queries cell size and repaints. Components that pick image or text at construction should re-decide in `invalidate()`.
- `TuiAltScreen` supports Kitty images with vertical cropping, but draws iTerm2 images as text (iTerm2 cannot delete or crop placements while scrolling); `TuiMainScreen` still draws them. tmux: [images in tmux](input-and-terminal.md#images-in-tmux).
