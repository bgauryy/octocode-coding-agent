import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { groupNodes } from "../src/modes/interactive/components/session-selector/groups.ts";
import type { FlatSessionNode } from "../src/modes/interactive/components/session-selector/session-tree.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

// The same hostile string as selector-untrusted-text.test.ts: OSC 52, ESC and C1 CSI screen clears, a title, bidi.
const HOSTILE = "A\x1b]52;c;cHduZWQ=\x07B\x1b[2JC\u009b2JD\x1b]0;title\x07E\u202eF";

/** Every escape, C1 control or bidi override except SGR colours and the TUI's own cursor markers. */
function unsafe(lines: string[]): string[] {
	return lines
		.map((line) => line.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b_octo:[^\x1b]*\x1b\\/g, ""))
		.filter((line) => /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/u.test(line));
}

const CTRL_P = "\x10";
const TAB = "\t";

function session(id: string, cwd: string, extra: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd,
		created: new Date(Number.NaN),
		modified: new Date(),
		messageCount: 1,
		firstMessage: "prompt",
		allMessagesText: "prompt",
		...extra,
	};
}

async function picker(sessions: SessionInfo[], initialSort: "recent" | "threaded"): Promise<SessionSelectorComponent> {
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager(), initialScope: "all", initialSort, viewportRows: () => 40 },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return selector;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("session folders, paths and labels drawn as untrusted text", () => {
	// A session header's `cwd` and the session file's path are read from disk as they are (listing.ts).
	it("the all-folders picker draws folder group labels without terminal controls", async () => {
		const selector = await picker([session("s1", `/work/${HOSTILE}`), session("s2", "/plain")], "recent");
		const lines = selector.render(160);
		expect(lines.join("\n")).toContain("/work/ABCDEF");
		expect(unsafe(lines)).toEqual([]);
	});

	it("the all-folders thread view draws each row's folder and path without terminal controls", async () => {
		const selector = await picker([session("s1", `/work/${HOSTILE}`, { path: `/tmp/${HOSTILE}.jsonl` })], "threaded");
		selector.handleInput(CTRL_P);
		const lines = selector.render(200);
		const text = lines.join("\n");
		expect(text).toContain("/work/ABCDEF");
		expect(text).toContain("/tmp/ABCDEF.jsonl");
		expect(unsafe(lines)).toEqual([]);
		// Back to this folder's scope: the list still renders.
		selector.handleInput(TAB);
		expect(unsafe(selector.render(200))).toEqual([]);
	});

	it("the /tree label editor draws an existing label without terminal controls", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "hello", timestamp: 0 },
		};
		const selector = new TreeSelectorComponent(
			[{ entry, children: [], label: `label ${HOSTILE}` }],
			"u1",
			40,
			() => {},
			() => {},
			() => {},
		);
		selector.handleInput("L");
		const lines = selector.render(200);
		expect(lines.join("\n")).toContain("Label (empty to remove):");
		expect(unsafe(lines)).toEqual([]);
	});

	it("groups a large all-folders list by folder in linear time", () => {
		const nodes: FlatSessionNode[] = Array.from({ length: 40_000 }, (_, i) => ({
			session: session(`s${i}`, i % 2 ? "/a" : "/b", { modified: new Date(i) }),
			depth: 0,
			isLast: true,
			ancestorContinues: [],
		}));
		const started = performance.now();
		const grouped = groupNodes(nodes, "folder");
		const elapsed = performance.now() - started;
		expect(grouped.nodes).toHaveLength(40_000);
		expect([...grouped.labels.entries()]).toEqual([
			[0, "/b"],
			[20_000, "/a"],
		]);
		// Copying each folder's list on every insert took about 0.5 s for 20,000 sessions in one folder, on each keystroke.
		expect(elapsed).toBeLessThan(250);
	});
});
