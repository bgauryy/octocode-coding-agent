import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import ignore from "ignore";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag, EXTRA_SKILLS_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { addIgnoreRules } from "../../utils/ignore.ts";
import { collectSkillEntries, isIgnored, readDirectoryEntries } from "../package-manager/discovery.ts";
import { type ConfigRoot, configRoots, makeItem, skillName } from "./roots.ts";
import type { ConfigItem, ConfigKind, DiscoverInput, Product } from "./types.ts";

/** Helpers the vendor files (`vendors/*.ts`) compose into their sources: each takes the roots or folders of one vendor. */

/** Context files a directory may hold, in the order the first one found is used. */
export const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"];

/** The context file a directory holds, if any. */
function findContextFile(dir: string): string | undefined {
	return CONTEXT_FILE_CANDIDATES.map((name) => join(dir, name)).find((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

/** The roots of one product, in `configRoots` order. */
export const productRoots = (input: DiscoverInput, product: Product): ConfigRoot[] =>
	configRoots(input).filter((root) => root.product === product);

/** Whether project items are listed at all: a trusted folder, or `includeUntrusted` for display. */
export const listsProject = (input: DiscoverInput): boolean => input.projectTrusted || !!input.includeUntrusted;

/**
 * Skills in `dirs`, all from `root`. `skipSynced` drops a Claude folder's `synced/` subtree (claude.ai skills that need
 * connectors Octocode does not have, whose broad triggers would win over local skills), unless the folder is a skill.
 */
export function skillItemsIn(
	dirs: readonly string[],
	root: Pick<ConfigRoot, "product" | "scope" | "origin" | "vendor">,
	input: DiscoverInput,
	options: { mode?: "octocode" | "agents"; skipSynced?: boolean } = {},
): ConfigItem[] {
	return dirs.flatMap((dir) => {
		const synced = join(dir, "synced") + sep;
		return collectSkillEntries(dir, options.mode ?? "octocode")
			.filter((file) => !options.skipSynced || !file.startsWith(synced))
			.map((file) => makeItem("skill", skillName(file), root, file, input, { baseDir: dirname(dir) }));
	});
}

/** Prompts or themes in each root's `subdir`. */
export function directoryItems(
	kind: "prompt" | "theme",
	subdir: string,
	collect: (dir: string) => string[],
	name: (file: string) => string,
	roots: readonly ConfigRoot[],
	input: DiscoverInput,
): ConfigItem[] {
	return roots.flatMap((root) =>
		collect(join(root.dir, subdir)).map((file) => makeItem(kind, name(file), root, file, input, { baseDir: root.dir })),
	);
}

/**
 * Entry points of Pi's TypeScript hooks in `dir`: its top-level `*.ts` and `*.js` files and the `index.ts` or `index.js`
 * of each subfolder. Dot entries, `node_modules` and ignored paths are skipped.
 */
function piHookFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	let entries: ReturnType<typeof readDirectoryEntries>;
	try {
		entries = readDirectoryEntries(dir, dir);
	} catch {
		// A folder that cannot be read lists nothing.
		return [];
	}
	return entries.flatMap((entry) => {
		if (isIgnored(ig, entry)) return [];
		if (entry.isFile) return /\.(ts|js)$/.test(entry.name) ? [entry.fullPath] : [];
		const index = ["index.ts", "index.js"].map((name) => join(entry.fullPath, name)).find((path) => existsSync(path));
		return index ? [index] : [];
	});
}

/** Pi's hook files in `<root>/<subdir>`: listed as not loaded, because Octocode does not run Pi's TypeScript hooks. */
export function piHookItems(subdir: string, roots: readonly ConfigRoot[], input: DiscoverInput): ConfigItem[] {
	return roots.flatMap((root) =>
		piHookFiles(join(root.dir, subdir)).map((file) =>
			makeItem("hook", basename(file), root, file, input, { baseDir: root.dir, notLoaded: "ignored-code" }),
		),
	);
}

/** The global context file of each root; project context files are loaded by `loadProjectContextFiles`. */
export function contextItems(roots: readonly ConfigRoot[], input: DiscoverInput): ConfigItem[] {
	return roots.flatMap((root) => {
		const file = root.scope === "global" ? findContextFile(root.dir) : undefined;
		return file ? [makeItem("context", "global", root, file, input)] : [];
	});
}

/** `file` in each root of the given scopes, when it exists. */
export function namedFileItems(
	kind: ConfigKind,
	file: string,
	scopes: readonly string[],
	roots: readonly ConfigRoot[],
	input: DiscoverInput,
): ConfigItem[] {
	return roots.flatMap((root) => {
		const path = join(root.dir, file);
		return scopes.includes(root.scope) && existsSync(path) ? [makeItem(kind, file, root, path, input)] : [];
	});
}

/** Hook files of one dialect; every file Octocode may read is listed, whether or not it exists (`loadHooks` skips a missing one). */
export function hookFileItems(
	files: readonly string[],
	dialect: "claude" | "codex" | "octocode",
	scope: "global" | "project",
	input: DiscoverInput,
): ConfigItem[] {
	return files.map((file) =>
		makeItem("hook", basename(file), { product: "octocode", vendor: dialect, scope, origin: dialect }, file, input),
	);
}

/**
 * Whether a listed hook file defines at least one hook. Claude's `settings.json` and Codex's `config.toml` exist for other
 * settings and are not hook sources then; a file that cannot be read or parsed still counts, so its failure shows.
 */
export function definesHooks(file: string): boolean {
	if (!existsSync(file)) return false;
	try {
		const document = parseConfigDocument(readFileSync(file, "utf8"), file);
		const hooks = isRecord(document) ? document.hooks : undefined;
		return isRecord(hooks) && Object.values(hooks).some((groups) => !Array.isArray(groups) || groups.length > 0);
	} catch {
		return true;
	}
}

export const promptName = (file: string): string => basename(file).replace(/\.md$/, "");

/**
 * Skill folders outside the products' own roots (Octocode's home, Claude Code, Codex, Cursor) are read in the root
 * session only. A native subagent starts with `--no-skills` and adopts its parent's captured inventory, so it never
 * discovers them itself; `OCTOCODE_SUBAGENT=1` also keeps any other child process from doing so.
 * `OCTOCODE_EXTRA_SKILLS=0` turns them off everywhere.
 */
export function externalSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !envFlag(env, SUBAGENT_ENV) && envFlag(env, EXTRA_SKILLS_ENV, true);
}
