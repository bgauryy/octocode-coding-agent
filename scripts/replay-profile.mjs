/**
 * Summarizes a V8 `.cpuprofile` written by a session replay (`scripts/replay-session.mjs --profile`): the functions with
 * the most self time, and the total split by the part of Octocode that owns it. Each sample is charged to the innermost
 * frame on its stack that belongs to an owned area, so a `JSON.stringify` called by the session writer counts as the
 * session writer and a path canonicalized by `common` for the permission check counts as the permission check; a sample with no owned frame counts as its runtime bucket (garbage collection, idle, Node, Vitest).
 */
import { readFileSync } from "node:fs";

/** Owned areas, first match wins: more specific paths come before the folders that hold them. */
const AREAS = [
	["replay harness", /\/test\/octocode\/(replay\/|e2e-replay)/],
	["DB mirror writer", /\/src\/core\/session-manager\/mirror/],
	["session manager (persistence, codec)", /\/src\/core\/session-manager/],
	["profiler and stall recorder", /\/src\/octocode\/profiler\//],
	["compaction", /\/src\/core\/compaction\/|\/src\/octocode\/compaction\/|\/src\/core\/session-compaction/],
	[
		"prompt and section building",
		/\/src\/octocode\/instructions\/|\/src\/core\/(system-prompt|prompt|resource-loader)|\/src\/octocode\/prompt-optimization\//,
	],
	["agent loop", /\/packages\/agent\/src\/|\/src\/core\/agent-session/],
	["provider and streaming (ai)", /\/packages\/ai\/src\//],
];

/**
 * Shared layers whose time belongs to whoever called them (a path canonicalized for the permission check, a query for the
 * team store); charged to them only when no owned frame is above.
 */
const PASS_THROUGH = [
	[/\/packages\/common\/src\//, "workspace common (no owner above)"],
	[/\/packages\/db\/src\//, "workspace db (no owner above)"],
];

/** The rest of the source, by owner folder: `octocode/<feature>`, `core/<module>`, or the workspace. */
const FOLDERS = [
	[/\/packages\/coding-agent\/src\/octocode\/([^/.]+)/, (name) => `other Octocode: ${name}`],
	[/\/packages\/coding-agent\/src\/([^/]+\/[^/.]+|[^/.]+)/, (name) => `other coding-agent: ${name}`],
	[/\/packages\/([^/]+)\/src\//, (name) => `workspace ${name}`],
];

const RUNTIME = {
	"(garbage collector)": "garbage collection",
	"(idle)": "idle",
	"(program)": "V8 and native (no JS frame)",
	"(root)": "V8 and native (no JS frame)",
};

function areaOf(url) {
	const named = AREAS.find(([, pattern]) => pattern.test(url))?.[0];
	if (named) return named;
	for (const [pattern, label] of FOLDERS) {
		const match = pattern.exec(url);
		if (match) return label(match[1]);
	}
	return undefined;
}

/** The innermost source frame above a sample (not Node, not a dependency): who asked for the time. */
const isSource = (url) => /\/(packages|scripts)\//.test(url) && !url.includes("/node_modules/");

function runtimeBucket(frame) {
	if (RUNTIME[frame.functionName]) return RUNTIME[frame.functionName];
	if (/vitest|vite-node|@vitest/.test(frame.url)) return "Vitest";
	if (frame.url.startsWith("node:") || frame.url === "") return "Node and builtins";
	return "dependencies";
}

const short = (url) => url.replace(/^file:\/\//, "").replace(/^.*?\/(packages|node_modules|scripts)\//, "$1/");

/** Areas under half a percent, merged into one row. */
function collapse(rows) {
	const kept = rows.filter((row) => row.pct >= 0.5);
	const small = rows.filter((row) => row.pct < 0.5);
	if (small.length === 0) return kept;
	const sum = (key) => Math.round(small.reduce((total, row) => total + row[key], 0) * 10) / 10;
	return [...kept, { area: `${small.length} smaller areas`, ms: sum("ms"), pct: sum("pct") }];
}

/** Reads `file` and returns the hotspots and the split, in milliseconds and percent of the profile's time. */
export function summarizeProfile(file, top = 20) {
	const profile = JSON.parse(readFileSync(file, "utf8"));
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parent = new Map();
	for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
	const selfUs = new Map();
	// V8 stores the time before each sample: sample i lasted until sample i + 1.
	for (let i = 0; i < profile.samples.length; i++) {
		const delta = profile.timeDeltas[i + 1] ?? 0;
		selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + delta);
	}
	const ownerCache = new Map();
	const ownerOf = (id) => {
		if (ownerCache.has(id)) return ownerCache.get(id);
		const chain = [];
		let owner;
		let shared;
		for (let at = id; at !== undefined; at = parent.get(at)) {
			chain.push(at);
			const url = nodes.get(at).callFrame.url;
			const layer = PASS_THROUGH.find(([pattern]) => pattern.test(url));
			if (layer) {
				shared ??= layer[1];
				continue;
			}
			owner = areaOf(url);
			if (owner) break;
		}
		owner ??= shared ?? runtimeBucket(nodes.get(id).callFrame);
		for (const at of chain) if (!ownerCache.has(at)) ownerCache.set(at, owner);
		return owner;
	};
	/** The two innermost source frames above a sample (`inner < outer`): who asked for the time. */
	const callerOf = (id) => {
		const frames = [];
		for (let at = parent.get(id); at !== undefined && frames.length < 2; at = parent.get(at)) {
			const frame = nodes.get(at).callFrame;
			if (isSource(frame.url))
				frames.push(`${frame.functionName || "(anonymous)"} ${short(frame.url)}:${frame.lineNumber + 1}`);
		}
		return frames.length > 0 ? frames.join(" < ") : "(no source frame)";
	};
	const total = [...selfUs.values()].reduce((sum, value) => sum + value, 0);
	const functions = new Map();
	const areas = new Map();
	for (const [id, us] of selfUs) {
		const frame = nodes.get(id).callFrame;
		const key = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
		const entry = functions.get(key) ?? {
			name: frame.functionName || "(anonymous)",
			where: frame.url ? `${short(frame.url)}:${frame.lineNumber + 1}` : "(native)",
			areas: new Map(),
			us: 0,
			callers: new Map(),
		};
		entry.us += us;
		entry.areas.set(ownerOf(id), (entry.areas.get(ownerOf(id)) ?? 0) + us);
		const caller = isSource(frame.url) ? undefined : callerOf(id);
		if (caller) entry.callers.set(caller, (entry.callers.get(caller) ?? 0) + us);
		functions.set(key, entry);
		const area = ownerOf(id);
		areas.set(area, (areas.get(area) ?? 0) + us);
	}
	const pct = (us) => Math.round((us / total) * 1000) / 10;
	const msOf = (us) => Math.round(us / 1000);
	return {
		totalMs: msOf(total),
		hotspots: [...functions.values()]
			.sort((a, b) => b.us - a.us)
			.slice(0, top)
			.map((entry) => ({
				name: entry.name,
				where: entry.where,
				area: [...entry.areas.entries()].sort((a, b) => b[1] - a[1])[0][0],
				ms: msOf(entry.us),
				pct: pct(entry.us),
				// For a native or Node function, the source frames that called it most.
				callers: [...entry.callers.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([caller, us]) => `${caller} (${msOf(us)} ms)`),
			})),
		areas: collapse(
			[...areas.entries()].sort((a, b) => b[1] - a[1]).map(([area, us]) => ({ area, ms: msOf(us), pct: pct(us) })),
		),
	};
}

/** The summary as Markdown tables. */
export function profileMarkdown(file, summary) {
	const lines = [
		`## CPU profile`,
		"",
		`\`${file}\`: ${summary.totalMs} ms sampled.`,
		"",
		"Time by area (self time, charged to the innermost owned frame):",
		"",
	];
	lines.push("| Area | ms | % |", "| --- | --- | --- |");
	for (const row of summary.areas) lines.push(`| ${row.area} | ${row.ms} | ${row.pct} |`);
	lines.push(
		"",
		`Top ${summary.hotspots.length} functions by self time:`,
		"",
		"| # | Function | Where | Area | ms | % | Called from |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	summary.hotspots.forEach((row, index) =>
		lines.push(
			`| ${index + 1} | \`${row.name}\` | ${row.where} | ${row.area} | ${row.ms} | ${row.pct} | ${row.callers.join("<br>")} |`,
		),
	);
	return `${lines.join("\n")}\n`;
}
