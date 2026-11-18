import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { type Segment, setSessionLineage, writeSegment } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const why = { reason: "recover the exact call used earlier this session" };

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(() => {
	setCurrentSession(undefined);
	setSessionLineage([]);
	vi.unstubAllEnvs();
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

function repo(): string {
	const cwd = tmp();
	fs.mkdirSync(`${cwd}/.git`);
	return cwd;
}

const header = (session: string, tldr: string): Omit<Segment, "n"> => ({
	session,
	entry: `e-${session}`,
	tokensBefore: 1_000,
	method: "cache-shared",
	tldr,
	topics: [],
	readFiles: [],
	modifiedFiles: [],
	messages: 1,
});

/** A session of this repository with one segment: `filler` MiB of text with no word in it, then `lines`. */
function session(cwd: string, id: string, lines: string[], filler = 0, tldr = `work of ${id}`): void {
	setCurrentSession(id);
	const padding = Array.from({ length: filler * 1024 }, () => "-".repeat(1023)).join("\n");
	writeSegment(header(id, tldr), [padding, ...lines].filter(Boolean).join("\n"));
	if (id !== "me")
		writeSessionRecord({
			session: id,
			repository: registeredWorkspace(cwd).id,
			workspace: cwd,
			goal: { role: "user", text: `goal of ${id}` },
			ending: [],
			toolCalls: 0,
		});
	setCurrentSession("me");
}

function tool(cwd: string) {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const archive = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd });
	return async (params: Record<string, unknown>, signal?: AbortSignal) => {
		const result = await archive.execute(
			"t1",
			{ op: "search", source: "sessions", ...why, ...params },
			signal,
			undefined,
			ctx,
		);
		return { text: result.content[0].text as string, details: result.details.history ?? result.details };
	};
}

const cursorOf = (text: string) => /with cursor (a2\.[\w-]+)/.exec(text)?.[1];

describe("archive search over a corpus larger than 32 MiB", () => {
	it("returns matches, this session first, and continues by cursor without repeating or failing", async () => {
		const cwd = repo();
		session(cwd, "me", ["recent call needle-me"]);
		session(
			cwd,
			"big",
			Array.from({ length: 250 }, (_, i) => `hit needle-big-${i}`),
			12,
		);
		session(cwd, "late", ["last needle-late"], 12);
		session(cwd, "idle", [], 12);
		const call = tool(cwd);

		const first = await call({ query: "needle-\\w+" });
		expect(first.text).toMatch(/matching lines? in/);
		expect(first.text.indexOf("needle-me")).toBeGreaterThanOrEqual(0);
		expect(first.text.indexOf("needle-me")).toBeLessThan(first.text.indexOf("needle-big-0"));
		let cursor = cursorOf(first.text);
		expect(cursor, first.text).toBeDefined();
		expect(first.text).toMatch(/Read \d+ of \d+ files/);

		// One cursor walks every page and every stretch of the scan: no page loop inside a cursor loop.
		let all = first.text;
		let guard = 0;
		while (cursor && guard++ < 40) {
			const next = await call({ query: "needle-\\w+", cursor });
			expect(next.text).not.toContain("needle-me");
			all += next.text;
			cursor = cursorOf(next.text);
		}
		expect(cursor).toBeUndefined();
		for (const marker of ["needle-me", "needle-big-0", "needle-big-249", "needle-late"]) expect(all).toContain(marker);
		expect(all.match(/needle-big-0\b/g)).toHaveLength(1);
	}, 60_000);

	it("recovers a call from this session's history by narrowing to it, or by file time", async () => {
		const cwd = repo();
		session(cwd, "me", ['{"operation":"impact","affectedEntrypoints":3}']);
		session(cwd, "old", ['{"operation":"impact","affectedEntrypoints":9}']);
		const call = tool(cwd);
		const both = await call({ query: 'affectedEntrypoints|"operation":"impact"' });
		expect(both.text).toContain('affectedEntrypoints":3');
		expect(both.text).toContain('affectedEntrypoints":9');
		const mine = await call({ query: "affectedEntrypoints", sessionId: "current" });
		expect(mine.text).toContain('affectedEntrypoints":3');
		expect(mine.text).not.toContain('affectedEntrypoints":9');
		expect((await call({ query: "affectedEntrypoints", since: "2999-01-01" })).text).toMatch(/No line matches/);
	});

	it("filters ranked keyword passages by query across more than 32 MiB, and ranks a matching topic line higher", async () => {
		const cwd = repo();
		session(cwd, "me", ["we chose the rollout plan today", "unrelated rollout chatter"], 0, "rollout plan");
		session(cwd, "big", ["a rollout plan with needle-late inside"], 17);
		session(cwd, "more", ["another rollout plan"], 17);
		const call = tool(cwd);
		const ranked = await call({ keywords: "rollout plan", query: "needle-late" });
		expect(ranked.details.hits).toBe(1);
		expect(ranked.text).toContain("needle-late");
		expect(ranked.text).not.toContain("unrelated rollout chatter");
		const plain = await call({ keywords: "rollout plan" });
		expect(plain.details.files).toBe(3);
		// The file whose TL;DR names the topic ranks its header and messages above same-score passages elsewhere.
		expect(plain.text.indexOf("1-e-me.md")).toBeLessThan(plain.text.indexOf("1-e-big.md"));
	}, 90_000);

	it("still ends a pathological regex at its deadline", async () => {
		const cwd = repo();
		session(cwd, "me", [`${"a".repeat(100_000)}!`]);
		await expect(tool(cwd)({ query: "^(a+)+$" })).rejects.toThrow(/exceeded 5 seconds/);
	}, 15_000);

	it("aborts a search on the caller's signal", async () => {
		const cwd = repo();
		session(cwd, "me", [`${"a".repeat(100_000)}!`]);
		const controller = new AbortController();
		const reason = new Error("stopped");
		const searching = tool(cwd)({ query: "^(a+)+$" }, controller.signal);
		const rejected = expect(searching).rejects.toBe(reason);
		setTimeout(() => controller.abort(reason), 200);
		await rejected;
	}, 15_000);
});
