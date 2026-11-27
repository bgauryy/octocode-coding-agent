#!/usr/bin/env node
/**
 * Copy the native harness folder `packages/coding-agent/src/octocode/native/` to where the package or a staged binary
 * reads it (`getNativeDir` in `src/config.ts`). Prompt folders (`prompts/`, `tools/`, `hooks/`, `agents/`) ship only
 * their Markdown, without READMEs and the generated `prompts/final/`; their TypeScript is compiled into the bundle.
 * `skills/` ships whole: a skill's scripts run from there. The prompt Markdown is also packed into one file,
 * `prompts.pack.json`, which a process reads instead of each file (`readPromptSources` in `src/core/prompt-template.ts`).
 *
 * Usage: node scripts/build/copy-native.mjs <source-dir> <destination-dir>
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The folders of `native/` that hold prompt Markdown (`PROMPT_FOLDERS` in `src/core/prompt-template.ts`). */
const PROMPT_FOLDERS = ["prompts", "tools", "hooks", "agents"];
/** Copied whole. */
const WHOLE_FOLDERS = ["skills"];
/** Folders under `prompts/` written for readers, never read at runtime. */
const READER_FOLDERS = new Set(["final"]);

function shipsPrompt(root, file) {
	const [first] = relative(root, file).split(sep);
	if (READER_FOLDERS.has(first)) return false;
	return !file.endsWith(".ts") && basename(file) !== "README.md";
}

/** The pack's name (`PROMPT_PACK` in `src/core/prompt-template.ts`). */
export const PROMPT_PACK = "prompts.pack.json";

/** Every shipped prompt Markdown file under `destination`, keyed by its path there with `/` separators. */
function packPrompts(destination) {
	const pack = {};
	for (const folder of PROMPT_FOLDERS) {
		const root = join(destination, folder);
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const file = join(entry.parentPath, entry.name);
			pack[relative(destination, file).split(sep).join("/")] = readFileSync(file, "utf8");
		}
	}
	writeFileSync(join(destination, PROMPT_PACK), JSON.stringify(pack));
}

export function copyNative(source, destination) {
	if (!existsSync(source)) throw new Error(`Missing ${source}; the native folder is required.`);
	mkdirSync(destination, { recursive: true });
	for (const folder of [...PROMPT_FOLDERS, ...WHOLE_FOLDERS]) {
		const from = join(source, folder);
		// Replace the folder so a deleted file does not linger in the build.
		rmSync(join(destination, folder), { recursive: true, force: true });
		if (!existsSync(from)) continue;
		const whole = WHOLE_FOLDERS.includes(folder);
		cpSync(from, join(destination, folder), {
			recursive: true,
			dereference: true,
			filter: (file) => whole || shipsPrompt(from, file),
		});
	}
	packPrompts(destination);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, destination] = process.argv.slice(2);
	if (!source || !destination) {
		console.error("Usage: node scripts/build/copy-native.mjs <source-dir> <destination-dir>");
		process.exit(1);
	}
	copyNative(resolve(source), resolve(destination));
}
