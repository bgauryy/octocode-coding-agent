import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { columnRows } from "../../theme/columns.ts";
import { entityOfRole } from "../shared/entity.ts";
import { formatSpan } from "../shared/format.ts";
import { plural } from "../shared/text.ts";
import type { Growth, Orphan, ProcessEntry, ProcessReport } from "./classify.ts";

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const rss = (kb: number) => mb(kb * 1024);
const growth = (value: Growth) => `growing: ${mb(value.from)} → ${mb(value.to)} in ${formatSpan(value.spanMs)}`;

function ownerNote(entry: ProcessEntry): string {
	if (entry.ownerPid === null) return "—";
	return `${entry.ownerPid} ${entry.ownerAlive ? "alive" : "GONE"}`;
}

function orphanLine(orphan: Orphan, width: number | undefined): string {
	const why =
		orphan.reason === "owner-gone" ? `owner ${orphan.ownerLabel} is gone` : `reparented away from ${orphan.ownerLabel}`;
	const line = `  pid ${orphan.pid} · ${orphan.kind} · ${why} · ${rss(orphan.rssKb)} · up ${formatSpan(orphan.ageMs)} · ${orphan.label}`;
	return width === undefined ? line : truncateToWidth(line, width);
}

export interface FormatOptions {
	/** Terminal columns a row may use. Set, a table that is wider than this is laid out in fewer columns. Unset: full table. */
	width?: number;
	/** Processes of other sessions on the machine that the listing leaves out; a line says how to see them. */
	hidden?: number;
}

const HEAD = ["NAME", "API", "PID", "PPID", "OWNER", "RSS", "AGE"];
const COMPACT_HEAD = ["NAME", "PID", "RSS", "AGE"];

function flagsOf(entry: ProcessEntry): string {
	return [entry.self && "this session", entry.growth && growth(entry.growth)].filter(Boolean).join("; ");
}

/** The processes' own rows: the full table, or at a narrow width the name, pid, memory and age with the rest under each. */
function processLines(
	processes: readonly ProcessEntry[],
	width: number | undefined,
): { head: string; rows: string[][] } {
	const named = (entry: ProcessEntry) => `${entityOfRole(entry.role)} ${entry.title}`;
	const full = columnRows(
		[
			HEAD,
			...processes.map((entry) => [
				named(entry),
				entry.apiId ?? "off",
				String(entry.pid),
				String(entry.ppid),
				ownerNote(entry),
				rss(entry.rssKb),
				formatSpan(entry.ageMs),
				flagsOf(entry) ? ` ← ${flagsOf(entry)}` : "",
			]),
		],
		{ gap: 1, min: [27 + 3, 10, 7, 7, 11, 8] },
	);
	if (width === undefined || full.every((line) => visibleWidth(line) <= width))
		return { head: full[0], rows: full.slice(1).map((line) => [line]) };
	const compact = columnRows(
		[
			COMPACT_HEAD,
			...processes.map((entry) => [named(entry), String(entry.pid), rss(entry.rssKb), formatSpan(entry.ageMs)]),
		],
		{ width, flex: [0] },
	);
	return {
		head: compact[0],
		rows: processes.map((entry, index) => {
			const detail = [`api ${entry.apiId ?? "off"}`, `ppid ${entry.ppid}`, `owner ${ownerNote(entry)}`];
			if (flagsOf(entry)) detail.push(`← ${flagsOf(entry)}`);
			return [compact[index + 1], truncateToWidth(`    ${detail.join(" · ")}`, width)];
		}),
	};
}

function childLines(processes: readonly ProcessEntry[], width: number | undefined): string[][] {
	const children = processes.flatMap((entry) => entry.children);
	const rows = columnRows(
		children.map((child) => [
			child.kind,
			`pid ${child.pid}`,
			rss(child.rssKb),
			formatSpan(child.ageMs),
			`${child.label}${child.growth ? `  ← ${growth(child.growth)}` : ""}`,
		]),
		{ gap: 1, indent: "    ", min: [8, 10, 8, 6], flex: [4], width },
	);
	let next = 0;
	return processes.map((entry) => rows.slice(next, (next += entry.children.length)));
}

/**
 * The `/processes` listing: the processes, each after its entity mark (main session or subagent), with their children,
 * then the orphans and what to do about them. Rows are never wrapped: `width` cuts the flexible columns.
 */
export function formatReport(report: ProcessReport, { width, hidden = 0 }: FormatOptions = {}): string {
	const { processes, orphans } = report;
	const lines = [
		processes.length
			? `Octocode processes: ${plural(processes.length, "process", "processes")}`
			: "No Octocode process found with a title or a recorded sample.",
	];
	if (processes.length) {
		const { head, rows } = processLines(processes, width);
		const children = childLines(processes, width);
		lines.push(head, ...rows.flatMap((row, index) => [...row, ...children[index]]));
	}
	if (hidden)
		lines.push("", `${plural(hidden, "process", "processes")} of other sessions not shown: /processes all lists them.`);
	if (processes.length)
		lines.push(
			"",
			"From another process: octocode-api status --to <name or API id>. API off: run /api on in that session.",
		);
	if (orphans.length) {
		lines.push("", `Orphans (${orphans.length}): started by an Octocode that is gone or no longer their parent`);
		lines.push(...orphans.map((orphan) => orphanLine(orphan, width)));
		lines.push(
			"Stop them with /processes stop (it asks first and signals only processes Octocode recorded as its own).",
		);
	} else if (processes.length) lines.push("", "No orphans.");
	return lines.join("\n");
}
