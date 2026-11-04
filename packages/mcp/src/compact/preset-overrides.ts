/**
 * The one form overrides are kept in, shipped with a preset or stored for a server (`GeneratedMeta.authored`), and the
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
import { isRecord } from "@octocodeai/octocode-contracts/guards";

export const hashList = (hashes: UpstreamHashes): string[] => (Array.isArray(hashes) ? hashes : [hashes]);

const isHashes = (value: unknown): value is UpstreamHashes =>
	typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

const TOOL_KEYS = ["descriptionHash", "description", "trigger", "fields"];

function fieldsError(name: string, fields: unknown): string | undefined {
	if (!isRecord(fields)) return `tools.${name}.fields: must map field paths to entries`;
	for (const [path, field] of Object.entries(fields)) {
		if (!isRecord(field) || !isHashes(field.upstream) || typeof field.text !== "string")
			return `tools.${name}.fields.${path}: needs "upstream" hash(es) and a "text" string`;
		const unknown = Object.keys(field).filter((key) => key !== "upstream" && key !== "text");
		if (unknown.length) return `tools.${name}.fields.${path}: unknown key ${unknown.join(", ")}`;
	}
	return undefined;
}

function toolError(name: string, value: unknown): string | undefined {
	if (!isRecord(value)) return `tools.${name}: must be an object`;
	const unknown = Object.keys(value).filter((key) => !TOOL_KEYS.includes(key));
	if (unknown.length) return `tools.${name}: unknown key ${unknown.join(", ")}`;
	for (const key of ["description", "trigger"] as const)
		if (value[key] !== undefined && typeof value[key] !== "string") return `tools.${name}.${key}: must be a string`;
	if ((value.description !== undefined || value.trigger !== undefined) && !isHashes(value.descriptionHash))
		return `tools.${name}: needs a "descriptionHash" string`;
	return value.fields === undefined ? undefined : fieldsError(name, value.fields);
}

/** Validates preset overrides read from JSON; unknown keys are rejected so a typo does not pass silently. */
export function parsePresetOverrides(value: unknown): { overrides: PresetOverrides } | { error: string } {
	if (!isRecord(value)) return { error: "preset overrides must be a JSON object" };
	const unknown = Object.keys(value).filter((key) => key !== "server" && key !== "tools");
	if (unknown.length) return { error: `unknown key ${unknown.join(", ")}` };
	const { server, tools } = value;
	if (
		server !== undefined &&
		!(isRecord(server) && typeof server.instructionsHash === "string" && typeof server.text === "string")
	)
		return { error: '"server" needs "instructionsHash" and "text" strings' };
	if (tools !== undefined) {
		if (!isRecord(tools)) return { error: '"tools" must map tool names to entries' };
		for (const [name, entry] of Object.entries(tools)) {
			const error = toolError(name, entry);
			if (error) return { error };
		}
	}
	return { overrides: value };
}

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

/** Overrides written for `input`, in the form they are kept (`octocode mcp compact preset`, `apply`). */
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
