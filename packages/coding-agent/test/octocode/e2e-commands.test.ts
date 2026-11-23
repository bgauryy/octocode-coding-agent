import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TuiAltScreen } from "@octocodeai/octocode-tui";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { type InteractiveHarness, type Outcome, startInteractive } from "./e2e-commands-harness.ts";

/**
 * Every slash command the terminal offers (built-in, native, extension and skill commands, read from the live
 * registry), submitted through the editor like a user would, against a real session with the native extension and the
 * Octocode MCP server. Only external boundaries are replaced: the scripted model, the browser opener (the default-browser opener and the app window) and process exit.
 * A command without a case below fails the coverage check, so a new command needs an observable assertion here.
 */
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@octocodeai/octocode-common/open-target", () => ({
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
const LAST = ["cron", "resume", "tree", "fork", "clone", "import", "new", "clear", "reset", "reload", "quit"];
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
	// The page opens on the current mode; the sweep dismisses it, which changes nothing.
	permissions: { check: asks(/Permissions[\s\S]*Mode\s+workspace —[\s\S]*workspace\s+current/) },
	security: { check: asks(/Security[\s\S]*Not checked[\s\S]*Approved[\s\S]*Denied/) },
	// A main session joins its team at start (lifecycle design O6b), so /agents lists it and its run; the run of this
	// idle session says what it does in the light's words, not "running".
	agents: { check: says(/\(you\) · main[\s\S]*Recent runs[^\n]*\n[^\n]*\(main\) idle · /) },
	// The page opens on the team feed (empty here) with internal notices hidden and the toggle key shown.
	messages: { check: asks(/Messages[\s\S]*no messages yet[\s\S]*Internal notices hidden · i shows them/) },
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
	// Empty sections are sentences: no code block labelled "diff" around "No staged changes.".
	diff: {
		check: (run) => {
			expect(run.text).toMatch(
				/Repository diff[\s\S]*Staged\s+No staged changes\.[\s\S]*Unstaged\s+No unstaged changes\./,
			);
			expect(run.text).not.toMatch(/\bdiff\s+No (un)?staged changes/);
		},
	},
	// The Cache Warming section comes from the real session through the feature context (`getCacheWarmingReport`).
	status: {
		check: says(
			/Session Info[\s\S]*File:[\s\S]*Cache Warming[\s\S]*Requested instructions:[\s\S]*Mode: \w+[\s\S]*Status: /,
		),
	},
	// A fresh home has recorded nothing yet: the report says so and where its history starts.
	usage: { check: says(/Usage today[\s\S]*No usage recorded[\s\S]*Usage last 7 days/) },
	// The dialog lists each configured server with its source and state: the Octocode server is connected with its tools; the browser, on demand in the main session, is off in this suite
	// (setup-env.ts), like the other bundled servers.
	mcp: {
		check: asks(
			/MCP servers[\s\S]*› octocode\s+direct · default\s+connected · \d+ tools[\s\S]*browser\s+onDemand · default\s+disabled/,
		),
	},
	// On by default, in the harness's isolated home: its socket and discovery record are the observable outcome.
	api: { check: says(/Octocode API oc-[0-9a-f]+\s+socket: \S+\.sock\s+Discovery:[\s\S]*\/home\/\.octocode\/api/) },
	archive: { check: says(/segment|archive|compact/i) },
	// The view opens on its Overview: one row per section with switch counts (Octocode's bundled skills are on), and keys
	// to move to Skills, MCPs, Hooks, Sources and Extensions; the harness switches (Claude Code, Codex, Cursor) live in Sources.
	harness: {
		check: asks(/Skills\s+[1-9]\d* on · \d+ off[\s\S]*Sources[\s\S]*←\/→ section/),
	},
	// `/jobs` lists what runs in the background: the cron the `/loop` case set shows in its overview.
	jobs: { check: says(/Crons[\s\S]*cron \*\/10 \* \* \* \*/) },
	memory: { check: asks(/memor/i) },
	// Bare `/optimize` shows the state and offers the toggle; the terminal dismisses the dialog, which changes nothing.
	optimize: { check: asks(/Prompt optimization is off/) },
	// Reads the real process table: this session is listed (or the table is unreadable where `ps` is missing).
	processes: { check: says(/Octocode processes:|No Octocode process found|cannot be read/) },
	rewind: { check: says(/No file changes to rewind on this branch/) },
	// Without a scope word `/purge` only prints its usage; deleting needs a preview and a typed confirmation.
	purge: { check: says(/Usage: \/purge workspace\|all/) },
	worktree: { check: says(/worktree/i) },
	// An unknown name lists the realms by name; the main checkout is always one.
	realm: { args: "zz-none", check: says(/No realm named zz-none\. Realms: main/) },
	// `/loop` sets a cron wait through the same path as the tool, and `/cron` then lists the session's scheduled tasks.
	loop: { args: "10m run the tests", check: says(/Every 10m: Scheduled task #\d+ sends "run the tests"/) },
	cron: { check: says(/cron \*\/10 \* \* \* \* · run 1 of 20 · next in/) },
	// Lists every monitor rule of the session's ledger: a page in the terminal, with all rules ok before any alert.
	monitor: { check: asks(/Monitor[\s\S]*Rules\s+\d+[\s\S]*Tripped\s+0[\s\S]*load[\s\S]*idle-items/) },
	// `/remote` grants control, so it asks first; the sweep dismisses the question and nothing is published (the
	// accepted path, which publishes an ssh link, is covered in remote-command.test.ts).
	remote: {
		check: (run) => {
			asks(/Publish a control link\?/)(run);
			says(/Cancelled: nothing was published/)(run);
		},
	},
	// The research CLI (`cli/command.ts`): its output is the command result.
	octocode: { args: "--version", check: says(/octocode \d+\.\d+\.\d+/) },
	// `/web` opens the user-level daemon's page on this session with a one-time code, never the token.
	web: {
		check: (run) => {
			expect(run.opened).toEqual([
				expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/open\/[^?#]+\?s=[^&]+&view=activity$/),
			]);
			expect(run.text).toMatch(
				/Opened the web workspace\. It keeps running after this session closes and stops by itself after 10 minutes/,
			);
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
	// The panel lists the live-applying interface page first, then each configurable setting with its value.
	settings: {
		check: asks(/Configuration[\s\S]*Interface and session \(applies now\)\s+open[\s\S]*harness:agents\s+on/),
	},
	model: { check: asks(/Choose a model for this chat/) },
	effort: { check: asks(/Thinking level/) },
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
	providers: { check: asks(/Ready means configured, not verified/) },
	models: { check: asks(/Off models leave/) },
	logout: {
		check: (run) => expect(`${run.text}\n${run.dialogs.join("\n")}`).toMatch(/credential|logout|log out|provider/i),
	},
	bug: { check: asks(/Report a bug/) },
	// Guarded: nothing to act on yet, or a confirmation the user declines.
	// No message yet, so no session file: /share says so before asking to upload anything (the confirmation and its
	// decline are covered in session-share.test.ts).
	share: {
		check: (run) => {
			expect(run.dialogs).toEqual([]);
			expect(run.text).toMatch(/Nothing to share yet: send a message first/);
		},
	},
	export: { check: says(/Nothing to export yet: send a message first/) },
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
	// Fullscreen is the default: /find opens the transcript search box; escape closes it for the next command.
	find: {
		check: (_run, t) => {
			expect(t.host.ui.hasOverlay(), "opens the search box").toBe(true);
			t.press("\x1b");
		},
	},
	// Fullscreen is the default: bare /mouse hands the mouse to the terminal and its notice says so; taken back after.
	mouse: {
		// `host.ui` is a reference that forwards to the live screen: assignment reaches the screen, a spy would not.
		before: (t) => {
			const ui = t.host.ui as TuiAltScreen;
			const flash = ui.flash;
			const flashes: string[] = [];
			ui.flash = (message, durationMs) => {
				flashes.push(message);
				flash.call(ui, message, durationMs);
			};
			return { flashes, restore: () => (ui.flash = flash) };
		},
		check: (_run, t, before) => {
			const seen = before as { flashes: string[]; restore: () => void };
			seen.restore();
			expect(seen.flashes).toEqual([expect.stringMatching(/^Mouse off: select, copy and scroll with your terminal/)]);
			(t.host.ui as TuiAltScreen).setMouseCapture(true);
		},
	},
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
			const after = entriesOf(was.file);
			const extra = after.slice(was.entries.length).map((value) => {
				const entry = value as { type?: string; customType?: string; message?: { role?: string } };
				return [entry.type, entry.customType, entry.message?.role].filter(Boolean).join(" ");
			});
			expect(after, `the original is unchanged (new entries: ${extra.join(", ")})`).toEqual(was.entries);
		},
	},
	import: { check: says(/Usage: \/import <path\.jsonl>/) },
	new: { check: startsOver },
	clear: { check: startsOver },
	reset: { check: startsOver },
	reload: { check: says(/Reloaded keybindings, features, skills/) },
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
		for (const command of t.host.session.featureHost.getRegisteredCommands())
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

	it("ends a finished feature command with its one next-step hint, keyed by its first argument", async () => {
		const jobs = await run("jobs");
		expect(jobs.settled).toBe(true);
		expect(jobs.text.match(/\/jobs kill <id>\s+stop one/g)).toHaveLength(1);
		const trust = await run("trust", "list");
		expect(trust.text).toMatch(/\/trust add \[path\]\s+trust a folder/);
	});

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
