import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../db/src/api.ts";
import { type Args, parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main/session-manager.ts";

/** Vitest's stdin and stdout are not terminals, so every run here is non-interactive, as a script's would be. */
let root: string;
let project: string;
let elsewhere: string;
let errors: string[];

function args(overrides: Partial<Args>): Args {
	return { messages: [], fileArgs: [], unknownFlags: [], diagnostics: [], ...overrides };
}

function savedSession(cwd: string, id: string): string {
	const session = SessionManager.create(cwd, undefined, { id });
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

const open = (parsed: Partial<Args>) =>
	createSessionManager(args(parsed), project, undefined, SettingsManager.inMemory());

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "octocode-main-selection-")));
	project = join(root, "project");
	elsewhere = join(root, "elsewhere");
	mkdirSync(project);
	mkdirSync(elsewhere);
	vi.stubEnv("OCTOCODE_AGENT_DB", join(root, "agent.db"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", join(root, "agent"));
	errors = [];
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit ${code}`);
	});
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	closeSharedAgentDb();
	rmSync(root, { recursive: true, force: true });
});

describe("session selection without a terminal", () => {
	it("refuses a session of another project and names --fork, leaving stdin unread", async () => {
		const file = savedSession(elsewhere, "aaaa1111-0000-4000-8000-000000000001");
		const stdin = vi.spyOn(process.stdin, "on");
		await expect(open({ print: true, session: "aaaa1111" })).rejects.toThrow("exit 1");
		const text = errors.join("\n");
		expect(text).toContain(file);
		expect(text).toContain("--fork aaaa1111");
		expect(stdin).not.toHaveBeenCalled();
	});

	it("refuses --resume and names --fork instead of painting the picker", async () => {
		await expect(open({ print: true, resume: true })).rejects.toThrow("exit 1");
		expect(errors.join("\n")).toContain("--fork <id>");
	});

	it("still opens a session of this project and forks one of another", async () => {
		savedSession(project, "bbbb1111-0000-4000-8000-000000000001");
		await expect(open({ print: true, session: "bbbb1111" })).resolves.toMatchObject({});
		savedSession(elsewhere, "cccc1111-0000-4000-8000-000000000001");
		const forked = await open({ print: true, fork: "cccc1111" });
		expect(forked.getSessionId()).not.toBe("cccc1111-0000-4000-8000-000000000001");
	});
});

describe("--resume <id>", () => {
	it("opens the session named on the command line like --session, by id and by unique prefix", async () => {
		const file = savedSession(project, "eeee1111-0000-4000-8000-000000000001");
		expect(
			(await open(parseArgs(["--resume", "eeee1111-0000-4000-8000-000000000001", "-p", "hi"]))).getSessionFile(),
		).toBe(file);
		expect((await open(parseArgs(["-r", "eeee1", "-p", "hi"]))).getSessionFile()).toBe(file);
	});

	it("reports an unknown id instead of opening the picker", async () => {
		await expect(open(parseArgs(["--resume", "ffff9999", "-p", "hi"]))).rejects.toThrow("exit 1");
		expect(errors.join("\n")).toContain("No session found matching 'ffff9999'");
	});
});

describe("ambiguous session prefixes", () => {
	const first = "dddd1111-0000-4000-8000-000000000001";
	const second = "dddd2222-0000-4000-8000-000000000002";

	it.each([
		["--session", { session: "dddd" }],
		["--fork", { fork: "dddd" }],
	] as const)("%s refuses a prefix of two local sessions and lists both", async (_flag, parsed) => {
		savedSession(project, first);
		savedSession(project, second);
		await expect(open({ print: true, ...parsed })).rejects.toThrow("exit 1");
		const text = errors.join("\n");
		expect(text).toContain("matches 2 sessions");
		expect(text).toContain(first);
		expect(text).toContain(second);
	});

	it("refuses a prefix of two sessions in other projects", async () => {
		savedSession(elsewhere, first);
		savedSession(elsewhere, second);
		await expect(open({ print: true, fork: "dddd" })).rejects.toThrow("exit 1");
		expect(errors.join("\n")).toContain("matches 2 sessions");
	});

	it("takes a local match over one in another project, and any unique prefix", async () => {
		const local = savedSession(project, first);
		savedSession(elsewhere, second);
		expect((await open({ print: true, session: "dddd" })).getSessionFile()).toBe(local);
		expect((await open({ print: true, session: "dddd1" })).getSessionFile()).toBe(local);
	});
});
