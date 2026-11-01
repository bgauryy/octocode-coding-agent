# Core API

Part of the [`@octocodeai/octocode-tui` guide](../README.md).

## TUI interface and renderers

`TUI` is the shared interface for component management, focus, overlays, input, lifecycle, terminal queries, and rendering. Choose a concrete renderer only when constructing the application:

- `TuiMainScreen` renders into the main terminal buffer and preserves terminal scrollback.
- `TuiAltScreen` renders a fixed-height viewport in the alternate terminal buffer with application-owned scrolling. When stopped, it restores the main buffer and prints the complete final document.

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";

const tui: TUI = new TuiMainScreen(terminal);
// To use an application-owned viewport in the alternate terminal buffer instead:
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

A component that throws from `render` during a frame does not stop the others: it is drawn as one line, `⚠ <Component> failed to render: <first line of the error>`, until it renders again. The error goes to `tui.onRenderError` (a `RenderErrorListener`, `(error, component) => void`) once per distinct failure; without a listener it is appended to `octocode-tui-render-errors.log` in the log directory passed to the renderer's constructor, else the system temporary folder. A direct `render()` call outside a frame still throws ([`render-isolation.ts`](../src/tui/render-isolation.ts)).

## Colors and terminal styles

Colors are values that can be converted or mixed before terminal rendering:

```typescript
import {
	colorToRgb,
	foregroundAnsi,
	getTerminalColorMode,
	mixColors,
	parseColor,
	rgbColor,
	styleText,
} from "@octocodeai/octocode-tui";

const accent = parseColor("oklch(70% 0.12 220)");
const background = parseColor("#20242a");
const foreground = mixColors(accent, background, 0.2);

const text = styleText("Ready", { fg: foreground, bg: background, bold: true }, getTerminalColorMode());
```

`Color` is an indexed ANSI color, an sRGB color, or an OKLCH color. Every color converts to sRGB, so color math such as `mixColors()` always works. Indices 0-15 follow the user's terminal palette, so their sRGB values are approximations. `styleText()` converts colors to truecolor or 256-color output based on the requested terminal mode.

`parseColor()` also accepts OKHSL, as in `okhsl(250 60% 55%)`; `okhslColor()` builds it in code and `colorToOkhsl()` reads any color's OKHSL channels. OKHSL saturation is relative to the most the sRGB gamut allows at the hue and lightness, so every value is in gamut and equal saturation looks equally colorful across hues. OKHSL colors are converted to sRGB when created.

Conversions are not cached. OKLCH colors, especially ones outside the sRGB gamut, are more expensive to convert than sRGB or indexed colors. For colors used on every render, convert once and reuse the result:

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b); // cheap to render repeatedly
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

`shimmerText()` paints plain text with a soft light band that sweeps left to right, for a "working" label. Each cell mixes `base` toward `peak` by a cosine falloff from the band's center; the band's position comes from `now` (default `Date.now()`), so the caller redraws on its own timer, such as a `Loader`'s frame interval, and every shimmer on the same clock moves in step:

```typescript
import { shimmerText } from "@octocodeai/octocode-tui";

const label = shimmerText("Working", {
	base: parseColor("#a7b0bc"),
	peak: parseColor("#e6edf3"),
	mode: getTerminalColorMode(),
	periodMs: 2000, // one sweep, including `padding` cells on each side (default 2000)
	halfWidth: 5, // band half-width in cells (default 5)
	padding: 10, // cells travelled before and after the text (default 10)
});
```

## Alternate-screen viewport layouts

`TuiAltScreen` can render an explicit terminal-height layout. `VStack` and `HStack` allocate constrained regions, while `ScrollView` owns scrolling for one region. These semantics are intentionally unavailable on `TuiMainScreen`, where the terminal owns scrollback.

```typescript
import { Container, isViewportTUI, ScrollView, Text, VStack } from "@octocodeai/octocode-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([editor, new Text("status")]);

if (isViewportTUI(tui)) {
	tui.setLayoutRoot(
		new VStack([
			{
				component: new ScrollView(transcript, {
					follow: "end",
					primary: true,
					overscroll: "chain",
				}),
				basis: 0,
				grow: 1,
				minSize: 1,
			},
			{
				component: editorAndFooter,
				basis: "auto",
				shrink: 1,
				minSize: 1,
			},
		]),
	);
}
```

