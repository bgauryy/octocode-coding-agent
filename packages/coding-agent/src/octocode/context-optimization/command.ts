/**
 * `octocode context`: what agents read of skills and MCP servers, outside a session. `list` shows, for the user folder
 * and for the project of the working directory (`contextOptimizationDirs`), each skill's source and optimized
 * description and each MCP server's generated file; `check` and `apply` validate and store skill rewrites, each in the
 * store that records the skill (the project's first, as a session reads them). The `octocode-context-optimization`
 * skill drives these commands; MCP server files are rewritten with the skill's scripts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { prepareAgentDb } from "../../storage/database.ts";
import {
	generatedDir,
	readGenerated,
	withPluginServers,
	hostTrust,
	loadMcpConfig,
	presetEntries,
	browserPreset,
	recommendedPresets,
} from "../../../../mcp/src/api.ts";
import { APP_NAME } from "../../config.ts";
import { contextSizeWarnings, generatedInstructionChars } from "../../core/context-budget.ts";
import { loadProjectContextFiles } from "../../core/resource-loader/context-files.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { contextOptimizationDirs } from "../shared/home.ts";
import {
	applySkillOverrides,
	checkSkillOverrides,
	parseSkillOverrides,
	readSkillsStore,
	SKILL_DESCRIPTION_MAX_CHARS,
	type SkillsStore,
	updateSkillsStore,
} from "./skills-store.ts";

const CONTEXT_USAGE = `${APP_NAME} context list [--json]
  ${APP_NAME} context check --overrides <file>
  ${APP_NAME} context apply --overrides <file> [--optimized-by <model>]

Overrides file: { "skills": { "<skill name>": "<description agents read>" } }
Run in the project whose skills you optimize; user-level skills are shared by every project.
MCP server files: ${APP_NAME} mcp compact --help`;

/** The skills listing's share of the prompt (`formatSkillsForPrompt`), for the size line. */
const SKILLS_LISTING_BUDGET_CHARS = 8_000;

interface ContextCommandOptions {
	agentDir: string;
	cwd: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
}

/** A scope's folder and its skills store. */
interface Scope {
	name: "project" | "user";
	dir: string;
	store: SkillsStore;
}

/** The project's scope first, as sessions read them. */
function scopes(options: ContextCommandOptions): Scope[] {
	const dirs = contextOptimizationDirs(options.cwd, options.agentDir);
	return [
		...(dirs.project ? [{ name: "project" as const, dir: dirs.project.dir }] : []),
		{ name: "user" as const, dir: dirs.user },
	].map((scope) => ({ ...scope, store: readSkillsStore(scope.dir) }));
}

/** A generated file's stem for a server name (the store's own rule: characters outside `\w.-` become `_`). */
const serverStem = (name: string): string => name.replace(/[^\w.-]/g, "_");

/**
 * The stems of the servers a session here configures: defaults, every loaded MCP file and enabled plugins, read through
 * `packages/mcp`'s loader without connecting to any server.
 */
function configuredServerStems(options: ContextCommandOptions): Set<string> {
	const place = {
		agentDir: options.agentDir,
		cwd: options.cwd,
		projectTrusted: hostTrust().folderTrusted(options.cwd),
	};
	const loaded = loadMcpConfig({
		...place,
		defaults: presetEntries([...recommendedPresets(), browserPreset()]),
	});
	return new Set(withPluginServers(loaded, place).servers.map((server) => serverStem(server.name)));
}

function mcpFiles(
	dir: string,
	configured: ReadonlySet<string>,
): Array<{
	server: string;
	chars: number;
	instructionChars: number;
	optimized: boolean;
	generatedAt: string;
	stale: boolean;
}> {
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	return names.flatMap((file) => {
		const server = file.slice(0, -".json".length);
		const generated = readGenerated(dir, server);
		if (!generated) return [];
		const { overrides, generatedAt } = generated.meta;
		// No configured server has this name any more (it was removed or renamed): the record only costs store space.
		return [
			{
				server,
				chars: generated.text.length,
				instructionChars: generatedInstructionChars(generated.text),
				optimized: overrides !== undefined,
				generatedAt,
				stale: !configured.has(server),
			},
		];
	});
}

/**
 * What a session in this folder would be warned about in `/context`: a configured server whose recorded instructions,
 * or the project's context files together, pass 1% of the default window. The project's record of a server comes
 * first, as a session reads it. A folder that cannot be read warns about nothing.
 */
function sizeWarnings(options: ContextCommandOptions): string[] {
	try {
		const configured = configuredServerStems(options);
		const servers = new Map<string, number>();
		for (const scope of scopes(options)) {
			const dir = scope.name === "user" ? generatedDir(options.agentDir) : join(scope.dir, "mcp");
			for (const file of mcpFiles(dir, configured))
				if (!file.stale && !servers.has(file.server)) servers.set(file.server, file.instructionChars);
		}
		const files = loadProjectContextFiles({
			cwd: options.cwd,
			agentDir: options.agentDir,
			projectTrusted: hostTrust().folderTrusted(options.cwd),
		});
		return contextSizeWarnings({
			servers: [...servers].map(([server, chars]) => ({ server, chars })),
			contextFilesChars: files.reduce((sum, file) => sum + file.content.length, 0),
		});
	} catch {
		return [];
	}
}

function skillRows(store: SkillsStore) {
	return Object.entries(store.skills)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, entry]) => ({
			name,
			optimized: entry.description !== undefined,
			sourceChars: entry.source.length,
			chars: (entry.description ?? entry.source).length,
			file: entry.file,
			// The skill's SKILL.md is gone (the skill was removed or moved): the record only costs store space.
			stale: !existsSync(entry.file),
			source: entry.source,
			...(entry.description ? { description: entry.description } : {}),
		}));
}

