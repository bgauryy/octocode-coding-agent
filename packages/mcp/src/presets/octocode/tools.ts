import { type CallToolResult, toLlmContent } from "../../client/index.ts";
import type { AgentToolResult } from "../../../../coding-agent/src/core/extensions/index.ts";
import { createMcpToolName } from "../../tool-names.ts";
import { createMcpToolDefinition, type McpToolDefinitionOptions } from "../../tool-definition.ts";
import { OCTOCODE_SERVER, LOCAL_READ_TOOLS } from "./names.ts";
import { resultBlock, resultText, toolHeader } from "../../../../coding-agent/src/octocode/shared/render.ts";
import { visibleControls } from "../../../../coding-agent/src/octocode/shared/sanitize.ts";
import { boundImagePart, capOutputToFile, saveFullOutput } from "../../../../coding-agent/src/octocode/shared/spill.ts";
import { TEXT_MAX_CHARS } from "../../../../coding-agent/src/octocode/shared/turn-budget.ts";
import { clip, queryTarget } from "../../../../coding-agent/src/octocode/shared/render/text.ts";
import { timedTool, timingOf } from "../../../../coding-agent/src/octocode/shared/render/rows.ts";
import { isRecord } from "../../../../coding-agent/src/utils/guards.ts";
import { type ImageLimits, imageLimits } from "../../../../coding-agent/src/octocode/shared/vision.ts";
import { skillNameOfRead } from "../../../../coding-agent/src/octocode/skill/catalog.ts";
import { summarizeResult } from "./summary.ts";
import { skillHeader } from "../../../../coding-agent/src/octocode/skill/render.ts";

/** What the extension registers one of the server's tools as: the generic path's name rules (charset, length) apply here too. */
export function octocodeToolName(tool: string): string {
	return createMcpToolName(OCTOCODE_SERVER, tool);
}

/**
 * A tool result for Octocode. Shared content conversion handles text and images.
 * A server bounds and pages its own output and a cut can hide the continuation inside
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
): Promise<AgentToolResult<{ tool: string }>> {
	const content: AgentToolResult["content"] = [];
	let outputTruncated = false;
	let structuredContent =
		declaresOutput && result.structuredContent !== undefined
			? (sanitizeJson(result.structuredContent) as AgentToolResult["structuredContent"])
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
				content: [
					{
						type: "text",
						text: file
							? `Structured result exceeds ${TEXT_MAX_CHARS} characters. Full JSON: ${file}. Request a smaller page or read the saved JSON.`
							: "Structured result exceeds the output limit and could not be saved. Request a smaller page.",
					},
				],
			};
		}
	}
	const modelContent = toLlmContent(result);
	for (const part of sanitizeJson(modelContent) as ReturnType<typeof toLlmContent>) {
		if (part.type === "text") {
			const text =
				part.text.length <= TEXT_MAX_CHARS
					? part.text
					: capOutputToFile(part.text, {
							label: `mcp ${tool}`,
							maxBytes: TEXT_MAX_CHARS,
							maxLines: TEXT_MAX_CHARS + 1,
						});
			outputTruncated ||= text !== part.text;
			content.push({ ...part, text });
		} else if (part.type === "image") {
			content.push(...(await boundImagePart(part, `mcp ${tool} image`, limits ? { limits } : {})));
		} else content.push(part);
	}
	if (failed && content.length === 0) {
		content.push({ type: "text", text: `${tool} failed without a message.` });
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
		summary: targets.length === 1 ? targets[0] : targets.length > 1 ? `${targets.length} queries` : "",
		queries: targets.length > 1 ? targets : [],
	};
}

/**
 * The Octocode tool for one tool the server lists. Its input schema is the server's JSON Schema as is (Octocode validates calls
 * against it). All tools use the host's shared exposure policy: direct by default, with explicit server and tool
 * settings taking precedence.
 */
export function defineOctocodeTool(options: McpToolDefinitionOptions) {
	const { tool, name } = options;
	// Local readers send structured evidence even when their server omits an output schema.
	const outputSchema = tool.outputSchema ?? (LOCAL_READ_TOOLS.has(name) ? {} : undefined);
	const declaresOutput = outputSchema !== undefined;
	const localFetchName = octocodeToolName("localFetch");
	return timedTool(
		createMcpToolDefinition({
			...options,
			presentation: {
				label: tool.title?.trim() || tool.name,
				...(declaresOutput ? { outputSchema } : {}),
				renderCall(args, theme, context) {
					// A model reading a loaded skill's SKILL.md is loading that skill: the row says so.
					const skill = name === localFetchName ? skillNameOfRead(args, context.cwd) : undefined;
					if (skill) return skillHeader(theme, context, skill);
					const { summary, queries } = callSummary(args);
					const lines = queries.map((query) => `${theme.fg("mdCode", query)}`);
					return toolHeader(theme, context, tool.name, summary, { lines });
				},
				renderResult(result, _options, theme, context) {
					const text = resultText(result);
					// An error is one message: its first line is the summary, the rest the body.
					const failed = context.isError;
					// A skill's instructions are one collapsed line, as the `skill` tool shows them.
					if (!failed && name === localFetchName && skillNameOfRead(context.args, context.cwd))
						return resultBlock(theme, context, {
							summary: "Loaded skill",
							summaryColor: "customMessageText",
							body: text,
							max: 0,
							...timingOf(result.details),
						});
					// The server's JSON envelope reads as one human line; the full payload shows when the row expands.
					const brief = summarizeResult(text);
					if (brief)
						return resultBlock(theme, context, { summary: brief, body: text, max: 0, ...timingOf(result.details) });
					return resultBlock(theme, context, {
						summary: failed ? text : "",
						body: failed ? text.split("\n").slice(1).join("\n") : text,
						...timingOf(result.details),
					});
				},
				async convertResult(result, ctx) {
					const converted = await toToolResult(tool.name, result, declaresOutput, imageLimits(ctx.model));
					return { ...converted, details: { ...converted.details, server: options.server } };
				},
			},
		}),
	);
}
