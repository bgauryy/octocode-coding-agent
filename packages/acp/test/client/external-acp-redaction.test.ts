import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpDiagnostics, AcpOutput } from "../../src/client/output.ts";
import { ACP_TEXT_BYTES, AcpTextRedactor } from "../../src/client/redaction.ts";
import { redactSecrets, secretProblem } from "../../../coding-agent/src/octocode/shared/sanitize.ts";

const secret = `sk-${"a".repeat(30)}`;
const pemHeader = "-----BEGIN RSA PRIVATE KEY-----";
const pemFooter = "-----END RSA PRIVATE KEY-----";
const pemBody = "U1lOVEhFVElDX0tFWV9CT0RZX05PVF9SRUFM";
const pem = `${pemHeader}\n${pemBody}\n${pemFooter}`;
const chunk = (text: string, messageId = "answer", marker = "source"): SessionNotification => ({
	sessionId: "session",
	update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text }, _meta: { marker } },
});
const tool = (): SessionNotification => ({
	sessionId: "session",
	update: { sessionUpdate: "tool_call", toolCallId: "call", title: "Read", rawOutput: "x".repeat(1024 * 1024) },
});
type Overflow = {
	type: "output_truncated";
	file: string;
	archiveComplete: boolean;
	bufferedBytes: number;
	redactionOmittedBytes: number;
	untrackedStreamBytes: number;
	captureIncomplete: boolean;
};
const overflow = (result: ReturnType<AcpOutput["reply"]>) =>
	result.updates!.find((entry) => (entry as { type?: string }).type === "output_truncated") as Overflow;
type ArchivedRecord = {
	type?: string;
	text?: string;
	update?: { sessionUpdate: string; _meta?: { marker: string } };
};
const records = (file: string): ArchivedRecord[] =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ArchivedRecord);

