/**
 * `yarn workspace @octocodeai/octocode-mcp run generate:compact [--accept <label>]... [--accept-all] [--check]`
 *
 * Reads the catalogs the linked `octocode-mcp` server and the installed browser server send now (with an empty home,
 * as the drift tests read them), compares them with the preset overrides in `src/presets/*\/compact-overrides.json`
 * one override at a time, and refreshes the Octocode catalog fixtures in `test/fixtures/compact/`.
 *
 * An override is keyed on the upstream text it replaces, so a rebuild of the server leaves every override whose text is
 * unchanged in force and fails open, to the server's text, for the others. This command lists those (`<tool>.<field>`
 * with the text before and after, from the previous fixtures) and exits 1 while any remain. Read each: when the
 * override is still true, name it with `--accept <label>` (or `--accept-all`) to re-point its hash; when the upstream
 * meaning changed, edit its `text` in the JSON, then accept it. An override whose tool or field is gone is dropped.
 * `--check` changes no file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	acceptStale,
	type CompactServerInput,
	parsePresetOverrides,
	type PresetOverrides,
	presetOverridesFor,
	presetStatus,
	renderServer,
	type StalePresetEntry,
} from "../src/compact/index.ts";
import { fieldUpstreamTexts } from "../src/compact/upstream.ts";
import { octocodeShippedCatalog } from "../src/presets/octocode/compact-overrides.ts";
import { browserMcpEntry } from "../src/presets/browser/launch.ts";
import { catalogOf } from "../test/stdio-catalog.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(root, "test/fixtures/compact");

interface Target {
	name: string;
	file: string;
	/** The catalogs the server sends now, with the fixture file each is kept in (none for the browser server). */
	read: () => Promise<{ catalog: CompactServerInput; fixture?: string }[]>;
	/** A catalog as the preset's hashes describe it. */
	shipped: (input: CompactServerInput) => CompactServerInput;
}

function octocodeServer(): string {
	const manifest = createRequire(import.meta.url).resolve("octocode-mcp/package.json");
	return path.join(path.dirname(manifest), "dist", "index.js");
}

const TARGETS: Target[] = [
	{
		name: "octocode",
		file: path.join(root, "src/presets/octocode/compact-overrides.json"),
		read: async () => {
			const server = octocodeServer();
			// The server drops `clasify` and every tool's `classification` field without a classification key.
			const keyless = await catalogOf("octocode", [server], { OCTOCODE_CLASSIFICATION_API: "" });
			const keyed = await catalogOf("octocode", [server], {
				OCTOCODE_CLASSIFICATION_API: "https://example.invalid/classify",
				OCTOCODE_CLASSIFICATION_KEY: "x",
			});
			return [
				{ catalog: keyless, fixture: "octocode-catalog-nokey.json" },
				{ catalog: keyed, fixture: "octocode-catalog.json" },
			];
		},
		shipped: octocodeShippedCatalog,
	},
	{
		name: "browser",
		file: path.join(root, "src/presets/browser/compact-overrides.json"),
		read: async () => {
			const entry = browserMcpEntry();
			if (!entry) throw new Error("the browser server (@octocodeai/octocode-chrome-devtools) is not installed");
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-compact-browser-"));
			try {
				return [{ catalog: await catalogOf("browser", [entry], {}, cwd) }];
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
		shipped: (input) => input,
	},
];

function parseArgs(argv: string[]): { accept: Set<string>; acceptAll: boolean; check: boolean } {
	const accept = new Set<string>();
	let acceptAll = false;
	let check = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--accept-all") acceptAll = true;
		else if (arg === "--check") check = true;
		else if (arg === "--accept" && argv[index + 1]) accept.add(argv[++index]);
		else throw new Error(`unknown argument ${arg}; see the header of scripts/generate-compact.ts`);
	}
	return { accept, acceptAll, check };
}

const clip = (text: string, length = 240) => (text.length > length ? `${text.slice(0, length)}…` : text);

/** What the preset's override replaced at `entry` in the catalogs of the previous run, for the reader deciding. */
function before(entry: StalePresetEntry, previous: CompactServerInput[]): string[] {
	const texts = previous.flatMap((input) => {
		if (entry.kind === "server") return [input.instructions ?? ""];
		const tool = input.tools.find((candidate) => candidate.name === entry.tool);
		if (!tool) return [];
		return entry.kind === "description"
			? [tool.description ?? ""]
			: (fieldUpstreamTexts(tool).get(entry.path ?? "") ?? []);
	});
	return [...new Set(texts)].sort();
}

function report(stale: StalePresetEntry[], previous: CompactServerInput[]): void {
	for (const entry of stale) {
		console.log(
			`  ${entry.label}: ${entry.reason === "missing" ? "no longer in the server" : "upstream text changed"}`,
		);
		if (entry.reason === "changed") {
			const was = before(entry, previous);
			if (was.length) console.log(`    was: ${clip(was.join(" | "))}`);
			console.log(`    now: ${clip(entry.current.join(" | "))}`);
		}
		console.log(`    override: ${clip(entry.override) || "(empty: the shared doc)"}`);
	}
}

function readPreset(target: Target): PresetOverrides {
	const parsed = parsePresetOverrides(JSON.parse(fs.readFileSync(target.file, "utf8")));
	if ("error" in parsed) throw new Error(`${target.file}: ${parsed.error}`);
	return parsed.overrides;
}

function readFixture(name: string): CompactServerInput | undefined {
	const file = path.join(FIXTURES, name);
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as CompactServerInput) : undefined;
}

async function run(target: Target, options: ReturnType<typeof parseArgs>): Promise<number> {
	const current = await target.read();
	const catalogs = current.map(({ catalog }) => target.shipped(catalog));
	const previous = current.flatMap(({ fixture }) => {
		const found = fixture ? readFixture(fixture) : undefined;
		return found ? [target.shipped(found)] : [];
	});
	let preset = readPreset(target);
	const stale = presetStatus(preset, catalogs);
	const chosen = stale.filter((entry) => options.acceptAll || options.accept.has(entry.label));
	const unknown = [...options.accept].filter((label) => !stale.some((entry) => entry.label === label));
	if (unknown.length) console.log(`  not stale, nothing to accept: ${unknown.join(", ")}`);
	console.log(`${target.name}: ${stale.length} stale override${stale.length === 1 ? "" : "s"}`);
	report(
		stale.filter((entry) => !chosen.includes(entry)),
		previous,
	);
	if (chosen.length) {
		console.log(
			`  ${options.check ? "would re-point" : "re-pointed"}: ${chosen.map((entry) => entry.label).join(", ")}`,
		);
		preset = acceptStale(preset, catalogs, chosen);
		if (!options.check) fs.writeFileSync(target.file, `${JSON.stringify(preset, null, "\t")}\n`);
	}
	for (const { catalog, fixture } of current) {
		const shipped = target.shipped(catalog);
		const overrides = presetOverridesFor(preset, shipped);
		console.log(
			`  ${fixture ?? target.name}: ${renderServer(shipped, overrides).length} chars with the overrides, ${renderServer(shipped).length} without`,
		);
		if (fixture && !options.check)
			fs.writeFileSync(path.join(FIXTURES, fixture), `${JSON.stringify(catalog, null, 1)}\n`);
	}
	return presetStatus(preset, catalogs).length;
}

const options = parseArgs(process.argv.slice(2));
let remaining = 0;
for (const target of TARGETS) remaining += await run(target, options);
if (remaining) {
	console.log(`\n${remaining} override${remaining === 1 ? "" : "s"} still stale; they fall back to the server's text.`);
	process.exitCode = 1;
}
