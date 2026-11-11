import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { type InteractiveHarness, type Outcome, startInteractive } from "./e2e-commands-harness.ts";

/**
 * Every slash command the terminal offers (built-in, native, extension and skill commands, read from the live
 * registry), submitted through the editor like a user would, against a real session with the native extension and the
 * Octocode MCP server. Only external boundaries are replaced: the scripted model, the browser opener (the default-browser opener and the app window) and process exit.
 * A command without a case below fails the coverage check, so a new command needs an observable assertion here.
 */
const opened = vi.hoisted(() => [] as string[]);
vi.mock("../../../common/src/open-target.ts", () => ({
	openTarget: async (file: string) => {
		opened.push(file);
	},
}));
// `/web` opens an app window by default: it is the external boundary, so no run can start a real browser.
vi.mock("../../src/octocode/browser/app-window.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createAppWindow: () => ({
		open: async (url: string) => void opened.push(url),
		close: async () => undefined,
	}),
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
	/** Model requests the command makes; omitted means none. */
	requests?: number;
	/** Runs just before the command and hands what it saw to `check`. */
	before?(t: InteractiveHarness): unknown;
	check(run: Run, t: InteractiveHarness, before?: unknown): void | Promise<void>;
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
/** The session file's entries (not the header) without ids and timestamps, which a copy renews. */
function entriesOf(file: string | undefined): unknown[] {
	if (!file || !fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.type !== "session")
		.map(({ id: _id, parentId: _parent, timestamp: _time, ...rest }) => rest);
}
const shutdown = vi.fn(async () => {});

