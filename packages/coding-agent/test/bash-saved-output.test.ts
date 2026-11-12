import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import {
	carrySavedOutput,
	releaseSavedOutput,
	rememberSavedOutput,
	restoreBashResult,
	storeBashResult,
} from "../src/core/tools/bash/stored-result.ts";
import { SessionCodec } from "../src/core/session-manager/codec.ts";

type Message = Record<string, unknown> & { structuredContent: Record<string, unknown> };

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `bash-saved-output-${process.pid}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function chatty(count: number): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			for (let i = 1; i <= count; i++) onData(Buffer.from(`compiling module ${i}\n`));
			return { exitCode: 0 };
		},
	};
}

/** A bash result message whose structured output is the text of `file`. */
function spilled(file: string, text: string): Message {
	writeFileSync(file, text);
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "[exit 0]\ntail" }],
		details: { output: "tail", exitCode: 0, fullOutputPath: file },
		structuredContent: { output: text, truncated: false, exit_code: 0 },
		isError: false,
		timestamp: 1,
	};
}

describe("bash saved output", () => {
	it("keeps the model text once: the stored truncation has no copy of it", async () => {
		const result = await createBashTool(dir, { operations: chatty(5000) }).execute("c1", { command: "x" });
		const details = result.details as { output: string; truncation?: Record<string, unknown>; fullOutputPath: string };
		expect(details.truncation).toMatchObject({ truncated: true, totalLines: 5000 });
		expect(details.truncation).not.toHaveProperty("content");
		expect(details.output.length).toBeGreaterThan(0);
		rmSync(details.fullOutputPath, { force: true });
	});

	it("stores a spilled result as a reference to its file without reading the file back", async () => {
		const result = await createBashTool(dir, { operations: chatty(5000) }).execute("c1", { command: "x" });
		const file = (result.details as { fullOutputPath: string }).fullOutputPath;
		const message = { role: "toolResult", toolName: "bash", toolCallId: "c1", ...result } as unknown as Message;
		const text = readFileSync(file, "utf8");
		expect(message.structuredContent.output).toBe(text);
		// Gone: a read would fail the proof and keep the output inline.
		rmSync(file);
		const stored = storeBashResult(message) as Message;
		expect(stored.structuredContent).toMatchObject({ outputFile: file });
		expect(stored.structuredContent).not.toHaveProperty("output");
	});

	it("does not trust a remembered output changed in place", () => {
		const file = join(dir, "out.log");
		const message = spilled(file, "x".repeat(200));
		rememberSavedOutput(message.structuredContent, file);
		message.structuredContent.output = "changed";
		expect((storeBashResult(message) as Message).structuredContent).toMatchObject({ output: "changed" });
	});

	it("carries the knowledge to a copy whose file moved", () => {
		const file = join(dir, "out.log");
		const message = spilled(file, "y".repeat(200));
		rememberSavedOutput(message.structuredContent, file);
		const moved = join(dir, "moved.log");
		renameSync(file, moved);
		const copy = { ...message.structuredContent, verification: { ok: true } };
		carrySavedOutput(message.structuredContent, copy, moved);
		const stored = storeBashResult({ ...message, structuredContent: copy }) as Message;
		expect(stored.structuredContent).toMatchObject({ outputFile: moved, verification: { ok: true } });
	});

	it("releases the live message's output to its file and leaves the returned object as it was", () => {
		const file = join(dir, "out.log");
		const text = "z".repeat(5000);
		const message = spilled(file, text);
		const returned = message.structuredContent;
		rememberSavedOutput(returned, file);
		releaseSavedOutput(message);
		expect(message.structuredContent).not.toBe(returned);
		expect(returned.output).toBe(text);
		// Storing the released form reads nothing: the file is gone and the reference stays.
		rmSync(file);
		const codec = new SessionCodec();
		const entry = { type: "message", id: "e1", parentId: null, timestamp: "t", message };
		const stored = codec.encode(entry) as unknown as { message: Message };
		expect(stored.message.structuredContent).toMatchObject({ outputFile: file });
		expect(Object.keys(message.structuredContent)).toEqual(Object.keys(returned));
	});

	it("reads a released output from the file when first read, as after a resume", () => {
		const file = join(dir, "out.log");
		const text = "w".repeat(5000);
		const message = spilled(file, text);
		rememberSavedOutput(message.structuredContent, file);
		releaseSavedOutput(message);
		expect(message.structuredContent.output).toBe(text);
		expect(JSON.stringify(message)).toBe(JSON.stringify(restoreBashResult(storeBashResult(message))));
	});

	it("leaves a result it knows nothing about unchanged", () => {
		const message = spilled(join(dir, "out.log"), "v".repeat(200));
		const before = message.structuredContent;
		releaseSavedOutput(message);
		expect(message.structuredContent).toBe(before);
	});
});
