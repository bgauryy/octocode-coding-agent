import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPackageDir } from "../../src/config.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(packageRoot, "src", "octocode");

const walk = (dir: string): string[] =>
	fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? walk(path.join(dir, entry.name))
				: entry.name.endsWith(".ts")
					? [path.join(dir, entry.name)]
					: [],
		);
const files = walk(sourceRoot).sort();
/** The native harness folder: each of its folders is a domain of its own, and so is each tool under `native/tools/`. */
const NATIVE = "native";
const NATIVE_TOOLS = "tools";

/** The domain of a source file: its top folder, `native/<folder>` in the native harness folder, `native/tools/<tool>` for a tool. */
const domainOf = (file: string): string => {
	const [first, second, third] = path.relative(sourceRoot, file).split(path.sep);
	if (first.endsWith(".ts")) return "(root)";
	if (first !== NATIVE) return first;
	return second === NATIVE_TOOLS && third && !third.endsWith(".ts")
		? `${NATIVE}/${NATIVE_TOOLS}/${third}`
		: `${NATIVE}/${second}`;
};

function importsOf(file: string): string[] {
	const text = fs.readFileSync(file, "utf8");
	// `from '…'`, dynamic `import('…')`, side-effect `import '…'` and `require('…')` all create a dependency.
	return [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)].flatMap(
		(match) => {
			const target = path.resolve(path.dirname(file), match[2].replace(/\.js$/, ".ts"));
			return files.includes(target) ? [target] : [];
		},
	);
}

/**
 * The layering: each domain may depend only on the domains listed. `shared` is the leaf within `octocode/`: only
 * cross-domain utilities stay there. The leaf domains split from it (`render`, `history`, `tool-input`, `browser`,
 * `child-sessions`, `worktree-paths`) depend on `shared` alone. Both still use host modules under `core/` and `modes/`;
 * the root modules (`index.ts` wires everything) may use any domain.
 */
