import { basename, dirname, join, sep } from "node:path";
import { canonicalizePath, isUnderPath } from "@octocodeai/octocode-common/paths";
import { skillCategory } from "../skills/category.ts";
import { claudeConfigDir, codexConfigDir } from "../../utils/host-config.ts";
import { mcpVendorLabel, skillFolder } from "./display-paths.ts";
import type { ConfigItem, ConfigKind, Product, Provenance } from "./types.ts";

/**
 * What the session loaded and where each item came from: the one model behind the startup listing and `/harness config`. It
 * joins discovery (every copy with its provenance, the shadowed and not-loaded ones included) with what the loaders
 * actually loaded (packages and project instruction files that discovery does not list). Pure: no file access except
 * path comparison, so a terminal and a text mode render the same data.
 */

/** `loaded` applies to the agent; the others are listed so the user can see why an item does not. */
type EntryState = "loaded" | "shadowed" | "untrusted" | "ignored" | "off";

export interface ContextEntry {
	name: string;
	path: string;
	/** Where it came from: `octocode global`, `pi project`, `plugin <name>`, `builtin`, `project`. */
	source: string;
	product?: Product;
	state: EntryState;
	/** Why it does not load, or a status such as an MCP server's connection state. */
	note?: string;
	/** For a shadowed copy: the file of the copy that loads instead. */
	winner?: string;
}

export interface ContextGroup {
	/** The discovery kind, or the first kind of a merged group. */
	id: string;
	title: string;
	/** `[one, many]`, for sentences that name what was found. */
	noun: readonly [string, string];
	entries: ContextEntry[];
}

/** One line saying what is wrong and what to do; `details` (ctrl+o) lists the items. */
export interface ContextWarning {
	text: string;
	details: string[];
}

export interface ContextView {
	groups: ContextGroup[];
	warnings: ContextWarning[];
}

/** What a loader loaded, by file. `label` names the source when discovery has no copy of the file. */
export interface LoadedRef {
	path: string;
	name?: string;
	label?: string;
}

/** A server of the MCP host's status, reduced to what the listing shows. */
interface McpEntry {
	name: string;
	enabled: boolean;
	state: string;
	source: string;
	scope?: string;
	toolCount?: number;
}

export interface ContextViewInput {
	discovery: ReadonlyMap<ConfigKind, readonly ConfigItem[]>;
	/** Per kind, what the session loaded. A kind without an entry here shows every discovered item. */
	loaded?: Partial<Record<ConfigKind, readonly LoadedRef[]>>;
	/** The MCP host's servers; without them the `mcp` items of discovery stand in. */
	mcp?: readonly McpEntry[];
	/** Pi's global roots, to tell a Pi MCP file from an Octocode one. */
	piRoots?: readonly string[];
}

const GROUPS: ReadonlyArray<{ id: string; title: string; noun: readonly [string, string]; kinds: ConfigKind[] }> = [
	{
		id: "context",
		title: "Context",
		noun: ["context file", "context files"],
		kinds: ["systemPrompt", "appendSystemPrompt", "context"],
	},
	{ id: "skill", title: "Skills", noun: ["skill", "skills"], kinds: ["skill"] },
	{ id: "agent", title: "Agents", noun: ["agent", "agents"], kinds: ["agent"] },
	{ id: "model", title: "Models", noun: ["models file", "models files"], kinds: ["model"] },
	{ id: "mcp", title: "MCP", noun: ["MCP server", "MCP servers"], kinds: ["mcp"] },
	{ id: "hook", title: "Hooks", noun: ["hook", "hooks"], kinds: ["hook"] },
	{ id: "plugin", title: "Plugins", noun: ["plugin", "plugins"], kinds: ["plugin"] },
	{ id: "prompt", title: "Prompts", noun: ["prompt", "prompts"], kinds: ["prompt"] },
	{ id: "theme", title: "Themes", noun: ["theme", "themes"], kinds: ["theme"] },
	{ id: "keybinding", title: "Keybindings", noun: ["keybindings file", "keybindings files"], kinds: ["keybinding"] },
	{ id: "setting", title: "Settings", noun: ["settings file", "settings files"], kinds: ["setting"] },
	{ id: "extension", title: "Extensions", noun: ["extension", "extensions"], kinds: ["extension"] },
];

