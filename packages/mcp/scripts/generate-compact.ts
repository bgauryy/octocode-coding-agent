/**
 * `yarn workspace @octocodeai/octocode-mcp run generate:compact [--preset browser] [--accept <label>]... [--accept-all] [--drop-stale] [--check]`
 *
 * Reads the catalog the installed browser server sends now and compares it with the preset overrides in
 * `src/presets/browser/compact-overrides.json`, one override at a time. The research catalog fixtures in
 * `test/fixtures/compact/` are frozen data and are not regenerated.
 *
 * An override is keyed on the upstream text it replaces, so a rebuild of the server leaves every override whose text is
 * unchanged in force and fails open, to the server's text, for the others. This command lists those (`<tool>.<field>`
 * with the current text) and exits 1 while any remain. Read each: when the override is still true, name it with
 * `--accept <label>` (or `--accept-all`) to re-point its hash; when the upstream meaning changed, edit its `text` in the
 * JSON, then accept it. An override whose tool or field is gone is dropped. `--drop-stale` deletes every stale override
 * instead, rewriting nothing: the server's own text applies there (the default response to drift; overrides are
 * optional). `--check` changes no file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	acceptStale,
	dropStale,
	type CompactServerInput,
	parsePresetOverrides,
	type PresetOverrides,
	presetOverridesFor,
	presetStatus,
	renderServer,
	type StalePresetEntry,
} from "../src/compact/index.ts";
import { browserMcpEntry } from "../src/presets/browser/launch.ts";
import { catalogOf } from "../test/stdio-catalog.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Target {
	name: string;
	file: string;
	/** The catalogs the server sends now. */
	read: () => Promise<CompactServerInput[]>;
}

const TARGETS: Target[] = [
	{
		name: "browser",
		file: path.join(root, "src/presets/browser/compact-overrides.json"),
		read: async () => {
			const entry = browserMcpEntry();
			if (!entry) throw new Error("the browser server (@octocodeai/octocode-chrome-devtools) is not installed");
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-compact-browser-"));
			try {
				return [await catalogOf("browser", [entry], {}, cwd)];
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	},
];

function parseArgs(argv: string[]): {
	accept: Set<string>;
	acceptAll: boolean;
	dropStale: boolean;
	check: boolean;
	preset?: string;
} {
	const accept = new Set<string>();
	let acceptAll = false;
	let check = false;
	let drop = false;
	let preset: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--accept-all") acceptAll = true;
		else if (arg === "--drop-stale") drop = true;
		else if (arg === "--check") check = true;
		else if (arg === "--accept" && argv[index + 1]) accept.add(argv[++index]);
		else if (arg === "--preset" && TARGETS.some((target) => target.name === argv[index + 1])) preset = argv[++index];
		else throw new Error(`unknown argument ${arg}; see the header of scripts/generate-compact.ts`);
	}
	return { accept, acceptAll, dropStale: drop, check, preset };
}

const clip = (text: string, length = 240) => (text.length > length ? `${text.slice(0, length)}…` : text);

function report(stale: StalePresetEntry[]): void {
	for (const entry of stale) {
		console.log(
			`  ${entry.label}: ${entry.reason === "missing" ? "no longer in the server" : "upstream text changed"}`,
		);
		if (entry.reason === "changed") console.log(`    now: ${clip(entry.current.join(" | "))}`);
		console.log(`    override: ${clip(entry.override) || "(empty: the shared doc)"}`);
	}
}

function readPreset(target: Target): PresetOverrides {
	const parsed = parsePresetOverrides(JSON.parse(fs.readFileSync(target.file, "utf8")));
	if ("error" in parsed) throw new Error(`${target.file}: ${parsed.error}`);
	return parsed.overrides;
}

async function run(target: Target, options: ReturnType<typeof parseArgs>): Promise<number> {
	const catalogs = await target.read();
	let preset = readPreset(target);
	const stale = presetStatus(preset, catalogs);
	const chosen = stale.filter((entry) => options.acceptAll || options.accept.has(entry.label));
	const unknown = [...options.accept].filter((label) => !stale.some((entry) => entry.label === label));
	if (unknown.length) console.log(`  not stale, nothing to accept: ${unknown.join(", ")}`);
	console.log(`${target.name}: ${stale.length} stale override${stale.length === 1 ? "" : "s"}`);
	report(stale.filter((entry) => !chosen.includes(entry)));
	if (options.dropStale) {
		const dropped = stale.filter((entry) => !chosen.includes(entry));
		if (dropped.length) {
			console.log(`  ${options.check ? "would drop" : "dropped"}: ${dropped.map((entry) => entry.label).join(", ")}`);
			preset = dropStale(preset, dropped);
			if (!options.check) fs.writeFileSync(target.file, `${JSON.stringify(preset, null, "\t")}\n`);
		}
	}
	if (chosen.length) {
		console.log(
			`  ${options.check ? "would re-point" : "re-pointed"}: ${chosen.map((entry) => entry.label).join(", ")}`,
		);
		preset = acceptStale(preset, catalogs, chosen);
		if (!options.check) fs.writeFileSync(target.file, `${JSON.stringify(preset, null, "\t")}\n`);
	}
	for (const catalog of catalogs) {
		const overrides = presetOverridesFor(preset, catalog);
		console.log(
			`  ${target.name}: ${renderServer(catalog, overrides).length} chars with the overrides, ${renderServer(catalog).length} without`,
		);
	}
	return presetStatus(preset, catalogs).length;
}

const options = parseArgs(process.argv.slice(2));
let remaining = 0;
for (const target of TARGETS)
	if (!options.preset || target.name === options.preset) remaining += await run(target, options);
if (remaining) {
	console.log(`\n${remaining} override${remaining === 1 ? "" : "s"} still stale; they fall back to the server's text.`);
	process.exitCode = 1;
}
