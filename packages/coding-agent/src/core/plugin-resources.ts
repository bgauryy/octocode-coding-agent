import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { discoverPluginComponents } from "./plugin-components.ts";
import { type PluginAgent, pluginAgents } from "./plugin-agents.ts";
import {
	isPluginIdentifier,
	resolveConfiguredPlugin,
	resolvePluginPath,
	type PluginManifest,
} from "./plugin-manifest.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { claudeArgumentNames } from "./claude-arguments.ts";
import { parsePromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { pluginContext } from "./plugin-context.ts";
import { configuredPlugins } from "./plugin-settings.ts";
import type { Settings } from "./settings-manager.ts";
import { loadSkillsFromDir, type LoadSkillsResult } from "./skills.ts";

function checkTree(root: string, directory: string, seen = new Set<string>()): void {
	const real = resolvePluginPath(root, `./${path.relative(root, directory).split(path.sep).join("/")}`);
	if (!statSync(real).isDirectory()) return;
	if (seen.has(real)) throw new Error(`Plugin skill directory cycle: ${directory}`);
	seen.add(real);
	for (const entry of readdirSync(real)) checkTree(root, path.join(real, entry), seen);
	seen.delete(real);
}

function configuredComponents(
	entries: Settings["plugins"],
	diagnostics: ResourceDiagnostic[],
	reportUnsupported = false,
): {
	manifest: PluginManifest;
	components: ReturnType<typeof discoverPluginComponents>;
}[] {
	const result: {
		manifest: PluginManifest;
		components: ReturnType<typeof discoverPluginComponents>;
	}[] = [];
	const seen = new Set<string>();
	for (const entry of configuredPlugins(entries, (message) =>
		diagnostics.push({ type: "error", path: "settings.plugins", message }),
	)) {
		if (entry.enabled === false) continue;
		const error = (message: string) => diagnostics.push({ type: "error", path: entry.path, message });
		try {
			const { manifest, errors, failure } = resolveConfiguredPlugin(entry);
			for (const message of errors) error(message);
			if (!manifest) {
				error(failure ?? "No valid plugin manifest found");
				continue;
			}
			const identity = `${manifest.protocol}:${manifest.root}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			const components = discoverPluginComponents(manifest);
			for (const message of components.errors) error(message);
			if (reportUnsupported && components.unsupported.length)
				diagnostics.push({
					type: "warning",
					path: manifest.root,
					message: `${manifest.name}: not loaded by Octocode yet: ${components.unsupported.join(", ")}`,
				});
			result.push({ manifest, components });
		} catch (cause) {
			error(String(cause));
		}
	}
	return result;
}

/** Activate instruction resources only; plugin code never enters the feature loader here. */
export function loadConfiguredPluginSkills(entries: Settings["plugins"]): LoadSkillsResult {
	const result: LoadSkillsResult = {
		skills: [],
		diagnostics: [],
		explicitSkills: [],
	};
	const names = new Set<string>();
	// Skills load first, so this loader reports the components no owner loads (once per plugin).
	for (const { manifest, components } of configuredComponents(entries, result.diagnostics, true)) {
		const error = (message: string) => result.diagnostics.push({ type: "error", path: manifest.root, message });
		try {
			for (const directory of components.skills) checkTree(manifest.root, directory);
			const files = new Set<string>();
			for (const directory of components.skills) {
				const loaded = loadSkillsFromDir({
					dir: directory,
					source: `plugin:${manifest.protocol}:${manifest.name}`,
					protocol: manifest.protocol,
				});
				result.diagnostics.push(...loaded.diagnostics);
				for (const skill of loaded.skills) {
					const file = resolvePluginPath(
						manifest.root,
						`./${path.relative(manifest.root, skill.filePath).split(path.sep).join("/")}`,
					);
					if (files.has(file)) continue;
					files.add(file);
					const name = `${manifest.name}:${skill.name}`;
					const registered = {
						...skill,
						name,
						...(manifest.protocol === "claude"
							? {
									claudePluginRoot: manifest.root,
									claudePluginData: pluginContext(manifest).data,
								}
							: {}),
						sourceInfo: {
							...skill.sourceInfo,
							source: `plugin:${manifest.protocol}:${manifest.name}`,
							origin: "package" as const,
							baseDir: manifest.root,
						},
					};
					const discovered = loaded.explicitSkills?.find((candidate) => candidate.skill === skill);
					if (manifest.protocol === "codex" && discovered)
						result.explicitSkills!.push({
							...discovered,
							skill: registered,
							name,
							...(manifest.format === "portable" ? { promptByteLimit: 8000 } : {}),
						});
					if (names.has(name)) {
						error(`Duplicate plugin skill name: ${name}; later definition skipped`);
						continue;
					}
					names.add(name);
					result.skills.push(registered);
				}
			}
		} catch (cause) {
			error(String(cause));
		}
	}
	return result;
}

/** A plugin agent with the plugin that ships it. */
export interface ConfiguredPluginAgent extends PluginAgent {
	plugin: string;
	root: string;
}

/**
 * The Claude plugin agents of the enabled `entries`, named `<plugin>:<agent>`. Only names and files: the subagent profile
 * loader reads and translates them (`octocode/subagents/profiles.ts`), and reports what it does not support.
 */
export function loadConfiguredPluginAgents(entries: Settings["plugins"]): {
	agents: ConfiguredPluginAgent[];
	diagnostics: ResourceDiagnostic[];
} {
	const result: { agents: ConfiguredPluginAgent[]; diagnostics: ResourceDiagnostic[] } = {
		agents: [],
		diagnostics: [],
	};
	// Other loaders report a plugin's manifest and non-agent component errors; this one keeps its own.
	for (const { manifest, components } of configuredComponents(entries, [])) {
		const error = (message: string) => result.diagnostics.push({ type: "error", path: manifest.root, message });
		for (const message of components.errors) if (message.startsWith(`${manifest.name}: agents`)) error(message);
		const loaded = pluginAgents(manifest, components.agents);
		for (const message of loaded.errors) error(message);
		for (const agent of loaded.agents) result.agents.push({ ...agent, plugin: manifest.name, root: manifest.root });
	}
	return result;
}

/** Claude's instruction-only command subset uses the existing prompt expansion owner. */
export function loadConfiguredPluginPrompts(entries: Settings["plugins"]): {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
} {
	const result: {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	} = { prompts: [], diagnostics: [] };
	const names = new Set<string>();
	for (const { manifest, components } of configuredComponents(entries, result.diagnostics)) {
		const error = (message: string, file = manifest.root) =>
			result.diagnostics.push({ type: "error", path: file, message });
		const add = (name: string, file: string, inline?: string, metadata: Record<string, unknown> = {}) => {
			try {
				if (!isPluginIdentifier(name)) throw new Error(`Invalid plugin command name: ${String(name)}`);
				const unsupported = Object.keys(metadata).filter(
					(key) => !["source", "content", "description", "argumentHint"].includes(key),
				);
				if (unsupported.length) throw new Error(`Unsupported command metadata: ${unsupported.join(", ")}`);
				for (const key of ["description", "argumentHint"])
					if (metadata[key] !== undefined && typeof metadata[key] !== "string")
						throw new Error(`${key} must be a string`);
				const source =
					inline === undefined
						? resolvePluginPath(manifest.root, `./${path.relative(manifest.root, file).split(path.sep).join("/")}`)
						: file;
				const sourceInfo = {
					path: source,
					source: `plugin:${manifest.protocol}:${manifest.name}`,
					scope: "temporary" as const,
					origin: "package" as const,
					baseDir: manifest.root,
				};
				const parsed = parsePromptTemplate(inline ?? readFileSync(source, "utf8"), source, sourceInfo);
				result.diagnostics.push(...parsed.diagnostics);
				if (!parsed.template) return;
				const extra = Object.keys(parsed.frontmatter ?? {}).filter(
					(key) => !["description", "argument-hint", "arguments"].includes(key),
				);
				if (extra.length) throw new Error(`Unsupported command frontmatter: ${extra.join(", ")}`);
				const argumentNames = claudeArgumentNames(parsed.frontmatter?.arguments);
				if (parsed.template.content.includes("!`"))
					throw new Error("Dynamic shell expansion in plugin commands is unsupported");
				const qualified = `${manifest.name}:${name}`;
				if (names.has(qualified)) throw new Error(`Duplicate plugin command: ${qualified}`);
				names.add(qualified);
				result.prompts.push({
					...parsed.template,
					name: qualified,
					argumentStyle: "claude",
					argumentNames,
					claudePluginRoot: manifest.root,
					claudePluginData: pluginContext(manifest).data,
					...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
					...(typeof metadata.argumentHint === "string" ? { argumentHint: metadata.argumentHint } : {}),
				});
			} catch (cause) {
				error(String(cause), file);
			}
		};
		for (const component of components.commands) {
			if (component.kind === "command")
				add(
					component.name,
					typeof component.definition.source === "string" ? component.definition.source : manifest.sources[0],
					typeof component.definition.content === "string" ? component.definition.content : undefined,
					component.definition,
				);
			else {
				try {
					const files = statSync(component.path).isDirectory()
						? readdirSync(component.path)
								.filter((name) => name.endsWith(".md"))
								.map((name) => path.join(component.path, name))
						: [component.path];
					for (const file of files) add(path.basename(file, ".md"), file);
				} catch (cause) {
					error(String(cause), component.path);
				}
			}
		}
	}
	return result;
}
