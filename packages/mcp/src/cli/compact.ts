/**
 * `octocode mcp compact`: the model-facing TypeScript file of each MCP server (see `../compact`) outside a session.
 * Agents and the `octocode-context-optimization` skill use it to show a server's file, measure description overrides against the
 * source catalog, store them, print them in a preset's per-tool form, and see which stored files are stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { hostIdentity } from "../host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import {
	catalogHash,
	catalogHashes,
	checkFidelity,
	COMPACT_GENERATOR_VERSION,
	type CompactServerInput,
	type DescriptionOverrides,
	serverGeneratedDir,
	type GeneratedMeta,
	parseOverrides,
	readGenerated,
	renderServer,
	resolveServerFile,
	toolHash,
	toPresetOverrides,
	writeGenerated,
} from "../compact/index.ts";
import type { LoadedMcpConfig, McpServerEntry } from "../config.ts";
import type { McpOAuthCredentialStore } from "../oauth.ts";
import { findMcpPreset } from "../preset.ts";
import { isEnabled } from "../server.ts";
import { readCatalogFile, readLiveCatalog } from "./compact-catalog.ts";
import { sizeReport } from "./compact-report.ts";
import { helpHint, type McpCommandOptions, parseOptions } from "./shared.ts";

export const compactUsage =
	(): string => `${hostIdentity().appName} mcp compact show <server> [--catalog <file>] [--plain] [--refresh]
  ${hostIdentity().appName} mcp compact catalog <server> [--catalog <file>] [--out <file>]
  ${hostIdentity().appName} mcp compact check <server> --overrides <file> [--catalog <file>]
  ${hostIdentity().appName} mcp compact apply <server> --overrides <file> [--optimized-by <model>] [--catalog <file>]
  ${hostIdentity().appName} mcp compact preset <server> --overrides <file> [--catalog <file>]
  ${hostIdentity().appName} mcp compact list [--offline] [--json]`;

interface CompactContext {
	loaded: LoadedMcpConfig;
	options: McpCommandOptions;
	credentials: McpOAuthCredentialStore;
	log: (line: string) => void;
	error: (line: string) => void;
	/** Why configured servers are missing (an untrusted or changed project config), for `list` to say. */
	note?: string;
}

const SOURCE_FLAGS = { catalog: "value" } as const;

/** The folder of a server's generated file, as a session in `cwd` uses it (`serverGeneratedDir`). */
function dirOf(context: CompactContext, server: string): string {
	const scope = context.loaded.servers.find((candidate) => candidate.name === server)?.scope;
	return serverGeneratedDir(context.options.agentDir, context.options.cwd, scope);
}

function findEntry(context: CompactContext, server: string): McpServerEntry | undefined {
	const entry = context.loaded.servers.find((candidate) => candidate.name === server);
	if (!entry) context.error(`No MCP server named "${server}".`);
	return entry;
}

/** The catalog from `--catalog`, else the live server. Reports the failure and returns undefined. */
async function catalogOf(
	context: CompactContext,
	server: string,
	file: string | true | undefined,
): Promise<CompactServerInput | undefined> {
	try {
		if (typeof file === "string") return readCatalogFile(file, server);
		const entry = findEntry(context, server);
		if (!entry) return undefined;
		if (!isEnabled({ entry }))
			throw new Error(`MCP server "${server}" is disabled. Pass --catalog <file> to use a saved catalog.`);
		return await readLiveCatalog(entry, context.options, context.credentials);
	} catch (error) {
		context.error(errorMessage(error));
		return undefined;
	}
}

function overridesOf(context: CompactContext, file: string | true | undefined): DescriptionOverrides | undefined {
	if (typeof file !== "string") {
		context.error(`--overrides <file> is required (use {} for none).\n${helpHint()}`);
		return undefined;
	}
	try {
		const parsed = parseOverrides(JSON.parse(readFileSync(file, "utf8")));
		if ("error" in parsed) context.error(`${file}: ${parsed.error}`);
		else return parsed.overrides;
	} catch (error) {
		context.error(`${file}: ${errorMessage(error)}`);
	}
	return undefined;
}