/** What a user does with Pi code Octocode does not run. */
export const PI_CODE_HINT = "convert to hooks.json or a plugin";
const UNTRUSTED_NOTE = "folder not trusted";
const SWITCHED_OFF_NOTE = "harness off (/harness)";
const HOST_PLUGIN_NOTES = { claude: "Claude Code plugin, added in settings", codex: "Codex plugin, added in settings" };

/** `octocode global`, `pi project`, `claude global`, `plugin <name>` (origin `plugin:<name>`), `octocode` (a role bundled with this build). */
function sourceLabel(provenance: Pick<Provenance, "scope" | "origin" | "hostPlugin">): string {
	if (provenance.scope === "builtin") return "octocode";
	if (provenance.hostPlugin) return `${provenance.hostPlugin} plugin`;
	if (provenance.origin.startsWith("plugin")) return provenance.origin.replace(":", " ");
	return `${provenance.origin} ${provenance.scope}`;
}

/**
 * The label for a loaded file that discovery does not list: Octocode's core skills (`core`), the Octocode skill
 * collection (`octocode`), a package, the user or project folder, the Claude or Codex skill folder, a flag (`--skill`,
 * `--prompt-template`) or a path that the `skills`/`prompts` settings name. The core label follows `skillCategory`.
 */
export function sourceInfoLabel(info: { source: string; scope: string; path?: string } | undefined): string {
	if (!info) return "other";
	// Skills the application ships itself are handed to the loader as extra paths; they are its core, not the user's.
	const category = info.path ? skillCategory({ filePath: info.path, sourceInfo: info }) : undefined;
	if (category === "core") return "core";
	if (info.source.startsWith("npm:") || info.source.startsWith("git:")) return `package ${info.source}`;
	// Built-in extensions share the `builtin` source with the Octocode skill collection.
	if (info.source === "builtin") return category === "octocode" ? "octocode" : "builtin";
	// The native extension adds the other hosts' user skill folders as extra paths too.
	if (info.path && isUnderPath(info.path, join(claudeConfigDir(), "skills"))) return "claude global";
	if (info.path && isUnderPath(info.path, join(codexConfigDir(), "skills"))) return "codex global";
	// Project skill folders of the other agents, reached through extra skill paths rather than settings.
	for (const [dir, label] of PROJECT_SKILL_DIRS)
		if (info.path?.includes(`${sep}${dir}${sep}skills${sep}`)) return `${label} project`;
	if (info.source === "cli") return "command line";
	if (info.scope === "user") return "octocode global";
	if (info.scope === "project") return "octocode project";
	return "settings path";
}

const PROJECT_SKILL_DIRS: ReadonlyArray<readonly [string, string]> = [
	[".claude", "claude"],
	[".codex", "codex"],
	[".agents", "agents"],
	[".cursor", "cursor"],
];

const CONTEXT_KINDS = new Set<ConfigKind>(["context", "systemPrompt", "appendSystemPrompt"]);

/** A version folder name (`1.0.0`, `26.1027.61615`): a plugin cache keeps one folder per version under the plugin's own. */
const VERSION_NAME = /^v?\d+(\.\d+)+$/;

function entryName(item: ConfigItem): string {
	if (CONTEXT_KINDS.has(item.kind)) return basename(item.provenance.path);
	if (item.kind === "plugin" && VERSION_NAME.test(item.name)) return basename(dirname(item.provenance.path));
	return item.name;
}

