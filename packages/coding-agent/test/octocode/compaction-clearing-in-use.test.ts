import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_RECENT_RESULTS } from "../../src/octocode/compaction/clearing.ts";
import { KEEP_IN_USE_TOKENS, KEEP_RECENT_TURNS } from "../../src/octocode/compaction/clearing-recent.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A task in progress: each turn reads a file and prints a command's output, in parallel. The results of the turns the
 * task is still working in must survive a clearing, however many tokens they total; only older ones go.
 */

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	promptCache: { short: 300, long: 3600 },
	contextWindow: 200_000,
};
/** About 2,700 tokens each: one turn's two results are 5,400. */
const SIZE = 8_000;
const TURNS = 12;

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

const text = (mark: string) => [{ type: "text", text: mark.repeat(SIZE) }];

/** One assistant turn with a `read` and a read-only `bash` call, and both results. */
function turn(index: number) {
	const read = `read${index}`;
	const bash = `bash${index}`;
	return [
		{
			role: "assistant",
			timestamp: T0 + index,
			content: [
				{ type: "toolCall", id: read, name: "read", arguments: { path: `src/file${index}.ts` } },
				{ type: "toolCall", id: bash, name: "bash", arguments: { command: `git log -n ${index}` } },
			],
		},
		{
			role: "toolResult",
			toolCallId: read,
			toolName: "read",
			content: text("r"),
			isError: false,
			timestamp: T0 + index,
		},
		{
			role: "toolResult",
			toolCallId: bash,
			toolName: "bash",
			content: text("b"),
			isError: false,
			timestamp: T0 + index,
		},
	];
}

function task(): unknown[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: T0 },
		...Array.from({ length: TURNS }, (_, index) => turn(index + 1)).flat(),
		{ role: "assistant", content: [{ type: "text", text: "Working on it." }], timestamp: T0 + 100 },
	];
}

function setup(messages: unknown[]) {
	const fake = fakeHost();
	registerCompaction(fake.api, { restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard);
	const ctx = fakeCtx({ cwd: "/repo", model });
	const branch = () => [
		...messages.map((message, index) => ({ type: "message", id: `m${index}`, message })),
		...fake.entries.map((entry, index) => ({
			type: "custom",
			id: `c${index}`,
			customType: entry.customType,
			data: entry.data,
		})),
	];
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: branch,
			getEntries: branch,
			buildSessionProjection: () => ({
				entries: messages.map((message, index) => ({ sourceEntry: { id: `m${index}` }, messages: [message] })),
				messages,
			}),
		},
	});
	const event = () => {
		const transcript = structuredClone(messages) as Array<{ role: string }>;
		return { type: "context", messages: transcript.filter((message) => message.role !== "system"), transcript };
	};
	return {
		...fake,
		/** A request made at `at`: the `context` handler decides the clearing, then every request shows the decision. */
		async request(at: number) {
			vi.spyOn(Date, "now").mockReturnValue(at);
			await fake.fire("context", event(), ctx);
			const shown = (await fake.fire("context", event(), ctx)) as { messages?: any[] } | undefined;
			return shown?.messages ?? messages;
		},
	};
}

/** Per result, oldest first: whether the request shows it cleared. */
const clearedFlags = (messages: any[]) =>
	messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			message.content
				.map((part: any) => part.text ?? "")
				.join("")
				.startsWith("[Old tool result cleared"),
		);

describe("clearing mid-task", () => {
	it("keeps every result of the turns the task is still working in, though they total more than the in-use bound", async () => {
		const workingSet = (KEEP_RECENT_TURNS - 1) * 2;
		// The turns in the window outweigh the bound, so a size cap alone would drop the oldest of them.
		expect(workingSet * (SIZE / CHARS_PER_TOKEN)).toBeGreaterThan(
			KEEP_IN_USE_TOKENS + KEEP_RECENT_RESULTS * (SIZE / CHARS_PER_TOKEN),
		);
		const s = setup(task());
		// A long command outlasted the cache lifetime: the next request rewrites the cache anyway, a free point to clear.
		const flags = clearedFlags(await s.request(T0 + 100 + HOUR + 1_000));
		expect(s.entries).toHaveLength(1);
		const old = flags.length - workingSet;
		expect(old).toBeGreaterThan(0);
		expect(flags.slice(0, old).every(Boolean)).toBe(true);
		expect(flags.slice(old)).toEqual(flags.slice(old).map(() => false));
	});

	it("keeps a named result that fits the bound though a newer named one is too big to", async () => {
		const messages = task() as any[];
		// The second turn's read is huge, the first turn's small; the closing reply names both files: both are out of the window.
		messages[5].content = [{ type: "text", text: "R".repeat(KEEP_IN_USE_TOKENS * CHARS_PER_TOKEN + 1) }];
		messages.at(-1).content = [{ type: "text", text: "Compare src/file1.ts and src/file2.ts." }];
		const s = setup(messages);
		const flags = clearedFlags(await s.request(T0 + 100 + HOUR + 1_000));
		expect(flags[2]).toBe(true);
		expect(flags[0]).toBe(false);
	});
});