async function show(context: CompactContext, args: string[]): Promise<number> {
	const parsed = parseOptions(args, { ...SOURCE_FLAGS, plain: "flag", refresh: "flag" }, context.error);
	if (!parsed) return 1;
	const [server, ...extra] = parsed.positional;
	if (!server || extra.length) return usage(context);
	const dir = dirOf(context, server);
	const stored = readGenerated(dir, server);
	const plain = parsed.values.has("plain");
	const fresh = plain || parsed.values.has("refresh") || parsed.values.has("catalog");
	if (stored && !fresh) {
		context.log(stored.text.trimEnd());
		return 0;
	}
	const input = await catalogOf(context, server, parsed.values.get("catalog"));
	if (!input) return 1;
	if (plain) {
		context.log(renderServer(input).trimEnd());
		return 0;
	}
	// What the next session renders: the stored file for this catalog, else a render with the overrides that still
	// describe it (the stored ones over the preset's).
	const file = resolveServerFile(dir, server, input, {
		preset: findMcpPreset(context.options.presets, server)?.compactOverrides?.(input),
		refresh: parsed.values.has("refresh"),
		onWriteError: (error) => context.error(`Could not store the file: ${errorMessage(error)}`),
	});
	context.log(file.text.trimEnd());
	return 0;
}

async function catalog(context: CompactContext, args: string[]): Promise<number> {
	const parsed = parseOptions(args, { ...SOURCE_FLAGS, out: "value" }, context.error);
	if (!parsed) return 1;
	const [server, ...extra] = parsed.positional;
	if (!server || extra.length) return usage(context);
	const input = await catalogOf(context, server, parsed.values.get("catalog"));
	if (!input) return 1;
	// The server name in a session's input is its call name; the file carries only what `--catalog` needs.
	const { instructions, tools } = input;
	const json = `${JSON.stringify({ ...(instructions ? { instructions } : {}), tools }, null, 2)}\n`;
	const out = parsed.values.get("out");
	if (typeof out === "string") {
		writeFileSync(out, json);
		context.log(`${server}: ${tools.length} tools, catalog ${catalogHash(input)}, written to ${out}`);
	} else context.log(json.trimEnd());
	return 0;
}

/** Fidelity problems of the overrides against the catalog, with the size report; undefined when the input fails. */
async function measure(context: CompactContext, args: string[], allowed: Record<string, "value" | "flag">) {
	const parsed = parseOptions(args, { ...SOURCE_FLAGS, overrides: "value", ...allowed }, context.error);
	if (!parsed) return undefined;
	const [server, ...extra] = parsed.positional;
	if (!server || extra.length) {
		usage(context);
		return undefined;
	}
	const overrides = overridesOf(context, parsed.values.get("overrides"));
	if (!overrides) return undefined;
	const input = await catalogOf(context, server, parsed.values.get("catalog"));
	if (!input) return undefined;
	const text = renderServer(input, overrides);
	return { parsed, server, input, overrides, text, result: checkFidelity(input, text, overrides) };
}

function printProblems(context: CompactContext, problems: readonly string[]): void {
	context.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
	for (const problem of problems) context.log(`- ${problem}`);
}

async function check(context: CompactContext, args: string[]): Promise<number> {
	const measured = await measure(context, args, {});
	if (!measured) return 1;
	const { input, overrides, text, result } = measured;
	context.log(sizeReport(input, overrides, renderServer(input), text));
	if (!result.ok) {
		printProblems(context, result.problems);
		return 1;
	}
	context.log(`\nfidelity check passed; catalog ${catalogHash(input)}`);
	return 0;
}

