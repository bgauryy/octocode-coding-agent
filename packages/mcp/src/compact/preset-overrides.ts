/**
 * The form overrides are kept in when stored for a server (`GeneratedMeta.authored`), and the
 * one rule for when they apply. Each override is keyed on the upstream text it replaces: the server instructions by
 * their hash, a tool's description and trigger by the hash of its description, and each field by the hash of its
 * description at a stable dotted path. A server release that rewrites some texts therefore drops only the overrides of
 * those texts; every other override still applies, and a stale one fails open to the server's own text (`presetStatus`
 * names it).
 */

import { instructionsHash } from "./render.ts";
import { fieldUpstreamTexts, toolDescriptionTexts, upstreamHash } from "./upstream.ts";
import type {
	CompactServerInput,
	DescriptionOverrides,
	PresetOverrides,
	PresetToolOverrides,
	UpstreamHashes,
} from "./types.ts";

export const hashList = (hashes: UpstreamHashes): string[] => (Array.isArray(hashes) ? hashes : [hashes]);

/**
 * The entries of `preset` that still describe `input`: the server text while the instructions are unchanged, a tool's
 * description and trigger while its description is, and each field while its upstream description at that path is.
 */
export function presetOverridesFor(
	preset: PresetOverrides,
	input: CompactServerInput,
): DescriptionOverrides | undefined {
	const tools: Record<string, string> = {};
	const triggers: Record<string, string> = {};
	const fields: Record<string, Record<string, string>> = {};
	for (const tool of input.tools) {
		const entry = preset.tools?.[tool.name];
		if (!entry) continue;
		if (
			entry.descriptionHash !== undefined &&
			hashList(entry.descriptionHash).includes(upstreamHash(toolDescriptionTexts(tool)))
		) {
			if (entry.description !== undefined) tools[tool.name] = entry.description;
			if (entry.trigger !== undefined) triggers[tool.name] = entry.trigger;
		}
		if (!entry.fields) continue;
		const upstream = fieldUpstreamTexts(tool);
		for (const [path, field] of Object.entries(entry.fields)) {
			const texts = upstream.get(path);
			if (!texts || !hashList(field.upstream).includes(upstreamHash(texts))) continue;
			(fields[tool.name] ??= {})[path] = field.text;
		}
	}
	const overrides: DescriptionOverrides = {
		...(preset.server && preset.server.instructionsHash === instructionsHash(input.instructions)
			? { server: preset.server.text }
			: {}),
		...(Object.keys(tools).length ? { tools } : {}),
		...(Object.keys(triggers).length ? { triggers } : {}),
		...(Object.keys(fields).length ? { fields } : {}),
	};
	return Object.keys(overrides).length ? overrides : undefined;
}

/** Overrides written for `input`, in the form they are kept (`octocode mcp compact apply`). */
export function toPresetOverrides(overrides: DescriptionOverrides, input: CompactServerInput): PresetOverrides {
	const tools: Record<string, PresetToolOverrides> = {};
	for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
		const description = overrides.tools?.[tool.name];
		const trigger = overrides.triggers?.[tool.name];
		const upstream = fieldUpstreamTexts(tool);
		const fields = Object.fromEntries(
			Object.entries(overrides.fields?.[tool.name] ?? {}).flatMap(([path, text]) => {
				const texts = upstream.get(path);
				return texts ? [[path, { upstream: upstreamHash(texts), text }]] : [];
			}),
		);
		if (description === undefined && trigger === undefined && !Object.keys(fields).length) continue;
		tools[tool.name] = {
			...(description !== undefined || trigger !== undefined
				? { descriptionHash: upstreamHash(toolDescriptionTexts(tool)) }
				: {}),
			...(description !== undefined ? { description } : {}),
			...(trigger !== undefined ? { trigger } : {}),
			...(Object.keys(fields).length ? { fields } : {}),
		};
	}
	return {
		...(overrides.server !== undefined
			? { server: { instructionsHash: instructionsHash(input.instructions), text: overrides.server } }
			: {}),
		...(Object.keys(tools).length ? { tools } : {}),
	};
}
