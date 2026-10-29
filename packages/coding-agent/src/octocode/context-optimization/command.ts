/**
 * `octocode context`: what agents read of skills and MCP servers, outside a session. `list` shows, for the user folder
 * and for the project of the working directory (`contextOptimizationDirs`), each skill's source and optimized
 * description and each MCP server's generated file; `check` and `apply` validate and store skill rewrites, each in the
 * store that records the skill (the project's first, as a session reads them). The `octocode-context-optimization`
 * skill drives these commands; MCP servers keep `octocode mcp compact`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generatedDir, readGenerated } from "../../../../mcp/src/compact/index.ts";
import { APP_NAME } from "../../config.ts";
import { errorMessage } from "../../utils/guards.ts";
import { contextOptimizationDirs } from "../shared/home.ts";
import {
	applySkillOverrides,
	checkSkillOverrides,
	parseSkillOverrides,
	readSkillsStore,
	SKILL_DESCRIPTION_MAX_CHARS,
	type SkillsStore,
	writeSkillsStore,
} from "./skills-store.ts";

export const CONTEXT_USAGE = `${APP_NAME} context list [--json]
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

function mcpFiles(dir: string): Array<{ server: string; chars: number; optimized: boolean; generatedAt: string }> {
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
		return [{ server, chars: generated.text.length, optimized: overrides !== undefined, generatedAt }];
	});
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
			source: entry.source,
			...(entry.description ? { description: entry.description } : {}),
		}));
}

function list(options: ContextCommandOptions, json: boolean, log: (line: string) => void): number {
	const rows = scopes(options).map((scope) => ({
		scope: scope.name,
		dir: scope.dir,
		skills: skillRows(scope.store),
		// The user folder's MCP files are `generatedDir`, which also moves an earlier release's folder there.
		mcp: mcpFiles(scope.name === "user" ? generatedDir(options.agentDir) : join(scope.dir, "mcp")),
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
			log(`  skill ${skill.name}  ${skill.optimized ? "optimized" : "source"}  ${skill.sourceChars} → ${skill.chars}`);
		for (const file of row.mcp)
			log(`  mcp ${file.server}  ${file.optimized ? "optimized" : "source"}  ${file.chars} characters`);
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
	if (!action || action === "--help" || action === "-h" || action === "help") {
		log(CONTEXT_USAGE);
		return action ? 0 : 1;
	}
	try {
		const { values } = parseArgs({
			args: [...rest],
			options: { json: { type: "boolean" }, overrides: { type: "string" }, "optimized-by": { type: "string" } },
			allowPositionals: false,
		});
		if (action === "list") return list(options, values.json === true, log);
		if (action !== "check" && action !== "apply") {
			error(`Unknown context command "${action}".\n${CONTEXT_USAGE}`);
			return 1;
		}
		if (!values.overrides) {
			error(`${action} needs --overrides <file>.\n${CONTEXT_USAGE}`);
			return 1;
		}
		const all = scopes(options);
		const planned = targets(all, readOverrides(values.overrides));
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
				writeSkillsStore(scope.dir, applySkillOverrides(scope.store, mine, values["optimized-by"]));
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