/** An item of a harness switched off in `/harness`: listed expanded with the reason, never counted or warned about. */
const switchedOff = (provenance: Pick<Provenance, "notLoaded">): boolean => provenance.notLoaded === "switched-off";

function notLoadedNote(item: ConfigItem): string {
	const { notLoaded, product } = item.provenance;
	if (notLoaded === "untrusted") return UNTRUSTED_NOTE;
	if (switchedOff(item.provenance)) return SWITCHED_OFF_NOTE;
	if (notLoaded === "ignored-code")
		return `${product === "pi" ? "Pi " : ""}${item.kind === "hook" ? "hook" : "extension"}, not loaded`;
	return item.provenance.shadowedBy ? `duplicate of ${sourceLabel(item.provenance.shadowedBy)}` : "";
}

function fromItem(item: ConfigItem): ContextEntry {
	const { notLoaded, shadowedBy } = item.provenance;
	const state: EntryState =
		notLoaded === "untrusted"
			? "untrusted"
			: switchedOff(item.provenance)
				? "off"
				: notLoaded
					? "ignored"
					: shadowedBy && !item.loaded
						? "shadowed"
						: "loaded";
	const host = item.provenance.hostPlugin && HOST_PLUGIN_NOTES[item.provenance.hostPlugin];
	const note = state === "loaded" ? (host ?? (item.role === "override" ? "override" : undefined)) : notLoadedNote(item);
	return {
		name: entryName(item),
		path: item.provenance.path,
		source: sourceLabel(item.provenance),
		product: item.provenance.product,
		state,
		...(note ? { note } : {}),
		...(state === "shadowed" && shadowedBy ? { winner: shadowedBy.path } : {}),
	};
}

function fallbackName(ref: LoadedRef, keepFileName: boolean): string {
	if (ref.name) return ref.name;
	if (keepFileName) return basename(ref.path);
	return basename(ref.path) === "SKILL.md" ? basename(dirname(ref.path)) : basename(ref.path).replace(/\.md$/, "");
}

/** One kind's entries: what the loader loaded (labelled by discovery where it has the file), plus the copies that did not load. */
function kindEntries(
	kind: ConfigKind,
	items: readonly ConfigItem[],
	refs: readonly LoadedRef[] | undefined,
): ContextEntry[] {
	if (!refs) return items.map(fromItem);
	// Copies in folders symlinked to one place share a real path: the loaded file is the copy at that exact path, else
	// the copy discovery loads, never a switched-off or shadowed one that happens to resolve to the same file.
	const byRealPath = new Map<string, ConfigItem[]>();
	for (const item of items) {
		const key = canonicalizePath(item.provenance.path);
		byRealPath.set(key, [...(byRealPath.get(key) ?? []), item]);
	}
	const matched = new Set<ConfigItem>();
	const find = (path: string): ConfigItem | undefined => {
		const copies = (byRealPath.get(canonicalizePath(path)) ?? []).filter((item) => !matched.has(item));
		return copies.find((item) => item.provenance.path === path) ?? copies.find((item) => item.loaded) ?? copies[0];
	};
	const loaded = refs.map((ref): ContextEntry => {
		const item = find(ref.path);
		if (item) {
			matched.add(item);
			return {
				...fromItem(item),
				name: CONTEXT_KINDS.has(item.kind) ? basename(ref.path) : (ref.name ?? item.name),
				state: "loaded",
			};
		}
		return {
			name: fallbackName(ref, CONTEXT_KINDS.has(kind)),
			path: ref.path,
			source: ref.label ?? "other",
			state: "loaded",
		};
	});
	// A copy the loader skipped for a reason discovery knows stays listed; a loaded-by-discovery copy the loader dropped does not.
	const rest = items.filter((item) => !matched.has(item) && (item.provenance.notLoaded || !item.loaded)).map(fromItem);
	return [...loaded, ...rest];
}

