import path from "node:path";
import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import type { SessionExtras } from "../src/core/session-picker.ts";
import { renderSessionRow } from "../src/modes/interactive/components/session-selector/row.ts";
import { SessionList } from "../src/modes/interactive/components/session-selector/session-list.ts";
import { initTheme } from "../src/theme/theme.ts";
import { tmp } from "./octocode/helpers.ts";

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

const info = (cwd = "/tmp/x"): SessionInfo => ({
	path: "/tmp/s1.jsonl",
	id: "s1",
	cwd,
	created: new Date(0),
	modified: new Date(0),
	messageCount: 3,
	firstMessage: "hello",
	allMessagesText: "hello",
});

const detail = (extras: SessionExtras, width: number, checkout?: string): string => {
	const lines = renderSessionRow({
		node: { session: info(), depth: 0, isLast: true, ancestorContinues: [] },
		width,
		selected: false,
		current: false,
		confirmingDelete: false,
		showPath: false,
		extras,
		...(checkout ? { checkout } : {}),
		transcriptMatch: false,
	}).map(stripAnsi);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return lines[1] ?? "";
};

const full: SessionExtras = {
	branch: "feature/long-branch-name",
	checkout: "worktree demo",
	cost: "≈$1.84",
	files: 7,
	children: 2,
};

const rowLines = (extras: SessionExtras, width = 100): string[] =>
	renderSessionRow({
		node: { session: info(), depth: 0, isLast: true, ancestorContinues: [] },
		width,
		selected: false,
		current: false,
		confirmingDelete: false,
		showPath: false,
		extras,
		transcriptMatch: false,
	}).map(stripAnsi);

describe("a live session's activity in its row", () => {
	it("shows what another live session is doing as the activity badge, not only the presence dot", () => {
		const [title, line2] = rowLines({ live: true, activity: "waiting", cost: "≈$1.84" });
		expect(title).toContain("◐ hello");
		expect(line2.trimStart().startsWith("needs you · ")).toBe(true);
		expect(rowLines({ live: true, activity: "error" })[1]).toContain("failed");
		expect(rowLines({ live: true, activity: "working" })[1]).toContain("working");
		// The word stays when the line narrows: it is what the row is for.
		expect(rowLines({ live: true, activity: "waiting", ...full }, 40)[1]).toContain("needs you");
	});

	it("keeps the presence dot alone for a live session whose light is unknown (an older Octocode has it open)", () => {
		const [title, line2] = rowLines({ live: true });
		expect(title).toContain("● hello");
		expect(line2).not.toMatch(/needs you|working|idle|failed/);
	});
});

describe("session row line 2", () => {
	it("shows the child-agent count, singular and plural", () => {
		expect(detail({ children: 2 }, 120)).toContain("2 agents");
		expect(detail({ children: 1 }, 120)).toContain("1 agent ");
		expect(detail({}, 120)).not.toContain("agent");
	});

	it("marks a worktree checkout whose folder is gone", () => {
		const gone = path.join(tmp("octocode-gone-"), ".octocode", "agent", "worktrees", "old");
		const list = new SessionList([info(gone)], true, "recent", "all", new KeybindingsManager());
		const lines = list.render(120).map(stripAnsi);
		expect(lines.join("\n")).toContain("worktree old (gone)");
		expect(detail({}, 120, "worktree old (gone)")).toContain("worktree old (gone)");
	});

	it("drops branch before cost as the line narrows", () => {
		let sawBranchDroppedWithCost = false;
		for (let width = 120; width >= 30; width--) {
			const line = detail(full, width);
			if (line.includes("feature/long") && !line.includes("≈$1.84"))
				throw new Error(`branch kept over cost at ${width}: ${line}`);
			if (!line.includes("feature/long") && line.includes("≈$1.84")) sawBranchDroppedWithCost = true;
		}
		expect(sawBranchDroppedWithCost).toBe(true);
	});

	it("keeps cost and the agent count on a narrow terminal, and leaves out the file count", () => {
		const line = detail({ cost: "≈$1.84", files: 7, children: 2 }, 80);
		expect(line).toContain("≈$1.84");
		expect(line).toContain("2 agents");
		expect(line).not.toContain("7 files");
		expect(detail({ files: 7 }, 120)).toContain("7 files");
	});
});
