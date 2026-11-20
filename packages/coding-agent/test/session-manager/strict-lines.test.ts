import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { decodeSessionRecords, encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { strictJsonLine } from "../../src/core/session-manager/json-line.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";

let scratch: string;
let cwd: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-strict-lines-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

/** Tool text cut inside a surrogate pair: a high surrogate with no low one, and a low one alone. */
const CUT = "binary \ud83d tail \udc00 end";
/** Nested past SQLite's JSON depth limit (1000), which JavaScript and Python still parse. */
function deep(levels: number): unknown {
	let value: unknown = "bottom";
	for (let at = 0; at < levels; at++) value = { down: value };
	return value;
}
function depthOf(value: unknown): number {
	let depth = 0;
	for (let at = value; typeof at === "object" && at !== null; at = (at as { down: unknown }).down) depth++;
	return depth;
}

describe("session lines", () => {
	it("are the same text when nothing needs a repair, and literal escape text stays as written", () => {
		const plain = { type: "custom", data: { text: "plain 🌊 text", path: "C:\\ud800\\x" } };
		expect(strictJsonLine(plain)).toBe(JSON.stringify(plain));
	});

	it("store a lone surrogate as U+FFFD and a value past the depth limit as its JSON text", () => {
		const line = strictJsonLine({ text: CUT, tree: deep(1200) });
		expect(line).not.toMatch(/\\ud[89a-f]/i);
		const parsed = JSON.parse(line) as { text: string; tree: unknown };
		expect(parsed.text).toBe("binary \ufffd tail \ufffd end");
		expect(parsed.text.isWellFormed()).toBe(true);
		// The cut keeps the rest: its JSON text holds the levels below it.
		const kept = depthOf(parsed.tree);
		expect(kept).toBeLessThan(300);
		let bottom: unknown = parsed.tree;
		for (let at = 0; at < kept; at++) bottom = (bottom as { down: unknown }).down;
		expect(depthOf(JSON.parse(bottom as string))).toBe(1200 - kept);
	});

	it("reach the transcripts database as JSON its own functions read, and read back from the file", async () => {
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		manager.appendCustomEntry("tool-output", { text: CUT, tree: deep(1200) });
		expect(await sessionMirrorSettled()).toBe(true);
		const mirror = sharedAgentDb().mirror.db;
		const rows = mirror
			.prepare(
				"SELECT json_valid(data, 1) AS strict, json_extract(data, '$.data.text') AS text FROM session_entries WHERE session_id = ? AND type = 'custom'",
			)
			.all(manager.getSessionId()) as Array<{ strict: number; text: string }>;
		expect(rows).toEqual([{ strict: 1, text: "binary \ufffd tail \ufffd end" }]);
		// The stored rows are the file's lines, byte for byte.
		const lines = readFileSync(manager.getSessionFile()!, "utf8").trim().split("\n");
		expect(transcripts.records(mirror, manager.getSessionId()).join("\n") === lines.join("\n")).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const entry = reopened.getEntries().find((each) => each.type === "custom") as { data: { text: string } };
		expect(entry.data.text).toBe("binary \ufffd tail \ufffd end");
		expect(await sessionMirrorSettled()).toBe(true);
	});

	it("keep a system part with a lone surrogate resolvable when a later line refers to it", () => {
		const tool = { name: "probe", description: `${CUT} ${"x".repeat(600)}`, parameters: { type: "object" } };
		const system = (id: string) => ({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-11-19T00:00:00.000Z",
			message: { role: "system", content: "prompt", toolsAdded: [tool], timestamp: 0 },
		});
		const { lines } = encodeSessionLines([system("a"), system("b")]);
		expect(lines[1]).toContain('"$ref"');
		const [first, second] = decodeSessionRecords(lines.map((line) => JSON.parse(line) as object)) as Array<{
			message: { toolsAdded: Array<{ description: string }> };
		}>;
		expect(second.message.toolsAdded[0]).toEqual(first.message.toolsAdded[0]);
		expect(second.message.toolsAdded[0].description.startsWith("binary \ufffd tail \ufffd end")).toBe(true);
	});
});
