/**
 * The one registry of next-step hints, for built-in and native feature commands. A finished command shows its entry
 * as one dim line (`/fork  branch from an earlier message`); the interactive terminal applies it, command files add no
 * prose. A key is a command name or a command and its first argument (`trust list`), which wins over the name alone.
 * A command that opens a page or picker with its own key bar has no entry and names why in `NO_NEXT_STEP`.
 */

/** A command to type and what it does. */
export type NextStep = readonly [command: string, verb: string];

const NEXT_STEPS: Readonly<Record<string, NextStep>> = {
	permissions: ["/permissions log", "review recent decisions"],
	agents: ["/agents stats", "see usage per agent"],
	messages: ["/agents", "see who is running"],
	cron: ["/help cron", "see how to schedule"],
	loop: ["/help loop", "see how to repeat a prompt"],
	realm: ["/help realm", "see the options"],
	plan: ["/plan <description>", "draft a plan"],
	btw: ["/btw <question>", "ask a side question"],
	context: ["/compact", "free context"],
	diff: ["/export", "save the session"],
	effort: ["/model", "switch model"],
	modelsettings: ["/modelsettings check", "verify models.json"],
	export: ["/share", "share it as a private gist"],
	import: ["/tree", "browse the imported branches"],
	share: ["/export", "save a local copy"],
	bug: ["/status", "see versions and paths"],
	copy: ["/export", "save the whole session"],
	links: ["/copy", "copy the last reply"],
	rename: ["/resume", "find it again later"],
	status: ["/debug", "write diagnostics"],
	changelog: ["/keys", "see shortcuts"],
	keys: ["/help", "find a command"],
	fork: ["/tree", "browse branches"],
	clone: ["/rename <name>", "name the copy"],
	logout: ["/providers", "connect another provider"],
	new: ["/resume", "reopen an earlier session"],
	clear: ["/new", "start a fresh session"],
	reset: ["/new", "start a fresh session"],
	compact: ["/context", "see the new size"],
	debug: ["/bug", "report a problem"],
	reload: ["/status", "check what loaded"],
	// Native feature commands.
	api: ["/api off", "stop the local API"],
	archive: ["/archive <n>", "open one segment's file"],
	backlog: ["/backlog tui", "open the board in the terminal"],
	"harness list": ["/harness", "switch sources on or off"],
	jobs: ["/jobs kill <id>", "stop one"],
	"memory add": ["/memory", "browse memories"],
	"mcp list": ["/mcp tools <server>", "see a server's tools"],
	"mcp tools": ["/configuration disable mcp:<server>", "switch a server off"],
	processes: ["/processes all", "list every Octocode process"],
	remote: ["/remote stop", "end remote access"],
	rewind: ["/diff", "see what changed"],
	"security check": ["/security", "review and approve"],
	"trust list": ["/trust add [path]", "trust a folder"],
	web: ["/processes", "see the web daemon"],
	worktree: ["/worktree new <name>", "create one"],
	"worktree new": ["/worktree switch <name>", "move this session into it"],
};

/** Commands with no entry, and why. */
export const NO_NEXT_STEP: Readonly<Record<string, string>> = {
	help: "opens a picker with its own key bar",
	model: "opens a selector with its own key bar",
	tree: "opens a selector with its own key bar",
	resume: "opens a selector with its own key bar",
	providers: "opens a manage page with its own key bar",
	monitor: "opens a page with its own key bar",
	configuration: "opens a selector with its own key bar; a verb prints its own result and when it applies",
	find: "opens the transcript search with its own key bar",
	queue: "opens a list with its own key bar; empty, it says how to queue",
	quit: "leaves the app",
	// Native feature commands.
	"backlog tui": "opens a board with its own key bar",
	harness: "opens a switch list with its own key bar",
	mcp: "opens a manager with its own key bar",
	memory: "opens a page with its own key bar",
	octocode: "hands the terminal to the research CLI, which prints its own help",
	optimize: "asks with its own choices; on and off say what changed",
	purge: "asks you to type the scope word, then reports what it deleted",
	security: "opens a review page with its own key bar",
	trust: "opens a page with its own key bar",
};

/**
 * The next-step hint for a command and its arguments, if it has one: the entry for the command and its first argument,
 * else none when that pair is a stated exception, else the command's own entry.
 */
export function nextStepFor(name: string, args = ""): NextStep | undefined {
	const word = args.trim().split(/\s+/u)[0];
	const pair = word ? `${name} ${word}` : undefined;
	if (pair && NEXT_STEPS[pair]) return NEXT_STEPS[pair];
	if (pair && NO_NEXT_STEP[pair]) return undefined;
	return NEXT_STEPS[name];
}

/** Every registry key, for tests that tie the entries to registered commands. */
export function nextStepKeys(): string[] {
	return Object.keys(NEXT_STEPS);
}
