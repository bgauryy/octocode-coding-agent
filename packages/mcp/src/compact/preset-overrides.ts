/**
 * Description overrides a preset ships for its server, keyed per tool by the hash of the tool they were written for,
 * so a server release that changes some tools keeps the overrides of the others.
 */

import { instructionsHash, toolHash } from "./render.ts";
import type { CompactServerInput, DescriptionOverrides } from "./types.ts";

interface PresetToolOverrides {
	/** {@link toolHash} of the tool the entries describe. */
	hash: string;
	description?: string;
	trigger?: string;
	fields?: Record<string, string>;
}

export interface PresetOverrides {
	/** The server text, for the instructions with this {@link instructionsHash}. */
	server?: { instructionsHash: string; text: string };
	tools?: Record<string, PresetToolOverrides>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

function toolError(name: string, value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.hash !== "string") return `tools.${name}: needs a "hash" string`;
	const unknown = Object.keys(value).filter((key) => !["hash", "description", "trigger", "fields"].includes(key));
	if (unknown.length) return `tools.${name}: unknown key ${unknown.join(", ")}`;
	for (const key of ["description", "trigger"] as const)
		if (value[key] !== undefined && typeof value[key] !== "string") return `tools.${name}.${key}: must be a string`;
	if (value.fields !== undefined && !isStringRecord(value.fields))
		return `tools.${name}.fields: must map field paths to strings`;
	return undefined;
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

/** The entries of `preset` that describe `input`: those of tools whose hash matches, the server text while the instructions do. */
export function presetOverridesFor(
	preset: PresetOverrides,
	input: CompactServerInput,
): DescriptionOverrides | undefined {
	const tools: Record<string, string> = {};
	const triggers: Record<string, string> = {};
	const fields: Record<string, Record<string, string>> = {};
	for (const tool of input.tools) {
		const entry = preset.tools?.[tool.name];
		if (!entry || entry.hash !== toolHash(tool)) continue;
		if (entry.description !== undefined) tools[tool.name] = entry.description;
		if (entry.trigger !== undefined) triggers[tool.name] = entry.trigger;
		if (entry.fields && Object.keys(entry.fields).length) fields[tool.name] = entry.fields;
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

/** Overrides written for `input`, in the form a preset ships them (`octocode mcp compact preset`). */
export function toPresetOverrides(overrides: DescriptionOverrides, input: CompactServerInput): PresetOverrides {
	const tools: Record<string, PresetToolOverrides> = {};
	for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
		const description = overrides.tools?.[tool.name];
		const trigger = overrides.triggers?.[tool.name];
		const fields = overrides.fields?.[tool.name];
		if (description === undefined && trigger === undefined && !fields) continue;
		tools[tool.name] = {
			hash: toolHash(tool),
			...(description !== undefined ? { description } : {}),
			...(trigger !== undefined ? { trigger } : {}),
			...(fields ? { fields } : {}),
		};
	}
	return {
		...(overrides.server !== undefined
			? { server: { instructionsHash: instructionsHash(input.instructions), text: overrides.server } }
			: {}),
		...(Object.keys(tools).length ? { tools } : {}),
	};
}
