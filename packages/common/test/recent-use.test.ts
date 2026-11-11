import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECENT_USE_WINDOW_MS, recentlyUsed, RecentUseRecorder } from "../src/recent-use.ts";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recent-use-")), "tool-use.json");

describe("recent use", () => {
	it("reports a recorded name inside the window and not after it, per scope", () => {
		const at = file();
		const recorder = new RecentUseRecorder(() => at);
		recorder.record("/repo", "docs/shout", 1_000);
		expect([...recentlyUsed(at, "/repo", 2_000)]).toEqual(["docs/shout"]);
		expect([...recentlyUsed(at, "/other", 2_000)]).toEqual([]);
		expect([...recentlyUsed(at, "/repo", 1_000 + RECENT_USE_WINDOW_MS)]).toEqual([]);
	});

	it("drops expired names when it writes and keeps other scopes", () => {
		const at = file();
		new RecentUseRecorder(() => at).record("/repo", "old", 0);
		new RecentUseRecorder(() => at).record("/other", "kept", RECENT_USE_WINDOW_MS - 1);
		new RecentUseRecorder(() => at).record("/repo", "new", RECENT_USE_WINDOW_MS + 5);
		expect(JSON.parse(fs.readFileSync(at, "utf8"))).toEqual({
			"/other": { kept: RECENT_USE_WINDOW_MS - 1 },
			"/repo": { new: RECENT_USE_WINDOW_MS + 5 },
		});
	});

	it("rewrites the file for one name at most once per interval", () => {
		const at = file();
		const recorder = new RecentUseRecorder(() => at);
		recorder.record("/repo", "tool", 1_000);
		recorder.record("/repo", "tool", 2_000);
		expect(JSON.parse(fs.readFileSync(at, "utf8"))).toEqual({ "/repo": { tool: 1_000 } });
		recorder.record("/repo", "tool", 1_000 + 10 * 60 * 1000);
		expect(JSON.parse(fs.readFileSync(at, "utf8"))["/repo"].tool).toBe(1_000 + 10 * 60 * 1000);
	});

	it("reads a missing or malformed file as nothing used and never throws", () => {
		const at = file();
		expect(recentlyUsed(at, "/repo").size).toBe(0);
		fs.writeFileSync(at, "{not json");
		expect(recentlyUsed(at, "/repo").size).toBe(0);
		fs.writeFileSync(at, JSON.stringify({ "/repo": { ok: Date.now(), bad: "x" }, "/list": [] }));
		expect([...recentlyUsed(at, "/repo")]).toEqual(["ok"]);
		expect(() => new RecentUseRecorder(() => path.join(at, "under-a-file")).record("/repo", "tool")).not.toThrow();
	});
});