async function apply(context: CompactContext, args: string[]): Promise<number> {
	const measured = await measure(context, args, { "optimized-by": "value" });
	if (!measured) return 1;
	const { parsed, server, input, overrides, text, result } = measured;
	if (!result.ok) {
		context.error(`Not applied; the fidelity check failed:\n- ${result.problems.join("\n- ")}`);
		return 1;
	}
	const model = parsed.values.get("optimized-by");
	const dir = dirOf(context, server);
	try {
		writeGenerated(dir, server, text, {
			...catalogHashes(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			overrides,
			...(typeof model === "string" ? { optimizedBy: { model, at: new Date().toISOString() } } : {}),
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		context.error(`Could not store the file: ${errorMessage(error)}`);
		return 1;
	}
	context.log(`Stored ${dir}/${server}.txt (${text.length} chars) for catalog ${catalogHash(input).slice(0, 12)}.`);
	context.log("Running sessions keep the previous file; a new session or loadout rebuild picks this one up.");
	return 0;
}

/** The overrides in the preset form (`McpServerPreset.compactOverrides`), each tool's entries with its hash. */
async function preset(context: CompactContext, args: string[]): Promise<number> {
	const measured = await measure(context, args, {});
	if (!measured) return 1;
	const { input, overrides, result } = measured;
	if (!result.ok) {
		context.error(`The fidelity check failed:\n- ${result.problems.join("\n- ")}`);
		return 1;
	}
	context.log(JSON.stringify(toPresetOverrides(overrides, input), null, "\t"));
	return 0;
}

/** Tools whose stored overrides no longer describe the live tool: changed or gone. */
function staleTools(meta: GeneratedMeta, live: CompactServerInput): string[] {
	const overridden = new Set(
		[meta.overrides?.tools, meta.overrides?.triggers, meta.overrides?.fields].flatMap((entries) =>
			Object.keys(entries ?? {}),
		),
	);
	const current = new Map(live.tools.map((tool) => [tool.name, toolHash(tool)]));
	return [...overridden].filter((tool) => meta.toolHashes?.[tool] !== current.get(tool)).sort();
}

interface ListRow {
	server: string;
	configured: boolean;
	hash?: string;
	overrides?: boolean;
	optimizedBy?: string;
	/** Whether the stored file differs from the server's live catalog; undefined when not checked or unreachable. */
	stale?: boolean;
	/** Tools whose overrides no longer describe the live tool; a session renders them from the server's text. */
	staleTools?: string[];
	note?: string;
}

async function list(context: CompactContext, args: string[]): Promise<number> {
	const parsed = parseOptions(args, { offline: "flag", json: "flag" }, context.error);
	if (!parsed) return 1;
	if (parsed.positional.length) return usage(context);
	const offline = parsed.values.has("offline");
	const rows = await Promise.all(
		context.loaded.servers.map(async (entry): Promise<ListRow> => {
			const stored = readGenerated(dirOf(context, entry.name), entry.name);
			const row: ListRow = {
				server: entry.name,
				configured: true,
				...(stored
					? {
							hash: stored.meta.hash.slice(0, 12),
							overrides: stored.meta.overrides !== undefined,
							...(stored.meta.optimizedBy ? { optimizedBy: stored.meta.optimizedBy.model } : {}),
						}
					: {}),
			};
			if (offline || !isEnabled({ entry })) return row;
			try {
				const input = await readLiveCatalog(entry, context.options, context.credentials);
				const live = catalogHash(input);
				row.stale = stored
					? stored.meta.hash !== live || stored.meta.generatorVersion !== COMPACT_GENERATOR_VERSION
					: undefined;
				const stale = stored ? staleTools(stored.meta, input) : [];
				if (stale.length) row.staleTools = stale;
				if (!stored) row.note = `no file; live catalog ${live.slice(0, 12)}`;
			} catch (error) {
				row.note = errorMessage(error).split("\n")[0];
			}
			return row;
		}),
	);
	if (context.note) context.error(context.note);
	if (parsed.values.has("json")) {
		context.log(JSON.stringify({ servers: rows }, null, 2));
		return 0;
	}
	if (rows.length === 0) context.log("No MCP servers configured.");
	for (const row of rows) {
		const state = row.stale === undefined ? "unknown" : row.stale ? "yes" : "no";
		context.log(
			[
				row.server,
				row.hash ?? "no file",
				`overrides: ${row.overrides === undefined ? "-" : row.overrides ? "yes" : "no"}`,
				`stale: ${state}`,
				...(row.staleTools ? [`stale overrides: ${row.staleTools.join(", ")}`] : []),
				...(row.optimizedBy ? [`optimized by ${row.optimizedBy}`] : []),
				...(row.note ? [`(${row.note})`] : []),
			].join("  "),
		);
	}
	return 0;
}

function usage(context: CompactContext): number {
	context.error(`Usage: ${compactUsage()}`);
	return 1;
}

/** Run `octocode mcp compact <args>` and return the exit code. */
export async function compact(
	args: string[],
	loaded: LoadedMcpConfig,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
	error: (line: string) => void,
	note?: string,
): Promise<number> {
	const context: CompactContext = { loaded, options, credentials, log, error, ...(note ? { note } : {}) };
	const [action, ...rest] = args;
	switch (action) {
		case "show":
			return show(context, rest);
		case "catalog":
			return catalog(context, rest);
		case "check":
			return check(context, rest);
		case "apply":
			return apply(context, rest);
		case "preset":
			return preset(context, rest);
		case "list":
			return list(context, rest);
		default:
			return usage(context);
	}
}
