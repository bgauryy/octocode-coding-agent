import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { folderTrustPrompt, worktreeTrustPrompt } from "../src/modes/interactive/components/folder-trust-prompt.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

// Model, tool and file text carrying controls a terminal would act on: a clipboard write (OSC 52), a screen clear
// written with ESC and with the one-byte C1 CSI, a title change and a bidi override.
const HOSTILE = "A\x1b]52;c;cHduZWQ=\x07B\x1b[2JC\u009b2JD\x1b]0;title\x07E\u202eF";

/** Every escape, C1 control or bidi override except SGR colours and the TUI's own cursor markers (`ESC _ octo:… BEL`). */
function unsafe(lines: string[]): string[] {
	return lines
		.map((line) => line.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b_octo:[^\x07]*\x07/g, ""))
		.filter((line) => /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/u.test(line));
}

const stamp = new Date(0).toISOString();
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function chain(entries: SessionEntry[], labels: Record<string, string> = {}): SessionTreeNode[] {
	const nodes = entries.map((entry): SessionTreeNode => ({ entry, children: [], label: labels[entry.id] }));
	for (let i = 1; i < nodes.length; i++) nodes[i - 1].children.push(nodes[i]);
	return nodes.slice(0, 1);
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("selectors drawing untrusted text", () => {
	it("the /tree selector draws message, tool, label and extension text without terminal controls", () => {
		const assistant = (id: string, parentId: string, content: unknown[], extra: object = {}): SessionEntry =>
			({
				type: "message",
				id,
				parentId,
				timestamp: stamp,
				message: {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "m",
					usage,
					stopReason: "stop",
					timestamp: 0,
					...extra,
				},
			}) as SessionEntry;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: `user ${HOSTILE}`, timestamp: 0 },
			},
			assistant("a1", "u1", [{ type: "text", text: `reply ${HOSTILE}` }]),
			assistant("a2", "a1", [
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `echo ${HOSTILE}` } },
				{ type: "toolCall", id: "t2", name: `tool${HOSTILE}`, arguments: {} },
			]),
			{
				type: "message",
				id: "r1",
				parentId: "a2",
				timestamp: stamp,
				message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, timestamp: 0 },
			},
			{
				type: "message",
				id: "r2",
				parentId: "r1",
				timestamp: stamp,
				message: { role: "toolResult", toolCallId: "t2", toolName: "x", content: [], isError: false, timestamp: 0 },
			},
			assistant("a3", "r2", [], { stopReason: "error", errorMessage: `failed ${HOSTILE}` }),
			{
				type: "custom_message",
				id: "c1",
				parentId: "a3",
				timestamp: stamp,
				customType: `ext${HOSTILE}`,
				content: `note ${HOSTILE}`,
				display: true,
			},
			{ type: "branch_summary", id: "b1", parentId: "c1", timestamp: stamp, fromId: "a1", summary: `sum ${HOSTILE}` },
			{ type: "session_info", id: "s1", parentId: "b1", timestamp: stamp, name: `name ${HOSTILE}` },
			{ type: "model_change", id: "m1", parentId: "s1", timestamp: stamp, provider: "p", modelId: `model${HOSTILE}` },
		];
		const selector = new TreeSelectorComponent(
			chain(entries, { u1: `label ${HOSTILE}` }),
			"m1",
			60,
			() => {},
			() => {},
			undefined,
			undefined,
			"all",
		);
		const lines = selector.render(200);
		const text = lines.join("\n");
		for (const shown of [
			"reply ABCDEF",
			"user ABCDEF",
			"failed ABCDEF",
			"sum ABCDEF",
			"label ABCDEF",
			"bash: echo ABCDEF",
		]) {
			expect(text).toContain(shown);
		}
		expect(unsafe(lines)).toEqual([]);
	});

	it("the fork selector draws earlier user messages without terminal controls", () => {
		const selector = new UserMessageSelectorComponent(
			[{ id: "u1", text: `pasted\n${HOSTILE}` }],
			() => {},
			() => {},
		);
		const lines = selector.render(120);
		expect(lines.join("\n")).toContain("pasted ABCDEF");
		expect(unsafe(lines)).toEqual([]);
	});

	it("the session picker preview draws the prompt and folder without terminal controls", async () => {
		const session: SessionInfo = {
			path: "/tmp/s1.jsonl",
			id: "s1",
			cwd: `/work/${HOSTILE}`,
			created: new Date(Number.NaN),
			modified: new Date(),
			messageCount: 1,
			firstMessage: `prompt ${HOSTILE}`,
			allMessagesText: "prompt",
		};
		const selector = new SessionSelectorComponent(
			async () => [session],
			async () => [session],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), initialSort: "recent", viewportRows: () => 40 },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		selector.handleInput(" ");
		const lines = selector.render(120);
		expect(lines.join("\n")).toContain("First prompt");
		expect(unsafe(lines)).toEqual([]);
	});

	it("the trust prompt draws the folder, its parents and the project file names without terminal controls", () => {
		const prompt = folderTrustPrompt(
			{
				path: `/work/${HOSTILE}/project`,
				parent: `/work/${HOSTILE}`,
				grandparent: `/work/${HOSTILE}2`,
				projectFiles: [`AGENTS.md${HOSTILE}`],
			},
			() => {},
		);
		const lines = prompt.render(200);
		expect(lines.join("\n")).toContain("Trust this folder");
		expect(lines.join("\n")).toContain("Found here: AGENTS.mdABCDEF");
		expect(unsafe(lines)).toEqual([]);
	});

	it("the worktree question draws the worktree and its source without terminal controls", () => {
		const lines = worktreeTrustPrompt({ path: `/wt/${HOSTILE}`, from: `/repo/${HOSTILE}` }, () => {}).render(200);
		expect(lines.join("\n")).toContain("Trust new worktree");
		expect(unsafe(lines)).toEqual([]);
	});
});
