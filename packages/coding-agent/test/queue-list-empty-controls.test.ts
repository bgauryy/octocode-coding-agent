import { getKeybindings, setKeybindings, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { afterEach, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { initTheme } from "../src/theme/theme.ts";

const initialBindings = getKeybindings();
afterEach(() => setKeybindings(initialBindings));

it("shows the fallback close key when item-only bindings are inactive on an empty queue", () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager({ "tui.select.confirm": "q", "tui.select.cancel": [] }));
	const onClose = vi.fn();
	const list = new QueueListComponent(vi.fn(), onClose);
	list.setRows([]);
	const text = list.render(80).map(stripTerminalSequences).join("\n");
	expect(text).toContain("No queued messages");
	expect(text).toContain("q close");
	list.handleInput("q");
	expect(onClose).toHaveBeenCalledOnce();
});
