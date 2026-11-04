#!/usr/bin/env node
/**
 * Copy the Markdown prompt tree of `packages/coding-agent/src/octocode/instructions/` (policy, lean, subagent, system,
 * workflows and roles) to where the package or a staged binary reads it (`getInstructionsDir` in `src/config.ts`).
 * Only the prompt files ship: the folder's TypeScript is compiled separately and `README.md` is for readers.
 *
 * Usage: node scripts/copy-instructions.mjs <source-dir> <destination-dir>
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The prompt folders under `source`: every directory. */
function instructionFolders(source) {
	return readdirSync(source, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

export function copyInstructions(source, destination) {
	if (!existsSync(source)) throw new Error(`Missing ${source}; the instructions folder is required.`);
	mkdirSync(destination, { recursive: true });
	for (const folder of instructionFolders(source)) {
		// Replace the folder so a deleted prompt file does not linger in the build.
		rmSync(join(destination, folder), { recursive: true, force: true });
		cpSync(join(source, folder), join(destination, folder), {
			recursive: true,
			dereference: true,
			filter: (file) => !file.endsWith(".ts"),
		});
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, destination] = process.argv.slice(2);
	if (!source || !destination) {
		console.error("Usage: node scripts/copy-instructions.mjs <source-dir> <destination-dir>");
		process.exit(1);
	}
	copyInstructions(resolve(source), resolve(destination));
}
