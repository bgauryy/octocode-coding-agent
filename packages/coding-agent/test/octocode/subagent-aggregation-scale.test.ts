import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { sessionChildren } from "../../src/octocode/child-sessions/session-children.ts";
import { ReportGroups } from "../../src/octocode/subagents/report-groups.ts";
import { descendants, roster } from "../../src/octocode/team/panel/roster.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

const member = (id: string, parentId: string, status = "working"): Member =>
	({ id, parentId, status, joinedAt: 0, updatedAt: 10_000 }) as Member;

describe("large subagent aggregates", () => {
	it("does not let duplicate completion remove a sibling's report hold", () => {
		const groups = new ReportGroups();
		groups.join("a", true);
		groups.join("b", true);
		groups.leave("a");
		groups.leave("a");
		groups.settled("b");
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(true);
		groups.leave("b");
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(false);
	});

	it("keeps ended reports attached when a sibling rejoins the same step, then moves it to another", () => {
		const groups = new ReportGroups();
		groups.join("a", true);
		groups.join("b", true);
		groups.leave("a");
		groups.join("b", true);
		groups.settled("b");
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(true);
		groups.nextStep();
		groups.join("b", true);
		groups.join("c", true);
		groups.settled("c");
		expect(groups.awaitsReport("a", new Set(["a"]))).toBe(false);
		expect(groups.awaitsReport("b", new Set(["b"]))).toBe(true);
		groups.leave("b");
		groups.leave("c");
		expect(groups.awaitsReport("b", new Set(["b"]))).toBe(false);
	});

	it("prepares a flat roster with linear parent reads before the panel collapses rows", () => {
		let reads = 0;
		const members = Array.from({ length: 1000 }, (_, i) => {
			const row = member(String(i), "root");
			Object.defineProperty(row, "parentId", {
				get: () => {
					reads++;
					return "root";
				},
			});
			return row;
		});
		expect(roster(members, "root", 10_000, []).tree).toHaveLength(1000);
		expect(reads).toBeLessThan(20_000);
	});

	it("preserves source-pass descendant order for shuffled trees", () => {
		const original = (members: Member[]): Member[] => {
			const mine = new Set(["root"]);
			const out: Member[] = [];
			let grew = true;
			while (grew) {
				grew = false;
				for (const row of members)
					if (row.parentId && mine.has(row.parentId) && !mine.has(row.id)) {
						mine.add(row.id);
						out.push(row);
						grew = true;
					}
			}
			return out;
		};
		let seed = 91;
		const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let trial = 0; trial < 40; trial++) {
			const rows = Array.from({ length: 100 }, (_, i) => member(String(i), i === 0 ? "root" : String(random() % i)));
			for (let i = rows.length - 1; i > 0; i--) {
				const j = random() % (i + 1);
				[rows[i], rows[j]] = [rows[j], rows[i]];
			}
			expect(descendants(rows, "root")).toEqual(original(rows));
		}
	});

	it("handles reverse chains and leaves unreachable parent cycles out", () => {
		const rows = Array.from({ length: 5000 }, (_, i) => member(String(i), i === 0 ? "root" : String(i - 1))).reverse();
		rows.push(member("cycle-a", "cycle-b"), member("cycle-b", "cycle-a"), member("root", "4999"));
		const tree = roster(rows, "root", 10_000, []).tree;
		expect(tree).toHaveLength(5000);
		expect(tree[0]).toMatchObject({ member: { id: "0" }, depth: 0 });
		expect(tree.at(-1)).toMatchObject({ member: { id: "4999" }, depth: 4999 });
	});

	it("checks only surviving legacy report paths and never resurrects a stale continuation report", () => {
		const root = tmp("child-history-scale-");
		const folder = path.join(root, "session");
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(root, "report.md"), "old report");
		const stat = vi.spyOn(fs, "lstatSync");
		const entries = Array.from({ length: 1000 }, (_, i) => ({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "agent",
				details: {
					id: "child",
					profile: "general",
					status: "background",
					runId: `run-${i}`,
					session: { dir: folder },
				},
			},
		}));
		expect(sessionChildren(entries)).toMatchObject([{ id: "child", status: "background" }]);
		expect(sessionChildren(entries)[0]?.report).toBeUndefined();
		expect(stat).not.toHaveBeenCalled();
		const [first] = sessionChildren(entries.slice(0, 1));
		expect(first.report).toBe(path.join(root, "report.md"));
		expect(stat).toHaveBeenCalledTimes(1);
	});
});
