import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	promptCache: { short: 300, long: 3600 },
	contextWindow: 1_000_000,
	cost: { input: 2.5, output: 15, cacheRead: 0.2, cacheWrite: 3.125, cacheWrite1h: 5 },
};

let savedRetention: string | undefined;
let savedHome: string | undefined;
beforeEach(() => {
	savedRetention = process.env[CACHE_RETENTION_ENV];
	savedHome = process.env.OCTOCODE_HOME;
	process.env[CACHE_RETENTION_ENV] = "long";
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	vi.restoreAllMocks();
	if (savedRetention === undefined) delete process.env[CACHE_RETENTION_ENV];
	else process.env[CACHE_RETENTION_ENV] = savedRetention;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

interface Call {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	details?: Record<string, unknown>;
	chars?: number;
}

/** A short session of these calls (each an assistant message and its result), then a cold-cache request over it. */
async function coldClearing(calls: Call[]) {
	const items = calls.flatMap((call, index) => [
		{
			id: `a${index}`,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: call.id, name: call.tool, arguments: call.args }],
				timestamp: T0 + index,
				usage: { input: 1, output: 1, cacheRead: 1000, cacheWrite: 10 },
			},
		},
		{
			id: `r${index}`,
			message: {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.tool,
				content: [
					{ type: "text", text: `${call.id} `.repeat(Math.ceil((call.chars ?? 18_000) / (call.id.length + 1))) },
				],
				...(call.details ? { details: call.details } : {}),
				isError: false,
				timestamp: T0 + index,
			},
		},
	]);
	const fake = fakeHost();
	registerCompaction(fake.api, { restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard);
	const ctx = fakeCtx({ cwd: "/repo", model });
	const branch = () => [
		...items.map((item) => ({ type: "message", id: item.id, message: item.message })),
		...fake.entries.map((entry, index) => ({
			type: "custom",
			id: `c${index}`,
			customType: entry.customType,
			data: entry.data,
		})),
	];
	Object.assign(ctx, {
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: branch,
			getEntries: branch,
			buildSessionProjection: () => ({
				entries: items.map((item) => ({ sourceEntry: { id: item.id }, messages: [item.message] })),
				messages: items.map((item) => item.message),
			}),
		},
	});
	vi.spyOn(Date, "now").mockReturnValue(T0 + HOUR + 60_000);
	const transcript = structuredClone(items.map((item) => item.message));
	await fake.fire("context", { type: "context", messages: transcript, transcript }, ctx);
	const cleared = fake.entries.flatMap((entry) =>
		entry.customType === CLEARED_RESULTS_TYPE
			? (entry.data as { results: Array<{ id: string; saved: string }> }).results
			: [],
	);
	return cleared;
}

const read = (id: string, path: string, extra: Record<string, unknown> = {}): Call => ({
	id,
	tool: "read",
	args: { path, ...extra },
});

describe("clearing a superseded read", () => {
	it("clears an older read of a file that a newer read shows whole, keeps the newer, and saves the old text", async () => {
		const cleared = await coldClearing([
			read("old", "a.ts"),
			read("other", "b.ts", { limit: 20 }),
			read("new", "a.ts"),
		]);
		expect(cleared.map((result) => result.id)).toEqual(["old"]);
		expect(fs.readFileSync(cleared[0].saved.replace(/ \(sha256.*$/, ""), "utf8")).toContain("old ");
	});

	it("clears a partial read that a later read covers, not one it does not cover", async () => {
		const cleared = await coldClearing([
			read("inside", "a.ts", { offset: 10, limit: 50 }),
			read("outside", "a.ts", { offset: 300, limit: 50 }),
			read("wide", "a.ts", { offset: 1, limit: 100 }),
		]);
		expect(cleared.map((result) => result.id)).toEqual(["inside"]);
	});

	it("keeps an older whole read when the newer read shows only a range", async () => {
		const cleared = await coldClearing([read("whole", "a.ts"), read("part", "a.ts", { offset: 5, limit: 10 })]);
		expect(cleared).toEqual([]);
	});
});
