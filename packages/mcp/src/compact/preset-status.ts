/**
 * Which kept overrides no longer match the server they were written for, per override: the drift tests name a preset's,
 * `generate:compact` shows and re-points them, and `octocode mcp compact list` names a server's stored ones. Overrides
 * are checked against every catalog a server sends
 * (the Octocode server varies its tools by configuration): one is stale when it differs in any catalog that has its
 * text, or when no catalog has it.
 */

import { instructionsHash } from "./render.ts";
import { hashList } from "./preset-overrides.ts";
import { fieldUpstreamTexts, toolDescriptionTexts, upstreamHash } from "./upstream.ts";
import type { CompactServerInput, PresetOverrides, PresetToolOverrides, UpstreamHashes } from "./types.ts";

export interface StalePresetEntry {
	/** `server`, `<tool>.description` (its trigger too) or `<tool>.<field path>`: what the drift tests name. */
	label: string;
	kind: "server" | "description" | "field";
	tool?: string;
	/** The field path, for a field. */
	path?: string;
	/** `changed`: the upstream text differs; `missing`: no catalog has the tool or field any more. */
	reason: "changed" | "missing";
	/** The override text that no longer applies. */
	override: string;
	/** The upstream texts now, across the catalogs that have them. */
	current: string[];
}

/** One override and how to read the text it replaces from a catalog. */
interface Probe {
	entry: Omit<StalePresetEntry, "reason" | "current">;
	/** The upstream texts in a catalog; undefined when it lacks the tool or field. */
	texts: (input: CompactServerInput) => string[] | undefined;
	hash: (texts: string[]) => string;
	hashes: UpstreamHashes;
}

const toolOf = (input: CompactServerInput, name: string) => input.tools.find((tool) => tool.name === name);

function probes(preset: PresetOverrides): Probe[] {
	const out: Probe[] = [];
	if (preset.server)
		out.push({
			entry: { label: "server", kind: "server", override: preset.server.text },
			texts: (input) => [input.instructions ?? ""],
			hash: ([text]) => instructionsHash(text),
			hashes: preset.server.instructionsHash,
		});
	for (const [name, tool] of Object.entries(preset.tools ?? {})) {
		if (tool.descriptionHash !== undefined)
			out.push({
				entry: {
					label: `${name}.description`,
					kind: "description",
					tool: name,
					override: tool.description ?? tool.trigger ?? "",
				},
				texts: (input) => {
					const found = toolOf(input, name);
					return found && toolDescriptionTexts(found);
				},
				hash: upstreamHash,
				hashes: tool.descriptionHash,
			});
		for (const [path, field] of Object.entries(tool.fields ?? {}))
			out.push({
				entry: { label: `${name}.${path}`, kind: "field", tool: name, path, override: field.text },
				texts: (input) => {
					const found = toolOf(input, name);
					return found && fieldUpstreamTexts(found).get(path);
				},
				hash: upstreamHash,
				hashes: field.upstream,
			});
	}
	return out;
}

/** The texts of the catalogs that have them, and the hash of each. */
function present(probe: Probe, inputs: readonly CompactServerInput[]): string[][] {
	return inputs.flatMap((input) => {
		const texts = probe.texts(input);
		return texts ? [texts] : [];
	});
}

/** The overrides of `preset` that differ in a catalog of `inputs`, or that no catalog has. */
export function presetStatus(preset: PresetOverrides, inputs: readonly CompactServerInput[]): StalePresetEntry[] {
	const stale: StalePresetEntry[] = [];
	for (const probe of probes(preset)) {
		const found = present(probe, inputs);
		if (!found.length) stale.push({ ...probe.entry, reason: "missing", current: [] });
		else if (found.some((texts) => !hashList(probe.hashes).includes(probe.hash(texts))))
			stale.push({ ...probe.entry, reason: "changed", current: [...new Set(found.flat())].sort() });
	}
	return stale;
}

const hashesOf = (probe: Probe, inputs: readonly CompactServerInput[]): UpstreamHashes => {
	const hashes = [...new Set(present(probe, inputs).map(probe.hash))].sort();
	return hashes.length === 1 ? hashes[0] : hashes;
};

/**
 * `preset` with the hashes of the `accepted` stale entries re-pointed at the catalogs of `inputs`, for a maintainer who
 * has read what changed upstream and found the override still true; an entry nothing has any more is dropped.
 */
export function acceptStale(
	preset: PresetOverrides,
	inputs: readonly CompactServerInput[],
	accepted: readonly StalePresetEntry[],
): PresetOverrides {
	const labels = new Set(accepted.map((entry) => entry.label));
	const byLabel = new Map(probes(preset).map((probe) => [probe.entry.label, probe]));
	const tools: Record<string, PresetToolOverrides> = {};
	for (const [name, tool] of Object.entries(preset.tools ?? {})) {
		const next: PresetToolOverrides = { ...tool };
		const description = byLabel.get(`${name}.description`);
		if (description && labels.has(description.entry.label)) {
			if (present(description, inputs).length) next.descriptionHash = hashesOf(description, inputs);
			else {
				delete next.descriptionHash;
				delete next.description;
				delete next.trigger;
			}
		}
		const fields: Record<string, { upstream: UpstreamHashes; text: string }> = {};
		for (const [path, field] of Object.entries(tool.fields ?? {})) {
			const probe = byLabel.get(`${name}.${path}`);
			if (!probe || !labels.has(probe.entry.label)) fields[path] = field;
			else if (present(probe, inputs).length) fields[path] = { ...field, upstream: hashesOf(probe, inputs) };
		}
		if (Object.keys(fields).length) next.fields = fields;
		else delete next.fields;
		if (next.description !== undefined || next.trigger !== undefined || next.fields) tools[name] = next;
	}
	const server = byLabel.get("server");
	return {
		...(preset.server
			? {
					server:
						server && labels.has("server")
							? { ...preset.server, instructionsHash: instructionsHash(inputs[0]?.instructions) }
							: preset.server,
				}
			: {}),
		...(Object.keys(tools).length ? { tools } : {}),
	};
}

/**
 * `preset` without the `stale` entries, so the server's own text applies there: the response to drift that rewrites
 * nothing. A stale description drops the tool's trigger with it (it is keyed on that description); a tool keeps its
 * still-valid fields.
 */
export function dropStale(preset: PresetOverrides, stale: readonly StalePresetEntry[]): PresetOverrides {
	const labels = new Set(stale.map((entry) => entry.label));
	const tools: Record<string, PresetToolOverrides> = {};
	for (const [name, tool] of Object.entries(preset.tools ?? {})) {
		const next: PresetToolOverrides = { ...tool };
		if (labels.has(`${name}.description`)) {
			delete next.descriptionHash;
			delete next.description;
			delete next.trigger;
		}
		const fields = Object.fromEntries(
			Object.entries(tool.fields ?? {}).filter(([path]) => !labels.has(`${name}.${path}`)),
		);
		if (Object.keys(fields).length) next.fields = fields;
		else delete next.fields;
		if (next.description !== undefined || next.trigger !== undefined || next.fields) tools[name] = next;
	}
	return {
		...(preset.server && !labels.has("server") ? { server: preset.server } : {}),
		...(Object.keys(tools).length ? { tools } : {}),
	};
}
