/**
 * Which file a catalog gets, shared by sessions (`presentation/`) and `octocode mcp compact`: the stored file while it
 * matches, else a new render that keeps every override still describing the catalog.
 */

import { checkFidelity } from "./fidelity.ts";
import {
	catalogHash,
	COMPACT_GENERATOR_VERSION,
	instructionsHash,
	presetHash,
	renderServer,
	toolHash,
} from "./render.ts";
import { readGenerated, readGeneratedMeta, writeGenerated } from "./store.ts";
import type { CompactServerInput, DescriptionOverrides, GeneratedMeta } from "./types.ts";

type CatalogHashes = Pick<GeneratedMeta, "hash" | "toolHashes" | "instructionsHash">;

/** The hashes a stored file records for the catalog it was rendered from. */
export function catalogHashes(input: CompactServerInput): Required<CatalogHashes> {
	return {
		hash: catalogHash(input),
		toolHashes: Object.fromEntries(input.tools.map((tool) => [tool.name, toolHash(tool)])),
		instructionsHash: instructionsHash(input.instructions),
	};
}

const pick = <T>(record: Record<string, T> | undefined, keep: ReadonlySet<string>): Record<string, T> | undefined => {
	const entries = Object.entries(record ?? {}).filter(([tool]) => keep.has(tool));
	return entries.length ? Object.fromEntries(entries) : undefined;
};

/** Overrides without empty kinds, or undefined when nothing is left. */
function compactOverrides(overrides: DescriptionOverrides): DescriptionOverrides | undefined {
	const result: DescriptionOverrides = {
		...(overrides.server !== undefined ? { server: overrides.server } : {}),
		...(overrides.tools && Object.keys(overrides.tools).length ? { tools: overrides.tools } : {}),
		...(overrides.triggers && Object.keys(overrides.triggers).length ? { triggers: overrides.triggers } : {}),
		...(overrides.fields && Object.keys(overrides.fields).length ? { fields: overrides.fields } : {}),
	};
	return Object.keys(result).length ? result : undefined;
}

/**
 * The part of `overrides`, written for the catalog `written`, that still describes `input`: all of it for the same
 * catalog; otherwise the entries of tools whose hash is unchanged, and the server text while the instructions are.
 */
export function carryOverrides(
	overrides: DescriptionOverrides | undefined,
	written: CatalogHashes,
	input: CompactServerInput,
): DescriptionOverrides | undefined {
	if (!overrides) return undefined;
	if (written.hash === catalogHash(input)) return overrides;
	const unchanged = new Set(
		input.tools.filter((tool) => written.toolHashes?.[tool.name] === toolHash(tool)).map((tool) => tool.name),
	);
	return compactOverrides({
		...(written.instructionsHash === instructionsHash(input.instructions) ? { server: overrides.server } : {}),
		tools: pick(overrides.tools, unchanged),
		triggers: pick(overrides.triggers, unchanged),
		fields: pick(overrides.fields, unchanged),
	});
}

/** `top` over `base`, entry by entry (field docs path by path). */
export function mergeOverrides(
	base: DescriptionOverrides | undefined,
	top: DescriptionOverrides | undefined,
): DescriptionOverrides | undefined {
	if (!base || !top) return top ?? base;
	const fields = { ...base.fields };
	for (const [tool, docs] of Object.entries(top.fields ?? {})) fields[tool] = { ...fields[tool], ...docs };
	return compactOverrides({
		server: top.server ?? base.server,
		tools: { ...base.tools, ...top.tools },
		triggers: { ...base.triggers, ...top.triggers },
		fields,
	});
}

export interface ServerFile {
	text: string;
	meta: GeneratedMeta;
	/** Whether the text was rendered now; false when the stored file was read. */
	rendered: boolean;
}

export interface ResolveOptions {
	/** The preset's overrides that describe this catalog (see `McpServerPreset.compactOverrides`). */
	preset?: DescriptionOverrides;
	/** Render even when the stored file matches. */
	refresh?: boolean;
	/** Called when storing a new render fails; the caller still gets the text. */
	onWriteError?: (error: unknown) => void;
}

/**
 * The file for a catalog: the stored one when this generator rendered it from this exact catalog and preset overrides.
 * Otherwise a new render with the stored overrides that still describe the catalog (`carryOverrides`, which also keeps
 * them across a generator change) over the preset's, kept only when the whole render passes the fidelity check; the
 * render is stored. A stored file rendered from the preset alone carries nothing once the preset changes, so a release
 * that changes the preset reaches users. `name` is the configured server name, which names the stored files.
 */
export function resolveServerFile(
	dir: string,
	name: string,
	input: CompactServerInput,
	options: ResolveOptions = {},
): ServerFile {
	const hashes = catalogHashes(input);
	const preset = presetHash(options.preset);
	const stored = readGenerated(dir, name);
	const previous = stored?.meta ?? readGeneratedMeta(dir, name);
	const samePreset = previous?.presetHash === preset;
	if (
		!options.refresh &&
		samePreset &&
		stored?.meta.hash === hashes.hash &&
		stored.meta.generatorVersion === COMPACT_GENERATOR_VERSION
	)
		return { text: stored.text, meta: stored.meta, rendered: false };
	const presetOnly = previous?.optimizedBy?.model === "preset";
	const carried =
		previous && (samePreset || !presetOnly) ? carryOverrides(previous.overrides, previous, input) : undefined;
	const candidate = mergeOverrides(options.preset, carried);
	const withOverrides = candidate && renderServer(input, candidate);
	const overrides =
		candidate && withOverrides && checkFidelity(input, withOverrides, candidate).ok ? candidate : undefined;
	const text = overrides && withOverrides ? withOverrides : renderServer(input);
	// "preset" marks overrides from the preset alone; carried overrides keep their writer, also when it is unnamed.
	const optimizedBy = !overrides
		? undefined
		: carried
			? previous?.optimizedBy
			: options.preset
				? { model: "preset", at: new Date().toISOString() }
				: undefined;
	const meta: GeneratedMeta = {
		...hashes,
		generatorVersion: COMPACT_GENERATOR_VERSION,
		...(overrides ? { overrides } : {}),
		...(preset ? { presetHash: preset } : {}),
		...(optimizedBy ? { optimizedBy } : {}),
		generatedAt: new Date().toISOString(),
	};
	try {
		writeGenerated(dir, name, text, meta);
	} catch (error) {
		options.onWriteError?.(error);
	}
	return { text, meta, rendered: true };
}

/** Tools of `input` whose description no override rewrites: candidates for the `octocode-compact-mcp` skill. */
export function unoptimizedTools(input: CompactServerInput, overrides: DescriptionOverrides | undefined): string[] {
	return input.tools
		.filter((tool) => overrides?.tools?.[tool.name] === undefined && overrides?.triggers?.[tool.name] === undefined)
		.map((tool) => tool.name);
}
