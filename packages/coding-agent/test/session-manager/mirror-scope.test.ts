import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";

let scratch: string;
let cwd: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "octocode-mirror-scope-"));
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

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const indexed = async (manager: SessionManager) => {
	expect(await sessionMirrorSettled()).toBe(true);
	return transcripts.has(sharedAgentDb().mirror.db, manager.getSessionId());
};

/** A session file written straight to `file`, as a benchmark or a copied fixture is. */
function sessionFileAt(file: string): string {
	const source = SessionManager.inMemory(cwd);
	source.appendMessage(message("from a fixture"));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${encodeSessionLines([source.getHeader()!, ...source.getEntries()]).lines.join("\n")}\n`);
	return file;
}

describe("the transcripts database indexes", () => {
	it("a session in the workspace's own session folder, even when the project is temporary", async () => {
		const manager = SessionManager.create(cwd);
		manager.appendMessage(message("kept"));
		expect(await indexed(manager)).toBe(true);
	});

	it("a temporary session folder a caller chose", async () => {
		const chosen = join(scratch, "chosen-sessions");
		const manager = SessionManager.create(cwd, chosen);
		manager.appendMessage(message("kept"));
		expect(await indexed(manager)).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!, chosen);
		reopened.appendMessage(message("again"));
		expect(await indexed(reopened)).toBe(true);
	});

	it("no file opened by path from a temporary folder, nor one from a repository's .octocode/tmp", async () => {
		for (const file of [join(scratch, "fixtures", "copy.jsonl"), join(cwd, ".octocode", "tmp", "bench", "big.jsonl")]) {
			const manager = SessionManager.open(sessionFileAt(file));
			manager.appendMessage(message("not indexed"));
			expect(await indexed(manager)).toBe(false);
		}
	});
});
