import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	SessionImportInvalidError,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
let root: string | undefined;
afterEach(() => {
	harness?.cleanup();
	if (root) rmSync(root, { recursive: true, force: true });
});

it("refuses a file that is not a session, leaves no copy behind and keeps the current session", async () => {
	root = mkdtempSync(join(tmpdir(), "octocode-import-"));
	harness = await createHarness({ sessionManager: SessionManager.create(root, join(root, "sessions")) });
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const unused: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("not used");
	};
	const runtime = new AgentSessionRuntime(harness.session, services, unused);
	const sessionDir = harness.session.sessionManager.getSessionDir();
	const before = readdirSync(sessionDir);
	const input = join(harness.tempDir, "not-a-session.jsonl");
	writeFileSync(input, '{"hello":"world"}\n');

	const refused = runtime.importFromJsonl(input);
	await expect(refused).rejects.toBeInstanceOf(SessionImportInvalidError);
	// The error names the file given and its bad line, never the copy in the session folder (it is removed).
	await expect(refused).rejects.toThrow(
		`Not a session file: ${input} (line 1 is not a session record, and a session file starts with its "session" header)`,
	);
	expect(readdirSync(sessionDir)).toEqual(before);
	expect(runtime.session).toBe(harness.session);
});