const ALLOWED: Record<string, string[]> = {
	shared: [],
	// Tool rows in the terminal: headers, result blocks, row state and motion, display blocks, thinking gists, item titles.
	render: ["shared"],
	// Session transcripts on disk: archive segments and LIBRARY, session records, history listing, search, ranking, errors.
	history: ["shared"],
	// Tool-call input formats: the file tool's input and patch grammar (Codex apply-patch), Claude Code's tool names and input shapes.
	"tool-input": ["shared"],
	// Opening local pages: the browser app window, where a page can open, the OS opener, the launcher, and routes every page serves.
	browser: ["shared"],
	// A parent's view of its children: the agent call's fields, child session files, report artifacts, handoff references.
	"child-sessions": ["shared"],
	// Where worktree sessions live: the member and own worktree roots and the prompt root a worktree session rebases to.
	"worktree-paths": ["shared"],
	"mcp-host": ["shared", "skill", "trust", "web", "render", "guard"],
	api: ["shared", "render"],
	// `worktrees`: a worktree session's message to its coordinator looks up the repository's main checkout.
	external: ["shared", "api", "worktrees", "ask", "child-sessions"],
	// Claude Code as the model backend: the connected runner, its cleaned environment and the ACP host come from `external`.
	"claude-code": ["external"],
	ask: ["shared", "render"],
	// `cli`: the bash guide names the research CLI only when its shim is installed. `ask`: the file review is an approval question.
	files: ["shared", "permission", "cli", "ask", "render", "tool-input", "wake"],
	// `monitor`: the check-in and child-silence rules are told through the monitor's `attend`.
	team: ["shared", "render", "tool-input", "worktree-paths", "wake", "monitor"],
	discovery: ["shared"],
	// `permission`: a Claude hook's `if` is one permission rule, judged by the source-policy parser and matcher.
	// `guard`: session start withholds a handler the user has not approved (the extension guard).
	// `monitor`: the MonitorAlert hook observes the monitor ledger.
	hooks: ["shared", "discovery", "render", "tool-input", "permission", "guard", "wake", "monitor"],
	plugins: ["shared", "hooks", "discovery"],
	// `/harness` folds in what plugins, hooks and discovery used to expose as their own commands.
	// `guard`: every external row shows its review state, and Enter opens its check.
	harness: ["shared", "plugins", "hooks", "discovery", "skill", "guard"],
	web: ["shared", "permission", "render"],
	// `sessions`: the summary's live state names the background work with the reader the reorient brief uses (`compaction/live-state.ts`);
	// `timer`: it names the active timers as their rows say (`timer/work.ts`). `monitor`: the context band rule.
	compaction: [
		"shared",
		"files",
		"permission",
		"archive",
		"sessions",
		"history",
		"render",
		"timer",
		"native/tools/compact",
		"monitor",
	],
	// The archive tool's profile source reads a stored session through the profiler.
	archive: ["shared", "permission", "profiler", "history", "render"],
	// The phase feed reads the ongoing items this session holds, as a settled run leaves them open; the editor's skill-word
	// highlight stems words the way history ranking does.
	ui: ["shared", "permission", "render", "child-sessions", "tool-input", "wake", "backlog", "history"],
	subagents: [
		"shared",
		"discovery",
		"team",
		"permission",
		"native/prompts",
		"backlog",
		"trust",
		"worktrees",
		"ask",
		"render",
		"history",
		"child-sessions",
		"worktree-paths",
		"wake",
		"native/tools/agent",
		// The idle-items rule.
		"monitor",
	],
	"native/prompts": ["shared", "history", "worktree-paths"],
	"native/agents": [],
	"native/hooks": [],
	// Each native tool's module: its schema, description and execute; the domain it serves does the work. A domain that
	// registers its own tool (backlog, compaction, memory, subagents, timer) imports that tool's folder only.
	"native/tools/agent": ["shared", "render", "child-sessions", "subagents", "team"],
	"native/tools/archive": ["shared", "render", "archive", "history"],
	"native/tools/ask-user": ["shared", "render", "ask"],
	"native/tools/backlog": ["shared", "render", "backlog"],
	"native/tools/backlog-plan": ["shared", "render", "backlog"],
	"native/tools/bash": ["shared", "render", "files", "wake"],
	"native/tools/compact": ["shared", "render", "compaction"],
	"native/tools/coordinate": ["shared", "render", "team", "permission"],
	"native/tools/file": ["shared", "render", "files", "permission", "tool-input"],
	"native/tools/memory": ["shared", "render", "memory", "permission"],
	"native/tools/models": ["shared", "subagents"],
	"native/tools/skill": ["shared", "render", "skill"],
	"native/tools/wait": ["shared", "render", "timer"],
	"native/tools/web": ["shared", "render", "permission", "web"],
	sessions: ["shared", "files", "subagents", "backlog", "archive", "child-sessions"],
	backlog: ["shared", "render", "browser", "native/tools/backlog", "native/tools/backlog-plan"],
	trust: ["shared"],
	// The extension guard: review items, the scanner and the review records. A leaf: loaders hand it plain data.
	// `trust`: the commands that record a decision refuse inside a session's shell.
	guard: ["shared", "trust"],
	// Rebuilds a stored session's profiler source from the team's message model; entry names from `shared`.
	profiler: ["shared", "team"],
	workspace: ["shared", "backlog", "team", "subagents", "profiler", "browser", "worktree-paths"],
	// The harness page previews a scan through the harness domain's renderer.
	"web-daemon": ["shared", "backlog", "workspace", "trust", "profiler", "browser", "harness"],
	remote: ["shared", "web-daemon", "workspace"],
	// `history`: a `query` is tested in the regex worker that bounds a search (`history/search.ts`).
	// `backlog`: start recall also searches the active item's goal (`memory/active-goal.ts`).
	memory: ["shared", "permission", "render", "history", "backlog", "native/tools/memory"],
	plan: ["shared"],
	// Every question to a person goes through `ask/` (one Question type); permission, external and subagents ask there.
	permission: ["shared", "plan", "ask", "child-sessions", "tool-input", "worktree-paths"],
	skill: ["shared", "render", "child-sessions", "compaction"],
	"context-optimization": ["shared"],
	// `/optimize`: its helper call is the small-tier route `subagents/` owns.
	"prompt-optimization": ["shared", "subagents"],
	// `!` shell mode: Tab completion and ghost text (`packages/terminal`); its model suggestion is one small-tier call.
	terminal: ["subagents"],
	// `/processes`, process titles and memory samples: process helpers from `shared`, agent-id variables from `team`.
	processes: ["shared", "team"],
	// The machine monitor: process titles from `processes` name the owner of a cause; alerts wake through the gate.
	monitor: ["shared", "processes", "wake"],
	// `/monitor`: lists the rules of the monitor ledger; it reads them and owns none.
	"monitor-room": ["shared", "monitor"],
	"native/skills": [],
	"terminal-launch": [],
	worktrees: ["shared", "terminal-launch", "trust", "worktree-paths"],
	// `/realm`: the checkout, worktrees, agents and saved sessions of the repository in one view; it reads each, owns none.
	realm: ["shared", "worktrees", "worktree-paths", "sessions"],
	// An until-command runs on the bash foreground path (`files`) after the plan-mode and read-only-role checks a bash call meets.
	timer: ["shared", "files", "permission", "plan", "render", "wake", "native/tools/wait"],
	// The wake gate: what each run was woken about, the `woke` row, the hold window; every wake source sends through it.
	wake: ["shared"],
	// `/octocode` and the agent-shell shim for the research CLI.
	cli: ["shared"],
};

