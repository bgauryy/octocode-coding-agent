import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAR_AT_LEAST_TOKENS, KEEP_RECENT_RESULTS } from "../../src/octocode/compaction/clearing.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { CLEARED_RESULTS_TYPE, contextReads } from "../../src/octocode/files/reads.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { CACHE_RETENTION_ENV } from "../../../common/src/env.ts";
import { shortPath } from "../../src/utils/display-path.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
// On Anthropic's own API, where the adapter sends the 1h tier the model declares.
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	promptCache: { short: 300, long: 3600 },
	contextWindow: 200_000,
};
/** About 3,300 tokens of text: the 20,000-token bar takes seven of these. */
const BIG = 10_000;

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

let counter = 0;
/** An assistant call and its result, as two messages. */
function exchange(
	tool: string,
	args: Record<string, unknown>,
	content: unknown[],
	extra: Record<string, unknown> = {},
) {
	const id = `call${++counter}`;
	return {
		id,
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: tool, arguments: args }],
				timestamp: T0 + counter,
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: tool,
				content,
				isError: false,
				timestamp: T0 + counter,
				...extra,
			},
		],
	};
}
const textOf = (length: number, mark = "x") => [{ type: "text", text: mark.repeat(length) }];
const reads = (count: number, length = BIG) =>
	Array.from({ length: count }, (_, index) =>
		exchange("read", { path: `f${index}.ts` }, textOf(length, String(index % 10))),
	);
const flat = (items: Array<{ messages: unknown[] }>) => items.flatMap((item) => item.messages);

interface Reply {
	role: "assistant";
	content: unknown[];
	timestamp: number;
}
const reply = (timestamp: number): Reply => ({
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	timestamp,
});

/** A registered extension over a session holding `messages`; `appendEntry` writes land in the branch, as in Octocode. */
/** The event as the runner emits it: handlers see the messages without system ones, and the whole transcript beside them. */
function contextEvent(list: unknown[]) {
	const transcript = structuredClone(list) as Array<{ role: string }>;
	return { type: "context", messages: transcript.filter((message) => message.role !== "system"), transcript };
}

function setup(
	messages: unknown[],
	options: {
		cwd?: string;
		withModel?: boolean;
		model?: Record<string, unknown>;
		priorEntries?: unknown[];
		guard?: Pick<FileGuard, "restore" | "forget">;
	} = {},
) {
	const fake = fakeHost();
	const guard = options.guard ?? { restore: vi.fn(), forget: vi.fn() };
	registerCompaction(fake.api, guard as FileGuard);
	const cwd = options.cwd ?? "/repo";
	const ctx = fakeCtx({
		cwd,
		// No known lifetime: provider-managed caching with no declared `promptCache` (an Anthropic model resolves 5m and 1h).
		model:
			options.withModel === false
				? { ...model, api: "mistral-conversations", promptCache: undefined }
				: (options.model ?? model),
	});
	const branch = () => [
		...messages.map((message, index) => ({ type: "message", id: `m${index}`, message })),
		...(options.priorEntries ?? []),
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
	return {
		...fake,
		ctx,
		guard,
		/** A model request made at `at`: the `context` handler decides the clearing before every request, in a run or at its start. */
		start: (at: number) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			return fake.fire("context", contextEvent(messages), ctx);
		},
		context: async (list: unknown[] = messages) =>
			((await fake.fire("context", contextEvent(list), ctx)) as { messages?: any[] } | undefined)?.messages ?? list,
	};
}

