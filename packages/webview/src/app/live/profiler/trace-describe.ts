import { formatTokens } from "../profiler-model.ts";
import type { Arrow } from "./trace-arrows.ts";
import { formatDuration, formatLatency } from "./trace-format.ts";
import type { LaneItem } from "./trace-model.ts";

/** Text for assistive technology and the crosshair tooltip. */

export function describeItem(item: LaneItem): string {
	const { event, request } = item;
	const duration = event.durationMs ? `, ${formatDuration(event.durationMs)}` : "";
	if (event.kind === "request") {
		const name = event.ref?.request === undefined ? "request" : `request ${event.ref.request}`;
		const running = item.open ? ", running" : "";
		if (!request) return `${name}${event.tokens ? `, ${formatTokens(event.tokens)} tokens` : ""}${duration}${running}`;
		const { cacheRead, cacheWrite, input } = request.usage;
		const broke = request.firstBreak === undefined ? "" : ", cache break";
		return `${name}, ${formatTokens(cacheRead)} cached, ${formatTokens(cacheWrite)} written, ${formatTokens(input)} uncached${duration}${broke}`;
	}
	const outcome = event.outcome && event.outcome !== "ok" ? `, ${event.outcome}` : "";
	return `${event.kind} ${event.label}${outcome}${duration}${item.open ? ", running" : ""}`;
}

export function describeArrow(arrow: Arrow): string {
	const { message } = arrow;
	return `message ${message.id} from ${message.from} to ${message.to.join(", ")}, ${message.state}, delivered ${formatLatency(message.deliveredMs)}`;
}

/** The crosshair tooltip lines of an item: what it is, how long, tokens and cache share. */
export function tooltipLines(item: LaneItem): string[] {
	const { event, cache, request } = item;
	const lines = [event.label];
	const facts: string[] = [event.kind];
	if (event.durationMs) facts.push(formatDuration(event.durationMs));
	for (const [phase, ms] of Object.entries(event.phases ?? {}))
		if (phase !== "execute" && phase !== "stream" && ms)
			facts.push(`${phase === "firstToken" ? "first token" : phase} ${formatDuration(ms)}`);
	if (item.open) facts.push("running");
	if (event.outcome && event.outcome !== "ok") facts.push(event.outcome);
	lines.push(facts.join(" \u00B7 "));
	if (request && cache) {
		const tokens = request.usage.input + request.usage.cacheRead + request.usage.cacheWrite;
		lines.push(`${formatTokens(tokens)} tokens \u00B7 ${Math.round(cache.cached * 100)}% cached`);
		if (request.missReason) lines.push(request.missReason);
	} else if (event.tokens) lines.push(`${formatTokens(event.tokens)} tokens`);
	return lines;
}
