import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpDiagnostics, AcpOutput } from "../../src/octocode/external/acp-output.ts";

const chunk = (text: string): SessionNotification => ({
	sessionId: "session",
	update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const tool = (text: string): SessionNotification => ({
	sessionId: "session",
	update: { sessionUpdate: "tool_call", toolCallId: "call", title: "Read", rawOutput: text },
});
type Overflow = { type: string; file?: string; archiveComplete: boolean; omittedBytes: number; error?: string };

describe("bounded ACP evidence capture", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "acp-output-"));
		vi.stubEnv("OCTOCODE_HOME", home);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("archives aggregate update overflow while retaining the answer and terminal response", () => {
		const output = new AcpOutput();
		output.append(chunk("first\n"));
		for (let index = 0; index < 3; index++) output.append(tool(`${index}:` + "evidence".repeat(80_000)));
		output.append(chunk("final answer"));
		const result = output.reply({ stopReason: "max_tokens", _meta: { marker: "terminal metadata" } });
		expect(result.stopReason).toBe("max_tokens");
		expect(result.text).toContain("first\nfinal answer");
		expect(result.text).toContain("ACP output truncated");
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
		const overflow = result.updates?.find((entry) => (entry as Overflow).type === "output_truncated") as Overflow;
		expect(overflow.archiveComplete).toBe(true);
		const records = readFileSync(overflow.file!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(6);
		expect(records.at(-1)).toEqual({
			type: "prompt_response",
			response: { stopReason: "max_tokens", _meta: { marker: "terminal metadata" } },
		});
		expect(result.updates?.at(-1)).toEqual({ type: "prompt_response", response: { stopReason: "max_tokens" } });
		if (process.platform !== "win32") expect(statSync(overflow.file!).mode & 0o777).toBe(0o600);
	});

	it("bounds text by UTF-8 bytes without breaking characters and preserves its end", () => {
		const output = new AcpOutput();
		output.append(chunk("start\n" + "𐐀".repeat(30_000)));
		output.append(chunk("\nfinal answer"));
		const result = output.reply({ stopReason: "end_turn" });
		expect(Buffer.byteLength(result.text)).toBeLessThan(67_000);
		expect(result.text).toContain("\nfinal answer\n[ACP output truncated.");
		expect(result.text).not.toContain("\uFFFD");
		const overflow = result.updates?.find((entry) => (entry as Overflow).type === "output_truncated") as Overflow;
		expect(readFileSync(overflow.file!, "utf8")).toContain("start\\n");
	});

	it("reports artifact failure without losing the terminal outcome", () => {
		const blocked = join(home, "not-a-directory");
		writeFileSync(blocked, "occupied");
		vi.stubEnv("OCTOCODE_HOME", blocked);
		const output = new AcpOutput();
		output.append(tool("x".repeat(2 * 1024 * 1024)));
		const result = output.reply({ stopReason: "cancelled" });
		expect(result.stopReason).toBe("cancelled");
		expect(result.text).toContain("Output archive could not be saved");
		expect(result.updates).toContainEqual(
			expect.objectContaining({ type: "output_truncated", archiveComplete: false, error: expect.any(String) }),
		);
		expect(result.updates?.at(-1)).toEqual({ type: "prompt_response", response: { stopReason: "cancelled" } });
	});

	it("bounds artifact growth and marks omitted evidence while preserving the terminal outcome", () => {
		const output = new AcpOutput();
		for (let index = 0; index < 3; index++) output.append(tool("x".repeat(12 * 1024 * 1024)));
		const result = output.reply({ stopReason: "refusal" });
		const overflow = result.updates?.find((entry) => (entry as Overflow).type === "output_truncated") as Overflow;
		expect(overflow.archiveComplete).toBe(false);
		expect(overflow.omittedBytes).toBeGreaterThan(12 * 1024 * 1024);
		expect(statSync(overflow.file!).size).toBeLessThanOrEqual(32 * 1024 * 1024);
		expect(result.text).toContain("32 MiB limit");
		expect(result.stopReason).toBe("refusal");
	});

	it("bounds stderr over many chunks and saves redacted evidence with the latest diagnostics", () => {
		const diagnostics = new AcpDiagnostics();
		diagnostics.append(`sk-${"a".repeat(30)}\n`);
		for (let index = 0; index < 100; index++) diagnostics.append("x".repeat(1000));
		diagnostics.append("\nfinal diagnostic");
		const text = diagnostics.toString();
		expect(Buffer.byteLength(text)).toBeLessThan(67_000);
		expect(text).toContain("ACP output truncated");
		expect(text).toMatch(/final diagnostic$/);
		const file = /Redacted archive: (.+\.txt)\./.exec(text)?.[1];
		expect(file).toBeTruthy();
		const saved = readFileSync(file!, "utf8");
		expect(saved).toContain("[redacted]");
		expect(saved).not.toContain(`sk-${"a".repeat(30)}`);
		expect(saved).toMatch(/final diagnostic$/);
	});
});
