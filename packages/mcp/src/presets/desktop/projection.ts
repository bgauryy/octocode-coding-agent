import type { CallToolResult } from "../../client/index.ts";
import { withStructuredText } from "../structured-text.ts";

type Structured = Record<string, unknown>;

function isRecord(value: unknown): value is Structured {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fields of a window read the model never acts on: the tree is already in the text, the note only advertises it. */
const WINDOW_STATE_DROPPED = ["tree_markdown", "elements", "_note"] as const;

/**
 * `get_window_state`: the text lists every element as `[index] role "label"`, so the structured `elements` array and the
 * `tree_markdown` copy go. What the text lacks stays: `snapshot_id`, `window_id`, `pid`, the counts, the partial-tree
 * markers and the screenshot geometry. A click needs `snapshot_id` plus the listed index (an `element_token` is
 * `<snapshot_id>:<element_index>`; any token that differs from that is kept by index). Without a tree in the structured
 * part the text may not list the elements, so they stay whole.
 */
function projectWindowState(data: Structured): Structured {
	if (typeof data.tree_markdown !== "string" || data.tree_markdown === "" || !Array.isArray(data.elements)) return data;
	const kept: Structured = {};
	for (const [key, value] of Object.entries(data)) {
		if (!(WINDOW_STATE_DROPPED as readonly string[]).includes(key)) kept[key] = value;
	}
	const tokens: Record<string, string> = {};
	const disabled: number[] = [];
	for (const element of data.elements) {
		if (!isRecord(element) || typeof element.element_index !== "number") continue;
		const index = element.element_index;
		const token = element.element_token;
		if (typeof token === "string" && token !== `${String(data.snapshot_id)}:${index}`) tokens[String(index)] = token;
		if (element.enabled === false) disabled.push(index);
	}
	kept.element_token_format = "<snapshot_id>:<element_index>";
	if (Object.keys(tokens).length > 0) kept.element_tokens = tokens;
	if (disabled.length > 0) kept.disabled_elements = disabled;
	return kept;
}

/** An entry without its null fields, zero layer and (for apps) launch metadata; what remains identifies and places it. */
function compactEntry(entry: unknown, drop: readonly string[]): unknown {
	if (!isRecord(entry)) return entry;
	const out: Structured = {};
	for (const [key, value] of Object.entries(entry)) {
		if (value === null || drop.includes(key)) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (key === "layer" && value === 0) continue;
		out[key] = value;
	}
	return out;
}

/** Past this many windows a listing is the whole desktop (no `pid`): only what is on screen is kept. */
const WINDOWS_ALL_KEPT = 12;
const WINDOWS_ON_SCREEN_KEPT = 25;

/**
 * `list_windows`: the text is only a count, so the windows are the data. A listing of one app (a dozen windows or
 * fewer) keeps every window, minus null space fields and a zero layer. A listing of the whole desktop (it is what a
 * call without `pid` returns, and every later request carries it) keeps the windows on screen and says how many it
 * left out and how to get one app's windows.
 */
function projectWindows(data: Structured): Structured {
	if (!Array.isArray(data.windows)) return data;
	if (data.windows.length <= WINDOWS_ALL_KEPT)
		return { ...data, windows: data.windows.map((window) => compactEntry(window, [])) };
	const onScreen = data.windows.filter((window) => (window as { is_on_screen?: unknown }).is_on_screen === true);
	const kept = onScreen.slice(0, WINDOWS_ON_SCREEN_KEPT);
	return {
		...data,
		windows: kept.map((window) => compactEntry(window, [])),
		windows_omitted: data.windows.length - kept.length,
		note: "A listing of the whole desktop keeps on-screen windows only; pass `pid` to list one app's windows, hidden ones included.",
	};
}

/** `list_apps`: the text lists only running apps, so every app stays, minus launch path, last use, kind and an inactive flag. */
function projectApps(data: Structured): Structured {
	if (!Array.isArray(data.apps)) return data;
	const apps = data.apps.map((app) => {
		const entry = compactEntry(app, ["launch_path", "last_used", "kind"]) as Structured;
		if (entry.active === false) delete entry.active;
		if (entry.pid === 0) delete entry.pid;
		return entry;
	});
	return { ...data, apps };
}

const PROJECTIONS: Record<string, (data: Structured) => Structured> = {
	get_window_state: projectWindowState,
	list_windows: projectWindows,
	list_apps: projectApps,
};

/**
 * The part of a Cua Driver `structuredContent` the model needs next: what its text lacks, minus what the text already
 * lists. Only tools studied against recorded results have a projection; any other tool comes back unchanged so a new
 * Driver tool is never hollowed out.
 */
export function projectStructured(tool: string, structuredContent: unknown): unknown {
	const project = Object.hasOwn(PROJECTIONS, tool) ? PROJECTIONS[tool] : undefined;
	return project && isRecord(structuredContent) ? project(structuredContent) : structuredContent;
}

/** A result with its projected structured part appended to the text. An error keeps its full envelope. */
export function projectDesktopResult(tool: string, result: CallToolResult): CallToolResult {
	if (result.isError || result.structuredContent === undefined) return withStructuredText(result);
	return withStructuredText({
		...result,
		structuredContent: projectStructured(tool, result.structuredContent),
	});
}
