import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../../src/cli/args.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../src/core/session-manager/mirror.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSessionManager } from "../../src/main/session-manager.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";

const tempDirs: string[] = [];
const managers = new Set<SessionManager>();
let mainDir: string;
let worktreeDir: string;
let sessionDir: string;

const args = (overrides: Partial<Args>): Args => ({
	messages: [],
	fileArgs: [],
	unknownFlags: [],
	diagnostics: [],
	...overrides,
});
const open = async (parsed: Partial<Args>, cwd = mainDir) => {
	const manager = await createSessionManager(args(parsed), cwd, sessionDir, SettingsManager.inMemory());
	managers.add(manager);
	return manager;
};

/** A saved session (a file exists only once a reply is recorded) in `cwd`. */
function savedSession(id: string, cwd: string): string {
	const session = SessionManager.create(cwd, sessionDir, { id });
	managers.add(session);
	session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return session.getSessionFile()!;
}

const sessionFiles = () => readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));

beforeEach(() => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-session-id-")));
	tempDirs.push(root);
	mainDir = join(root, "repo");
	worktreeDir = join(root, "repo", ".octocode", "agent", "worktrees", "x");
	sessionDir = join(root, "sessions");
	mkdirSync(worktreeDir, { recursive: true });
	vi.stubEnv("OCTOCODE_AGENT_DB", join(root, "agent.db"));
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	for (const manager of managers) manager.retire();
	managers.clear();
	// Finish the writes this fixture started before stopping the worker and deleting its directory.
	if (!(await sessionMirrorSettled())) throw new Error("Fixture mirror writes did not settle before cleanup");
	closeSharedAgentDb();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("--session-id across folders", () => {
	it("refuses an id that belongs to a session in another folder, and names its file", async () => {
		const file = savedSession("taken", worktreeDir);
		await expect(open({ sessionId: "taken" })).rejects.toThrow("exit 1");
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(file));
		expect(sessionFiles()).toHaveLength(1);
	});

	it("refuses `--fork --session-id` for such an id too", async () => {
		const file = savedSession("taken", worktreeDir);
		savedSession("source", mainDir);
		await expect(open({ fork: "source", sessionId: "taken" })).rejects.toThrow("exit 1");
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(file));
		expect(sessionFiles()).toHaveLength(2);
	});

	it("forks an exact historical ID after its checkout and transcript file disappear", async () => {
		const source = savedSession("historical", worktreeDir);
		// The mirror is written after the file; a file removed before its rows land is not mirrored at all.
		expect(await sessionMirrorSettled()).toBe(true);
		rmSync(source);
		rmSync(worktreeDir, { recursive: true });
		savedSession("historical-prefix", mainDir);
		const copy = await open({ fork: "historical" });
		expect(copy.getSessionId()).not.toBe("historical");
		expect(copy.getHeader()?.parentSession).toBe(source);
		expect(copy.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(sessionFiles()).toHaveLength(2);
	});

	it("still resumes an id of this folder, and creates a new one when no folder has it", async () => {
		const file = savedSession("mine", mainDir);
		expect((await open({ sessionId: "mine" })).getSessionFile()).toBe(file);
		expect((await open({ sessionId: "fresh" })).getSessionId()).toBe("fresh");
		expect(sessionFiles()).toHaveLength(1);
	});
});
