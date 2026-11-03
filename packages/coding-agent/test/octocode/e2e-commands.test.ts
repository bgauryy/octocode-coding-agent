import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { type InteractiveHarness, type Outcome, startInteractive } from "./e2e-commands-harness.ts";

/**
 * Every slash command the terminal offers (built-in, native, extension and skill commands, read from the live
 * registry), submitted through the editor like a user would, against a real session with the native extension and the
 * Octocode MCP server. Only external boundaries are replaced: the scripted model, the browser opener and process exit.
 * A command without a case below fails the coverage check, so a new command needs an observable assertion here.
 */
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../../src/octocode/shared/open.ts", () => ({
	openFile: async (file: string) => {
		opened.push(file);
	},
}));

interface Run extends Outcome {
	/** URLs handed to the browser opener. */
	opened: string[];
	/** Model requests the command made. */
	requests: number;
}
interface Case {
	/** Safe arguments; omitted means the bare command. */
	args?: string;
	check(run: Run, t: InteractiveHarness): void | Promise<void>;
}

const says = (pattern: RegExp) => (run: Run) => expect(run.text).toMatch(pattern);
const asks = (pattern: RegExp) => (run: Run) => {
	expect(run.dialogs.length, "opens a dialog the user can dismiss").toBeGreaterThan(0);
	expect(run.dialogs.join("\n")).toMatch(pattern);
};
const noModel = (run: Run) => expect(run.requests).toBe(0);
/**
 * /new, /clear and /reset each start a fresh, unnamed session. They run back to back and the transcript keeps the
 * same "New session started" line, so only the first adds text; a session id not seen before proves each one.
 */
const sessionIds = new Set<string>();
let startedOver = 0;
const startsOver = (run: Run, t: InteractiveHarness) => {
	if (startedOver++ === 0) expect(run.text).toMatch(/New session started/);
	const id = t.host.sessionManager.getSessionId();
	expect(sessionIds.has(id), "starts a session not seen before").toBe(false);
	sessionIds.add(id);
	expect(t.host.sessionManager.getSessionName()).toBeUndefined();
};

/** Commands that replace or end the session run last, in this order. */
const LAST = ["resume", "tree", "fork", "clone", "import", "new", "clear", "reset", "reload", "quit"];
const shutdown = vi.fn(async () => {});

const CASES: Record<string, Case> = {
	// Native features.
	permissions: { check: says(/Permission mode: workspace/) },
	agents: { check: says(/No agents have joined in this repository/) },
	plan: {
		check: async (run, t) => {
			expect(run.text).toMatch(/Planning active; revision 0/);
			const off = await t.submit("/plan --off");
			expect(off.settled).toBe(true);
			expect(off.text).toMatch(/plan/i);
		},
	},
	btw: { check: says(/Usage: \/btw <question>/) },
	context: { check: says(/Total context: 0 of [\d,]+ tokens/) },
	diff: { check: says(/Repository diff[\s\S]*No staged changes/) },
	status: { check: says(/Session Info[\s\S]*File:/) },
	llama: { check: says(/Configure llama\.cpp with \/login llama\.cpp/) },
	mcp: { check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/octocode/) },
	api: { check: says(/Octocode API is off/) },
	archive: { check: says(/segment|archive|compact/i) },
	hooks: { check: says(/Hooks: (on|off)/) },
	config: { check: says(/Loaded context and where each item came from|Nothing is loaded/) },
	jobs: { check: says(/job/i) },
	memory: { check: asks(/memor/i) },
	plugins: { check: asks(/type to filter/) },
	rewind: { check: says(/No file changes to rewind on this branch/) },
	// Without a scope word `/purge` only prints its usage; deleting needs a preview and a typed confirmation.
	purge: { check: says(/Usage: \/purge workspace\|all/) },
	worktree: { check: says(/worktree/i) },
	// `/remote` publishes the user-level daemon; without OCTOCODE_WEB_DAEMON=1 it refuses and starts nothing.
	remote: { check: says(/Could not publish a remote link:[\s\S]*OCTOCODE_WEB_DAEMON=1/) },
	web: {
		check: (run) => {
			expect(run.opened).toEqual([
				expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/#access=[0-9a-f]{64}&view=activity$/),
			]);
			expect(run.text).toMatch(/Opened the web workspace at\s+http:\/\/127\.0\.0\.1:\d+/);
		},
	},
	backlog: {
		check: (run) => expect(run.opened).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/#access=/)]),
	},
	// Terminal commands that open a picker or menu.
	help: { check: asks(/\/btw\s+Ask a side question/) },
	settings: { check: asks(/Skill commands/) },
	model: { check: asks(/Models from configured providers/) },
	effort: { check: asks(/Thinking Level/) },
	modelsettings: { check: asks(/Model settings/) },
	// The one /trust: a menu in the terminal, and `list` prints where this folder stands and the stored decisions.
	trust: {
		check: async (run, t) => {
			asks(/Folder trust/)(run);
			const list = await t.submit("/trust list");
			expect(list.settled).toBe(true);
			expect(list.text).toMatch(/no\s+trust\s+decision\s+yet[\s\S]*No\s+trust\s+decisions\s+are\s+stored/);
		},
	},
	login: { check: asks(/Configured means credentials are present/) },
	logout: {
		check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/credential|logout|log out|provider/i),
	},
	skills: { check: asks(/SKILL\.md/) },
	bug: { check: asks(/Report a bug/) },
	// Guarded: nothing to act on yet, or a confirmation the user declines.
	share: {
		check: (run) => {
			expect(run.dialogs.length).toBeGreaterThan(0);
			expect(run.text).toMatch(/Share cancelled/);
		},
	},
	export: { check: says(/Nothing to export yet/) },
	copy: { check: says(/No agent messages to copy yet/) },
	compact: { check: says(/Nothing to compact yet/) },
	queue: { check: says(/No queued messages/) },
	github: { args: "status", check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/GitHub/) },
	rename: {
		args: "e2e named session",
		check: (_run, t) => expect(t.host.sessionManager.getSessionName()).toBe("e2e named session"),
	},
	changelog: { check: says(/What's New/) },
	keys: { check: says(/Keyboard Shortcuts/) },
	debug: { check: says(/Debug log written/) },
	// Session-changing commands, run last.
	resume: { check: (run) => expect(run.dialogs.length).toBeGreaterThan(0) },
	tree: { check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/\S/) },
	fork: { check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/\S/) },
	clone: { check: (run) => expect(run.text).toMatch(/\S/) },
	import: { check: says(/Usage: \/import <path\.jsonl>/) },
	new: { check: startsOver },
	clear: { check: startsOver },
	reset: { check: startsOver },
	reload: { check: says(/Reloaded keybindings, extensions, skills/) },
	// Process exit is the boundary: the terminal asks the host to shut down once and nothing else runs.
	quit: { check: () => expect(shutdown).toHaveBeenCalledTimes(1) },
};