function mcpLabel(server: McpEntry, piRoots: readonly string[]): { source: string; product?: Product } {
	if (server.scope === "default" || server.source.startsWith("built-in")) return { source: "builtin" };
	if (server.scope === "extension") return { source: "plugin" };
	const scope = server.scope ?? "global";
	const vendor = mcpVendorLabel(server.source);
	if (vendor === ".agents" || vendor === "root .mcp.json") return { source: vendor };
	if (vendor) return { source: `${vendor} ${scope}` };
	const pi = server.source.includes("/.pi/") || piRoots.some((root) => server.source.startsWith(root));
	return pi ? { source: `pi ${scope}`, product: "pi" } : { source: `octocode ${scope}`, product: "octocode" };
}

function mcpEntries(servers: readonly McpEntry[], piRoots: readonly string[]): ContextEntry[] {
	return servers.map((server) => {
		const note = server.enabled
			? server.state === "connected" && server.toolCount
				? `connected (${server.toolCount} tool${server.toolCount === 1 ? "" : "s"})`
				: server.state
			: "disabled";
		return {
			name: server.name,
			path: server.source,
			...mcpLabel(server, piRoots),
			// A server the security review withholds is switched on but does not load.
			state: server.enabled && server.state !== "not checked" ? "loaded" : "off",
			note,
		};
	});
}

export function buildContextView(input: ContextViewInput): ContextView {
	const known = new Set<ConfigKind>(GROUPS.flatMap((group) => group.kinds));
	// A kind discovery returns that the table does not name still appears, so a new kind needs no change here.
	const extra = [...input.discovery.keys()]
		.filter((kind) => !known.has(kind))
		.map((kind) => ({
			id: kind,
			title: `${kind[0].toUpperCase()}${kind.slice(1)}`,
			noun: [kind, `${kind}s`] as const,
			kinds: [kind],
		}));
	const groups: ContextGroup[] = [...GROUPS, ...extra].map((group) => ({
		id: group.id,
		title: group.title,
		noun: group.noun,
		entries:
			group.id === "mcp" && input.mcp
				? mcpEntries(input.mcp, input.piRoots ?? [])
				: group.kinds.flatMap((kind) => kindEntries(kind, input.discovery.get(kind) ?? [], input.loaded?.[kind])),
	}));
	// Code Octocode does not run is one group of its own, whatever kind it is: one place says it is not loaded.
	const code = groups.flatMap((group) => group.entries.filter((entry) => entry.state === "ignored"));
	for (const group of groups) group.entries = group.entries.filter((entry) => entry.state !== "ignored");
	const notLoaded: ContextGroup = {
		id: "extension",
		title: "Not loaded",
		noun: ["file not loaded", "files not loaded"],
		entries: code,
	};
	const shown = [...groups, notLoaded].filter((group) => group.entries.length > 0);
	return { groups: shown, warnings: contextWarnings(shown) };
}

/** The entries that apply (or, for code Octocode does not run, are present). Shadowed and untrusted copies do not count. */
export function activeEntries(group: ContextGroup): ContextEntry[] {
	return group.entries.filter((entry) => entry.state === "loaded" || entry.state === "ignored");
}

