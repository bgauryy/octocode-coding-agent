import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	promotedTools,
	SNAPSHOT_MAX_AGE_MS,
	usageCounts,
	UsageRecorder,
	usageSnapshot,
	type UsageGroup,
} from "../src/usage-counts.ts";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-counts-")), "tool-usage.json");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 12);

/** `sessions` sessions of `group` declare `tool`; the first `callers` call it. */
function sessions(at: string, group: UsageGroup, tool: string, sessions: number, callers: number, now = NOW): void {
	for (let i = 0; i < sessions; i++) {
		const recorder = new UsageRecorder(
			() => at,
			() => group,
		);
		recorder.record("declared", [tool], now);
		if (i < callers) recorder.record("called", [tool], now);
	}
}

describe("usage counts", () => {
	it("promotes at 10% of 20 declaring sessions and not below, per role group", () => {
		const at = file();
		sessions(at, "main", "docs/hit", 20, 2);
		sessions(at, "main", "docs/miss", 19, 2);
		sessions(at, "main", "docs/cold", 20, 1);
		sessions(at, "subagent", "docs/hit", 5, 5);
		expect(usageCounts(at, "main", NOW)["docs/hit"]).toMatchObject({ declared: 20, called: 2, used: 2 });
		expect([...promotedTools(at, "main", NOW)]).toEqual(["docs/hit"]);
		expect(promotedTools(at, "subagent", NOW).size).toBe(0);
	});

	it("counts a session once per kind, and a load counts as a use", () => {
		const at = file();
		const recorder = new UsageRecorder(
			() => at,
			() => "main",
		);
		for (let i = 0; i < 3; i++) {
			recorder.record("declared", ["t"], NOW);
			recorder.record("called", ["t"], NOW);
		}
		recorder.record("loaded", ["t"], NOW);
		expect(usageCounts(at, "main", NOW).t).toEqual({
			declared: 1,
			called: 1,
			loaded: 1,
			calledUndeclared: 0,
			refused: 0,
			used: 1,
		});
		recorder.reset();
		recorder.record("declared", ["t"], NOW);
		expect(usageCounts(at, "main", NOW).t?.declared).toBe(2);
	});

	it("counts a call before declaration as loaded and used too, once per session", () => {
		const at = file();
		const recorder = new UsageRecorder(
			() => at,
			() => "main",
		);
		recorder.record("calledUndeclared", ["rare"], NOW);
		recorder.record("calledUndeclared", ["rare"], NOW);
		expect(usageCounts(at, "main", NOW).rare).toMatchObject({ calledUndeclared: 1, loaded: 1, used: 1, called: 0 });
	});

	it("promotes a tool whose calls are refused more than once per using session", () => {
		const at = file();
		const recorder = new UsageRecorder(
			() => at,
			() => "main",
		);
		recorder.record("declared", ["t"], NOW);
		recorder.record("refused", ["t"], NOW);
		recorder.record("called", ["t"], NOW);
		expect(promotedTools(at, "main", NOW).size).toBe(0);
		recorder.record("refused", ["t"], NOW);
		expect([...promotedTools(at, "main", NOW)]).toEqual(["t"]);
	});

	it("keeps 7 days of counts", () => {
		const at = file();
		sessions(at, "main", "old", 1, 1, NOW - 7 * DAY);
		sessions(at, "main", "edge", 1, 1, NOW - 6 * DAY);
		sessions(at, "main", "new", 1, 1, NOW);
		const days = Object.keys(JSON.parse(fs.readFileSync(at, "utf8")).days);
		expect(days).toEqual(["2026-11-09", "2026-11-15"]);
		expect(Object.keys(usageCounts(at, "main", NOW)).sort()).toEqual(["edge", "new"]);
	});

	it("starts cold, saves the snapshot for an hour, then computes it again", () => {
		const at = file();
		expect(usageSnapshot(at, "main", NOW).size).toBe(0);
		sessions(at, "main", "t", 20, 20);
		expect(usageSnapshot(at, "main", NOW + SNAPSHOT_MAX_AGE_MS - 1).size).toBe(0);
		expect([...usageSnapshot(at, "main", NOW + SNAPSHOT_MAX_AGE_MS)]).toEqual(["t"]);
		fs.rmSync(at);
		expect(usageSnapshot(at, "main", NOW + SNAPSHOT_MAX_AGE_MS + 1)).toEqual(new Set());
	});

	it("reads a malformed file as no data and never throws", () => {
		const at = file();
		fs.writeFileSync(at, "{nope");
		expect(usageCounts(at, "main", NOW)).toEqual({});
		fs.writeFileSync(at, JSON.stringify({ days: { x: [] }, snapshots: { main: 3 } }));
		expect(promotedTools(at, "main", NOW).size).toBe(0);
		expect(() =>
			new UsageRecorder(
				() => path.join(at, "under-a-file"),
				() => "main",
			).record("called", ["t"]),
		).not.toThrow();
	});
});