const resultTexts = (messages: any[]) =>
	messages
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((part: any) => part.text ?? `<${part.type}>`).join(""));
const cleared = (text: string) => text.startsWith("[Old tool result cleared");
const savedPathOf = (text: string) => /Full output: (\S+) \(sha256/.exec(text)?.[1];

describe("clearing old tool results when the cache is rewritten anyway or clearing pays", () => {
	const idleMessages = (items: Array<{ messages: unknown[] }>) => [
		{ role: "user", content: "go", timestamp: T0 },
		...flat(items),
		reply(T0 + 100),
	];

	it("while the cache is warm, clears nothing in a short session, however large its old results", async () => {
		// Eight requests: three old results of 10,000 tokens each pass the 20,000-token bar, but re-sending them over about
		// eight more requests costs less than writing the rest of the history to the cache again.
		const messages = idleMessages(reads(8, 30_000));
		const s = setup(messages);
		await s.start(T0 + 100 + HOUR - 1_000);
		expect(s.entries).toEqual([]);
		expect(resultTexts(await s.context()).every((text) => text.length === 30_000)).toBe(true);
		expect(s.guard.forget).not.toHaveBeenCalled();
	});

	describe("while the cache is warm, a long session", () => {
		const warmAt = T0 + 100 + 60_000;
		const perResult = BIG / CHARS_PER_TOKEN;
		/**
		 * The first session length (one result per request, plus the closing reply) at which the documented rule
		 * `T_old × R × N > S_after × W` holds, with `T_old` the results older than the newest five, `N` the requests so far
		 * and `S_after` about the five kept results (placeholders and short replies are a rounding error here).
		 */
		const predicted = (read: number, write: number) => {
			for (let results = KEEP_RECENT_RESULTS + 1; results < 200; results++) {
				const old = (results - KEEP_RECENT_RESULTS) * perResult;
				if (old >= CLEAR_AT_LEAST_TOKENS && old * read * (results + 1) > KEEP_RECENT_RESULTS * perResult * write)
					return results;
			}
			throw new Error("never pays");
		};
		const firstClearing = async (options: Parameters<typeof setup>[1] = {}) => {
			for (let results = KEEP_RECENT_RESULTS + 1; results < 60; results++) {
				const s = setup(idleMessages(reads(results)), options);
				await s.start(warmAt);
				if (s.entries.length > 0) {
					const out = resultTexts(await s.context());
					expect(out.slice(0, results - KEEP_RECENT_RESULTS).every(cleared)).toBe(true);
					expect(out.slice(-KEEP_RECENT_RESULTS).every((text) => text.length === BIG)).toBe(true);
					return results;
				}
			}
			return undefined;
		};

		it("clears once re-sending its old results costs more than rewriting the cache once (no catalog prices: 0.1 read, 2 write for 1 hour)", async () => {
			expect(predicted(0.1, 2)).toBe(13);
			expect(await firstClearing()).toBe(predicted(0.1, 2));
		});

		it("prices by the model's catalog: a cheap read and no write premium clear sooner", async () => {
			// Writes cost the input price (no premium) and reads a quarter of it.
			const priced = {
				...model,
				contextWindow: 1_000_000,
				cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
			};
			const at = predicted(0.5, 2);
			expect(at).toBeLessThan(predicted(0.1, 2));
			expect(await firstClearing({ model: priced })).toBe(at);
		});
	});

	it("after an idle gap past the cache lifetime keeps the newest five and clears older results to saved files", async () => {
		const items = reads(12);
		const s = setup(idleMessages(items));
		await s.start(T0 + 100 + HOUR + 1_000);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].customType).toBe(CLEARED_RESULTS_TYPE);
		const outcome = resultTexts(await s.context());
		expect(outcome.slice(0, 12 - KEEP_RECENT_RESULTS).every(cleared)).toBe(true);
		expect(outcome.slice(-KEEP_RECENT_RESULTS).every((text) => text.length === BIG)).toBe(true);
		// Every cleared result is reachable: its placeholder names a file holding the whole text and how to get it back.
		outcome.slice(0, 12 - KEEP_RECENT_RESULTS).forEach((text, index) => {
			const file = savedPathOf(text)!;
			expect(fs.readFileSync(path.resolve(file), "utf8")).toBe(String(index % 10).repeat(BIG));
			expect(text).toMatch(/to save context/);
			expect(text).toMatch(/run the call again/);
		});
	});

	it("resolves the session output folder once for a batch, and saves each result as before", async () => {
		const items = reads(40, 2_000);
		const s = setup(idleMessages(items));
		const chmod = vi.spyOn(fs, "chmodSync");
		await s.start(T0 + 100 + HOUR + 1_000);
		const outcome = resultTexts(await s.context());
		const clearedTexts = outcome.slice(0, 40 - KEEP_RECENT_RESULTS);
		expect(clearedTexts.every(cleared)).toBe(true);
		// Same content, same file: the saved copies are named by their hash (ten distinct texts here).
		const files = clearedTexts.map((text) => savedPathOf(text)!);
		expect(new Set(files).size).toBe(10);
		files.forEach((file, index) =>
			expect(fs.readFileSync(path.resolve(file), "utf8")).toBe(String(index % 10).repeat(2_000)),
		);
		// Resolving the folder makes its private directories (three per resolution): once, not once per result.
		expect(chmod.mock.calls.length).toBeLessThanOrEqual(3);
	});

	describe("while the cache is warm and the request rewrites it anyway", () => {
		// Twelve reads: clearing alone would not pay yet (see the long session above), so only the rewrite clears them.
		const head = { role: "system", content: "base prompt", timestamp: T0 - 1 };
		const tool = { name: "extra", description: "d", parameters: { type: "object", properties: {} } };
		const sectionUpdate = { role: "system", content: "", sections: { planning: "on" }, timestamp: T0 + 150 };
		const toolUpdate = { role: "system", content: "", toolsAdded: [tool], timestamp: T0 + 150 };
		const warmAt = T0 + 100 + 60_000;
		const capable = { ...model, compat: { supportsMidConvoSystemMessages: true } };

		const cleared12 = async (s: ReturnType<typeof setup>) => {
			await s.start(warmAt);
			return (
				s.entries.length === 1 &&
				resultTexts(await s.context())
					.slice(0, 12 - KEEP_RECENT_RESULTS)
					.every(cleared)
			);
		};

		it("does not clear for a trailing update on a model that keeps system updates in the history", async () => {
			for (const update of [sectionUpdate, toolUpdate]) {
				const s = setup([head, ...idleMessages(reads(12)), update], { model: capable });
				await s.start(warmAt);
				expect(s.entries).toEqual([]);
			}
		});

		it("clears for a collapsing model whose leading prompt changes, not for one whose leading prompt stays", async () => {
			expect(await cleared12(setup([head, ...idleMessages(reads(12)), toolUpdate]))).toBe(true);
			// A section update becomes a user message after the head: the cached prefix is untouched.
			const kept = setup([head, ...idleMessages(reads(12)), sectionUpdate]);
			await kept.start(warmAt);
			expect(kept.entries).toEqual([]);
		});

		it("clears when a trailing system update folds into the leading prompt, though handlers never see system messages", async () => {
			const s = setup([head, ...idleMessages(reads(12)), toolUpdate]);
			await s.start(warmAt);
			expect(s.entries).toHaveLength(1);
		});

		it("clears for a model switch", async () => {
			const switched = { ...reply(T0 + 100), provider: "other", model: "m" };
			const messages = [{ role: "user", content: "go", timestamp: T0 }, ...flat(reads(12)), switched];
			expect(await cleared12(setup(messages, { model: capable }))).toBe(true);
		});

		it("clears nothing without a rewrite ahead, and a rewrite clears however little of the window is used", async () => {
			const warm = setup(idleMessages(reads(12)));
			await warm.start(warmAt);
			expect(warm.entries).toEqual([]);
			// About 40,000 tokens of a 200,000-token window.
			expect(await cleared12(setup([head, ...idleMessages(reads(12)), toolUpdate]))).toBe(true);
		});
	});

	it("applies the decision identically on every later request, so the prompt stays byte-stable", async () => {
		const s = setup(idleMessages(reads(12)));
		await s.start(T0 + 100 + HOUR + 1_000);
		const first = JSON.stringify(await s.context());
		vi.spyOn(Date, "now").mockReturnValue(T0 + 100 + 5 * HOUR);
		expect(JSON.stringify(await s.context())).toBe(first);
		// A new prompt right after (the cache is warm again, or the clearing already happened) decides nothing more.
		await s.start(T0 + 100 + HOUR + 5_000);
		expect(s.entries).toHaveLength(1);
	});

	it("clears only when the older results total at least 20,000 tokens", async () => {
		const perResult = Math.ceil((CLEAR_AT_LEAST_TOKENS * CHARS_PER_TOKEN) / 4) - 100;
		const below = setup(idleMessages(reads(KEEP_RECENT_RESULTS + 4, perResult)));
		await below.start(T0 + 100 + HOUR + 1_000);
		expect(below.entries).toEqual([]);
		// Nothing was saved for a clearing that did not happen.
		expect(
			fs.readdirSync(process.env.OCTOCODE_HOME!, { recursive: true }).filter((name) => /cleared-/.test(String(name))),
		).toEqual([]);
		const atLeast = setup(idleMessages(reads(KEEP_RECENT_RESULTS + 4, perResult + 200)));
		await atLeast.start(T0 + 100 + HOUR + 1_000);
		expect(atLeast.entries).toHaveLength(1);
	});

	it("clears only re-fetchable read-only results: Octocode MCP, web, grep/find/ls, read and read-only bash; never a writing bash command, file, agent or custom messages", async () => {
		const keep = [
			exchange("bash", { command: "npm install" }, textOf(60_000)),
			exchange("file", { queries: [] }, textOf(60_000)),
			exchange("agent", { task: "x" }, textOf(60_000)),
		];
		const custom = { role: "custom", customType: "note", content: "y".repeat(60_000), timestamp: T0 };
		const old = [
			exchange("mcp__octocode__localSearch", { queries: [] }, textOf(20_000)),
			exchange("web", { url: "https://x.test" }, textOf(20_000)),
			exchange("grep", { pattern: "a" }, textOf(20_000)),
			exchange("find", { pattern: "a" }, textOf(20_000)),
			exchange("ls", { path: "." }, textOf(20_000)),
			exchange("bash", { command: "ls -la" }, textOf(20_000)),
		];
		const s = setup([custom, ...flat(keep), ...flat(old), ...flat(reads(KEEP_RECENT_RESULTS)), reply(T0 + 100)]);
		await s.start(T0 + 100 + HOUR + 1_000);
		const out = await s.context();
		const byTool = new Map(
			out.filter((m) => m.role === "toolResult").map((m) => [m.toolName + m.toolCallId, cleared(m.content[0].text)]),
		);
		const keyOf = (item: { id: string; messages: any[] }) => `${item.messages[1].toolName}${item.id}`;
		for (const item of old) expect(byTool.get(keyOf(item))).toBe(true);
		for (const item of keep) expect(byTool.get(keyOf(item))).toBe(false);
		expect(out[0]).toEqual(custom);
	});

	it("leaves errors, results with images and results that are already placeholders alone", async () => {
		const error = exchange("read", { path: "gone.ts" }, textOf(60_000), { isError: true });
		const image = exchange("read", { path: "a.png" }, [
			...textOf(60_000),
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		const placeholder = exchange("read", { path: "p.ts" }, [
			{
				type: "text",
				text: `[Old tool result cleared after the prompt cache expired; full output: /x ${"z".repeat(60_000)}]`,
			},
		]);
		const s = setup([...flat([error, image, placeholder]), ...flat(reads(KEEP_RECENT_RESULTS)), reply(T0 + 100)]);
		await s.start(T0 + 100 + HOUR + 1_000);
		// The only older, clearable text is nothing: the three above are excluded, so the bar is not met.
		expect(s.entries).toEqual([]);
	});

	it("does not clear a result whose full text could not be saved, and clears nothing when too little remains", async () => {
		const blocker = path.join(tmp(), "file-not-folder");
		fs.writeFileSync(blocker, "");
		process.env.OCTOCODE_HOME = blocker;
		const s = setup(idleMessages(reads(12)));
		await s.start(T0 + 100 + HOUR + 1_000);
		expect(s.entries).toEqual([]);
		expect(resultTexts(await s.context()).every((text) => text.length === BIG)).toBe(true);
		expect(s.guard.forget).not.toHaveBeenCalled();
	});

	it("skips a model with no known cache lifetime and a session with no reply yet", async () => {
		const unknown = setup(idleMessages(reads(12)), { withModel: false });
		await unknown.start(T0 + 100 + 10 * HOUR);
		expect(unknown.entries).toEqual([]);
		const fresh = setup([
			{ role: "user", content: "go", timestamp: T0 },
			...flat(reads(12)).filter((message: any) => message.role === "toolResult"),
		]);
		await fresh.start(T0 + 10 * HOUR);
		expect(fresh.entries).toEqual([]);
	});

	it("applies a persisted decision after a resume, reload or fork (read from the branch), and the file guard stops counting cleared reads", async () => {
		const items = reads(12);
		const messages = idleMessages(items);
		const first = setup(messages);
		await first.start(T0 + 100 + HOUR + 1_000);
		const entry = first.entries[0];
		const resumed = setup(messages, {
			priorEntries: [{ type: "custom", id: "old", customType: entry.customType, data: entry.data }],
		});
		const out = resultTexts(await resumed.context());
		expect(out.slice(0, 7).every(cleared)).toBe(true);
		expect(out.slice(7).every((text) => text.length === BIG)).toBe(true);
		// contextReads (the guard's memory after a resume) omits the cleared reads and keeps the five that stayed.
		const kept = contextReads(resumed.ctx).map((read) => path.basename(read.file));
		expect(kept.sort()).toEqual(["f10.ts", "f11.ts", "f7.ts", "f8.ts", "f9.ts"]);
	});

	it("counts a refresh by Octocode's cache warmer as cache use: no clearing while the warmed entry lives", async () => {
		const warmedAt = T0 + 100 + HOUR - 60_000;
		const warm = {
			type: "usage",
			id: "w1",
			timestamp: new Date(warmedAt).toISOString(),
			kind: "cache_warm",
			provider: "p",
			model: "m",
			usage: { cacheRead: 1000, cacheWrite: 0 },
		};
		const s = setup(idleMessages(reads(12)), { priorEntries: [warm] });
		await s.start(T0 + 100 + HOUR + 1_000);
		expect(s.entries).toEqual([]);
		// Once the warmed entry has expired too, clearing goes ahead.
		await s.start(warmedAt + HOUR + 1_000);
		expect(s.entries).toHaveLength(1);
	});

	it("gives a repeated-read note the placeholder of the result it points at, and never keeps a note among the newest five", async () => {
		const items = reads(12);
		const notes = items.slice(0, 2).map((item, index) =>
			exchange(
				"read",
				{ path: `f${index}.ts` },
				[
					{
						type: "text",
						text: `[Unchanged since your earlier read of f${index}.ts (same range); that result is above in your context.]`,
					},
				],
				{ details: { unchangedOf: item.id } },
			),
		);
		const s = setup(idleMessages([...items, ...notes]));
		await s.start(T0 + 100 + HOUR + 1_000);
		const out = resultTexts(await s.context());
		// The newest five real results stay whole; the notes do not take their places.
		expect(out.slice(7, 12).every((text) => text.length === BIG)).toBe(true);
		// Each note now names the saved file of the cleared original instead of pointing "above".
		expect(out.slice(12)).toEqual([out[0], out[1]]);
		expect(out.slice(12).every(cleared)).toBe(true);
	});

	it("makes the file guard ask for a fresh read of a file whose read was cleared", async () => {
		const guard = { restore: vi.fn(), forget: vi.fn() };
		const s = setup(idleMessages(reads(12)), { guard });
		await s.start(T0 + 100 + HOUR + 1_000);
		const forgotten = guard.forget.mock.calls.map(([file]) => path.basename(String(file))).sort();
		expect(forgotten).toEqual(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts"]);
	});

	it("keeps a file known to the guard when a newer read of it is still in context, as a resume would", async () => {
		const guard = { restore: vi.fn(), forget: vi.fn() };
		const items = reads(12);
		// f0.ts is read again last: that read is among the newest five and stays whole.
		const again = exchange("read", { path: "f0.ts" }, textOf(BIG, "z"));
		const s = setup(idleMessages([...items, again]), { guard });
		await s.start(T0 + 100 + HOUR + 1_000);
		expect(s.entries).toHaveLength(1);
		const forgotten = guard.forget.mock.calls.map(([file]) => path.basename(String(file)));
		expect(forgotten).not.toContain("f0.ts");
		expect(forgotten.length).toBeGreaterThan(0);
		// What a resume rebuilds the guard from shows it too.
		expect(contextReads(s.ctx).map((read) => path.basename(read.file))).toContain("f0.ts");
	});
	it("clears from the context handler alone, also inside a run after a gap longer than the cache lifetime (a long tool), once", async () => {
		const s = setup(idleMessages(reads(12)));
		// Warm: the last reply was a moment ago, so this request clears nothing and the prompt is what it was.
		await s.start(T0 + 100 + 5_000);
		expect(s.entries).toEqual([]);
		expect(s.handlers.get("context")).toHaveLength(1);
		expect(s.handlers.has("before_agent_start")).toBe(false);
		// The next request of the same run comes after a tool that ran longer than the lifetime: no new prompt, only `context`.
		const out = resultTexts(await s.start(T0 + 100 + HOUR + 1_000).then(() => s.context()));
		expect(s.entries).toHaveLength(1);
		expect(out.slice(0, 7).every(cleared)).toBe(true);
		// The request after that finds the decision made: nothing more is cleared and the bytes do not change.
		const first = JSON.stringify(await s.context());
		await s.start(T0 + 100 + HOUR + 2_000);
		expect(s.entries).toHaveLength(1);
		expect(JSON.stringify(await s.context())).toBe(first);
	});

	describe("bash results spilled to a file", () => {
		const spill = (name: string) => {
			const file = path.join(tmp(), name);
			fs.writeFileSync(file, "whole output");
			return file;
		};
		const bash = (command: string, spilled: string | undefined) =>
			exchange(
				"bash",
				{ command },
				textOf(BIG, "b"),
				spilled === undefined ? {} : { details: { fullOutputPath: spilled } },
			);

		it("clears an old read-only command to the file Octocode saved, or to a copy saved now when it has none or it is gone; never one that writes", async () => {
			const spilled = Array.from({ length: 8 }, (_, index) => ({
				item: bash(`cat src/a${index}.ts | head -50`, spill(`octocode-bash-${index}.log`)),
				file: "",
			}));
			const writes = bash("npm install > install.log", spill("octocode-bash-w.log"));
			const unsaved = bash("git status", undefined);
			const gone = bash("ls -la", path.join(tmp(), "octocode-bash-missing.log"));
			const items = [writes, unsaved, gone, ...spilled.map(({ item }) => item)];
			const s = setup([
				{ role: "user", content: "go", timestamp: T0 },
				...flat(items),
				...flat(reads(KEEP_RECENT_RESULTS)),
				reply(T0 + 100),
			]);
			await s.start(T0 + 100 + HOUR + 1_000);
			expect(s.entries).toHaveLength(1);
			const out = (await s.context()).filter((message) => message.role === "toolResult");
			const byId = new Map(out.map((message) => [message.toolCallId, message.content[0].text as string]));
			expect(byId.get(writes.id)).toHaveLength(BIG);
			// Without a spill file the result's own text is saved, whole, when it is cleared.
			for (const copied of [unsaved, gone]) {
				const text = byId.get(copied.id)!;
				expect(cleared(text)).toBe(true);
				expect(fs.readFileSync(path.resolve(savedPathOf(text)!), "utf8")).toBe("b".repeat(BIG));
			}
			spilled.forEach(({ item }) => {
				const file = (item.messages[1] as any).details.fullOutputPath as string;
				// The placeholder names Octocode's own spill file; no second copy is written.
				expect(byId.get(item.id)).toContain(`Full output: ${shortPath(file)}.`);
			});
			const saved = (s.entries[0].data as { results: Array<{ id: string; saved: string }> }).results
				.filter((result) => spilled.some(({ item }) => item.id === result.id))
				.map((result) => result.saved);
			expect(saved).toEqual(spilled.map(({ item }) => shortPath((item.messages[1] as any).details.fullOutputPath)));
		});

		it("leaves them alone while the cache is warm", async () => {
			const items = Array.from({ length: 12 }, (_, index) =>
				bash(`cat a${index}.ts`, spill(`octocode-bash-${index}.log`)),
			);
			const s = setup([{ role: "user", content: "go", timestamp: T0 }, ...flat(items), reply(T0 + 100)]);
			await s.start(T0 + 100 + HOUR - 1_000);
			expect(s.entries).toEqual([]);
		});
	});
});