let t: InteractiveHarness;
let names: string[] = [];
let skills = new Set<string>();

beforeAll(async () => {
	t = await startInteractive();
	(t.host as { shutdown: unknown }).shutdown = shutdown;
	sessionIds.add(t.host.sessionManager.getSessionId());
	names = t.host.getSlashCommands(true).map((command) => command.name);
	skills = new Set(t.host.skillCommands.keys());
}, 120_000);
afterAll(async () => t?.stop());

async function run(name: string, args = ""): Promise<Run> {
	t.reply("scripted reply");
	const requests = t.requests.length;
	const before = opened.length;
	const outcome = await t.submit(`/${name}${args ? ` ${args}` : ""}`);
	return { ...outcome, requests: t.requests.length - requests, opened: opened.slice(before) };
}

describe("every slash command through the terminal editor", () => {
	it("reads built-in, native, extension and skill commands from the live registry, each with a case", () => {
		for (const command of BUILTIN_SLASH_COMMANDS) expect(names).toContain(command.name);
		for (const command of t.host.session.extensionRunner.getRegisteredCommands())
			expect(names).toContain(command.invocationName ?? command.name);
		expect(new Set(names).size).toBe(names.length);
		expect(skills.size).toBeGreaterThan(0);
		const uncovered = names.filter((name) => !CASES[name] && !skills.has(name));
		expect(uncovered, "add an e2e case for each new command").toEqual([]);
		const stale = Object.keys(CASES).filter((name) => !names.includes(name));
		expect(stale, "cases for commands that no longer exist").toEqual([]);
		expect(names).toContain("web");
		expect(names).not.toContain("octocode");
	});

	it("runs each command with an observable outcome and no hang", async () => {
		const order = [
			...names.filter((name) => !LAST.includes(name) && !skills.has(name)),
			...[...skills].sort(),
			...LAST.filter((name) => names.includes(name)),
		];
		const failures: string[] = [];
		for (const name of order) {
			const result = await run(name, CASES[name]?.args);
			try {
				expect(result.settled, "finishes within its timeout").toBe(true);
				expect(result.error).toBeUndefined();
				if (skills.has(name)) {
					// A skill command sends its skill to the model once.
					expect(result.requests).toBe(1);
					expect(t.requests.at(-1)).toContain(name);
					expect(result.text).toContain(`[skill] ${name}`);
				} else {
					noModel(result);
					await CASES[name].check(result, t);
				}
			} catch (error) {
				const seen = `${result.text}\n--- dialogs ---\n${result.dialogs.join("\n---\n")}`.slice(0, 1500);
				failures.push(`/${name}: ${(error as Error).message.split("\n")[0]}\n${seen}`);
			}
		}
		expect(failures.join("\n\n")).toBe("");
	}, 600_000);

	it("reports the retired /octocode as unknown and runs nothing", async () => {
		const result = await run("octocode");
		expect(result.text).toMatch(/Unknown command \/octocode\./);
		expect(result.opened).toEqual([]);
		expect(result.requests).toBe(0);
		expect(t.host.editor.getText()).toBe("/octocode");
		t.host.editor.setText("");
	});
});
