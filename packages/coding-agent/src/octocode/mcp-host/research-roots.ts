/**
 * The folders the user added for the research server's local readers, beyond the ones the host supplies itself
 * (workspace, sessions, loaded skills). Four home-level sources feed one validation: the global `settings.json`
 * `research.allowedPaths`, `ALLOWED_PATHS` in `<Octocode home>/.env`, `local.allowedPaths` in
 * `<Octocode home>/.octocoderc`, and the `ALLOWED_PATHS` of the host's process environment. Project and workspace files
 * are never read: a repository must not widen what a read-only tool may reach.
 *
 * Every entry is checked here, and only here. A rejected entry is reported by name and dropped, never widened.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getOctocodeHome } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { isUnderPath, normalizePath } from "../../../../common/src/paths.ts";
import { stripBom } from "../../../../common/src/text.ts";
import type { McpResearchRoots } from "../../../../mcp/src/host.ts";
import { sessionsRoot } from "../shared/home.ts";

/** Credential stores under the home folder: a root may not be, contain or lie inside one. */
const CREDENTIAL_STORES = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".azure", ".kube", ".docker"];

/** The realpath of `target`, or of its nearest existing ancestor with the rest appended (a folder that is not there yet). */
function realOrLoose(target: string): string {
	const missing: string[] = [];
	let current = target;
	while (true) {
		try {
			return path.join(fs.realpathSync.native(current), ...missing.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return target;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

const overlaps = (a: string, b: string): boolean => isUnderPath(a, b) || isUnderPath(b, a);

/** Why `candidate` (an existing folder, by spelling or by realpath) may not be a root; undefined when it may. */
function forbiddenReason(candidates: readonly string[], env: NodeJS.ProcessEnv, home: string): string | undefined {
	const variants = (target: string): string[] => [...new Set([path.resolve(target), realOrLoose(target)])];
	const sessions = variants(sessionsRoot(env));
	const octocodeHomes = [...new Set([getOctocodeHome(env, home), sharedHome(env, home)])];
	for (const candidate of candidates) {
		if (path.parse(candidate).root === candidate) return "is a filesystem root";
		if (variants(home).includes(candidate)) return "is your home folder";
		if (!sessions.some((root) => isUnderPath(candidate, root)))
			for (const octocodeHome of octocodeHomes.flatMap(variants))
				if (overlaps(candidate, octocodeHome))
					return `contains or lies inside the Octocode home (${octocodeHome}), which holds credentials and trust decisions`;
		for (const store of CREDENTIAL_STORES.flatMap((name) => variants(path.join(home, name))))
			if (overlaps(candidate, store)) return `contains or lies inside the credential store ${store}`;
	}
	return undefined;
}

/**
 * The folder with `.env` and `.octocoderc`: `OCTOCODE_HOME` when set, else `~/.octocode`. It is the shared Octocode
 * home that the research server reads; the host's own state folder lives inside it by default.
 */
function sharedHome(env: NodeJS.ProcessEnv, home: string): string {
	return env.OCTOCODE_HOME?.trim() ? getOctocodeHome(env, home) : path.join(home, CONFIG_DIR_NAME);
}

/** One entry's absolute realpath, or why it is dropped. */
function checked(raw: unknown, env: NodeJS.ProcessEnv, home: string): { root: string } | { problem: string } {
	if (typeof raw !== "string") return { problem: "is not text; ignored" };
	const expanded = normalizePath(raw.trim(), { homeDir: home });
	if (!path.isAbsolute(expanded))
		return { problem: "is not an absolute path; ignored. Use a full path or one that starts with ~/" };
	if (expanded.split(/[\\/]/).includes("..")) return { problem: 'contains ".."; ignored' };
	let real: string;
	try {
		real = fs.realpathSync.native(expanded);
		if (!fs.statSync(real).isDirectory()) return { problem: "is not a folder; ignored" };
	} catch {
		return { problem: "does not exist; skipped" };
	}
	const reason = forbiddenReason([...new Set([path.resolve(expanded), real])], env, home);
	return reason ? { problem: `${reason}; ignored` } : { root: real };
}

function readText(file: string): string | undefined {
	try {
		return stripBom(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** `ALLOWED_PATHS` of a dotenv file, parsed like the research server does: `KEY=VALUE`, `export` prefix, quotes stripped. */
function dotenvValue(text: string, key: string): string | undefined {
	let found: string | undefined;
	for (const line of text.split("\n")) {
		const entry = line.trim().replace(/^export\s+/, "");
		if (entry.startsWith("#") || !entry.includes("=")) continue;
		const eq = entry.indexOf("=");
		if (entry.slice(0, eq).trim() === key)
			found = entry
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
	}
	return found?.trim() ? found : undefined;
}

const commaList = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);

/** The global `settings.json` `research.allowedPaths`; the project file is never consulted, trusted or not. */
function settingsRoots(agentDir: string): unknown[] {
	try {
		const paths = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getGlobalSettings().research
			?.allowedPaths;
		return Array.isArray(paths) ? paths : [];
	} catch {
		return [];
	}
}

/** `local.allowedPaths` of the home `.octocoderc`. */
function rcRoots(file: string): unknown[] {
	const text = readText(file);
	if (text === undefined) return [];
	try {
		const paths = (JSON.parse(text) as { local?: { allowedPaths?: unknown } } | null)?.local?.allowedPaths;
		return Array.isArray(paths) ? paths : [];
	} catch {
		return [];
	}
}

/**
 * The validated extra roots, read live from the four sources: absolute realpaths, de-duplicated and sorted, with a
 * warning (naming the source) for each entry dropped. `env` is the process environment; `home` and `agentDir` only
 * move the user's folders for tests.
 */
export function userResearchRoots(
	env: NodeJS.ProcessEnv = process.env,
	home = os.homedir(),
	agentDir = getAgentDir(),
): McpResearchRoots {
	const shared = sharedHome(env, home);
	const envFile = readText(path.join(shared, ".env"));
	const sources: Array<[string, unknown[]]> = [
		[`research.allowedPaths in ${path.join(agentDir, "settings.json")}`, settingsRoots(agentDir)],
		[`ALLOWED_PATHS in ${path.join(shared, ".env")}`, commaList(envFile && dotenvValue(envFile, "ALLOWED_PATHS"))],
		[`local.allowedPaths in ${path.join(shared, ".octocoderc")}`, rcRoots(path.join(shared, ".octocoderc"))],
		["the ALLOWED_PATHS environment variable", commaList(env.ALLOWED_PATHS)],
	];
	const roots = new Set<string>();
	const warnings: string[] = [];
	for (const [source, entries] of sources)
		for (const raw of entries) {
			const result = checked(raw, env, home);
			if ("root" in result) roots.add(result.root);
			else warnings.push(`Allowed folder ${JSON.stringify(raw)} from ${source} ${result.problem}.`);
		}
	return { roots: [...roots].sort(), warnings };
}
