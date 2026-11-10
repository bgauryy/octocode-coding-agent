import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type JsonObject } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeTiming } from "../../src/octocode/shared/locks.ts";
import { fixture } from "./permission-session-fixture.ts";

/**
 * `toolExecution.earlyStart` through a whole session on the scripted model: a call whose block the model has closed starts
 * while the rest of the reply still streams, but only when the tool declares it changes nothing and the mode asks nothing.
 */
afterEach(() => vi.unstubAllEnvs());

const OBSERVE = "mcp__policy__observe";
const TAIL = "Looking at the result next. ".repeat(12);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function session(
	earlyStart: boolean,
	mode: "manual" | "full" = "full",
	readRole = true,
	rules?: { ask?: string[] },
) {
	const f = await fixture("claude", {
		mode,
		nestedMcp: true,
		readRole,
		tokensPerSecond: 150,
		...(rules ? { rules } : {}),
	});
	f.settingsManager.applyOverrides({ toolExecution: { earlyStart } });
	await f.session.prompt("/mcp tools policy");
	await vi.waitFor(() => expect(f.session.getAllTools().some((tool) => tool.name === OBSERVE)).toBe(true), {
		timeout: 5000,
	});
	return f;
}

/** The scripted reply: the call, then text that streams after the call's block closed. `stopReason` is how it ends. */
function reply(f: Fixture, tool: string, args: JsonObject, stopReason: "toolUse" | "length", id: string) {
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall(tool, args, { id }), fauxText(TAIL)], { stopReason }),
		fauxAssistantMessage("DONE"),
	]);
}

/** Runs the reply; what `seen` counted when the assistant message ended. */
async function runAndObserve(f: Fixture, seen: () => number) {
	let atMessageEnd: number | undefined;
	const unsubscribe = f.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant" && atMessageEnd === undefined)
			atMessageEnd = seen();
	});
	await f.session.prompt("Look.");
	unsubscribe();
	return atMessageEnd;
}

const mcpCalls = (f: Fixture) => f.mcpRecords().filter((record) => record.message.method === "tools/call").length;

describe("early start of tool calls", () => {
	it("starts a read-only MCP call before its message ends when the setting is on", async () => {
		const f = await session(true);
		try {
			reply(f, OBSERVE, {}, "toolUse", "early-1");
			expect(await runAndObserve(f, () => mcpCalls(f))).toBe(1);
			expect(mcpCalls(f)).toBe(1);
			expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toContain(
				"NESTED_MCP_READ_EVIDENCE",
			);
		} finally {
			await f.close();
		}
	});

	it("waits for the message to end when the setting is off", async () => {
		const f = await session(false);
		try {
			reply(f, OBSERVE, {}, "toolUse", "late-1");
			expect(await runAndObserve(f, () => mcpCalls(f))).toBe(0);
			expect(mcpCalls(f)).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("waits for an MCP tool its server's entry does not give the read role", async () => {
		const f = await session(true, "full", false);
		try {
			reply(f, OBSERVE, {}, "toolUse", "write-1");
			expect(await runAndObserve(f, () => mcpCalls(f))).toBe(0);
			expect(mcpCalls(f)).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("waits for `bash`, even with the setting on", async () => {
		const f = await session(true);
		try {
			const marker = path.join(f.cwd, "early-bash.txt");
			reply(f, "bash", { command: `printf x > '${marker}'`, reason: "Write a marker" }, "toolUse", "bash-1");
			expect(await runAndObserve(f, () => (fs.existsSync(marker) ? 1 : 0))).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("waits for a tool that does not declare it is read-only", async () => {
		const f = await session(true);
		try {
			reply(f, "nested_permission_fixture", {}, "toolUse", "plain-1");
			expect(await runAndObserve(f, () => (fs.existsSync(path.join(f.cwd, "nested-a.txt")) ? 1 : 0))).toBe(0);
			expect(fs.existsSync(path.join(f.cwd, "nested-a.txt"))).toBe(true);
		} finally {
			await f.close();
		}
	});

	it("discards an early call when the reply is cut by the output limit, leaving no check timing", async () => {
		const f = await session(true);
		try {
			reply(f, OBSERVE, {}, "length", "cut-1");
			// The call did start (its server saw it) before the cut was known.
			expect(await runAndObserve(f, () => mcpCalls(f))).toBe(1);
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ toolCallId: "cut-1", isError: true });
			expect(JSON.stringify(result)).toContain("output limit");
			expect(JSON.stringify(result)).not.toContain("NESTED_MCP_READ_EVIDENCE");
			// A recorded check would show as queue time this far in the future.
			expect(takeTiming("cut-1", Date.now() + 60_000)).toEqual({});
		} finally {
			await f.close();
		}
	});

	it("waits for the message to end for a call a source rule asks about, then runs it once", async () => {
		const f = await session(true, "manual", true, { ask: [OBSERVE] });
		try {
			reply(f, OBSERVE, {}, "toolUse", "ask-1");
			// The ask would open a dialog mid-stream: the call is not started early, and is judged normally afterwards.
			expect(await runAndObserve(f, () => mcpCalls(f))).toBe(0);
			expect(mcpCalls(f)).toBe(1);
			expect(JSON.stringify(f.session.messages.findLast((m) => m.role === "toolResult"))).toContain(
				"NESTED_MCP_READ_EVIDENCE",
			);
		} finally {
			await f.close();
		}
	});
});
