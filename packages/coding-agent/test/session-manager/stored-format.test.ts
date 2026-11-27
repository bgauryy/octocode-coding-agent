import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describePayloadLayers, type AssistantMessage, type SystemMessage, type Tool } from "@octocodeai/octocode-ai";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { type FileEntry, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";
import { SessionCodec } from "../../src/core/session-manager/codec.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { serializeSessionBranch } from "../../src/core/session-export.ts";
import { STRUCTURED_OUTPUT_MAX_BYTES } from "../../src/core/tools/bash/stored-result.ts";
import { readSavedOutput } from "../../src/core/tools/saved-output.ts";
import { parseTranscript } from "../../src/octocode/profiler/entries.ts";

let scratch: string;
let cwd: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-stored-format-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
});
afterEach(async () => {
	await sessionMirrorSettled();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

const usage = {
	input: 10,
	output: 5,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 115,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tools: Tool[] = Array.from({ length: 12 }, (_, i) => ({
	name: `tool${i}`,
	description: `Tool ${i}. ${"Explains what it does. ".repeat(40)}`,
	parameters: { type: "object", properties: { path: { type: "string", description: "A path." } } } as never,
}));

const systemMessage = (): SystemMessage => ({
	role: "system",
	content: `You are a coding agent. ${"Follow the rules. ".repeat(60)}`,
	sections: { rules: `<rules>${"Be exact. ".repeat(80)}</rules>`, tools: `<tools>${"Use them. ".repeat(80)}</tools>` },
	toolsAdded: tools,
	timestamp: 1,
});

/** A bash result shaped as the tool stores it: header line, body, and the body again in details and structured content. */
function bashResult(callId: string, body: string, extra: Record<string, unknown> = {}) {
	return {
		role: "toolResult" as const,
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text" as const, text: `[exit 0 · 0.1s · 3 lines · 1 KB]\n${body}` }],
		details: { output: body, exitCode: 0, ...extra },
		structuredContent: { output: body, truncated: false, exit_code: 0, wall_time_seconds: 0.1, total_lines: 3 },
		isError: false,
		timestamp: 2,
	};
}

/**
 * Appends `turns` turns to `session`: each a user message and the assistant reply carrying the trace of the request
 * that produced it (every layer so far, the cache marker on the newest message), with a bash result every third turn
 * and a compaction half way, as a real session records them.
 */
function record(session: SessionManager, turns: number): void {
	session.appendMessage(systemMessage());
	const wire: Record<string, unknown>[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		const prompt = `Turn ${turn}: ${"please look at this. ".repeat(10)}`;
		session.appendMessage({ role: "user", content: prompt, timestamp: turn });
		wire.push({ role: "user", content: [{ type: "text", text: prompt }] });
		const marked = wire.map((message, index) =>
			index === wire.length - 1 ? { ...message, cache_control: { type: "ephemeral", ttl: "1h" } } : message,
		);
		const trace = describePayloadLayers("anthropic-messages", {
			tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
			messages: marked,
		});
		const reply = `Answer ${turn}: ${"done. ".repeat(20)}`;
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: reply }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "stop",
			timestamp: turn,
			requestTrace: trace,
		};
		session.appendMessage(assistant);
		wire.push({ role: "assistant", content: [{ type: "text", text: reply }] });
		if (turn % 3 === 0) {
			const body = Array.from({ length: 20 }, (_, i) => `line ${turn}.${i} of command output`).join("\n");
			session.appendMessage(bashResult(`call-${turn}`, body));
			wire.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call-${turn}`, content: body }] });
		}
		if (turn === Math.floor(turns / 2)) {
			session.appendCompaction("summary of the first half", session.getLeafId(), 5000);
		}
	}
}

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const whole = (entries: readonly FileEntry[]) => entries.map((entry) => JSON.stringify(entry));

/** The session as files written before the stored format were: every entry whole. */
function oldFormat(session: SessionManager): string {
	return `${[session.getHeader()!, ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function traceBytes(file: string): number {
	let bytes = 0;
	for (const line of lines(file)) {
		const message = (JSON.parse(line) as { message?: { requestTrace?: unknown } }).message;
		if (message?.requestTrace) bytes += JSON.stringify(message.requestTrace).length;
	}
	return bytes;
}

describe("stored session format", () => {
	it("reads a file written before the format with every entry unchanged", () => {
		const memory = SessionManager.inMemory(cwd);
		record(memory, 12);
		const file = join(scratch, "old.jsonl");
		const text = oldFormat(memory);
		writeFileSync(file, text);

		const opened = SessionManager.open(file, scratch, cwd);
		expect(whole(opened.getEntries())).toEqual(whole(memory.getEntries()));
		expect(opened.buildSessionContext()).toEqual(memory.buildSessionContext());
		// Opening never rewrites a current-version file.
		expect(readFileSync(file, "utf8")).toBe(text);
	});

	it("stores references and reads back byte-identical entries in every reader", async () => {
		const session = SessionManager.create(cwd, scratch);
		record(session, 12);
		const file = session.getSessionFile()!;
		const written = whole(session.getEntries());

		const raw = lines(file).map((line) => JSON.parse(line) as Record<string, any>);
		const traces = raw.filter((entry) => entry.message?.requestTrace).map((entry) => entry.message.requestTrace);
		expect(traces[0].base).toBeUndefined();
		expect(traces.slice(1).every((trace) => typeof trace.base === "string" && trace.keep > 0)).toBe(true);
		const compaction = raw.find((entry) => entry.type === "compaction")!;
		expect(
			compaction.systemMessage.toolsAdded.every((tool: unknown) => Object.keys(tool as object)[0] === "$ref"),
		).toBe(true);
		const bash = raw.find((entry) => entry.message?.toolName === "bash")!;
		expect(bash.message.details.output).toBeUndefined();
		expect(bash.message.details.outputAt).toEqual([33, expect.any(Number)]);
		expect(bash.message.structuredContent.output).toBeUndefined();

		// The session manager, a raw load, the profiler and the database mirror.
		expect(whole(SessionManager.open(file, scratch, cwd).getEntries())).toEqual(written);
		expect(whole(loadEntriesFromFile(file).slice(1))).toEqual(written);
		expect(
			parseTranscript(readFileSync(file, "utf8"))
				.slice(1)
				.map((entry) => JSON.stringify(entry)),
		).toEqual(written);
		// The profiler reads appended text with the codec that read the lines before it.
		const text = readFileSync(file, "utf8");
		const cut = text.indexOf("\n", text.length / 2) + 1;
		const codec = new SessionCodec();
		const appended = [...parseTranscript(text.slice(0, cut), codec), ...parseTranscript(text.slice(cut), codec)];
		expect(appended.slice(1).map((entry) => JSON.stringify(entry))).toEqual(written);
		await sessionMirrorSettled();
		const fromDb = SessionManager.forkFrom({ storedId: session.getSessionId() }, cwd, join(scratch, "db-fork"));
		expect(whole(fromDb.getEntries())).toEqual(written);
		const fromDbAsync = await SessionManager.forkFromAsync(
			{ storedId: session.getSessionId() },
			cwd,
			join(scratch, "db-fork-async"),
		);
		expect(whole(fromDbAsync.getEntries())).toEqual(written);
		expect(fromDbAsync.getHeader()?.parentSessionId).toBe(session.getSessionId());

		// A fork, an export and a lone copy each read on their own.
		const fork = SessionManager.forkFrom(file, cwd, join(scratch, "forks"));
		expect(whole(fork.getEntries())).toEqual(written);
		const lone = join(scratch, "lone.jsonl");
		writeFileSync(lone, readFileSync(fork.getSessionFile()!));
		expect(whole(loadEntriesFromFile(lone).slice(1))).toEqual(written);
		const exported = join(scratch, "export.jsonl");
		writeFileSync(exported, serializeSessionBranch(session));
		expect(whole(loadEntriesFromFile(exported).slice(1))).toEqual(whole(session.getBranch()));
	});

	it("continues references after a reopen with the codec that decoded the file", () => {
		const session = SessionManager.create(cwd, join(scratch, "reopen"));
		record(session, 4);
		const file = session.getSessionFile()!;
		const before = lines(file).length;
		const opened = SessionManager.open(file, join(scratch, "reopen"), cwd);
		// The same system message again: every part the file already holds is written as a reference.
		opened.appendMessage(systemMessage());
		const added = lines(file)
			.slice(before)
			.map((line) => JSON.parse(line) as Record<string, any>);
		const system = added.find((entry) => entry.message?.role === "system")!;
		expect(system.message.toolsAdded.every((tool: unknown) => Object.keys(tool as object)[0] === "$ref")).toBe(true);
		expect(whole(loadEntriesFromFile(file))).toEqual(whole([loadEntriesFromFile(file)[0], ...opened.getEntries()]));
	});

	it("keeps request traces linear in the turn count over 200 turns", () => {
		const sizes = [100, 200].map((turns) => {
			const session = SessionManager.create(cwd, join(scratch, `turns-${turns}`));
			record(session, turns);
			const file = session.getSessionFile()!;
			const before = Buffer.byteLength(oldFormat(session));
			const after = readFileSync(file).length;
			const old = join(scratch, `old-${turns}.jsonl`);
			writeFileSync(old, oldFormat(session));
			return { before, after, traces: traceBytes(file), oldTraces: traceBytes(old) };
		});
		const [half, full] = sizes;
		// Whole traces grow with the square of the turn count: twice the turns, about four times the bytes.
		expect(full.oldTraces / half.oldTraces).toBeGreaterThan(3.5);
		expect(full.traces / half.traces).toBeLessThan(2.2);
		expect(full.after).toBeLessThan(full.before / 4);
	});

	it("shares unchanged layer objects between consecutive live traces once they are stored", () => {
		const session = SessionManager.create(cwd, scratch);
		record(session, 6);
		const traces = session
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
			.map((message) => message.requestTrace!);
		const copies = JSON.parse(JSON.stringify(traces)) as typeof traces;
		const [previous, current] = traces.slice(-2);
		// Tools and system are unchanged; the message layers before the moved cache marker too.
		expect(current.layers[0]).toBe(previous.layers[0]);
		expect(current.layers[1]).toBe(previous.layers[1]);
		expect(current.layers[2]).toBe(previous.layers[2]);
		expect(current.layers.at(-1)).not.toBe(previous.layers.at(-1));
		// Sharing changes no value.
		expect(JSON.parse(JSON.stringify(traces))).toEqual(copies);
	});

	it("reads a spilled structured output back from the saved file, and only then", () => {
		const saved = join(scratch, "spill.log");
		const fullText = Array.from({ length: 5000 }, (_, i) => `raw line ${i}`).join("\n");
		writeFileSync(saved, fullText);
		const body = "raw line 0\n[... elided ...]\nraw line 4999".padEnd(80, " ");
		const session = SessionManager.create(cwd, scratch);
		session.appendMessage({ role: "user", content: "run it", timestamp: 1 });
		const message = bashResult("spilled", body, { fullOutputPath: saved });
		message.structuredContent.output = readSavedOutput(saved, STRUCTURED_OUTPUT_MAX_BYTES).content;
		session.appendMessage(message);
		const file = session.getSessionFile()!;
		const stored = JSON.parse(lines(file).at(-1)!).message.structuredContent;
		expect(stored).not.toHaveProperty("output");
		expect(stored.outputFile).toBe(saved);
		expect(lines(file).at(-1)!.length).toBeLessThan(fullText.length / 4);

		const last = () =>
			SessionManager.open(file, scratch, cwd).getEntries().at(-1) as unknown as { message: typeof message };
		expect(JSON.stringify(last().message)).toBe(JSON.stringify(message));
		rmSync(saved);
		const gone = last();
		expect(gone.message.structuredContent.output).toBeUndefined();
		expect(gone.message.details.output).toBe(body);
	});
});
