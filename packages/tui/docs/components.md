# Built-in Components

Part of the [`@octocodeai/octocode-tui` guide](../README.md). To write your own, see [Custom components](custom-components.md).

## Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

## Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
	1, // paddingX (default: 1)
	1, // paddingY (default: 1)
	(text) => chalk.bgGray(text), // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text)); // Change background dynamically
```

## Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
	"Hello World", // text content
	1, // paddingX (default: 1)
	1, // paddingY (default: 1)
	(text) => chalk.bgGray(text), // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
text.setHangingIndent(true); // wrapped rows keep the leading spaces of the line they continue
```

## TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
	"This is a very long line that will be truncated...",
	0, // paddingX (default: 0)
	0, // paddingY (default: 0)
);
```

## Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

Clicking positions the cursor and gives the input keyboard focus in alternate-screen mode.

The value never holds a control character: typed and pasted text drop them, and `setValue` removes C0, DEL and C1 controls (line breaks become spaces, a tab four spaces), so a stored name or label cannot write a terminal sequence when the input draws it.

**Key Bindings:**

- `Enter` - Submit
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Ctrl+U` - Delete to start of line
- `Ctrl+K` - Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` - Word navigation
- `Alt+Left` / `Alt+Right` - Word navigation
- Arrow keys, Backspace, Delete work as expected

## Editor

Multi-line text editor with autocomplete, file completion, paste handling, and vertical scrolling when content exceeds terminal height.

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // Horizontal padding (default: 0)
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
// Draw the border rows yourself; `standard()` draws the editor's own (scroll markers, a subclass's override)
editor.borderDecorator = (edge, width, hiddenLineCount, standard) =>
  hiddenLineCount > 0 ? standard() : chalk.blue("─".repeat(width));
editor.visibleLineCount; // Text rows the last render drew between the top and bottom border
```

**Features:**

- Click-to-position cursor and clickable autocomplete rows in alternate-screen mode
- Multi-line editing with word wrap
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker); control characters other than newlines are removed from pasted text
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)

**Key Bindings:**

- `Enter` - Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter` - New line (terminal-dependent, Alt+Enter most reliable)
- `Tab` - Autocomplete
- `Ctrl+K` - Delete to end of line
- `Ctrl+U` - Delete to start of line
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Alt+D` or `Alt+Delete` - Delete word forwards
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+]` - Jump forward to character (awaits next keypress, then moves cursor to first occurrence)
- `Ctrl+Alt+]` - Jump backward to character
- Arrow keys, Backspace, Delete work as expected

## Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

const md = new Markdown(
	"# Hello\n\nSome **bold** text",
	1, // paddingX
	1, // paddingY
	theme, // MarkdownTheme
	defaultStyle, // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

**Features:**

- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`; long code lines wrap under the block indent and the line's own indentation
- Tables with a rule under the header; rules between rows appear only when a row wraps
- Task lists as `☐` / `✔` (done items struck through), or the source `[ ]` / `[x]` with `preserveOrderedListMarkers`
- Padding support
- Render caching for performance

## Loader

Animated loading spinner.

```typescript
const loader = new Loader(
	tui, // TUI instance for render updates
	(s) => chalk.cyan(s), // spinner color function
	(s) => chalk.gray(s), // message color function
	"Loading...", // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

## CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
	tui, // TUI instance for render updates
	(s) => chalk.cyan(s), // spinner color function
	(s) => chalk.gray(s), // message color function
	"Working...", // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**

- `signal: AbortSignal` - Aborted when user presses Escape
- `aborted: boolean` - Whether the loader was aborted
- `onAbort?: () => void` - Callback when user presses Escape

## SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

const list = new SelectList(
	[
		{ value: "opt1", label: "Option 1", description: "First option" },
		{ value: "opt2", label: "Option 2", description: "Second option" },
	],
	5, // maxVisible
	theme, // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

**Controls:**

- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Select a row
- Arrow keys: Navigate
- Enter: Select
- Escape: Cancel

## SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[]; // If provided, Enter/Space cycles through these
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

const settings = new SettingsList(
	[
		{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
		{ id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
	],
	10, // maxVisible
	theme, // SettingsListTheme
	(id, newValue) => console.log(`${id} changed to ${newValue}`),
	() => console.log("Cancelled"),
);
settings.updateValue("theme", "light");
```

**Controls:**

- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Activate a row
- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

## Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

## Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals, and also when the data is not plain base64, since other bytes could end the terminal's image sequence early.

```typescript
interface ImageTheme {
	fallbackColor: (str: string) => string;
}

interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
}

const image = new Image(
	base64Data, // base64-encoded image data
	"image/png", // MIME type
	theme, // ImageTheme
	options, // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.

### Image capability detection

`getCapabilities().images` returns `"kitty"`, `"iterm2"`, or `null`. Environment hints include `TERM=xterm-kitty`, so Kitty sessions can be recognized without local window variables.

On interactive stdin and stdout, `ProcessTerminal` also sends a Kitty graphics query with a one-pixel PNG. It shares the keyboard negotiation's device-attributes sentinel and does not wait before accepting input. A matching `OK` enables Kitty images; an error or a device-attributes reply without a graphics acknowledgement disables them. If neither reply arrives, environment detection remains in effect. The query does not display or store the pixel. See the [Kitty protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/#querying-support-and-available-transmission-mediums).

The optional third callback to `Terminal.start(onInput, onResize, onCapabilitiesChange)` reports capability changes. The TUI uses it to invalidate mounted components, query cell dimensions, and repaint images in both renderers. Custom components that choose an image or text fallback during construction should reconsider that choice in `invalidate()`.

Explicit capability overrides take precedence. Automatic probing is skipped for redirected streams, tmux/screen (inside tmux, Kitty images use passthrough and Unicode placeholders; see [Terminal multiplexers](input-and-terminal.md#terminal-multiplexers)), Rex, and terminals detected as using the iTerm2 image protocol. `OCTOCODE_IMAGE_PROTOCOL=kitty`, `iterm2`, or `none` forces the corresponding choice; `auto` keeps detection enabled.

### Alternate-screen image compatibility

`TuiAltScreen` supports inline images and partial viewport cropping in terminals that implement the Kitty graphics protocol, including Kitty and Ghostty. iTerm2's inline-image protocol does not provide operations to delete an existing placement or crop its source while scrolling. To prevent stale images from remaining over repainted content, `TuiAltScreen` renders image components as text placeholders in iTerm2. `TuiMainScreen` continues to render iTerm2 inline images normally.
