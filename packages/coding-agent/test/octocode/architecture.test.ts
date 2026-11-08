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
const domainOf = (file: string): string => {
	const [first] = path.relative(sourceRoot, file).split(path.sep);
	return first.endsWith(".ts") ? "(root)" : first;
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
 * The layering: each domain may depend only on the domains listed. `shared` is the leaf within `octocode/` (it still
 * uses host modules under `core/` and `modes/`); the root modules (`index.ts` wires everything) may use any domain.
 */
const ALLOWED: Record<string, string[]> = {
	shared: [],
	"mcp-host": ["shared", "skill", "trust", "web"],
	llama: ["shared"],
	api: ["shared"],
	// `worktrees`: a worktree session's message to its coordinator looks up the repository's main checkout.
	external: ["shared", "api", "worktrees", "ask"],
	ask: ["shared"],
	// `cli`: the bash guide names the research CLI only when its shim is installed. `ask`: the file review is an approval question.
	files: ["shared", "permission", "cli", "ask"],
	team: ["shared"],
	discovery: ["shared"],
	hooks: ["shared", "discovery"],
	plugins: ["shared", "hooks", "discovery"],
	// `/harness` folds in what plugins, hooks and discovery used to expose as their own commands.
	harness: ["shared", "plugins", "hooks", "discovery", "skill"],
	web: ["shared", "permission"],
	// `sessions`: the summary's live state names the background work with the reader the reorient brief uses (`compaction/live-state.ts`).
	compaction: ["shared", "files", "permission", "archive", "sessions"],
	// The archive tool's profile source reads a stored session through the profiler.
	archive: ["shared", "memory", "permission", "profiler"],
	ui: ["shared", "permission"],
	subagents: ["shared", "discovery", "team", "permission", "instructions", "backlog", "trust", "worktrees", "ask"],
	instructions: ["shared"],
	sessions: ["shared", "files", "subagents", "backlog", "archive"],
	backlog: ["shared"],
	trust: ["shared"],
	// Rebuilds a stored session's profiler source from the team's message model.
	profiler: ["team"],
	workspace: ["shared", "backlog", "team", "subagents", "profiler"],
	"web-daemon": ["shared", "backlog", "workspace", "trust", "profiler"],
	remote: ["shared", "web-daemon", "workspace"],
	memory: ["shared", "permission"],
	plan: ["shared"],
	// Every question to a person goes through `ask/` (one Question type); permission, external and subagents ask there.
	permission: ["shared", "plan", "ask"],
	skill: ["shared"],
	"context-optimization": ["shared"],
	// `/optimize`: its helper call is the small-tier route `subagents/` owns.
	"prompt-optimization": ["shared", "subagents"],
	// `/processes`, process titles and memory samples: process helpers from `shared`, agent-id variables from `team`.
	processes: ["shared", "team"],
	"native-skills": [],
	"terminal-launch": [],
	worktrees: ["shared", "terminal-launch", "trust"],
	// An until-command runs on the bash foreground path (`files`) after the plan-mode and read-only-role checks a bash call meets.
	timer: ["shared", "files", "permission", "plan"],
	// `/octocode` and the agent-shell shim for the research CLI.
	cli: ["shared"],
};

describe("source layout", () => {
	it("requires an explicit dependency policy for every source domain", () => {
		const folders = fs
			.readdirSync(sourceRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
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
			[/createHash\(['"]sha256['"]\)/, "../../common/src/atomic-file.ts"],
			[/env\[[^\]]+\](?:\?\.trim\(\))? === '1'/, "../../common/src/env.ts"],
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

	// Ratchets on two known debts. Each limit is the count measured on 2026-11-04 plus a small margin for work landing the
	// same day. When a count falls, lower its limit with it; raising one needs a reason in the commit. Nothing here asks for
	// a refactor: `core` depending on `octocode` shrinks through ports, as `packages/acp` and `packages/mcp` show, and the
	// interactive mode's shared host through narrow per-collaborator hosts, as `core/agent-session` shows.
	it("does not grow the imports from core into octocode (measured 22)", () => {
		const srcRoot = path.join(packageRoot, "src");
		const edges = walk(path.join(srcRoot, "core")).flatMap((file) =>
			[
				...fs
					.readFileSync(file, "utf8")
					.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g),
			]
				.map((match) => path.resolve(path.dirname(file), match[2]))
				.filter((target) => target.startsWith(sourceRoot + path.sep)),
		);
		expect(edges.length).toBeGreaterThan(0);
		expect(
			edges.length,
			"src/core gained an import from src/octocode; pass the dependency through a port",
		).toBeLessThanOrEqual(25);
	});

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
