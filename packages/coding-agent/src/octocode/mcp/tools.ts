import fs from "node:fs";
import { type CallToolResult, type Tool, toLlmContent } from "@octocodeai/octocode-mcp";
import type { TSchema } from "typebox";
import type {
	AgentToolResult,
	ToolAnnotations as PiToolAnnotations,
	ToolDefinition,
} from "../../core/extensions/index.ts";
import { LOCAL_READ_TOOLS } from "../shared/local-reads.ts";
import { isDirectResearchTool } from "../shared/octocode-tools.ts";
import { clip, queryTarget, resultBlock, resultText, timedTool, timingOf, toolHeader } from "../shared/render.ts";
import { visibleControls } from "../shared/sanitize.ts";
import { boundImagePart, capOutputToFile, saveFullOutput } from "../shared/spill.ts";
import { isRecord } from "../shared/util.ts";
import { type ImageLimits, imageLimits } from "../shared/vision.ts";

/** What the extension registers a server's tool as. */
interface ToolBinding {
	exposure?: "direct" | "deferred";
	/** Octocode's tool name prefix for the server, `mcp__octocode__`. */
	prefix: string;
	/** The tools' namespace: the server's name and its instructions. */
	namespace: NonNullable<ToolDefinition["namespace"]>;
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
	/** The text the turn's results have put in the context so far; every result of one assistant message shares it. */
	budget?: TurnBudget;
}

/** Hints the server gave about the tool, as Octocode's annotations (booleans only: nothing else is a hint). */
function annotations(tool: Tool): PiToolAnnotations | undefined {
	const hints = tool.annotations;
	if (!hints) return undefined;
	const picked: PiToolAnnotations = {};
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		if (typeof hints[key] === "boolean") picked[key] = hints[key];
	}
	return Object.keys(picked).length > 0 ? picked : undefined;
}

/** UTF-16 characters kept whole per MCP text part, allowing headroom around the server's 50,000-character page. */
export const TEXT_MAX_CHARS = 60_000;
/** Characters of tool results one assistant message may put in the context whole (Claude Code's per-message budget). */
export const TURN_MAX_CHARS = 200_000;
/** Space reserved for the recovery pointer when a turn exhausts its text budget. */
const RECOVERY_CHARS = 1024;

/** Bounds turn text; overflow records remain recoverable from the first omitted result's archive. */
export class TurnBudget {
	private used = 0;
	private archive: string | undefined;

	limit(): number {
		return Math.min(TEXT_MAX_CHARS, Math.max(0, TURN_MAX_CHARS - this.used - RECOVERY_CHARS));
	}

	charge(chars: number): void {
		this.used += chars;
	}

	text(text: string, tool: string): string {
		const preview = this.archive
			? ""
			: text.length <= TEXT_MAX_CHARS
				? text
				: capOutputToFile(text, { label: `mcp ${tool}`, maxBytes: TEXT_MAX_CHARS, maxLines: TEXT_MAX_CHARS + 1 });
		if (this.archive || preview.length > TURN_MAX_CHARS - this.used - RECOVERY_CHARS) {
			const record = `${JSON.stringify({ tool, text })}\n`;
			if (this.archive) {
				fs.appendFileSync(this.archive, record);
				return "";
			}
			const file = saveFullOutput(record, "mcp-turn-overflow");
			if (!file) throw new Error("Could not save MCP output beyond the turn budget");
			const note = `\n[Turn text budget reached. This result and all later omitted MCP text in this turn are saved as JSON lines at ${file}.]`;
			const gap = "\n[…]\n";
			const available = Math.min(
				text.length,
				TEXT_MAX_CHARS - note.length - gap.length,
				Math.max(0, TURN_MAX_CHARS - this.used - note.length - gap.length),
			);
			if (note.length + gap.length > TURN_MAX_CHARS - this.used)
				throw new Error("MCP recovery pointer exceeds remaining turn budget");
			this.archive = file;
			const head = Math.floor(available * 0.7);
			const shown = `${text.slice(0, head)}${gap}${available > head ? text.slice(-(available - head)) : ""}${note}`;
			this.charge(shown.length);
			return shown;
		}
		this.charge(preview.length);
		return preview;
	}

	reset(): void {
		this.used = 0;
		this.archive = undefined;
	}
}

/**
 * A tool result for Octocode. Text and images pass through, embedded text resources become text and other blocks a short
 * placeholder (`toLlmContent`). A server bounds and pages its own output and a cut can hide the continuation inside
 * it, so text is left whole up to `TEXT_MAX_CHARS` (less once the turn's `budget` is nearly used); a longer part is
 * saved whole to the session's `output/` folder and replaced by its head and tail plus the file's path. An oversized
 * image is saved and resized by Octocode to `limits` (the active model's image limit, `imageLimits(ctx.model)`); the model sees the fitted image, its original path and the
 * dimension mapping (only the path if resizing fails). Repository, GitHub and registry text is untrusted: terminal control
 * characters, bidi overrides and invisible characters (Unicode tags among them) are shown as visible escapes
 * (`\u{200d}`, `\r`) in every string before the model reads it or the terminal draws it, so nothing the server
 * returned disappears and nothing raw reaches the terminal. `structuredContent` is the server's, kept for tools that declare an
 * `outputSchema`. Oversized structured results become explicit errors with a saved JSON recovery path.
 * An error result is the server's text as an error.
 */
