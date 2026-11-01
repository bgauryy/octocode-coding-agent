# @octocodeai/octocode-tui

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

This package owns terminal components and input/rendering primitives. The coding-agent host owns command routing, configuration discovery and MCP management; see [CONFIGURATIONS.md](../../CONFIGURATIONS.md) and its [terminal UI guide](../coding-agent/docs/tui.md).

## Features

- **Interchangeable Renderers**: Shared `TUI` interface with main-screen and alternate-screen implementations
- **Differential Rendering**: Updates only changed lines or viewport rows
- **Application-owned Scrolling**: Alternate-screen viewport supports mouse, trackpad, and keyboard navigation
- **Synchronized Output**: Uses CSI 2026 for atomic screen updates (no flicker)
- **Bracketed Paste Mode**: Handles large pastes correctly with markers for >10 line pastes
- **Component-based**: Simple Component interface with render() method
- **Theme Support**: Components accept theme interfaces for customizable styling
- **Built-in Components**: Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, MouseRegion, Spacer, Image, Box, Container, VStack, HStack, ScrollView
- **Inline Images**: Renders images in terminals that support Kitty or iTerm2 graphics protocols
- **Autocomplete Support**: File paths and slash commands

## Quick Start

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@octocodeai/octocode-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create the default main-screen renderer through the shared TUI interface
const tui: TUI = new TuiMainScreen(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from "./test/test-themes.ts";
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
	console.log("Submitted:", text);
	tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to allow exit
tui.addInputListener((data) => {
	if (matchesKey(data, "ctrl+c")) {
		tui.stop();
		process.exit(0);
	}
});

// Start
tui.start();
```

## Documentation

| Page | Covers |
| --- | --- |
| [Core API](docs/core-api.md) | The `TUI` interface and renderers, colors and styles, alternate-screen layouts, overlays, the component interface, mouse input, focus and IME support |
| [Built-in components](docs/components.md) | Container, Box, Text, TruncatedText, Input, Editor, Markdown, loaders, SelectList, SettingsList, Spacer, Image |
| [Input, rendering and terminals](docs/input-and-terminal.md) | Autocomplete, key detection, rendering modes and pacing, the terminal interface, multiplexers, utilities |
| [Custom components](docs/custom-components.md) | Handling input, line width, ANSI codes, caching, and the chat example |

## Development

```bash
# From the repository root: install dependencies and run the checks
yarn install
yarn run check

# From packages/tui: run the tests and the demo
yarn run test
node test/chat-simple.ts
```

### Native helpers

Platform helpers for modifier-key state and clipboard access ship as prebuilds; each page explains how to rebuild it: [macOS](native/darwin/README.md), [Linux](native/linux/README.md) and [Windows](native/win32/README.md).

### Debug logging

Set `OCTOCODE_TUI_WRITE_LOG` to capture the raw ANSI stream written to stdout.

```bash
OCTOCODE_TUI_WRITE_LOG=/tmp/tui-ansi.log node test/chat-simple.ts
```
