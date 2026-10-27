import { animationClock, getCapabilities, getImageDimensions, imageFallback, MOTION } from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { formatDuration } from "../../octocode/shared/duration.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims = img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** Renderer state of {@link startToolTimer} and {@link toolTimerText}, kept in `ToolRenderContext.state`. */
interface ToolTimerState {
	startedAt?: number;
	endedAt?: number;
	/** Stops the row's repaint subscription on the animation clock. */
	unsubscribe?: () => void;
}

/** Start the row's clock once execution starts. Call from `renderCall`. */
export function startToolTimer(context: ToolRenderContext<ToolTimerState>): void {
	const state = context.state;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

/**
 * The row's timing line, from `renderResult`: `Elapsed 4.2s` while the result is partial, redrawn
 * every second, and `Took 4.2s` once it is final. Undefined when the row has no start time and no
 * recorded duration.
 */
export function toolTimerText(context: ToolRenderContext<ToolTimerState>, isPartial: boolean): string | undefined {
	const state = context.state;
	if (state.startedAt !== undefined && isPartial && !state.unsubscribe) {
		state.unsubscribe = animationClock.subscribe(() => context.invalidate(), { everyMs: MOTION.tickMs, kind: "info" });
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= Date.now();
		state.unsubscribe?.();
		state.unsubscribe = undefined;
	}
	// A final result's recorded duration wins: it is monotonic and survives reloads. The renderer's own clock is the
	// fallback for live progress and for results stored without one.
	if (!isPartial && context.durationMs !== undefined) return `Took ${formatDuration(context.durationMs, true)}`;
	if (state.startedAt === undefined) return undefined;
	const endTime = state.endedAt ?? Date.now();
	return `${isPartial ? "Elapsed" : "Took"} ${formatDuration(endTime - state.startedAt, true)}`;
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}