const CASES: Record<string, Case> = {
	// Native features.
	permissions: { check: says(/Permission mode: workspace/) },
	// A main session joins its team at start (lifecycle design O6b), so /agents lists it and its run.
	agents: { check: says(/\(you\) · main[\s\S]*Recent runs/) },
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
	llama: { check: says(/Configure llama\.cpp with \/providers llama\.cpp/) },
	// The dialog lists each configured server with its source and state: the Octocode server is connected with its tools.
	mcp: {
		check: asks(
			/MCP servers[\s\S]*› browser\s+direct · default\s+not selected[\s\S]*octocode\s+direct · default\s+connected · \d+ tools/,
		),
	},
	// On by default, in the harness's isolated home: its socket and discovery record are the observable outcome.
	api: { check: says(/Octocode API oc-[0-9a-f]+\s+socket: \S+\.sock\s+Discovery:[\s\S]*\/home\/\.octocode\/api/) },
	archive: { check: says(/segment|archive|compact/i) },
	// One row per harness comes first: Claude Code, Codex and Cursor are off by default, then Octocode's own group.
	harness: {
		check: asks(
			/\[ \] Claude Code {2}default off[\s\S]*\[ \] Codex {2}default off[\s\S]*\[ \] Cursor {2}default off[\s\S]*Octocode/,
		),
	},
	jobs: { check: says(/No background bash jobs are running\./) },
	memory: { check: asks(/memor/i) },
	// Bare `/optimize` shows the state and offers the toggle; the terminal dismisses the dialog, which changes nothing.
	optimize: { check: asks(/Prompt optimization is off/) },
	// Reads the real process table: this session is listed (or the table is unreadable where `ps` is missing).
	processes: { check: says(/Octocode processes:|No Octocode process found|cannot be read/) },
	rewind: { check: says(/No file changes to rewind on this branch/) },
	// Without a scope word `/purge` only prints its usage; deleting needs a preview and a typed confirmation.
	purge: { check: says(/Usage: \/purge workspace\|all/) },
	worktree: { check: says(/worktree/i) },
	// `/remote` starts the user-level daemon (or reuses the one `/web` started) and publishes an ssh link; the harness
	// drains the daemon when it stops.
	remote: { check: says(/Then open: http:\/\/127\.0\.0\.1:\d+\/#access=[\s\S]*Stop with \/remote stop/) },
	// The research CLI (`cli/command.ts`): its output is the command result.
	octocode: { args: "--version", check: says(/octocode \d+\.\d+\.\d+/) },
	// `/web` opens the user-level daemon's page on this session with a one-time code, never the token.
	web: {
		check: (run) => {
			expect(run.opened).toEqual([
				expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/open\/[^?#]+\?s=[^&]+&view=activity$/),
			]);
			expect(run.text).toMatch(/Opened the web workspace\. It keeps running after this session closes\./);
		},
	},
	// Bare `/backlog` runs `/web backlogs`.
	backlog: {
		check: (run) =>
			expect(run.opened).toEqual([
				expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/open\/[^?#]+\?s=[^&]+&view=board$/),
			]),
	},
	// Terminal commands that open a picker or menu.
	help: { check: asks(/\/btw\s+Ask a side question without tools/) },
	configuration: { check: asks(/Interface and session/) },
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
	providers: { check: asks(/Configured means credentials are present/) },
	logout: {
		check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/credential|logout|log out|provider/i),
	},
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
	links: { check: says(/No matching references/) },
	compact: { check: says(/Nothing to compact yet/) },
	queue: { check: says(/No queued messages/) },
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
	// A new session file with the original's entries, and the original file left as it was.
	clone: {
		before: (t) => {
			const file = t.host.sessionManager.getSessionFile();
			return { file, id: t.host.sessionManager.getSessionId(), entries: entriesOf(file) };
		},
		check: (run, t, before) => {
			const was = before as { file: string | undefined; id: string; entries: unknown[] };
			expect(run.text).toMatch(/Cloned to new session/);
			const file = t.host.sessionManager.getSessionFile();
			expect(file, "a new session file").toBeTruthy();
			expect(file).not.toBe(was.file);
			expect(t.host.sessionManager.getSessionId()).not.toBe(was.id);
			expect(was.entries.length, "the original has entries to copy").toBeGreaterThan(0);
			const copied = entriesOf(file);
			expect(copied.slice(0, was.entries.length), "every original entry, in order").toEqual(was.entries);
			// The new session joins its team on start: that is the only entry the copy adds.
			expect(copied.slice(was.entries.length)).toEqual([
				expect.objectContaining({ type: "custom", customType: "octocode-team" }),
			]);
			expect(entriesOf(was.file), "the original is unchanged").toEqual(was.entries);
		},
	},
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
		expect(names).toContain("octocode");
	});

	it("runs each command with an observable outcome and no hang", async () => {
		const order = [
			...names.filter((name) => !LAST.includes(name) && !skills.has(name)),
			...[...skills].sort(),
			...LAST.filter((name) => names.includes(name)),
		];
		const failures: string[] = [];
		for (const name of order) {
			const seen = CASES[name]?.before?.(t);
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
					if (CASES[name].requests === undefined) noModel(result);
					else expect(result.requests).toBe(CASES[name].requests);
					await CASES[name].check(result, t, seen);
				}
			} catch (error) {
				const seen = `${result.text}\n--- dialogs ---\n${result.dialogs.join("\n---\n")}`.slice(0, 1500);
				failures.push(`/${name}: ${(error as Error).message.split("\n")[0]}\n${seen}`);
			}
		}
		expect(failures.join("\n\n")).toBe("");
	}, 600_000);

	it("passes /octocode arguments to the research CLI as typed: bare is its own no-argument output, no aliases", async () => {
		const bare = await run("octocode");
		expect(bare.text).toMatch(/octocode\.toolCatalog/);
		expect(bare.opened).toEqual([]);
		expect(bare.requests).toBe(0);
		const help = await run("octocode", "--help");
		expect(help.text).toMatch(/Native Octocode research tools/);
		// `login` is not rewritten to `auth login`, and it is no CLI command: the whole line goes to the agent as a prompt.
		const login = await run("octocode", "login");
		expect(login.settled).toBe(true);
		expect(login.text).not.toMatch(/unrecognized subcommand|needs an interactive terminal/);
		expect(login.requests).toBe(1);
	});
});
