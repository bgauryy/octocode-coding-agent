import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Command-line options of the model catalog generator, and the package it writes into. */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const packageRoot = join(__dirname, "../..");

function readGeneratorOptions(args: string[]): {
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
	providers: string[] | undefined;
} {
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;
	let providers: string[] | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--providers") {
			providers = args[++index]?.split(",").filter(Boolean);
			if (!providers?.length) throw new Error("--providers requires comma-separated provider IDs");
			continue;
		}
		// Kept for existing build and release commands. A partial response always fails generation.
		if (arg === "--strict") continue;
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir))
		throw new Error("--data-only cannot be combined with JSON catalog output");
	return { dataOnly, jsonOnly, jsonOutputDir, pretty, providers };
}

export const generatorOptions = readGeneratorOptions(process.argv.slice(2));

/** Full runs include every source. Scoped runs fetch only the selected providers’ dependencies. */
export function refreshesProvider(id: string): boolean {
	return !generatorOptions.providers || generatorOptions.providers.includes(id);
}
