# Input, rendering and terminals

Part of the [`@octocodeai/octocode-tui` guide](../README.md).

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@octocodeai/octocode-tui";

const provider = new CombinedAutocompleteProvider(
	[
		{ name: "help", description: "Show help" },
		{ name: "clear", description: "Clear screen" },
		{ name: "delete", description: "Delete last message" },
	],
	process.cwd(), // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**Features:**

- Type `/` to see slash commands
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefix
- Filters to attachable files for `@` prefix
- Never suggests a file name that contains control characters, which would otherwise reach the terminal as escapes

## Key Detection

Use `matchesKey()` with the `Key` helper for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import { matchesKey, Key } from "@octocodeai/octocode-tui";

if (matchesKey(data, Key.ctrl("c"))) {
	process.exit(0);
}

if (matchesKey(data, Key.enter)) {
	submit();
} else if (matchesKey(data, Key.escape)) {
	cancel();
} else if (matchesKey(data, Key.up)) {
	moveUp();
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):

- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

## Rendering modes

`TuiMainScreen` uses three rendering strategies:

1. **First Render**: Output all lines without clearing scrollback
2. **Width Changed or Change Above Viewport**: Clear screen and fully re-render
3. **Normal Update**: Move the cursor to the first changed line, clear to the end, and render changed lines

`TuiAltScreen` owns a terminal-height viewport. Without an explicit layout root it preserves the legacy single-document scrolling behavior. With `setLayoutRoot()`, `VStack`, `HStack`, and nested `ScrollView` components can reserve fixed regions and independently scroll constrained regions. It updates changed viewport rows in place, follows streaming output while at the bottom, and preserves a manually selected scroll position while content grows. Mouse-wheel and configurable keyboard navigation scroll without modifying terminal scrollback, including jumps between OSC 133 semantic prompt markers. Scrollbars support hover expansion, thumb dragging, and track-click jumping. Clicking an OSC 8 hyperlink opens it with the configured URL handler. Dragging with the primary mouse button selects text and, unless `TuiAltScreenOptions.copyOnSelect` is `false`, copies it to the clipboard with OSC 52; holding the drag at a scroll view's top or bottom edge auto-scrolls and extends the selection into off-screen content. Kitty images support vertical viewport cropping; iTerm2 inline images fall back to text because the iTerm2 protocol cannot delete or crop placements during viewport repainting.

Both renderers wrap updates in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

### Experimental render pacing

The default scheduler still coalesces ordinary requests at a 16 ms minimum interval. Applications can opt a concrete renderer into output-pressure admission, adaptive cadence, or both independently:

```typescript
const tui = new TuiMainScreen(new ProcessTerminal());
tui.setRenderPacing({ outputGate: true, metrics: true });
// Or trial only frame-cost pacing: tui.setRenderPacing({ adaptiveCadence: true, metrics: true });
const stats = tui.getRenderPacingStats();
```

The optional `Terminal.pendingOutputBytes` reports queued output where a terminal can observe it; custom implementations without it retain the legacy schedule. Scheduled frames are deferred before their diffs are composed when the queue exceeds the experimental 256 KiB high watermark, then retry every 10 ms until it falls to 128 KiB. These values can be set with `highWaterBytes`, `lowWaterBytes` and `retryMs`; they are **unmeasured starting values**, not a memory limit. `requestRender(true)` and `renderNow()` bypass the gate, as do terminal restoration and final output. An individual frame may exceed the watermark. Adaptive cadence uses the previous frame duration with a 200 ms maximum interval and is off by default.

`metrics: true` enables bounded counters for painted and deferred frames, maximum observed queued bytes, frame time, timer lateness and input-to-paint latency. `ProcessTerminal` also counts bytes, write sizes and writes that returned `false` through `getOutputTelemetry()`. No transcript text is retained. The extra counters and decorative-progress keepalive suppression are disabled by default. The opt-in gate cannot prevent a synchronous POSIX TTY write from blocking; measure on the target transport before enabling it. Run `node scripts/profile-render-backpressure.mjs --trials 3` from the repository root for a four-mode **offline simulated-consumer** comparison; it is not a live PTY or end-user benchmark.

## Terminal Interface

The TUI works with any object implementing the `Terminal` interface:

```typescript
interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
}
```

**Built-in implementations:**

- `ProcessTerminal` - Uses `process.stdin/stdout`
- `VirtualTerminal` - For testing (uses `@xterm/headless`)

### Terminal multiplexers

`detectMultiplexer(env?)` returns `"tmux"`, `"screen"`, `"zellij"` or `null`, checking the session markers (`TMUX`, `STY`, `ZELLIJ`) before the `TERM` prefix. `hasTmuxSession(env?)` is true only with `TMUX` set; a `tmux*` `TERM` alone is not a session. `paneTarget(env?)` returns the pane id from `TMUX_PANE`, or `undefined` when it is unset or empty; the tmux queries and the pane launcher use it as their one `-t` target rule. `tmuxExec(args, options?)` is the one asynchronous `tmux` call (it rejects with `tmux failed: <stderr>`, or the abort reason, after a 5-second default timeout), and `tmuxGlobalOption(name, env?)` reads a global option with it, or `undefined` when tmux cannot answer. The tmux queries below run `tmux` synchronously with a short timeout, ignore stderr, cache their answer per `TMUX` and `TMUX_PANE`, and never throw:

- `tmuxClientTerminalNames(env?)` lists the attached client's emulator names, best first: the name from `#{client_termtype}` (`kitty(0.35.2)` gives `kitty`), then `#{client_termname}`. It is `[]` when tmux cannot answer or no client is attached; that answer is not cached, so a client that attaches later is found.
- `tmuxClientTermFeatures(env?)` lists `#{client_termfeatures}`. Hyperlink detection inside tmux emits OSC 8 only when it contains `hyperlinks`.
- `tmuxPaneAllowsPassthrough(env?)` is true when the pane's `allow-passthrough` is `on` or `all`, or when tmux is older than 3.3 and has no such option. `wrapTmuxPassthrough(payload)` builds the `ESC P tmux; ... ESC \` envelope with every ESC doubled; wrap only when the pane allows it, because tmux drops the envelope otherwise.
- `resetMultiplexerCache()` clears the caches.

**Images.** Inside a tmux session, automatic detection turns Kitty images on only when all of these hold: the attached client is Kitty or Ghostty (the only outer terminals here that draw Unicode placeholders; WezTerm and Warp do not), the pane's `allow-passthrough` lets the envelope through, and 24-bit colour reaches the client (`RGB` in `client_termfeatures`, or a truecolor `COLORTERM`). Otherwise images stay off and components render their text fallback. Probing is skipped, because tmux does not forward the reply.

In that mode `getCapabilities().kittyPlaceholders` is `true`. Every Kitty command is wrapped in `wrapTmuxPassthrough`; all chunks of one transmission share one envelope, because tmux can put another pane's output between envelopes and the terminal keeps only one chunked load in progress, so interleaved uploads from panes redrawing together would both be lost. A transmission over `TMUX_PASSTHROUGH_LIMIT` (1,000,000 escaped bytes, under tmux's 1 MiB `input-buffer-size` default, beyond which tmux drops the sequence) is split into several envelopes at chunk boundaries and can still be interleaved. The image is transmitted with a virtual placement (`a=T,U=1`), and `Image` returns one text line per row made of U+10EEEE cells. Each cell names its row and column with a combining mark, and the image id (kept within 24 bits) is the 24-bit foreground colour. tmux stores and redraws those cells like text, so the image follows scrolling, pane switches and redraws, which a cursor-positioned placement cannot do. The first row starts with the transmit sequence; `isImageLine` is true for every placeholder row so padding, truncation and overlay compositing leave them alone. If the first row scrolls out of the fullscreen viewport, the image is not re-sent, so it can show blank cells once the terminal has dropped its data. The placeholder cells stay in tmux, but an outer terminal attached later never received the uploads. With tmux's `focus-events on` and focus reports enabled, tmux sends the pane a focus-in on attach; the TUI then lists the session's clients (`tmux list-clients`, without blocking) and, when one is new or tmux cannot answer, writes the upload envelopes of its rendered lines again. A pane or window switch with the same clients sends nothing. Without focus events, a same-size attach shows blank cells until the next full redraw.

