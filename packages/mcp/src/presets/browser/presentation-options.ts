import { isRecord } from "../../../../coding-agent/src/utils/guards.ts";

/** Tools whose `options` record is read by the engine as environment-style settings (`SHOT_ANNOTATE`, `MONITOR_MS`). */
const OPTION_TOOLS: ReadonlySet<string> = new Set(["screenshot", "snapshot", "check"]);

/**
 * The engine reads each option as a string and ignores anything else without an error: `SHOT_ANNOTATE: true` is
 * dropped, only `"1"` turns annotation on. Booleans become `"1"`/`"0"` and numbers become their decimal text; every
 * other value and every other argument passes through unchanged. The same object is returned when nothing changes.
 */
export function normalizeBrowserArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
	const options = args.options;
	if (!OPTION_TOOLS.has(tool) || !isRecord(options)) return args;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (typeof value === "boolean") next[key] = value ? "1" : "0";
		else if (typeof value === "number" && Number.isFinite(value)) next[key] = String(value);
		else next[key] = value;
		if (next[key] !== value) changed = true;
	}
	return changed ? { ...args, options: next } : args;
}
