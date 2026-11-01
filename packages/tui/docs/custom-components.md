# Custom components

Part of the [`@octocodeai/octocode-tui` guide](../README.md). Components implement the [component interface](core-api.md#component-interface).

## Creating Custom Components

When creating custom components, **each line returned by `render()` must not exceed the `width` parameter**. The TUI will error if any line is wider than the terminal.

### Handling Input

Use `matchesKey()` with the `Key` helper for keyboard input:

```typescript
import { matchesKey, Key, truncateToWidth } from "@octocodeai/octocode-tui";
import type { Component } from "@octocodeai/octocode-tui";

class MyInteractiveComponent implements Component {
	private selectedIndex = 0;
	private items = ["Option 1", "Option 2", "Option 3"];

	public onSelect?: (index: number) => void;
	public onCancel?: () => void;

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.enter)) {
			this.onSelect?.(this.selectedIndex);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
		}
	}

	render(width: number): string[] {
		return this.items.map((item, i) => {
			const prefix = i === this.selectedIndex ? "> " : "  ";
			return truncateToWidth(prefix + item, width);
		});
	}

	invalidate(): void {}
}
```

### Handling Line Width

Use the provided utilities to ensure lines fit:

```typescript
import { visibleWidth, truncateToWidth } from "@octocodeai/octocode-tui";
import type { Component } from "@octocodeai/octocode-tui";

class MyComponent implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		// Option 1: Truncate long lines
		return [truncateToWidth(this.text, width)];

		// Option 2: Check and pad to exact width
		const line = this.text;
		const visible = visibleWidth(line);
		if (visible > width) {
			return [truncateToWidth(line, width)];
		}
		// Pad to exact width (optional, for backgrounds)
		return [line + " ".repeat(width - visible)];
	}

	invalidate(): void {}
}
```

### ANSI Code Considerations

Both `visibleWidth()` and `truncateToWidth()` correctly handle ANSI escape codes:

- `visibleWidth()` ignores ANSI codes when calculating width
- `truncateToWidth()` preserves ANSI codes and properly closes them when truncating

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " " + blue "W" + "…" with proper reset
```

### Caching

For performance, components should cache their rendered output and only re-render when necessary:

```typescript
class CachedComponent implements Component {
	private text: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = [truncateToWidth(this.text, width)];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
```

## Example

See `test/chat-simple.ts` for a complete chat interface example with:

- Markdown messages with custom background colors
- Loading spinner during responses
- Editor with autocomplete and slash commands
- Spacers between messages

Run it:

```bash
node test/chat-simple.ts
```
