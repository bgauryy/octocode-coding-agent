import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionList } from "../src/modes/interactive/components/session-selector/session-list.ts";
import {
	buildSessionTree,
	flattenSessionTree,
} from "../src/modes/interactive/components/session-selector/session-tree.ts";
import { initTheme } from "../src/theme/theme.ts";

function session(n: number, patch: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: `s${n}`,
		path: `/probe/s${n}.jsonl`,
		cwd: "/probe",
		created: new Date(0),
		modified: new Date(100000 - n),
		messageCount: 2,
		firstMessage: `Task ${n}`,
		allMessagesText: `Task ${n}`,
		...patch,
	};
}
function list(sessions: SessionInfo[], current?: string) {
	return new SessionList(sessions, false, "recent", "all", new KeybindingsManager(), current, {
		viewportRows: () => 24,
	});
}
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("large session picker", () => {
	it("keeps the selected path across sorting, search, named filtering and refresh", () => {
		const sessions = Array.from({ length: 1000 }, (_, n) => session(n));
		sessions[1].parentSessionPath = sessions[999].path;
		sessions[1].name = "Task chosen";
		const picker = list(sessions);
		picker.handleInput("\x1b[B");
		expect(picker.getSelectedSession()?.id).toBe("s1");
		picker.setSortMode("threaded");
		expect(picker.getSelectedSession()?.id).toBe("s1");
		picker.setQuery("Task");
		expect(picker.getSelectedSession()?.id).toBe("s1");
		picker.setQuery("absent-result");
		expect(picker.getSelectedSession()).toBeUndefined();
		picker.setQuery("Task");
		expect(picker.getSelectedSession()?.id).toBe("s1");
		picker.setNameFilter("named");
		expect(picker.getSelectedSession()?.id).toBe("s1");
		picker.setSessions([...sessions].reverse(), false);
		expect(picker.getSelectedSession()?.id).toBe("s1");
		const selected: string[] = [];
		picker.onSelect = (value) => selected.push(value);
		picker.handleInput("\r");
		expect(selected).toEqual([sessions[1].path]);
	});
	it("keeps a deep fork's title and current mark visible in the bounded window", () => {
		const sessions = Array.from({ length: 80 }, (_, n) =>
			session(n, n ? { parentSessionPath: `/probe/s${n - 1}.jsonl` } : {}),
		);
		const picker = list(sessions, sessions[79].path);
		picker.setSortMode("threaded");
		for (let n = 0; n < 79; n++) picker.handleInput("\x1b[B");
		for (const width of [40, 80, 160]) {
			const lines = picker.render(width).map(stripVTControlCharacters);
			const chosen = lines.find((line) => line.startsWith("› "));
			expect(chosen).toContain("Task 79");
			expect(chosen).toContain("◆");
			expect(lines.length).toBeLessThanOrEqual(24);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

describe("session fork tree", () => {
	it("flattens 8000 successive forks without using the call stack", () => {
		const sessions = Array.from({ length: 8000 }, (_, n) =>
			session(n, n ? { parentSessionPath: `/probe/s${n - 1}.jsonl` } : {}),
		);
		const flat = flattenSessionTree(buildSessionTree(sessions));
		expect(flat).toHaveLength(8000);
		expect(flat[0].session.id).toBe("s0");
		expect(flat[7999].session.id).toBe("s7999");
		expect(flat[7999].depth).toBe(7999);
		expect(flat[7999].ancestorContinues).toHaveLength(7999);
	});
	it("preserves activity ordering, stable sibling ties and connector metadata", () => {
		const sessions = [
			session(0, { modified: new Date(10) }),
			session(1, { parentSessionPath: "/probe/s0.jsonl", modified: new Date(30) }),
			session(2, { parentSessionPath: "/probe/s0.jsonl", modified: new Date(30) }),
			session(3, { modified: new Date(20) }),
		];
		const flat = flattenSessionTree(buildSessionTree(sessions));
		expect(
			flat.map((node) => ({
				id: node.session.id,
				depth: node.depth,
				last: node.isLast,
				ancestors: node.ancestorContinues,
			})),
		).toEqual([
			{ id: "s0", depth: 0, last: false, ancestors: [] },
			{ id: "s1", depth: 1, last: false, ancestors: [false] },
			{ id: "s2", depth: 1, last: true, ancestors: [false] },
			{ id: "s3", depth: 0, last: true, ancestors: [] },
		]);
	});
	it("terminates a duplicate identity that links a root back to itself", () => {
		const flat = flattenSessionTree(
			buildSessionTree([session(0), session(0, { parentSessionPath: "/probe/s0.jsonl" })]),
		);
		expect(flat.map((node) => node.session.id)).toEqual(["s0"]);
	});
	it("retains orphan roots and safely omits rootless parent cycles", () => {
		const flat = flattenSessionTree(
			buildSessionTree([
				session(0, { parentSessionPath: "/probe/s1.jsonl" }),
				session(1, { parentSessionPath: "/probe/s0.jsonl" }),
				session(2, { parentSessionPath: "/probe/missing.jsonl" }),
				session(3, { parentSessionPath: "/probe/s3.jsonl" }),
			]),
		);
		expect(flat.map((node) => node.session.id)).toEqual(["s2"]);
	});
});