`OCTOCODE_IMAGE_PROTOCOL=kitty` (or the `terminal.images` setting) forces this mode inside tmux without the checks above; `none` disables it. iTerm2 inline images stay off inside tmux: tmux does not track where the outer terminal draws them, so they would not stay with the text, and there is no placeholder equivalent.

`packages/tui/test/helpers/fake-tmux.ts` puts a fake `tmux` first on `PATH` for tests (`display-message`, `show-options` and `show` replies); `helpers/real-tmux.ts` stops a private tmux server and removes its socket. `yarn run test:tmux` runs every tmux test.

**Pasted control keys.** With extended keys on, tmux can re-encode control bytes as extended keys: `ESC [ 27 ; 5 ; <codepoint> ~` with its default `extended-keys-format xterm`, or `ESC [ <codepoint> ; 5 u` with `csi-u`. `Editor` and `Input` decode both forms back to the control byte (Ctrl+J becomes a newline) when they appear inside a bracketed paste, so neither format leaks sequence text into the input. In a tmux 3.8 check, bracketed pastes arrived unchanged and only unbracketed input was re-encoded; that input arrives as key presses, and the editor inserts a newline for Ctrl+J.

**Bracketed paste.** tmux wraps a paste only while the pane's own paste mode (DEC 2004) is on, and detach, reattach, pane and window switches keep it. Anything that writes `ESC[?2004l` or a full reset to the pane's terminal (a child process sharing the tty) turns it off without telling the program, and a multi-line paste then arrives as separate lines. With a `TMUX` session, `ProcessTerminal` re-sends `ESC[?2004h` on input and resize at most once per second and never inside a paste. The first paste straight after a reset still arrives unbracketed.

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";

// Get visible width of string (ignoring ANSI codes)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello W…"

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// Wrap text to width (preserving ANSI codes across line breaks)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```
