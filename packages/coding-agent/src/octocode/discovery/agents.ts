import fs from "node:fs";
import path from "node:path";
import { getSubagentsDir } from "../../config.ts";
import { type ConfigRoot, makeItem } from "../../core/discovery/roots.ts";
import { insideProject } from "../../core/extensibility/toggles.ts";
import { translateAgentFields } from "../../core/plugin-agent-fields.ts";
import { loadConfiguredPluginAgents } from "../../core/plugin-resources.ts";
import type { ConfigItem, DiscoverInput } from "../../core/discovery/types.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { globalPaths, projectAgentDirs } from "../shared/home.ts";

const PROJECT: Pick<ConfigRoot, "product" | "scope" | "origin"> = {
	product: "octocode",
	scope: "project",
	origin: "octocode",
};

/** What a profile file answers to: the `name` in its front matter, else its file name without `.md`. */
function profileName(file: string): string {
	try {
		const { frontmatter } = parseFrontmatter<{ name?: unknown }>(fs.readFileSync(file, "utf8"));
		if (typeof frontmatter.name === "string" && frontmatter.name.trim()) return frontmatter.name.trim();
	} catch {
		// An unreadable file keeps its file name; the profile loader reports the failure.
	}
	return path.basename(file, ".md");
}

/**
 * Subagent profiles: the roles bundled with this build, the Octocode home's `agents/`, and the project's `.octocode/agents/`
 * of a trusted folder. Pi has no profile format, so no Pi folder is read. Items come highest-precedence first, a later file
 * of a folder before an earlier one, so the loader (which reads them in reverse) keeps its load order and "later wins".
 * The agents of the enabled Claude plugins in `input.plugins` come last, named `<plugin>:<agent>` with origin `plugin:<name>`:
 * they rank below every other profile (`core/discovery/precedence.ts`), so a plugin never replaces a profile.
 */
export function agentItems(input: DiscoverInput): ConfigItem[] {
	const env = input.env ?? process.env;
	const folders: { dir: string; root: Pick<ConfigRoot, "product" | "scope" | "origin"> }[] = [
		{ dir: getSubagentsDir(), root: { product: "octocode", scope: "builtin", origin: "bundled" } },
		{ dir: globalPaths(env, input.home).agents, root: { product: "octocode", scope: "global", origin: "octocode" } },
		...(input.projectTrusted || input.includeUntrusted
			? projectAgentDirs(input.cwd).map((dir) => ({ dir, root: { ...PROJECT } }))
			: []),
	];
	const items: ConfigItem[] = [];
	for (const { dir, root } of new Map(folders.map((folder) => [folder.dir, folder])).values()) {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) {
			const full = path.join(dir, file);
			items.push(makeItem("agent", profileName(full), root, full, input, { baseDir: dir }));
		}
	}
	return [...items.reverse(), ...pluginAgentItems(input)];
}

/** The plugin agents, each with a diagnostic naming the frontmatter it does not support (the profile loader ignores it too). */
function pluginAgentItems(input: DiscoverInput): ConfigItem[] {
	return loadConfiguredPluginAgents(input.plugins).agents.map((agent) => {
		const root = {
			product: "octocode" as const,
			scope: insideProject(agent.root, input.cwd) ? ("project" as const) : ("global" as const),
			origin: `plugin:${agent.plugin}`,
		};
		const item = makeItem("agent", agent.name, root, agent.file, input, { baseDir: agent.root });
		try {
			const { unsupported } = translateAgentFields(parseFrontmatter(fs.readFileSync(agent.file, "utf8")).frontmatter);
			if (unsupported.length > 0) item.diagnostics.push(`unsupported frontmatter ignored: ${unsupported.join(", ")}`);
		} catch {
			// An unreadable or unparsable file is reported by the profile loader.
		}
		return item;
	});
}