describe("ACP logical stream redaction", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "acp-redaction-"));
		vi.stubEnv("OCTOCODE_HOME", home);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});
	const fileIn = (directory: string, extension: string) => {
		const file = readdirSync(directory, { recursive: true }).find((path) => String(path).endsWith(extension));
		expect(file).toBeDefined();
		return join(directory, String(file));
	};

	it.each([
		secret,
		`ghp_${"a".repeat(30)}`,
		`Bearer\n${"a".repeat(30)}`,
		`password\n=\n"${"a".repeat(30)}1"`,
		`https://user:${"a".repeat(30)}1@example.invalid`,
		pem,
	])("redacts every split position of a credential before emitting its logical unit: %s", (credential) => {
		for (let split = 1; split < credential.length; split++) {
			const emitted: string[] = [];
			const redactor = new AcpTextRedactor((text) => emitted.push(text));
			redactor.append(credential.slice(0, split));
			redactor.append(credential.slice(split));
			expect(emitted.join(""), `split ${split}`).toBe("");
			redactor.finish();
			expect(emitted.join(""), `split ${split}`).not.toContain(credential);
			expect(emitted.join(""), `split ${split}`).toContain("[redacted]");
			expect(redactor.bufferedBytes).toBe(0);
		}
	});

	it.each([true, false])(
		"redacts split PEM headers and bodies, including captures without an END marker: %s",
		(complete) => {
			expect(secretProblem(pemHeader)).toContain("private key");
			expect(redactSecrets(pem)).toBe("[redacted]");
			const output = new AcpOutput();
			output.append(tool());
			output.append(chunk(pemHeader.slice(0, 12)));
			output.append(chunk(`${pemHeader.slice(12)}\n${pemBody}\n`));
			const file = fileIn(home, ".jsonl");
			expect(readFileSync(file, "utf8")).not.toContain(pemBody);
			if (complete) {
				output.append(chunk(pemFooter.slice(0, 10)));
				output.append(chunk(`${pemFooter.slice(10)}\nfinal answer`));
			}
			const reply = output.reply(complete ? { stopReason: "end_turn" } : undefined);
			expect(readFileSync(file, "utf8")).not.toContain(pemBody);
			expect(reply.text).not.toContain(pemBody);
			expect(reply.text).toContain("[redacted]");
			expect(overflow(reply).archiveComplete).toBe(complete);
			if (complete) expect(reply.text).toContain("final answer");
		},
	);

	it("redacts PEM bodies across retained small-reply fragments", () => {
		const output = new AcpOutput();
		output.append(chunk(`${pemHeader}\n`, "answer", "header"));
		output.append(chunk(`${pemBody}\n`, "answer", "body"));
		output.append(chunk(pemFooter, "answer", "footer"));
		const reply = output.reply({ stopReason: "end_turn" });
		expect(JSON.stringify(reply)).not.toContain(pemBody);
		expect(reply.text).toBe("[redacted]");
	});

	it("drops oversized PEM bodies through a matching split footer while ignoring a nonmatching footer", () => {
		const output = new AcpOutput();
		output.append(chunk(`${pemHeader}\n`));
		output.append(chunk(`${pemBody}\n`.repeat(2000)));
		output.append(chunk(`-----END EC PRIVATE KEY-----\n${pemBody}\n`));
		output.append(chunk(pemFooter.slice(0, 10)));
		output.append(chunk(`${pemFooter.slice(10)}\nfinal answer`));
		const reply = output.reply({ stopReason: "max_tokens" });
		const archive = overflow(reply);
		expect(readFileSync(archive.file, "utf8")).not.toContain(pemBody);
		expect(archive.archiveComplete).toBe(false);
		expect(archive.redactionOmittedBytes).toBeGreaterThan(ACP_TEXT_BYTES);
		expect(reply.text).toContain("final answer");
		expect(reply.stopReason).toBe("max_tokens");
	});

	it("never persists unfinished stderr, even when snapshots are requested between chunks", () => {
		const diagnostics = new AcpDiagnostics();
		diagnostics.append(`${"x".repeat(ACP_TEXT_BYTES + 1)}\n`);
		const file = fileIn(home, ".txt");
		diagnostics.append("sk-");
		expect(diagnostics.toString()).toContain("3 unfinished text bytes are buffered");
		expect(readFileSync(file, "utf8")).not.toContain("sk-");
		diagnostics.append("a".repeat(30));
		expect(diagnostics.toString()).not.toContain(secret);
		expect(readFileSync(file, "utf8")).not.toContain(secret);
		diagnostics.append("\nfinal diagnostic\n");
		const saved = readFileSync(file, "utf8");
		expect(saved).toContain("[redacted]\nfinal diagnostic\n");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it.each(
		["before", "after"].flatMap((timing) => ["sk-", "Bearer\n", "password\n=\n"].map((prefix) => ({ timing, prefix }))),
	)("redacts $prefix deltas starting $timing spill while preserving source metadata", ({ timing, prefix }) => {
		const output = new AcpOutput();
		if (timing === "after") output.append(tool());
		output.append(chunk(prefix, "answer", "first"));
		if (timing === "before") output.append(tool());
		const file = fileIn(home, ".jsonl");
		expect(readFileSync(file, "utf8")).not.toContain("sk-");
		output.append(chunk(`${"a".repeat(30)}1`, "answer", "second"));
		expect(readFileSync(file, "utf8")).not.toContain("a".repeat(30));
		output.append(chunk("\nfinal answer"));
		const reply = output.reply({ stopReason: "end_turn" });
		const archive = overflow(reply);
		const evidence = records(archive.file);
		expect(
			evidence
				.filter((entry) => entry.type === "text_stream")
				.map((entry) => entry.text)
				.join(""),
		).toBe("[redacted]\nfinal answer");
		expect(
			evidence
				.filter((entry) => entry.update?.sessionUpdate === "agent_message_chunk")
				.map((entry) => entry.update!._meta!.marker),
		).toEqual(["first", "second", "source"]);
		expect(archive).toMatchObject({ archiveComplete: true, bufferedBytes: 0, redactionOmittedBytes: 0 });
		expect(reply.text).toContain("[redacted]\nfinal answer");
		expect(JSON.stringify(reply)).not.toContain(secret);
	});

	it("redacts text formed by joining separate message previews before taking the bounded tail", () => {
		const output = new AcpOutput();
		output.append(chunk("sk-", "one"));
		output.append(chunk("a".repeat(30), "two"));
		expect(output.reply({ stopReason: "end_turn" }).text).toBe("[redacted]");
	});

	it("redacts complete structured values and secret-looking metadata keys before JSON serialization", () => {
		const output = new AcpOutput();
		output.append(tool());
		output.append({
			sessionId: "session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "call",
				rawOutput: { [secret]: `Bearer\n${"a".repeat(30)}`, incompleteUrl: "https://user:password", "@": "safe" },
			},
		});
		const reply = output.reply({ stopReason: "end_turn" });
		const archived = readFileSync(overflow(reply).file, "utf8");
		expect(archived).not.toContain(secret);
		expect(archived).not.toContain("a".repeat(30));
		expect(records(overflow(reply).file)).toContainEqual({
			sessionId: "session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "call",
				rawOutput: { "[redacted]": "[redacted]", incompleteUrl: "https://user:password", "@": "safe" },
			},
		});
	});

	it("redacts small replies across metadata changes and interleaved message identities", () => {
		const output = new AcpOutput();
		output.append(chunk("sk-", "private", "first"));
		output.append(chunk("unrelated answer\n", "other"));
		output.append(chunk("a".repeat(30), "private", "last"));
		const reply = output.reply({ stopReason: "end_turn" });
		const updates = reply.updates as SessionNotification[];
		const privateText = updates
			.filter((entry) => entry.update && "messageId" in entry.update && entry.update.messageId === "private")
			.map((entry) => "content" in entry.update && (entry.update.content as { text: string }).text)
			.join("");
		expect(privateText).toBe("[redacted]");
		expect(reply.text).toBe("unrelated answer\n[redacted]");
		expect(JSON.stringify(reply)).not.toContain("a".repeat(30));
	});

	it("keeps multiline introducers pending across many whitespace chunks and omits oversized units", () => {
		const emitted: string[] = [];
		const redactor = new AcpTextRedactor((text) => emitted.push(text));
		redactor.append("Bearer");
		for (let index = 0; index < 100; index++) redactor.append(" ".repeat(1000));
		redactor.append(`\n${"a".repeat(30)}\nfinal answer`);
		redactor.finish();
		expect(emitted.join("")).not.toContain("a".repeat(30));
		expect(emitted.join("")).toContain("omitted");
		expect(emitted.join("")).toMatch(/final answer$/);
		expect(redactor.omittedBytes).toBe(6 + 100_000 + 1 + 30 + 1);
		expect(redactor.bufferedBytes).toBe(0);
	});

	it("marks oversized secret units incomplete and preserves the answer after the next safe boundary", () => {
		const output = new AcpOutput();
		output.append(chunk("sk-"));
		output.append(chunk("a".repeat(ACP_TEXT_BYTES * 2)));
		output.append(chunk("\nfinal answer"));
		const reply = output.reply({ stopReason: "max_tokens" });
		const archive = overflow(reply);
		expect(archive).toMatchObject({
			archiveComplete: false,
			bufferedBytes: 0,
			redactionOmittedBytes: 3 + ACP_TEXT_BYTES * 2 + 1,
		});
		expect(reply.stopReason).toBe("max_tokens");
		expect(reply.text).toContain("final answer");
		expect(readFileSync(archive.file, "utf8")).not.toContain("a".repeat(30));
	});

	it("caps independent stream identities with explicit omitted-byte metadata", () => {
		const output = new AcpOutput();
		output.append(tool());
		for (let index = 0; index < 9; index++) output.append(chunk(secret, `message-${index}`));
		const reply = output.reply({ stopReason: "end_turn" });
		expect(overflow(reply)).toMatchObject({
			archiveComplete: false,
			redactionOmittedBytes: secret.length,
			untrackedStreamBytes: secret.length,
		});
		expect(readFileSync(overflow(reply).file, "utf8")).not.toContain(secret);
		expect(reply.text).toContain("Text stream identities are limited to 8 streams");
	});

	it("reuses completed stream slots so later messages retain their final answer", () => {
		const output = new AcpOutput();
		output.append(tool());
		for (let index = 0; index < 12; index++) output.append(chunk(`${secret}\n`, `message-${index}`));
		output.append(chunk("final answer", "final"));
		const reply = output.reply({ stopReason: "end_turn" });
		expect(overflow(reply)).toMatchObject({ archiveComplete: true, redactionOmittedBytes: 0 });
		expect(reply.text).toContain("final answer");
		expect(readFileSync(overflow(reply).file, "utf8")).not.toContain(secret);
	});

	it("bounds huge identity keys without retaining their text stream", () => {
		const output = new AcpOutput();
		output.append(tool());
		output.append(chunk(secret, "m".repeat(2000)));
		const reply = output.reply({ stopReason: "end_turn" });
		expect(overflow(reply)).toMatchObject({ archiveComplete: false, untrackedStreamBytes: secret.length });
		expect(JSON.stringify(reply)).not.toContain(secret);
	});

	it("seals partial captures, marks them incomplete, and never appends a late credential suffix", () => {
		const output = new AcpOutput();
		output.append(tool());
		output.append(chunk("sk-"));
		const reply = output.reply();
		const archive = overflow(reply);
		const before = readFileSync(archive.file, "utf8");
		output.append(chunk("a".repeat(30)));
		expect(archive).toMatchObject({ archiveComplete: false, captureIncomplete: true, bufferedBytes: 0 });
		expect(readFileSync(archive.file, "utf8")).toBe(before);
		expect(output.reply({ stopReason: "end_turn" })).toBe(reply);
		expect(reply.stopReason).toBeUndefined();
	});
});
