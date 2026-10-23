import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { type PluginManifest, resolvePluginPath } from "./plugin-manifest.ts";

type PluginComponent = { kind: "path"; path: string } | { kind: "inline"; value: Record<string, unknown> };
type PluginCommand =
	| { kind: "path"; path: string }
	| {
			kind: "command";
			name: string;
			definition: Record<string, unknown>;
	  };

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Normalize component declarations without loading instructions or executing plugin code. */
export function discoverPluginComponents(manifest: PluginManifest): {
	skills: string[];
	commands: PluginCommand[];
	hooks: PluginComponent[];
	errors: string[];
} {
	const errors: string[] = [];
	const settings = manifest.settings;
	const paths = (
		field: string,
		value: unknown,
		kind: "directory" | "json" | "markdown",
		optional = false,
	): string[] => {
		const result: string[] = [];
		for (const entry of Array.isArray(value) ? value : [value]) {
			try {
				if (typeof entry !== "string") throw new Error("expected a path string");
				if (optional) {
					try {
						lstatSync(path.resolve(manifest.root, entry));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
				}
				if (entry === "." && field !== "skills") throw new Error("path must start with ./");
				const resolved = resolvePluginPath(manifest.root, entry);
				const stat = statSync(resolved);
				if (kind === "directory" && !stat.isDirectory()) throw new Error("expected a directory");
				if (kind === "json" && (!stat.isFile() || path.extname(resolved) !== ".json"))
					throw new Error("expected a JSON file");
				if (kind === "markdown" && !(stat.isDirectory() || (stat.isFile() && path.extname(resolved) === ".md")))
					throw new Error("expected a Markdown file or directory");
				result.push(resolved);
			} catch (error) {
				errors.push(`${manifest.name}: ${field}: ${String(error)}`);
			}
		}
		return result;
	};
	const skills = new Set<string>();
	if (manifest.format === "portable" || manifest.protocol === "claude" || settings.skills === undefined)
		for (const item of paths("skills", "./skills", "directory", true)) skills.add(item);
	if (manifest.format !== "portable" && settings.skills !== undefined)
		for (const item of paths("skills", settings.skills, "directory")) skills.add(item);

	const commands: PluginCommand[] = [];
	if (manifest.protocol === "claude") {
		if (object(settings.commands)) {
			for (const [name, definition] of Object.entries(settings.commands)) {
				if (
					!object(definition) ||
					"source" in definition === "content" in definition ||
					("source" in definition ? typeof definition.source !== "string" : typeof definition.content !== "string")
				) {
					errors.push(`${manifest.name}: commands.${name}: expected exactly one source or content string`);
					continue;
				}
				if (definition.source !== undefined) {
					const source = paths(`commands.${name}`, definition.source, "markdown")[0];
					if (!source) continue;
					if (!statSync(source).isFile()) {
						errors.push(`${manifest.name}: commands.${name}: source must be a Markdown file`);
						continue;
					}
					commands.push({ kind: "command", name, definition: { ...definition, source } });
				} else commands.push({ kind: "command", name, definition: { ...definition } });
			}
		} else {
			for (const item of new Set(
				paths(
					"commands",
					settings.commands === undefined ? "./commands" : settings.commands,
					"markdown",
					settings.commands === undefined,
				),
			))
				commands.push({ kind: "path", path: item });
		}
	}
	const hooks: PluginComponent[] = [];
	const seen = new Set<string>();
	const hookPaths = (entry: unknown, optional = false) => {
		for (const item of paths("hooks", entry, "json", optional)) {
			if (seen.has(item)) continue;
			seen.add(item);
			hooks.push({ kind: "path", path: item });
		}
	};
	if (
		manifest.protocol === "claude" ||
		settings.hooks === undefined ||
		(Array.isArray(settings.hooks) && settings.hooks.length === 0)
	)
		hookPaths("./hooks/hooks.json", true);
	if (settings.hooks !== undefined) {
		const entries = Array.isArray(settings.hooks) ? settings.hooks : [settings.hooks];
		const mixedCodex =
			manifest.protocol === "codex" && !entries.every((entry) => typeof entry === "string") && !entries.every(object);
		if (mixedCodex) errors.push(`${manifest.name}: hooks: Codex requires a homogeneous path or inline-object array`);
		else
			for (const entry of entries) {
				if (object(entry)) {
					if (manifest.protocol === "codex" && !object(entry.hooks)) {
						errors.push(`${manifest.name}: hooks: Codex inline declarations require a hooks wrapper`);
						continue;
					}
					hooks.push({ kind: "inline", value: manifest.protocol === "claude" ? { hooks: entry } : entry });
				} else hookPaths(entry);
			}
	}
	return { skills: [...skills], commands, hooks, errors };
}
