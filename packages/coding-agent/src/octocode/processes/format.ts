import { formatSpan } from "../shared/format.ts";
import { plural } from "../shared/render/text.ts";
import type { Growth, Orphan, ProcessEntry, ProcessReport } from "./classify.ts";

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const rss = (kb: number) => mb(kb * 1024);
const growth = (value: Growth) => `growing: ${mb(value.from)} → ${mb(value.to)} in ${formatSpan(value.spanMs)}`;
const pad = (text: string | number, width: number) => String(text).padEnd(width);

function ownerNote(entry: ProcessEntry): string {
	if (entry.ownerPid === null) return "—";
	return `${entry.ownerPid} ${entry.ownerAlive ? "alive" : "GONE"}`;
}

function orphanLine(orphan: Orphan): string {
	const why =
		orphan.reason === "owner-gone" ? `owner ${orphan.ownerLabel} is gone` : `reparented away from ${orphan.ownerLabel}`;
	return `  pid ${orphan.pid} · ${orphan.kind} · ${why} · ${rss(orphan.rssKb)} · up ${formatSpan(orphan.ageMs)} · ${orphan.label}`;
}

/** The `/processes` listing: the processes with their children, then the orphans and what to do about them. */
export function formatReport(report: ProcessReport): string {
	const { processes, orphans } = report;
	const lines = [
		processes.length
			? `Octocode processes: ${plural(processes.length, "process", "processes")}`
			: "No Octocode process found with a title or a recorded sample.",
	];
	if (processes.length)
		lines.push(
			[pad("NAME", 30), pad("API", 10), pad("PID", 7), pad("PPID", 7), pad("OWNER", 11), pad("RSS", 8), "AGE"].join(
				" ",
			),
		);
	for (const entry of processes) {
		const flags = [entry.self && "this session", entry.growth && growth(entry.growth)].filter(Boolean).join("; ");
		lines.push(
			[
				pad(entry.title, 30),
				pad(entry.apiId ?? "off", 10),
				pad(entry.pid, 7),
				pad(entry.ppid, 7),
				pad(ownerNote(entry), 11),
				pad(rss(entry.rssKb), 8),
				formatSpan(entry.ageMs),
			].join(" ") + (flags ? `  ← ${flags}` : ""),
		);
		for (const child of entry.children)
			lines.push(
				`    ${pad(child.kind, 8)} pid ${pad(child.pid, 6)} ${pad(rss(child.rssKb), 8)} ${pad(formatSpan(child.ageMs), 6)} ${child.label}${child.growth ? `  ← ${growth(child.growth)}` : ""}`,
			);
	}
	if (processes.length)
		lines.push(
			"",
			"From another process: octocode-api status --to <name or API id>. API off: run /api on in that session.",
		);
	if (orphans.length) {
		lines.push("", `Orphans (${orphans.length}): started by an Octocode that is gone or no longer their parent`);
		lines.push(...orphans.map(orphanLine));
		lines.push(
			"Stop them with /processes stop (it asks first and signals only processes Octocode recorded as its own).",
		);
	} else if (processes.length) lines.push("", "No orphans.");
	return lines.join("\n");
}
