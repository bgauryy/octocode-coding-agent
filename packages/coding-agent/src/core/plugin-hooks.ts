import { readFileSync } from "node:fs";
import { stripBom } from "../../../common/src/text.ts";
import { discoverPluginComponents } from "./plugin-components.ts";
import { resolveConfiguredPlugin, type PluginManifest } from "./plugin-manifest.ts";
import type { Settings } from "./settings-manager.ts";

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