Stack entries support `basis`, `grow`, `shrink`, `minSize`, `maxSize`, and responsive `visible` callbacks. Mouse-wheel input targets the scroll view under the pointer and unused delta chains to outer scroll views by default. The primary scroll view receives the alternate-screen keyboard navigation actions and wheel input over non-scrollable regions. It can also jump between OSC 133 semantic prompt markers, matching common terminal prompt-navigation shortcuts. Press `Ctrl+Shift+F` to open or close its bordered search panel. The panel shows the configured previous/next shortcuts and provides clickable arrow controls; by default, `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G` move between matches, and `Escape` also closes search. `TuiAltScreenOptions.searchMatchStyle` and `searchCurrentMatchStyle` customize match highlighting, while `searchNavigationButtonStyle` styles each arrow button and receives its hover state. `TuiAltScreenOptions.scrollToEndIndicator` renders a clickable label centered on the last row of a `follow: "end"` primary scroll view while it is scrolled away from the end; clicking it resumes end-following.

Layout geometry is rebuilt for each requested frame. Stateful components are retained, and their existing rendered-line caches remain effective. Calling `render(width)` directly on these layout components produces an unbounded document, which is also used when alt mode restores the main screen.

## Overlays

Overlays render components on top of existing content without replacing it. Useful for dialogs, menus, and modal UI.

```typescript
// Show overlay with default options (centered, max 80 cols)
const handle = tui.showOverlay(component);

// Show overlay with custom positioning and sizing
// Values can be numbers (absolute) or percentage strings (e.g., "50%")
const handle = tui.showOverlay(component, {
  // Sizing
  width: 60,              // Fixed width in columns
  width: "80%",           // Width as percentage of terminal
  minWidth: 40,           // Minimum width floor
  maxHeight: 20,          // Maximum height in rows
  maxHeight: "50%",       // Maximum height as percentage of terminal

  // Anchor-based positioning (default: 'center')
  anchor: 'bottom-right', // Position relative to anchor point
  offsetX: 2,             // Horizontal offset from anchor
  offsetY: -1,            // Vertical offset from anchor

  // Percentage-based positioning (alternative to anchor)
  row: "25%",             // Vertical position (0%=top, 100%=bottom)
  col: "50%",             // Horizontal position (0%=left, 100%=right)

  // Absolute positioning (overrides anchor/percent)
  row: 5,                 // Exact row position
  col: 10,                // Exact column position

  // Margin from terminal edges
  margin: 2,              // All sides
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility
  visible: (termWidth, termHeight) => termWidth >= 100  // Hide on narrow terminals

  // Focus behavior
  nonCapturing: true       // Don't auto-focus when shown
});

// OverlayHandle methods
handle.hide();              // Permanently remove the overlay
handle.setHidden(true);     // Temporarily hide (can show again)
handle.setHidden(false);    // Show again after hiding
handle.isHidden();          // Check if temporarily hidden
handle.focus();             // Focus and bring to visual front
handle.unfocus();           // Release focus to normal fallback
handle.unfocus({ target: baseComponent }); // Release this overlay to a specific component
handle.unfocus({ target: null });   // Release this overlay and leave focus empty
handle.isFocused();         // Check if overlay has focus
handle.getBounds();         // Get last rendered terminal-relative bounds

handle.unfocus();
// Overlay loses focus; TUI falls back to another visible capturing overlay or the previous focus target.

handle.unfocus({ target: null });
// Overlay loses focus; no component receives input until focus is set again.

// A focused visible overlay reclaims keyboard input after temporary replacement UI
// releases focus. If you want a specific component to receive input while overlays remain
// visible, call handle.unfocus({ target: component }).

// Hide topmost overlay
tui.hideOverlay();

// Check if any visible overlay is active
tui.hasOverlay();
```

