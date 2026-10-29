import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import type * as StartupUi from "../src/cli/startup-ui.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main/session-manager.ts";
import { closeSharedAgentDb, sharedAgentDb } from "../src/octocode/agentdb/db.ts";
import { SessionIndex } from "../src/octocode/sessions/store.ts";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../src/cli/startup-ui.ts", async (importOriginal) => ({
	...(await importOriginal<typeof StartupUi>()),
	showStartupSelector: confirm,
}));

const QUESTION = `Another Octocode process (pid ${process.pid}) has this session open. Resume it here as well?`;
const tempDirs: string[] = [];
let projectDir: string;
let sessionDir: string;

function args(overrides: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides };
}

/** A saved session whose row says this (live) process has it open. */
function liveSession(id: string): SessionManager {
	const session = SessionManager.create(projectDir, sessionDir, { id });
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
	new SessionIndex(sharedAgentDb()).start(id);
	return session;
}

const ttys = [process.stdin, process.stdout] as const;
const savedTty = ttys.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));

function terminal(interactive: boolean): void {
	for (const stream of ttys) Object.defineProperty(stream, "isTTY", { value: interactive, configurable: true });
}

const open = (parsed: Partial<Args>) =>
	createSessionManager(args(parsed), projectDir, sessionDir, SettingsManager.inMemory());

beforeEach(() => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-main-liveness-")));
	tempDirs.push(root);
	projectDir = join(root, "project");
	sessionDir = join(root, "sessions");
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv("OCTOCODE_AGENT_DB", join(root, "agent.db"));
	confirm.mockReset();
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
	ttys.forEach((stream, at) => {
		const saved = savedTty[at];
		if (saved) Object.defineProperty(stream, "isTTY", saved);
		else delete (stream as { isTTY?: boolean }).isTTY;
	});
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("opening a session another Octocode process has open", () => {
	it.each([
		["--session", (file: string) => ({ session: file })],
		["--continue", () => ({ continue: true })],
		["--session-id", () => ({ sessionId: "live-id" })],
	] as const)("%s asks as /resume does, and opens it only when confirmed", async (_flag, parsed) => {
		const file = liveSession("live-id").getSessionFile()!;
		terminal(true);
		confirm.mockResolvedValueOnce(true);
		expect((await open(parsed(file))).getSessionFile()).toBe(file);
		expect(confirm).toHaveBeenCalledWith(expect.anything(), QUESTION, [
			{ label: "Resume", value: true },
			{ label: "Cancel", value: false },
		]);
		confirm.mockResolvedValueOnce(false);
		await expect(open(parsed(file))).rejects.toThrow("exit 0");
	});

	it("refuses without a terminal to ask in", async () => {
		const file = liveSession("live-id").getSessionFile()!;
		terminal(false);
		for (const parsed of [{ session: file }, { continue: true }, { sessionId: "live-id" }])
			await expect(open(parsed)).rejects.toThrow("exit 1");
		expect(confirm).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`pid ${process.pid}`));
	});

	it("opens a session no live process has open without asking", async () => {
		const session = liveSession("ended-id");
		new SessionIndex(sharedAgentDb()).end("ended-id");
		terminal(false);
		expect((await open({ session: session.getSessionFile()! })).getSessionFile()).toBe(session.getSessionFile());
		expect((await open({ continue: true })).getSessionFile()).toBe(session.getSessionFile());
		expect(confirm).not.toHaveBeenCalled();
	});
});