function list(options: ContextCommandOptions, json: boolean, log: (line: string) => void): number {
	const configured = configuredServerStems(options);
	const rows = scopes(options).map((scope) => ({
		scope: scope.name,
		dir: scope.dir,
		skills: skillRows(scope.store),
		// The user folder's MCP files are `generatedDir`, which also moves an earlier release's folder there.
		mcp: mcpFiles(scope.name === "user" ? generatedDir(options.agentDir) : join(scope.dir, "mcp"), configured),
	}));
	if (json) {
		log(JSON.stringify({ scopes: rows }, null, 2));
		return 0;
	}
	const all = rows.flatMap((row) => row.skills);
	if (all.length === 0) log("No skills recorded yet: start a session once, and it records the skills it loads.");
	else {
		const before = all.reduce((sum, skill) => sum + skill.sourceChars, 0);
		const after = all.reduce((sum, skill) => sum + skill.chars, 0);
		log(
			`Skills: ${all.filter((skill) => skill.optimized).length}/${all.length} optimized; descriptions ${before} → ${after} characters (the listing's budget is ${SKILLS_LISTING_BUDGET_CHARS} with names and paths).`,
		);
	}
	for (const row of rows) {
		log(`\n${row.scope === "project" ? "Project" : "User"}: ${row.dir}`);
		for (const skill of row.skills)
			log(
				`  skill ${skill.name}  ${skill.optimized ? "optimized" : "source"}  ${skill.sourceChars} → ${skill.chars}${skill.stale ? "  stale (skill file no longer exists)" : ""}`,
			);
		for (const file of row.mcp)
			log(
				`  mcp ${file.server}  ${file.optimized ? "optimized" : "source"}  ${file.chars} characters${file.stale ? "  stale (no configured MCP server has this name)" : ""}`,
			);
		if (!row.skills.length && !row.mcp.length) log("  (nothing recorded)");
	}
	return 0;
}

function readOverrides(file: string): Record<string, string> {
	const parsed = parseSkillOverrides(JSON.parse(readFileSync(file, "utf8")) as unknown);
	if ("error" in parsed) throw new Error(`${file}: ${parsed.error}`);
	return parsed.overrides;
}

/** Each rewrite with the scope whose store records its skill; undefined when no store does. */
function targets(all: readonly Scope[], overrides: Record<string, string>) {
	return Object.entries(overrides).map(([name, description]) => ({
		name,
		description,
		scope: all.find((scope) => scope.store.skills[name]),
	}));
}

export async function runContextCommand(args: readonly string[], options: ContextCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [action, ...rest] = args;
	// `octocode context <action> --help` works like `octocode context --help`; a missing action is a usage error (stderr).
	if (action === "--help" || action === "-h" || action === "help" || rest.includes("--help") || rest.includes("-h")) {
		log(CONTEXT_USAGE);
		return 0;
	}
	if (!action) {
		error(CONTEXT_USAGE);
		return 1;
	}
	try {
		const { values } = parseArgs({
			args: [...rest],
			options: { json: { type: "boolean" }, overrides: { type: "string" }, "optimized-by": { type: "string" } },
			allowPositionals: false,
		});
		if (action === "list") {
			await prepareAgentDb();
			return list(options, values.json === true, log);
		}
		if (action !== "check" && action !== "apply") {
			error(`Unknown context command "${action}".\n${CONTEXT_USAGE}`);
			return 1;
		}
		if (!values.overrides) {
			error(`${action} needs --overrides <file>.\n${CONTEXT_USAGE}`);
			return 1;
		}
		const overrides = readOverrides(values.overrides);
		await prepareAgentDb();
		const all = scopes(options);
		const planned = targets(all, overrides);
		const problems: string[] = [];
		for (const { name, description, scope } of planned) {
			if (!scope) {
				problems.push(`${name}: no recorded skill has this name here; start a session in this project first`);
				continue;
			}
			problems.push(...checkSkillOverrides(scope.store, { [name]: description }));
			const source = scope.store.skills[name]?.source.length ?? 0;
			const chars = description.trim().length;
			log(`  ${scope.name} ${name}  ${source} → ${chars}${chars > source ? "  (longer than the source)" : ""}`);
		}
		// Sizes are told, never enforced: a warning is no problem and does not change the exit code.
		for (const warning of sizeWarnings(options)) log(`Warning: ${warning}`);
		if (problems.length) {
			for (const problem of problems) error(problem);
			error(
				`${problems.length} problem${problems.length === 1 ? "" : "s"}; descriptions are limited to ${SKILL_DESCRIPTION_MAX_CHARS} characters in one paragraph.`,
			);
			return 1;
		}
		if (action === "check") {
			log("0 problems.");
			return 0;
		}
		for (const scope of all) {
			const mine = Object.fromEntries(
				planned.filter((entry) => entry.scope === scope).map((entry) => [entry.name, entry.description]),
			);
			if (Object.keys(mine).length)
				await updateSkillsStore(scope.dir, (current) => {
					for (const name of Object.keys(mine))
						if (current.skills[name]?.hash !== scope.store.skills[name]?.hash)
							throw new Error(`${name}: its source changed; check the overrides again before applying.`);
					return applySkillOverrides(current, mine, values["optimized-by"]);
				});
		}
		log(
			`Applied ${planned.length} skill description${planned.length === 1 ? "" : "s"}; agents read them from the next session start or /reload.`,
		);
		return 0;
	} catch (failure) {
		error(errorMessage(failure));
		return 1;
	}
}
