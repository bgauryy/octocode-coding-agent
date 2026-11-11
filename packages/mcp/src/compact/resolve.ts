/**
 * Which file a catalog gets, shared by sessions (`presentation/`) and `octocode mcp compact`: the stored file while it
 * matches, else a new render with the overrides that describe the catalog. Overrides come from one place: the ones the
 * user stored for the server (`octocode mcp compact apply`), each applied while the upstream text it replaces is
 * unchanged (`presetOverridesFor`). Octocode ships none, so a server without stored overrides is rendered from its own
 * text.
 */

import { checkOverrides } from "./fidelity.ts";
import { presetOverridesFor, toPresetOverrides } from "./preset-overrides.ts";
import { catalogHash, COMPACT_GENERATOR_VERSION, instructionsHash, renderServer, toolHash } from "./render.ts";
import { readGenerated, readGeneratedMeta, writeGenerated } from "./store.ts";
import type { CompactServerInput, DescriptionOverrides, GeneratedMeta, PresetOverrides } from "./types.ts";

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
 * The overrides a stored file keeps for its server. A file written before overrides were keyed has them unkeyed, so
 * they are keyed here for `input`, the first catalog it meets: all of them for the catalog they were written for, else
 * those of tools whose hash is unchanged and the server text while the instructions are. A file an earlier release
 * rendered with overrides it shipped (`optimizedBy.model` "preset") holds none of the user's.
 */
function authoredOverrides(meta: GeneratedMeta, input: CompactServerInput): PresetOverrides | undefined {
	if (meta.authored) return meta.authored;
	if (!meta.overrides || meta.optimizedBy?.model === "preset") return undefined;
	if (meta.hash === catalogHash(input)) return toPresetOverrides(meta.overrides, input);
	const unchanged = new Set(
		input.tools.filter((tool) => meta.toolHashes?.[tool.name] === toolHash(tool)).map((tool) => tool.name),
	);
	const kept = compactOverrides({
		...(meta.instructionsHash === instructionsHash(input.instructions) ? { server: meta.overrides.server } : {}),
		tools: pick(meta.overrides.tools, unchanged),
		triggers: pick(meta.overrides.triggers, unchanged),
		fields: pick(meta.overrides.fields, unchanged),
	});
	return kept && toPresetOverrides(kept, input);
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

/** The overrides that describe `input`: the stored ones whose upstream text is unchanged. */
export function describedOverrides(
	meta: GeneratedMeta | undefined,
	input: CompactServerInput,
): DescriptionOverrides | undefined {
	const authored = meta && authoredOverrides(meta, input);
	return authored ? presetOverridesFor(authored, input) : undefined;
}

/** `overrides` split by what it rewrites: the server text, then each tool's description, trigger and fields together. */
function overrideEntries(overrides: DescriptionOverrides): DescriptionOverrides[] {
	const tools = new Set([
		...Object.keys(overrides.tools ?? {}),
		...Object.keys(overrides.triggers ?? {}),
		...Object.keys(overrides.fields ?? {}),
	]);
	const entries = [...tools].flatMap((tool) => {
		const only = new Set([tool]);
		const entry = compactOverrides({
			tools: pick(overrides.tools, only),
			triggers: pick(overrides.triggers, only),
			fields: pick(overrides.fields, only),
		});
		return entry ? [entry] : [];
	});
	return overrides.server === undefined ? entries : [{ server: overrides.server }, ...entries];
}

/**
 * The overrides of `candidate` that render faithfully. A bad one fails open to the server's own text by itself: it must
 * not void the others, which would silently cost every agent the whole compaction.
 */
function faithfulOverrides(
	input: CompactServerInput,
	candidate: DescriptionOverrides | undefined,
): DescriptionOverrides | undefined {
	if (!candidate) return undefined;
	const passes = (overrides: DescriptionOverrides) =>
		checkOverrides(input, renderServer(input, overrides), overrides).ok;
	if (passes(candidate)) return candidate;
	const kept = overrideEntries(candidate)
		.filter(passes)
		.reduce<DescriptionOverrides | undefined>((all, entry) => mergeOverrides(all, entry), undefined);
	return kept && passes(kept) ? kept : undefined;
}

export interface ServerFile {
	text: string;
	meta: GeneratedMeta;
	/** Whether the text was rendered now; false when the stored file was read. */
	rendered: boolean;
}

export interface ResolveOptions {
	/** Render even when the stored file matches. */
	refresh?: boolean;
	/** Called when storing a new render fails; the caller still gets the text. */
	onWriteError?: (error: unknown) => void;
}

/**
 * The file for a catalog: the stored one when this generator rendered it from this exact catalog. Otherwise a new
 * render with the `describedOverrides` that pass the fidelity check (`faithfulOverrides`); the render is stored. The
 * stored overrides stay as written, stale ones too, so a stale one applies again if the server's text comes back. A
 * file an earlier release rendered with overrides it shipped (`presetHash`, or written by "preset") is rendered again,
 * from the server's text and the user's stored overrides.
 * `name` is the configured server name, which names the stored files.
 */
export function resolveServerFile(
	dir: string,
	name: string,
	input: CompactServerInput,
	options: ResolveOptions = {},
): ServerFile {
	const hash = catalogHash(input);
	const stored = readGenerated(dir, name);
	const previous = stored?.meta ?? readGeneratedMeta(dir, name);
	if (
		!options.refresh &&
		previous?.presetHash === undefined &&
		previous?.optimizedBy?.model !== "preset" &&
		stored?.meta.hash === hash &&
		stored.meta.generatorVersion === COMPACT_GENERATOR_VERSION
	)
		return { text: stored.text, meta: stored.meta, rendered: false };
	const authored = previous && authoredOverrides(previous, input);
	const overrides = faithfulOverrides(input, describedOverrides(previous, input));
	const text = overrides ? renderServer(input, overrides) : renderServer(input);
	// Stored overrides keep their writer, also when it is unnamed.
	const optimizedBy = authored ? previous?.optimizedBy : undefined;
	const meta: GeneratedMeta = {
		hash,
		generatorVersion: COMPACT_GENERATOR_VERSION,
		...(overrides ? { overrides } : {}),
		...(authored ? { authored } : {}),
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
