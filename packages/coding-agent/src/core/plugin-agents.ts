import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { isPluginIdentifier, type PluginManifest, resolvePluginPath } from "./plugin-manifest.ts";

/** An agent file a plugin ships. `folders` are the subfolders of `agents/` it sits in; they are part of its name. */
export interface PluginAgentFile {
	file: string;
	folders: string[];
}

/** One plugin agent: its scoped name (`<plugin>:<agent>`) and file. */
export interface PluginAgent {
	name: string;
	file: string;
}

const MAX_NAME = 256;

/**
 * The default scan: every `.md` file under the plugin's `agents/`, recursively. A symlink must stay inside the plugin and a
 * directory cycle is an error, as for skills.
 */
export function scanPluginAgents(manifest: PluginManifest, errors: string[]): PluginAgentFile[] {
	const files: PluginAgentFile[] = [];
	try {
		lstatSync(path.resolve(manifest.root, "agents"));
	} catch {
		return files;
	}
	const walk = (relative: string, folders: string[], seen: Set<string>): void => {
		let real: string;
		try {
			real = resolvePluginPath(manifest.root, relative);
			if (seen.has(real)) throw new Error(`Plugin agent directory cycle: ${relative}`);
			seen.add(real);
			for (const entry of readdirSync(real).sort()) {
				const child = `${relative}/${entry}`;
				const target = resolvePluginPath(manifest.root, child);
				const stat = lstatSync(target);
				if (stat.isDirectory()) walk(child, [...folders, entry], seen);
				else if (stat.isFile() && entry.endsWith(".md")) files.push({ file: target, folders });
			}
			seen.delete(real);
		} catch (cause) {
			errors.push(`${manifest.name}: agents: ${String(cause)}`);
		}
	};
	walk("./agents", [], new Set());
	return files;
}

/** Whether a frontmatter `name` can be the last part of a scoped name; otherwise the file name is used (as Claude does for a name over 256 characters). */
const usableName = (value: unknown): value is string =>
	typeof value === "string" &&
	value.trim().length > 0 &&
	value.trim().length <= MAX_NAME &&
	isPluginIdentifier(value.trim());

/**
 * The scoped name: the plugin name, each subfolder of `agents/` and the agent joined with colons, where the agent is the
 * frontmatter `name` or else the file name without `.md`. Files listed in the manifest `agents` key carry no subfolders.
 * Claude documents the same rule: `agents/review/security.md` in `my-plugin` is `my-plugin:review:security`, and
 * `name: audit` in that file makes it `my-plugin:review:audit`. Throws when a folder or file name cannot be a name part.
 */
export function pluginAgentName(plugin: string, agent: PluginAgentFile, frontmatterName?: unknown): string {
	const leaf = usableName(frontmatterName) ? frontmatterName.trim() : path.basename(agent.file, ".md");
	const parts = [...agent.folders, leaf];
	for (const part of parts)
		if (!isPluginIdentifier(part) || part.length > MAX_NAME)
			throw new Error(
				`agent name part "${part}" must be non-empty, without spaces, colons, slashes or control characters`,
			);
	return [plugin, ...parts].join(":");
}

/**
 * The agents of a plugin with their scoped names. A frontmatter that does not parse still names the agent after its file (the
 * profile loader then reports the parse failure). A repeated name keeps the first file and reports the rest.
 */
export function pluginAgents(
	manifest: PluginManifest,
	files: readonly PluginAgentFile[],
): { agents: PluginAgent[]; errors: string[] } {
	const agents: PluginAgent[] = [];
	const errors: string[] = [];
	const names = new Map<string, string>();
	for (const agent of files) {
		try {
			let declared: unknown;
			try {
				declared = parseFrontmatter(readFileSync(agent.file, "utf8")).frontmatter.name;
			} catch {
				declared = undefined;
			}
			const name = pluginAgentName(manifest.name, agent, declared);
			const first = names.get(name);
			if (first) {
				errors.push(
					`${manifest.name}: agents: ${name} is defined by ${first} and ${agent.file}; the second is skipped`,
				);
				continue;
			}
			names.set(name, agent.file);
			agents.push({ name, file: agent.file });
		} catch (cause) {
			errors.push(`${manifest.name}: agents: ${agent.file}: ${errorMessage(cause)}`);
		}
	}
	return { agents, errors };
}
