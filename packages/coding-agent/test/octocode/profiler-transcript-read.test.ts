import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/octocode/profiler/entries.ts";
import { prepare } from "../../src/octocode/profiler/entries.ts";
import { createProfiler } from "../../src/octocode/profiler/index.ts";
import { handleProfilerRequest, type ProfilerRoutePort } from "../../src/octocode/profiler/route.ts";
import { readTranscript } from "../../src/octocode/profiler/transcript-read.ts";

const at = (second: number) => new Date(1_700_000_000_000 + second * 1000).toISOString();

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const entries: Entry[] = [
	{ type: "session", id: "s" },
	{ type: "message", id: "1", timestamp: at(1), message: { role: "user", content: "go" } },
	{
		type: "message",
		id: "2",
		timestamp: at(2),
		message: {
			role: "assistant",
			usage,
			content: [
				{ type: "thinking", thinking: "plan the send" },
				{ type: "text", text: "sending" },
				{ type: "toolCall", name: "send" },
			],
		},
	},
	{ type: "custom_message", id: "3", timestamp: at(3), customType: "n", content: "a notice" },
	{ type: "message", id: "4", timestamp: at(4), message: { role: "assistant", usage, content: "x".repeat(25_000) } },
	{ type: "message", id: "5", timestamp: at(5), message: { role: "user", content: "later" } },
];

describe("readTranscript", () => {
	it("returns the entries around one with their thinking, text and tools", () => {
		const found = readTranscript("a", prepare(entries), 2);
		expect(found.entries.map((item) => item.entry)).toEqual([0, 1, 2, 3, 4]);
		expect(found.entries[2]).toMatchObject({
			role: "assistant",
			thinking: "plan the send",
			text: "sending",
			tools: ["send"],
		});
		expect(found.entries[3]).toMatchObject({ role: "notice", text: "a notice" });
	});

	it("cuts a very long entry and says so", () => {
		const [last] = readTranscript("a", prepare(entries), 4).entries.filter((item) => item.entry === 4);
		expect(last?.text).toHaveLength(20_000);
		expect(last?.truncated).toBe(true);
	});

	it("returns no entries past the end", () => {
		expect(readTranscript("a", prepare(entries), 99).entries).toEqual([]);
	});
});

describe("profiler routes for messages and transcript", () => {
	function ask(path: string, port: Partial<ProfilerRoutePort>) {
		const reply = vi.fn();
		const url = new URL(`http://x${path}`);
		return handleProfilerRequest({ method: "GET" } as IncomingMessage, url, port as ProfilerRoutePort, reply).then(
			() => reply.mock.calls[0] as [number, unknown],
		);
	}
	const base = "/api/profiler";

	it("reads a page of messages from a cursor, with a bounded limit, refusing a malformed cursor", async () => {
		const messages = vi.fn(() => ({ messages: [] }));
		expect((await ask(`${base}/messages?limit=60`, { messages }))[0]).toBe(200);
		expect(messages).toHaveBeenLastCalledWith(60, undefined);
		const cursor = `${base}/messages?limit=30&beforeAt=1700&beforeKey=m:000000000012`;
		expect((await ask(cursor, { messages }))[0]).toBe(200);
		expect(messages).toHaveBeenLastCalledWith(30, { at: 1700, key: "m:000000000012" });
		for (const bad of ["limit=0", "limit=501", "limit=x", "limit=5&beforeAt=1", "limit=5&beforeAt=1&beforeKey=n:1"])
			expect((await ask(`${base}/messages?${bad}`, { messages }))[0]).toBe(400);
	});

	it("reads a transcript window by agent, entry and session, refusing bad input and unknown agents", async () => {
		const transcript = vi.fn((agentId: string, entry: number) =>
			agentId === "a" ? { agentId, entry, entries: [] } : undefined,
		);
		expect((await ask(`${base}/transcript?agent=a&entry=4`, { transcript }))[0]).toBe(200);
		expect(transcript).toHaveBeenLastCalledWith("a", 4, undefined);
		expect((await ask(`${base}/transcript?agent=a&entry=4&session=s-1`, { transcript }))[0]).toBe(200);
		expect(transcript).toHaveBeenLastCalledWith("a", 4, "s-1");
		expect((await ask(`${base}/transcript?agent=zz&entry=4`, { transcript }))[0]).toBe(404);
		expect((await ask(`${base}/transcript?agent=a`, { transcript }))[0]).toBe(400);
		expect((await ask(`${base}/transcript?agent=a%2F..&entry=1`, { transcript }))[0]).toBe(400);
		expect((await ask(`${base}/transcript?agent=a&entry=1&session=..%2Fx`, { transcript }))[0]).toBe(400);
	});
});

const second: Entry[] = [
	{ type: "session", id: "s-two" },
	{ type: "message", id: "9", timestamp: at(9), message: { role: "user", content: "second session" } },
];

describe("profiler service: messages past the live window and transcript windows", () => {
	const folders: string[] = [];
	afterEach(() => {
		for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
	});
	const write = (name: string, lines: Entry[]) => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-read-"));
		folders.push(folder);
		const file = path.join(folder, `${name}.jsonl`);
		fs.writeFileSync(file, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		return file;
	};
	const row = (id: number) => ({ id, at: id, from: "main", to: ["x"], text: `m${id}`, state: "delivered" as const });

	function profilerOver(extra: Partial<Parameters<typeof createProfiler>[0]> = {}) {
		const main = write("main", [{ ...entries[0], id: "s-one" }, ...entries.slice(1)]);
		return createProfiler({
			sessionId: "s-one",
			self: () => ({ id: "main", role: "main", status: "idle" }),
			coordinatorFile: () => main,
			members: () => [],
			traffic: () => [],
			transcript: () => undefined,
			...extra,
		});
	}

	it("returns the source's page and cursor, and only the first page carries notices", () => {
		const next = { at: 3, key: "m:000000000003" };
		const history = vi.fn((_limit: number, before?: unknown) => ({
			traffic: [row(5), row(4)],
			...(before ? {} : { next }),
		}));
		const profiler = profilerOver({ history });
		const first = profiler.messages(2);
		expect(first.messages.map((message) => message.id)).toEqual([5, 4]);
		expect(first.next).toEqual(next);
		const older = profiler.messages(2, next);
		expect(history).toHaveBeenLastCalledWith(2, next);
		expect(older.next).toBeUndefined();
	});

	it("reads the current session's transcript, and another session's by its own file", () => {
		const other = write("old", second);
		const profiler = profilerOver({ sessionTranscript: (id) => (id === "s-two" ? other : undefined) });
		expect(profiler.transcript("main", 2)?.entries.map((item) => item.entry)).toEqual([0, 1, 2, 3, 4]);
		expect(profiler.transcript("main", 1, "s-one")?.entries[0]?.entry).toBe(0);
		const old = profiler.transcript("main", 1, "s-two");
		expect(old?.entries.map((item) => item.text)).toEqual([undefined, "second session"]);
	});

	it("refuses, rather than answer from another session, when the asked session's transcript is missing", () => {
		const profiler = profilerOver({ sessionTranscript: () => undefined });
		expect(profiler.transcript("main", 1, "s-gone")).toBeUndefined();
		expect(profiler.transcript("ghost", 1)).toBeUndefined();
	});
});