export async function toToolResult(
	tool: string,
	result: CallToolResult,
	declaresOutput: boolean,
	limits?: ImageLimits,
	budget?: TurnBudget,
): Promise<AgentToolResult<{ tool: string }>> {
	const content: AgentToolResult["content"] = [];
	let outputTruncated = false;
	let structuredContent =
		declaresOutput && result.structuredContent !== undefined
			? sanitizeJson(result.structuredContent) as AgentToolResult["structuredContent"]
			: undefined;
	let failed = result.isError;
	if (structuredContent !== undefined) {
		const serialized = JSON.stringify(structuredContent);
		if (serialized.length > TEXT_MAX_CHARS) {
			const file = saveFullOutput(serialized, `mcp-${tool}-structured`);
			structuredContent = undefined;
			failed = true;
			result = {
				...result,
				content: [{
					type: "text",
					text: file
						? `Structured result exceeds ${TEXT_MAX_CHARS} characters. Full JSON: ${file}. Request a smaller page or read the saved JSON.`
						: "Structured result exceeds the output limit and could not be saved. Request a smaller page.",
				}],
			};
		}
	}
	for (const part of sanitizeJson(toLlmContent(result)) as ReturnType<typeof toLlmContent>) {
		if (part.type === "text") {
			const text = budget
				? budget.text(part.text, tool)
				: part.text.length <= TEXT_MAX_CHARS
					? part.text
					: capOutputToFile(part.text, { label: `mcp ${tool}`, maxBytes: TEXT_MAX_CHARS, maxLines: TEXT_MAX_CHARS + 1 });
			outputTruncated ||= text !== part.text;
			content.push({ ...part, text });
		} else if (part.type === "image") {
			for (const bounded of await boundImagePart(part, `mcp ${tool} image`, limits ? { limits } : {})) {
				content.push(bounded.type === "text" && budget ? { ...bounded, text: budget.text(bounded.text, tool) } : bounded);
			}
		} else content.push(part);
	}
	if (failed && content.length === 0) {
		const text = `${tool} failed without a message.`;
		content.push({ type: "text", text: budget ? budget.text(text, tool) : text });
	}
	return {
		content,
		details: { tool, ...(outputTruncated ? { outputTruncated: true } : {}) },
		...(structuredContent !== undefined ? { structuredContent } : {}),
		...(failed ? { isError: true } : {}),
	};
}

/** Every string in a JSON value with its control and invisible characters made visible; the same object when nothing changed. */
export function sanitizeJson(value: unknown): unknown {
	if (typeof value === "string") return visibleControls(value);
	if (Array.isArray(value)) {
		const next = value.map(sanitizeJson);
		return next.some((item, i) => item !== value[i]) ? next : value;
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			next[key] = sanitizeJson(item);
			if (next[key] !== item) changed = true;
		}
		return changed ? next : value;
	}
	return value;
}

/** The call's header: the tool name, then what its first query looks for; a batch adds one line per query. */
function callSummary(args: unknown): { summary: string; queries: string[] } {
	const queries = isRecord(args) && Array.isArray(args.queries) ? args.queries.filter(isRecord) : [];
	const targets = queries.map((query) => clip(queryTarget(query), 200));
	return {
		summary: targets.length === 1 ? targets[0]! : targets.length > 1 ? `${targets.length} queries` : "",
		queries: targets.length > 1 ? targets : [],
	};
}

/**
 * The Octocode tool for one tool the server lists. Its input schema is the server's JSON Schema as is (Octocode validates calls
 * against it). The local research tools are `direct`, declared to the model from the first request; the server's other
 * tools use the exposure the host resolves from catalog size and provider support.
 */
export function octocodeToolDefinition(tool: Tool, binding: ToolBinding): ToolDefinition {
	const hints = annotations(tool);
	const name = `${binding.prefix}${tool.name}`;
	// Local readers send structured evidence even when their server omits an output schema.
	const outputSchema = tool.outputSchema ?? (LOCAL_READ_TOOLS.has(name) ? {} : undefined);
	const declaresOutput = outputSchema !== undefined;
	return timedTool({
		name,
		label: tool.title?.trim() || tool.name,
		description: tool.description?.trim() || tool.title?.trim() || `Octocode tool ${tool.name}`,
		parameters: tool.inputSchema as unknown as TSchema,
		...(declaresOutput ? { outputSchema: outputSchema as unknown as TSchema } : {}),
		exposure: isDirectResearchTool(name) ? "direct" : (binding.exposure ?? "direct"),
		namespace: binding.namespace,
		...(hints ? { annotations: hints } : {}),
		renderCall(args, theme, context) {
			const { summary, queries } = callSummary(args);
			const lines = queries.map((query) => `${theme.fg("mdCode", query)}`);
			return toolHeader(theme, context, tool.name, summary, { lines });
		},
		renderResult(result, _options, theme, context) {
			const text = resultText(result);
			// An error is one message: its first line is the summary, the rest the body.
			const failed = context.isError === true;
			return resultBlock(theme, context, {
				summary: failed ? text : "",
				body: failed ? text.split("\n").slice(1).join("\n") : text,
				...timingOf(result.details),
			});
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return toToolResult(
				tool.name,
				await binding.call(tool.name, isRecord(params) ? params : {}, signal),
				declaresOutput,
				imageLimits(ctx.model),
				binding.budget,
			);
		},
	});
}
