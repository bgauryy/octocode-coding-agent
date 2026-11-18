import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeList } from "../src/modes/interactive/components/tree-selector/tree-list.ts";
import { initTheme } from "../src/theme/theme.ts";

function userEntry(id: string, parentId: string | null, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: text, timestamp: 0 },
	};
}

/** A damaged session: `x` names itself as parent, so getTree() makes it a root that keeps parentId === id. */
function selfParentedTree(): SessionTreeNode[] {
	const child = { entry: userEntry("y", "x", "second"), children: [] };
	return [{ entry: userEntry("x", "x", "first"), children: [child] }] as unknown as SessionTreeNode[];
}

describe("tree selector over a self-parented entry", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("opens on a leaf below the loop and renders both entries", () => {
		const list = new TreeList(selfParentedTree(), "y", 10);
		const output = list.render(80).join("\n");
		expect(output).toContain("first");
		expect(output).toContain("second");
		expect(list.getSelectedNode()?.entry.id).toBe("y");
	});

	it("filters to user messages and back without hanging", () => {
		const list = new TreeList(selfParentedTree(), "y", 10, "y", "labeled-only");
		expect(list.render(80).join("\n")).toContain("No entries · ");
		list.handleInput("a");
		expect(list.getSearchQuery()).toBe("a");
	});
});