**Anchor values**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`

**Resolution order**:

1. `minWidth` is applied as a floor after width calculation
2. For position: absolute `row`/`col` > percentage `row`/`col` > `anchor`
3. `margin` clamps final position to stay within terminal bounds
4. `visible` callback controls whether overlay renders (called each frame)

## Component Interface

All components implement:

```typescript
interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
}
```

| Method                | Description                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `render(width)`       | Returns an array of strings, one per line. Each line **must not exceed `width`** or the TUI will error. Use `truncateToWidth()` or manual wrapping to ensure this. |
| `handleInput?(data)`  | Called when the component has focus and receives keyboard input. The `data` string contains raw terminal input (may include ANSI escape sequences).                |
| `handleMouse?(event)` | Called by `TuiAltScreen` for normalized pointer input targeted at the component.                                                                                   |
| `invalidate()`        | Required. Clear any cached render state so the next `render()` starts from scratch. Components without cached render state can use an empty implementation.        |

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines. If you emit multi-line text with styling, reapply styles per line or use `wrapTextWithAnsi()` so styles are preserved for each wrapped line.

## Mouse Input

`TuiAltScreen` normalizes SGR mouse input and hit-tests components and overlays. Events contain component-local `x`/`y`, absolute `screenX`/`screenY`, bounds, button, modifiers, click count, and wheel delta. `TuiMainScreen` does not capture mouse input because the terminal owns its scrollback.

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@octocodeai/octocode-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

Returning `handled` suppresses renderer-level fallback behavior. `capture` keeps subsequent drag and release events routed to the same component. `focus` requests keyboard focus. The optional `render` flag controls repainting: press, click, drag, and wheel default to rendering; move and release do not. Set `render: true` for a hover state that visibly changed, or `render: false` for a handled no-op. Render requests are coalesced and terminal output remains differential.

Unhandled gestures retain alternate-screen defaults: wheel input scrolls the nearest `ScrollView` and chains unused delta, primary-button drags select text, OSC 8 links open before parent click handlers, and unhandled right-click preserves configured paste behavior. A click is emitted only when press/release completes without a drag.

Use `MouseRegion` to add mouse behavior without changing a component's rendering:

```typescript
const collapsible = new MouseRegion(content, (event) => {
	if (event.type !== "click" || event.button !== "left") return undefined;
	expanded = !expanded;
	return { handled: true };
});
```

`Container` and `Box` route events to nested children using geometry recorded by the last rendered frame, so pointer motion does not rerender children merely to hit-test them. Explicit `VStack`, `HStack`, and `ScrollView` layouts use the alternate-screen layout frame directly.

## Focusable Interface (IME Support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@octocodeai/octocode-tui";

class MyInput implements Component, Focusable {
	focused: boolean = false; // Set by TUI when focus changes

	render(width: number): string[] {
		const marker = this.focused ? CURSOR_MARKER : "";
		// Emit marker right before the fake cursor
		return [`> ${beforeCursor}${marker}${renderFakeCursor(atCursor)}${afterCursor}`];
	}

	invalidate(): void {}
}
```

When a `Focusable` component has focus, TUI:

1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor only when `showHardwareCursor` is enabled

`renderFakeCursor()` wraps the cursor cell in zero-width markers. TUI renders them as reverse video. When `showHardwareCursor` is enabled, TUI removes the fake cursor that directly follows `CURSOR_MARKER`, so the focused component shows only the terminal cursor. Fake cursors without a preceding `CURSOR_MARKER` stay visible.

The hardware cursor remains hidden by default. This keeps the fake cursor rendering, while still positioning the hardware cursor for terminals that track IME candidate windows with hidden cursors. Some terminals require a visible hardware cursor for IME positioning; enable it with the renderer constructor's `showHardwareCursor` argument or `setShowHardwareCursor(true)`. The `Editor` and `Input` built-in components already implement this interface.

**Container components with embedded inputs:** When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child:

```typescript
import { Container, type Focusable, Input } from "@octocodeai/octocode-tui";

class SearchDialog extends Container implements Focusable {
	private searchInput: Input;

	// Propagate focus to child input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor() {
		super();
		this.searchInput = new Input();
		this.addChild(this.searchInput);
	}
}
```

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position.