/** The value seen most often, first seen on a tie. */
function mostCommon(values: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * What no row says on its own, one line each: copies skipped because another of the same name loads (per kind, naming
 * where the winner loads from) and project items skipped for trust. Switched-off items are not warnings: the user chose.
 */
function contextWarnings(groups: readonly ContextGroup[]): ContextWarning[] {
	const all = groups.flatMap((group) => group.entries.map((entry) => ({ group, entry })));
	const describe = ({ group, entry }: (typeof all)[number], withNote: boolean) =>
		`${entry.source} ${group.title.toLowerCase()}: ${entry.name}${withNote ? ` \u2014 ${entry.note}` : ""}`;
	const warnings: ContextWarning[] = [];
	const add = (found: typeof all, text: string, withNote = true) => {
		if (found.length > 0) warnings.push({ text, details: found.map((item) => describe(item, withNote)) });
	};
	for (const group of groups) {
		const shadowed = all.filter((item) => item.group === group && item.entry.state === "shadowed");
		if (shadowed.length === 0) continue;
		const noun = group.noun[shadowed.length === 1 ? 0 : 1];
		const winner = mostCommon(shadowed.flatMap(({ entry }) => (entry.winner ? [entry.winner] : [])));
		const kept = group.id === "skill" && winner ? `, kept ${skillFolder(winner)}` : "";
		add(shadowed, `${shadowed.length} duplicate ${noun} skipped${kept} (ctrl+o lists)`);
	}
	const untrusted = all.filter(({ entry }) => entry.state === "untrusted");
	add(
		untrusted,
		`${untrusted.length} project ${untrusted.length === 1 ? "item" : "items"} not loaded: ${UNTRUSTED_NOTE}; run /trust`,
		false,
	);
	return warnings;
}

/** A group with at most this many items names them in the compact line; a larger one counts them per source. */
const NAMED_LIMIT = 3;

/**
 * `octocode global AGENTS.md · project AGENTS.md` for the context files and for a group of a few items, or
 * `octocode global 9 · pi global 2` for a longer one (skills are always counted: names are for the expanded list;
 * `counted` forces the counts, for a group whose names another column shows). Code that is not loaded reads
 * `legacy.ts (pi global) · convert to hooks.json or a plugin`; shadowed or untrusted copies are left to
 * {@link problemSummary}.
 */
export function sourceSummary(group: ContextGroup, options: { counted?: boolean } = {}): string {
	// Counted, a disabled server still has a source; shadowed and untrusted copies never do.
	const active = options.counted
		? group.entries.filter((entry) => entry.state === "loaded" || entry.state === "off")
		: activeEntries(group);
	const tally = (key: (entry: ContextEntry) => string) => {
		const counts = new Map<string, number>();
		for (const entry of active) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
		return counts;
	};
	const named = group.id === "context" || (group.id !== "skill" && active.length <= NAMED_LIMIT);
	const code = group.id === "extension";
	if (named && !options.counted) {
		const label = (entry: ContextEntry) => (code ? `${entry.name} (${entry.source})` : `${entry.source} ${entry.name}`);
		const parts = [...tally(label)].map(([text, count]) => (count > 1 ? `${text} \u00d7${count}` : text));
		return (code ? [...parts, PI_CODE_HINT] : parts).join(" \u00b7 ");
	}
	const parts = [...tally((entry) => entry.source)].map(([label, count]) => `${label} ${count}`);
	return (code ? [...parts, PI_CODE_HINT] : parts).join(" \u00b7 ");
}

/** `1 shadowed · 2 not trusted · 3 off` (the details say why in full): the copies of a group that do not apply. */
export function problemSummary(group: ContextGroup): string {
	const count = (state: EntryState) => group.entries.filter((entry) => entry.state === state).length;
	return [
		count("shadowed") > 0 ? `${count("shadowed")} duplicate` : "",
		count("untrusted") > 0 ? `${count("untrusted")} not trusted` : "",
		count("off") > 0 ? `${count("off")} off` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * `Found Pi configuration: 2 skills, 1 context file. Run /harness config ...`; undefined when nothing came from Pi. Code that is
 * not loaded is left out: its own row and the Not loaded hint already say so.
 */
export function piNoticeText(view: ContextView): string | undefined {
	const found = view.groups.flatMap((group) => {
		const count = group.entries.filter((entry) => entry.product === "pi" && entry.state !== "ignored").length;
		return count > 0 ? [`${count} ${group.noun[count === 1 ? 0 : 1]}`] : [];
	});
	if (found.length === 0) return undefined;
	return `Found Pi configuration: ${found.join(", ")}. Run /harness config to see where each item came from.`;
}
