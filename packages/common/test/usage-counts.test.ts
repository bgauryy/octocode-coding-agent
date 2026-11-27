import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promotedTools, usageCounts, UsageRecorder, usageSnapshot, type UsageGroup } from "../src/usage-counts.ts";
import { load, update } from "../src/usage-file.ts";

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

	it("starts cold and keeps the snapshot for the UTC day and the install, not for an hour", () => {
		const at = file();
		const install = { version: "1.0.0" };
		expect(usageSnapshot(at, "main", NOW, install).size).toBe(0);
		sessions(at, "main", "t", 20, 20);
		// Later the same day (NOW is 12:00 UTC) the saved snapshot holds, so the tool list stays the same.
		expect(usageSnapshot(at, "main", NOW + 11 * 60 * 60 * 1000, install).size).toBe(0);
		// Another install, or the next day, computes it again.
		expect([...usageSnapshot(at, "main", NOW + 60 * 1000, { version: "1.0.1" })]).toEqual(["t"]);
		expect([...usageSnapshot(at, "main", NOW + 12 * 60 * 60 * 1000, install)]).toEqual(["t"]);
		fs.rmSync(at);
		expect(usageSnapshot(at, "main", NOW + DAY, install)).toEqual(new Set());
	});

	it("only reads the snapshot for a caller that names no install (a settings view)", () => {
		const at = file();
		sessions(at, "main", "t", 20, 20);
		expect([...usageSnapshot(at, "main", NOW)]).toEqual(["t"]);
		expect(JSON.parse(fs.readFileSync(at, "utf8")).snapshots).toEqual({});
	});

	it("keeps the most used promoted tools while their sizes fit the budget", () => {
		const at = file();
		sessions(at, "main", "big", 20, 20);
		sessions(at, "main", "mid", 20, 10);
		sessions(at, "main", "small", 20, 4);
		sessions(at, "main", "open", 20, 2);
		new UsageRecorder(
			() => at,
			() => "main",
		).recordSizes(
			[
				["big", 900],
				["mid", 600],
				["small", 300],
			],
			NOW,
		);
		// `open` has no size (promoting it adds nothing), so it always fits; `mid` does not fit after `big`.
		expect([...usageSnapshot(at, "main", NOW, { version: "1", budget: 1200 })]).toEqual(["big", "open", "small"]);
		// A different budget computes the snapshot again.
		expect([...usageSnapshot(at, "main", NOW, { version: "1", budget: 2000 })]).toEqual([
			"big",
			"mid",
			"open",
			"small",
		]);
	});

	it("keeps bumps it could not write and adds them to the next update", () => {
		const at = file();
		let blocked = true;
		const recorder = new UsageRecorder(
			() => (blocked ? path.join(at, "under-a-missing-folder", "x.json") : at),
			() => "main",
		);
		recorder.record("declared", ["t"], NOW);
		blocked = false;
		recorder.record("called", ["t"], NOW);
		expect(usageCounts(at, "main", NOW).t).toMatchObject({ declared: 1, called: 1, used: 1 });
	});

	it("loses no bump when processes write at once", async () => {
		const at = file();
		const module = new URL("../src/usage-counts.ts", import.meta.url).href;
		const script = `
			const { UsageRecorder } = await import(${JSON.stringify(module)});
			const recorder = new UsageRecorder(() => process.argv[1], () => "subagent");
			for (let i = 0; i < 25; i++) {
				recorder.reset();
				recorder.record("declared", ["docs/a", "docs/b"]);
				recorder.record("called", ["docs/a"]);
			}`;
		const children = Array.from({ length: 6 }, () =>
			spawn(process.execPath, ["--conditions=source", "--input-type=module", "-e", script, at], {
				stdio: ["ignore", "ignore", "pipe"],
			}),
		);
		const codes = await Promise.all(children.map(async (child) => (await once(child, "close"))[0] as number));
		expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
		const counts = usageCounts(at, "subagent");
		expect(counts["docs/a"]).toMatchObject({ declared: 150, called: 150, used: 150 });
		expect(counts["docs/b"]).toMatchObject({ declared: 150, called: 0 });
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

describe("usage file updates", () => {
	it.skipIf(process.getuid?.() === 0)("throws on a file it cannot read instead of replacing it with new counts", () => {
		const at = file();
		new UsageRecorder(
			() => at,
			() => "main",
		).record("called", ["octocode/localSearch"], Date.now());
		const before = fs.readFileSync(at, "utf8");
		fs.chmodSync(at, 0o000);
		try {
			expect(() => update(at, Date.now(), (usage) => void (usage.days = {}))).toThrow();
			// A reader still gets no data rather than an error.
			expect(load(at).days).toEqual({});
		} finally {
			fs.chmodSync(at, 0o600);
		}
		expect(fs.readFileSync(at, "utf8")).toBe(before);
	});
});
