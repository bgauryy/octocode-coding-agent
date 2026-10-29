import { GLYPH, Text } from "@octocodeai/octocode-tui";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { setToolInterruptShown } from "../../core/application/interrupted-tools.ts";
import { isRecord } from "../../utils/guards.ts";
import { formatDuration } from "../shared/format.ts";

/** The session entry (`api.appendEntry`, never sent to the model) that carries one turn's summary line. */
export const TURN_LINE_TYPE = "octocode-turn";

/** A turn shorter than this, with no tool, is not worth a line. */
const MIN_TURN_MS = 3_000;

/** `✻ Worked for 1m02s · 5 tools`, or undefined when the entry holds no usable duration. */
export function turnLineText(data: unknown): string | undefined {
	if (!isRecord(data) || typeof data.ms !== "number" || !Number.isFinite(data.ms)) return undefined;
	const tools =
		typeof data.tools === "number" && data.tools > 0 ? ` · ${data.tools} tool${data.tools === 1 ? "" : "s"}` : "";
	return `${GLYPH.turn} Worked for ${formatDuration(data.ms)}${tools}`;
}

/**
 * One dim line after the last assistant block of a run that took at least three seconds or used a tool. It is a
 * session entry, so it is not part of the model's context and is drawn again when the session resumes. Subagents
 * never register it (`registerUi` returns first): their sessions have no transcript on screen.
 *
 * Also records whether a tool of the run ended under an interrupt, which the message that follows the aborted row
 * reads so the interrupt is said once.
 */
export function registerTurnLine(api: ExtensionAPI): void {
	let startedAt = 0;
	let tools = 0;
	api.registerEntryRenderer(TURN_LINE_TYPE, (entry, _options, theme) => {
		const text = turnLineText(entry.data);
		return text ? new Text(theme.fg("dim", text), 1, 0) : undefined;
	});
	api.on("agent_start", async () => {
		startedAt = Date.now();
		tools = 0;
		setToolInterruptShown(false);
	});
	api.on("tool_execution_start", async (event) => {
		if (!event.parentToolCallId) tools += 1;
	});
	api.on("tool_execution_end", async (event, ctx) => {
		if (!event.parentToolCallId && event.isError && ctx.signal?.aborted) setToolInterruptShown(true);
	});
	api.on("agent_end", async (_event, ctx) => {
		const ms = Date.now() - startedAt;
		if (!ctx.hasUI || startedAt === 0 || (ms < MIN_TURN_MS && tools === 0)) return;
		api.appendEntry(TURN_LINE_TYPE, { ms, tools });
		startedAt = 0;
	});
}
