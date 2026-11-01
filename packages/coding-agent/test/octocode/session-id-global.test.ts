import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../../src/cli/args.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSessionManager } from "../../src/main/session-manager.ts";
import { closeSharedAgentDb } from "../../src/octocode/agentdb/db.ts";

const tempDirs: string[] = [];
let mainDir: string;
let worktreeDir: string;
let sessionDir: string;

const args = (overrides: Partial<Args>): Args => ({
	messages: [],
	fileArgs: [],
	unknownFlags: new Map(),
	diagnostics: [],
	...overrides,
});
const open = (parsed: Partial<Args>, cwd = mainDir) =>
	createSessionManager(args(parsed), cwd, sessionDir, SettingsManager.inMemory());

/** A saved session (a file exists only once a reply is recorded) in `cwd`. */
function savedSession(id: string, cwd: string): string {
	const session = SessionManager.create(cwd, sessionDir, { id });
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
	worktreeDir = join(root, "repo", ".octocode", "worktrees", "x");
	sessionDir = join(root, "sessions");
	mkdirSync(worktreeDir, { recursive: true });
	vi.stubEnv("OCTOCODE_AGENT_DB", join(root, "agent.db"));
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
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

	it("still resumes an id of this folder, and creates a new one when no folder has it", async () => {
		const file = savedSession("mine", mainDir);
		expect((await open({ sessionId: "mine" })).getSessionFile()).toBe(file);
		expect((await open({ sessionId: "fresh" })).getSessionId()).toBe("fresh");
		expect(sessionFiles()).toHaveLength(1);
	});
});
