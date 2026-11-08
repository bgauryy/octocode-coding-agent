import type {
	ProfileAgents,
	ProfileFinding,
	ProfileInsights,
	ProfileRequest,
	ProfileRequests,
	ProfileTimeline,
	ProfileUsage,
} from "@octocodeai/octocode-contracts/profiler";

/** `1234` as `1.2k`, `2_500_000` as `2.5M`: token counts as a person scans them. */
function tokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(Math.round(value));
}

const dollars = (value: number | undefined): string =>
	value === undefined ? "-" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
const percent = (value: number | undefined): string => (value === undefined ? "-" : `${Math.round(value * 100)}%`);

function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return minutes < 60
		? `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
		: `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Left-aligns every column except those named in `right`, two spaces apart; the last column is not padded. */
function table(head: string[], rows: string[][], right: number[] = []): string {
	const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, column) =>
				column === cells.length - 1 && !right.includes(column)
					? cell
					: right.includes(column)
						? cell.padStart(widths[column])
						: cell.padEnd(widths[column]),
			)
			.join("  ")
			.trimEnd();
	return [line(head), ...rows.map(line)].join("\n");
}

export function agentsTable({ sessionId, agents }: ProfileAgents): string {
	const rows = agents.map((agent) => [
		agent.parentId ? `  ${agent.id}` : agent.id,
		agent.role,
		agent.model ?? "-",
		agent.profiled ? String(agent.requests) : "n/a",
		percent(agent.hitRate),
		tokens(agent.totals.cacheWrite),
		dollars(agent.totals.cost),
	]);
	const spent = agents.reduce((sum, agent) => sum + (agent.totals.cost ?? 0), 0);
	return [
		`Session ${sessionId}: ${agents.length} agent${agents.length === 1 ? "" : "s"}, ${dollars(spent)}`,
		table(["AGENT", "ROLE", "MODEL", "REQ", "HIT", "WRITTEN", "COST"], rows, [3, 4, 5, 6]),
	].join("\n");
}

const impact = (finding: ProfileFinding): string => {
	if (finding.cost !== undefined) return dollars(finding.cost);
	if (finding.waitedMs !== undefined) return duration(finding.waitedMs);
	return finding.tokens !== undefined ? `${tokens(finding.tokens)} tok` : "-";
};

export function insightsTable({ sessionId, findings }: ProfileInsights): string {
	if (!findings.length) return `Session ${sessionId}: no findings.`;
	const rows = findings.map((finding) => [
		finding.severity,
		finding.kind,
		finding.agentId ?? "-",
		impact(finding),
		finding.title,
	]);
	return [
		`Session ${sessionId}: ${findings.length} finding${findings.length === 1 ? "" : "s"}, most costly first`,
		table(["SEV", "KIND", "AGENT", "COST", "FINDING"], rows, [3]),
		...findings.flatMap((finding) => ["", finding.title, `  ${finding.detail}`]),
	].join("\n");
}

const usageLine = (usage: ProfileUsage): string =>
	`in ${tokens(usage.input)}  read ${tokens(usage.cacheRead)}  written ${tokens(usage.cacheWrite)}  out ${tokens(usage.output)}${usage.cost === undefined ? "" : `  ${dollars(usage.cost)}`}`;

const time = (at: number): string => new Date(at).toISOString().slice(11, 19);

function layersOf(request: ProfileRequest): string {
	const rows = request.layers.map((layer, index) => [
		request.firstBreak === index ? ">" : " ",
		layer.state,
		layer.kind,
		layer.label,
		tokens(layer.tokens),
		layer.changed ? "changed" : "",
	]);
	return table(["", "STATE", "KIND", "LAYER", "TOKENS", ""], rows, [4]);
}

function requestHeader(request: ProfileRequest): string {
	const miss = request.missReason ? `  miss: ${request.missReason}` : "";
	return `#${request.index}  ${time(request.at)}  ${request.model}${request.estimated ? "  (estimated)" : ""}\n  ${usageLine(request.usage)}${miss}`;
}

/** One agent's requests, a line each; `layers` adds each request's layers (a single request always shows them). */
export function requestsTable({ agentId, requests }: ProfileRequests, layers: boolean): string {
	if (!requests.length) return `${agentId}: no requests.`;
	if (layers || requests.length === 1)
		return requests.map((request) => `${requestHeader(request)}\n${layersOf(request)}`).join("\n\n");
	const rows = requests.map((request) => {
		const prompt = request.usage.input + request.usage.cacheRead + request.usage.cacheWrite;
		return [
			String(request.index),
			time(request.at),
			tokens(prompt),
			prompt > 0 ? percent(request.usage.cacheRead / prompt) : "-",
			tokens(request.usage.cacheWrite),
			dollars(request.usage.cost),
			request.missReason ?? "",
		];
	});
	return `${agentId}: ${requests.length} request${requests.length === 1 ? "" : "s"}\n${table(["#", "AT", "PROMPT", "HIT", "WRITTEN", "COST", "MISS"], rows, [0, 2, 3, 4, 5])}`;
}

export function timelineTable({ sessionId, events }: ProfileTimeline): string {
	if (!events.length) return `Session ${sessionId}: no events.`;
	const start = events[0].at;
	const rows = events.map((event) => [
		`+${duration(event.at - start)}`,
		event.agentId,
		event.kind,
		event.durationMs === undefined ? "" : duration(event.durationMs),
		event.outcome && event.outcome !== "ok" ? `${event.label} (${event.outcome})` : event.label,
	]);
	return `Session ${sessionId}: ${events.length} events from ${time(start)}\n${table(["AT", "AGENT", "KIND", "TOOK", "WHAT"], rows, [0, 3])}`;
}
