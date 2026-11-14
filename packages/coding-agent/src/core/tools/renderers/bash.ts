/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Spacer, Text, VisualLinePreview } from "@octocodeai/octocode-tui";
import { foldHint, TOOL_PREVIEW_LINES } from "../../../theme/theme-tui-helpers.ts";
import { stateMark, type UiState } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { formatDuration } from "../../../utils/duration.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../features/types.ts";
import type { BashToolDetails } from "../bash/outcome.ts";
import { getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
import { reuseText } from "./output.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

export const BASH_UPDATE_THROTTLE_MS = 100;
function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
/** How a finished run ended: a nonzero exit or timeout failed, an abort or kill was stopped. */
function endState(details: BashToolDetails | undefined, header: string | undefined, isError: boolean): UiState {
	if (
		details?.termination === "aborted" ||
		details?.termination === "terminated" ||
		/^\[(?:aborted|terminated)/.test(header ?? "")
	)
		return "stopped";
	if (
		isError ||
		details?.termination === "timeout" ||
		(details?.exitCode !== undefined && details.exitCode !== 0 && details.exitCode !== null)
	)
		return "failed";
	return "done";
}

/** The mark and words that end a run, so its outcome does not rest on band tint: `✗ exit 1 · 0.4s`. */
function outcomeLine(
	state: UiState,
	header: string | undefined,
	details: BashToolDetails | undefined,
	durationMs: number | undefined,
): string {
	const words =
		header ??
		[
			state === "stopped"
				? "cancelled"
				: details?.termination === "timeout"
					? "timed out"
					: typeof details?.exitCode === "number"
						? `exit ${details.exitCode}`
						: undefined,
			durationMs === undefined ? undefined : formatDuration(durationMs, true),
		]
			.filter(Boolean)
			.join(" · ");
	return `${stateMark(theme, state)} ${theme.fg(state === "done" ? "muted" : "text", words)}`.trimEnd();
}

function rebuildBashResultRenderComponent(
	component: Container,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	timerText: string | undefined,
	finish: { isError: boolean; durationMs: number | undefined },
): void {
	component.clear();
	// One blank row separates the result from the command; its parts follow each other without more.
	let lead = "\n";
	const addLine = (text: string) => {
		component.addChild(new Text(`${lead}${text}`, 0, 0));
		lead = "";
	};

	let output = getTextOutput(result, showImages).trim();
	// The result's first line (`[exit 0 · 4.2s · 312 lines · 18 KB]`) is the status; it stays visible above the collapsed output.
	const header = options.isPartial
		? undefined
		: /^\[(?:exit|timed out|aborted|terminated)[^\n]*\](?:\n|$)/.exec(output)?.[0];
	if (header) output = output.slice(header.length).trim();
	const state = options.isPartial ? undefined : endState(result.details, header, finish.isError);
	if (state) {
		const line = outcomeLine(state, header?.trim(), result.details, finish.durationMs);
		if (line) addLine(line);
	}
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg(state === "failed" ? "text" : "toolOutput", line))
			.join("\n");

		if (options.expanded) {
			addLine(styledOutput);
		} else {
			if (lead) component.addChild(new Spacer(1));
			lead = "";
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: TOOL_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) => foldHint(hidden, true),
				}),
			);
		}
	}

	if (!header && (truncation?.truncated || fullOutputPath)) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		addLine(theme.fg("warning", `[${warnings.join(". ")}]`));
	}

	// The outcome line already carries a finished run's duration: the clock shows only while it runs, or when no
	// duration reached the outcome.
	const durationShown = state !== undefined && (header !== undefined || finish.durationMs !== undefined);
	if (timerText && !durationShown) addLine(theme.fg("muted", timerText));
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			startToolTimer(context);
			return reuseText(context, formatShellCall(args as { command?: string; timeout?: number } | undefined, prompt));
		},
		renderResult(result, options, _theme, context) {
			const timerText = toolTimerText(context, options.isPartial);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildBashResultRenderComponent(component, result, options, context.showImages, timerText, {
				isError: context.isError,
				durationMs: context.durationMs,
			});
			component.invalidate();
			return component;
		},
	};
}
