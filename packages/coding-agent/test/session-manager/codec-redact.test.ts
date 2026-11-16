import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { clearSecretValues, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import { serializeSessionBranch } from "../../src/core/session-export.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionCodec } from "../../src/core/session-manager/codec.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { exportSessionToHtml } from "../../src/core/export-html/index.ts";

const KEY = "zq9-registered-credential-4f81c2d7";
const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4)}`;

let scratch: string;
let cwd: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-codec-redact-"));
	cwd = join(scratch, "work");
	mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(scratch, "agent.db"));
	vi.stubEnv("OCTOCODE_HOME", join(scratch, "home"));
	registerSecretValue(KEY);
});
afterEach(async () => {
	clearSecretValues();
	await sessionMirrorSettled();
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

const toolResult = (text: string) => ({
	role: "toolResult" as const,
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text" as const, text }],
	details: { echoed: text },
	isError: false,
	timestamp: 2,
});

describe("secrets in session files", () => {
	it("encodes a tool result without a registered key or a credential pattern, and leaves the entry unchanged", () => {
		const entry = {
			type: "message",
			id: "a1",
			parentId: null,
			message: toolResult(`env dump: API=${KEY} gh=${GITHUB}`),
		};
		const before = JSON.stringify(entry);
		const line = JSON.stringify(new SessionCodec().encode(entry));
		expect(line).not.toContain(KEY);
		expect(line).not.toContain(GITHUB);
		expect(line).toContain("[redacted]");
		expect(JSON.stringify(entry)).toBe(before);
	});

	it("keeps an entry without credentials as the same object", () => {
		const entry = {
			type: "message",
			id: "a1",
			parentId: null,
			message: { role: "user", content: "hello", timestamp: 1 },
		};
		expect(new SessionCodec().encode(entry)).toBe(entry);
	});

	it("writes the session file redacted while memory keeps the text; resume and export read the redacted text", async () => {
		const session = SessionManager.create(cwd, scratch);
		session.appendMessage({ role: "user", content: `use ${KEY}`, timestamp: 1 });
		session.appendMessage(toolResult(`token ${KEY}`));
		const file = session.getSessionFile()!;

		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(KEY);
		expect(JSON.stringify(session.getEntries())).toContain(KEY);

		const reopened = SessionManager.open(file, scratch, cwd);
		expect(JSON.stringify(reopened.getEntries())).not.toContain(KEY);
		expect(JSON.stringify(reopened.getEntries())).toContain("[redacted]");

		expect(serializeSessionBranch(session)).not.toContain(KEY);

		const html = readFileSync(await exportSessionToHtml(session, undefined, join(scratch, "out.html")), "utf8");
		const data = /id="session-data"[^>]*>([^<]+)</.exec(html)?.[1];
		expect(data).toBeDefined();
		expect(Buffer.from(data!, "base64").toString("utf8")).not.toContain(KEY);
	});
});
