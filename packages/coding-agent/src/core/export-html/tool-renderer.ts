/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders tool calls and results to HTML from their display (the data every surface draws); a tool without one is
 * drawn by its TUI renderers with the ANSI output converted to HTML.
 */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai";
import { resultPurposeData } from "@octocodeai/octocode-contracts";
import type { Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../features/types.ts";
import { buildToolDisplay } from "../application/transcript-display.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";
import { displayCallHtml, displayResultHtml } from "./display-html.ts";
import type { ToolHtmlRenderer } from "./index.ts";

interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, as resolved by extensions and the registered tool */
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
	/** The reason row of a tool call, as the terminal draws it; supplied by the host because `core/` cannot import the tool views. */
	reasonRow: ToolRowView;
	/** The purpose block below a tool result (what its own data states per query row), likewise supplied by the host. */
	purposeRows: ToolRowView;
}

export type ToolRowView = (toolName: string, args: unknown, structuredContent?: unknown) => Component | undefined;

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100, reasonRow, purposeRows } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
			durationMs: undefined,
			outputPad: 1,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				// A tool with a display is drawn from it, like every other surface; terminal output is the fallback.
				if (toolDef?.display)
					return displayCallHtml(buildToolDisplay(toolDef.display, { toolName, args, text: "", status: "running" }));
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				// The shared reason row of the TUI, so an exported native call states its goal under its header.
				lines.push(...(reasonRow(toolName, args)?.render(width) ?? []));
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
			structuredContent?: unknown,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolRenderers(toolName);
				if (toolDef?.display) {
					const content = result as (TextContent | ImageContent)[];
					const display = buildToolDisplay(toolDef.display, {
						toolName,
						args: renderedArgs.get(toolCallId),
						result: { content, details, isError, structuredContent },
						text: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
						status: isError ? "failed" : "completed",
					});
					// The call header already states a native call's reason; an MCP call's comes from its result.
					const reason = display.reason && renderedArgs.has(toolCallId) ? "" : (display.reason ?? "");
					const lead = reason
						? `<div class="tool-reason">↳ ${reason.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`
						: "";
					const html = displayResultHtml(display);
					return {
						...(html.collapsed !== html.expanded ? { collapsed: lead + html.collapsed } : {}),
						expanded: lead + html.expanded,
					};
				}
				if (!toolDef?.renderResult) {
					return undefined;
				}
				// An MCP call's purpose comes from its result, so it opens the result, right under the call. Without the
				// arguments a native tool's reason row (drawn with its call) is not repeated here.
				const stated = resultPurposeData({ structuredContent, content: result });
				const purpose = reasonRow(toolName, undefined, stated)?.render(width) ?? [];
				// Under the result message, below its output, and not repeating the reason row above.
				const returned = purposeRows(toolName, renderedArgs.get(toolCallId), stated)?.render(width) ?? [];

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml([
					...purpose,
					...trimRenderedResultLines(collapsedComponent.render(width)),
					...returned,
				]);

				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml([
					...purpose,
					...trimRenderedResultLines(expandedComponent.render(width)),
					...returned,
				]);

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},
	};
}
