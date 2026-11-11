/**
 * Which stored overrides no longer match the server they were written for, per override: `octocode mcp compact list`
 * names them. Overrides are checked against every catalog given (a server can vary its tools by configuration): one is
 * stale when it differs in any catalog that has its text, or when no catalog has it.
 */

import { instructionsHash } from "./render.ts";
import { hashList } from "./preset-overrides.ts";
import { fieldUpstreamTexts, toolDescriptionTexts, upstreamHash } from "./upstream.ts";
import type { CompactServerInput, PresetOverrides, UpstreamHashes } from "./types.ts";

interface StalePresetEntry {
	/** `server`, `<tool>.description` (its trigger too) or `<tool>.<field path>`. */
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
