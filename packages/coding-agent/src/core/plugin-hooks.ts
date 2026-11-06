import { readFileSync } from "node:fs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { stripBom } from "../../../common/src/text.ts";
import { discoverPluginComponents } from "./plugin-components.ts";
import { resolveConfiguredPlugin, type PluginManifest } from "./plugin-manifest.ts";
import type { Settings } from "./settings-schema.ts";

interface PluginHookInspection {
	manifest?: PluginManifest;
	definitions: { source: string; value: Record<string, unknown> }[];
	errors: string[];
}

/** Reads the hook declarations of one plugin without running them; non-empty `errors` means none of them load. */
export function inspectPluginHooks(entry: NonNullable<Settings["plugins"]>[number]): PluginHookInspection {
	const result: PluginHookInspection = { definitions: [], errors: [] };
	try {
		const { manifest, errors, failure } = resolveConfiguredPlugin(entry);
		result.errors.push(...errors);
		if (!manifest) throw new Error(failure);
		result.manifest = manifest;
		const components = discoverPluginComponents(manifest);
		result.errors.push(...components.errors);
		for (const [index, component] of components.hooks.entries()) {
			const source = component.kind === "path" ? component.path : `${manifest.sources.at(-1)}#hooks[${index}]`;
			const text = component.kind === "path" ? readFileSync(component.path, "utf8") : JSON.stringify(component.value);
			const value: unknown = JSON.parse(stripBom(text));
			if (
				typeof value !== "object" ||
				value === null ||
				Array.isArray(value) ||
				!("hooks" in value) ||
				typeof value.hooks !== "object" ||
				value.hooks === null ||
				Array.isArray(value.hooks)
			)
				throw new Error(`${source}: expected an object with a hooks event map`);
			if ("modules" in value)
				result.errors.push(`${source}: modules require the unsupported Claude Mods runtime; plugin hooks not loaded`);
			result.definitions.push({ source, value: value });
		}
	} catch (error) {
		result.errors.push(String(error));
	}
	return result;
}

/** The MCP servers the `mcp_tool` hooks of these declarations call, each once, in declaration order. */
export function pluginHookMcpServers(definitions: PluginHookInspection["definitions"]): string[] {
	const servers = new Set<string>();
	for (const { value } of definitions)
		for (const groups of Object.values(isRecord(value.hooks) ? value.hooks : {}))
			for (const group of Array.isArray(groups) ? groups : [])
				for (const hook of isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [])
					if (isRecord(hook) && hook.type === "mcp_tool" && typeof hook.server === "string") servers.add(hook.server);
	return [...servers];
}