describe("source layout", () => {
	it("requires an explicit dependency policy for every source domain", () => {
		const dirs = (root: string): string[] =>
			fs
				.readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		const folders = dirs(sourceRoot)
			.flatMap((name) =>
				name === NATIVE
					? dirs(path.join(sourceRoot, NATIVE)).flatMap((sub) =>
							// A tool folder holding only Markdown (its snippet, guidelines) is no domain.
							sub === NATIVE_TOOLS
								? [...new Set(files.map(domainOf))].filter((domain) => domain.startsWith(`${NATIVE}/${NATIVE_TOOLS}/`))
								: [`${NATIVE}/${sub}`],
						)
					: [name],
			)
			.sort();
		const unclassified = folders.filter((folder) => !Object.hasOwn(ALLOWED, folder));
		expect(unclassified, "Declare each new domain and its permitted dependencies in ALLOWED.").toEqual([]);
		const removed = Object.keys(ALLOWED).filter((domain) => !folders.includes(domain));
		expect(removed, "Drop a removed domain from ALLOWED.").toEqual([]);
	});

	it("lets each domain depend only on the domains below it", () => {
		const violations = files.flatMap((file) => {
			const domain = domainOf(file);
			if (domain === "(root)") return [];
			return importsOf(file)
				.filter((target) => domainOf(target) !== domain && !(ALLOWED[domain] ?? []).includes(domainOf(target)))
				.map((target) => `${path.relative(sourceRoot, file)} -> ${path.relative(sourceRoot, target)}`);
		});
		expect(violations).toEqual([]);
	});

	it("never imports the root modules from a domain, and nothing imports index.ts", () => {
		const upward = files
			.filter((file) => domainOf(file) !== "(root)")
			.flatMap((file) =>
				importsOf(file)
					.filter((target) => domainOf(target) === "(root)")
					.map((target) => `${path.relative(sourceRoot, file)} -> ${path.relative(sourceRoot, target)}`),
			);
		expect(upward).toEqual([]);
		expect(
			files
				.filter((file) => importsOf(file).includes(path.join(sourceRoot, "index.ts")))
				.map((file) => path.relative(sourceRoot, file)),
		).toEqual([]);
	});

	it("has no import cycles between files", () => {
		const graph = new Map(files.map((file) => [file, importsOf(file)]));
		const cycles: string[] = [];
		const done = new Set<string>();
		const visit = (file: string, trail: string[]): void => {
			if (trail.includes(file))
				return void cycles.push(
					[...trail.slice(trail.indexOf(file)), file].map((f) => path.relative(sourceRoot, f)).join(" -> "),
				);
			if (done.has(file)) return;
			for (const next of graph.get(file) ?? []) visit(next, [...trail, file]);
			done.add(file);
		};
		for (const file of files) visit(file, []);
		expect(cycles).toEqual([]);
	});

	it("keeps one owner per shared helper", () => {
		// Each helper has one owner (src/shared unless one domain alone uses it); a copy elsewhere drifts (as a removed flag once did: `=true` read differently from OCTOCODE_HOOKS=true).
		const owners: Array<[RegExp, string]> = [
			[/process\.kill\(/, "shared/process.ts"],
			[/instanceof Error \? [^:]+: String\(/, "shared/util.ts"],
			[/createHash\(['"]sha256['"]\)/, "@octocodeai/octocode-common/atomic-file"],
			[/env\[[^\]]+\](?:\?\.trim\(\))? === '1'/, "@octocodeai/octocode-common/env"],
			[/\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/, "@octocodeai/octocode-common/regexp"],
		];
		const copies = files.flatMap((file) => {
			const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
			const text = fs.readFileSync(file, "utf8");
			return owners
				.filter(([pattern, owner]) => relative !== owner && pattern.test(text))
				.map(([pattern]) => `${relative}: ${pattern.source}`);
		});
		expect(copies).toEqual([]);
	});

	it("names the .octocode folder only in shared/home.ts", () => {
		// Every path under `~/.octocode` or `<repo root>/.octocode` goes through src/shared/home.ts, so one module decides
		// where things live. Prose that mentions `.octocode/code/temp/` (prompts, tool descriptions) is fine; path segments are not.
		const owners = new Set(["shared/home.ts"]);
		const segment = /(['"`])\.octocode\1|homedir\(\)\s*,\s*(['"`])\.octocode/;
		const hits = files
			.map((file) => path.relative(sourceRoot, file).split(path.sep).join("/"))
			.filter(
				(relative) => !owners.has(relative) && segment.test(fs.readFileSync(path.join(sourceRoot, relative), "utf8")),
			);
		expect(hits).toEqual([]);
	});

	it("imports only declared packages, Octocode only as a peer, and never @octocodeai/config", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<
			string,
			Record<string, string> | undefined
		>;
		const runtime = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		]);
		const packageOf = (specifier: string) =>
			specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
		const bare = files.flatMap((file) =>
			[
				...fs
					.readFileSync(file, "utf8")
					.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])([^.'"][^'"]*)\1/g),
			]
				.map((match) => match[2])
				.filter((specifier) => !specifier.startsWith("node:"))
				.map((specifier) => ({ file: path.relative(sourceRoot, file), name: packageOf(specifier) })),
		);
		expect(bare.filter(({ name }) => !runtime.has(name)).map(({ file, name }) => `${file}: ${name}`)).toEqual([]);
		expect(bare.filter(({ name }) => name === "@octocodeai/config").map(({ file }) => file)).toEqual([]);
	});

	it("limits Octocode integration outside the host to its MCP preset", () => {
		const packagesDir = path.resolve(packageRoot, "..");
		const others = fs
			.readdirSync(packagesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && path.join(packagesDir, entry.name) !== packageRoot);
		const offenders = others.flatMap((entry) => {
			const src = path.join(packagesDir, entry.name, "src");
			if (!fs.existsSync(src)) return [];
			return walk(src)
				.filter((file) => !file.startsWith(path.join(packagesDir, "mcp", "src", "presets", "octocode") + path.sep))
				.filter((file) =>
					/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*|import\.meta\.resolve\(\s*)['"](?:octocode|octocode-mcp|@octocodeai\/octocode-native)['"/]/.test(
						fs.readFileSync(file, "utf8"),
					),
				)
				.map((file) => path.relative(packagesDir, file));
		});
		expect(offenders).toEqual([]);
	});

	// `core` reaches `octocode` only through what the entry points pass in (the native feature set) or install as ports.
	it("keeps core free of imports from octocode", () => {
		const srcRoot = path.join(packageRoot, "src");
		const imports = walk(path.join(srcRoot, "core")).flatMap((file) =>
			[
				...fs
					.readFileSync(file, "utf8")
					.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g),
			].map((match) => ({ file, target: path.resolve(path.dirname(file), match[2]) })),
		);
		// The scan must see core's own relative imports, or an empty result below would prove nothing.
		expect(imports.length).toBeGreaterThan(100);
		const edges = imports
			.filter(({ target }) => target.startsWith(sourceRoot + path.sep))
			.map(({ file, target }) => `${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, target)}`);
		expect(edges, "src/core gained an import from src/octocode; pass the dependency in from an entry point").toEqual(
			[],
		);
	});

	// A ratchet on a known debt: the limit is the count measured on 2026-11-04 plus a small margin for work landing the same
	// day. When the count falls, lower the limit with it; raising it needs a reason in the commit. The shared host shrinks
	// through narrow per-collaborator hosts, as `core/agent-session` shows.
	it("does not grow the uses of the interactive mode's shared host (measured 2,178)", () => {
		const uses = walk(path.join(packageRoot, "src", "modes", "interactive", "interactive-mode")).reduce(
			(count, file) => count + (fs.readFileSync(file, "utf8").match(/\bhost\./g)?.length ?? 0),
			0,
		);
		expect(uses).toBeGreaterThan(0);
		expect(
			uses,
			"interactive-mode gained uses of its shared host; give the collaborator a narrow host",
		).toBeLessThanOrEqual(2_200);
	});

	it("locates its package root at any depth", () => {
		expect(getPackageDir()).toBe(packageRoot);
	});
});
