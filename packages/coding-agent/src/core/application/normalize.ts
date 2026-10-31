import {
	applicationContentText,
	type ApplicationContentBlock,
	type ApplicationMessage,
	type ApplicationTool,
	type ContentAnnotation,
} from "@octocodeai/octocode-contracts";
import { compactionSummaryDisplay } from "../messages.ts";
import type { ApplicationAssets } from "./assets.ts";
import { keepEnds, OUTPUT_CHARS } from "./service/projection.ts";

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** Public display values must not retain references to provider objects mutated by later stream chunks. */
export function cloneDisplay<T>(value: T): T {
	return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function preview(
	text: string,
	assets: ApplicationAssets,
	slot?: string,
): { text: string; full?: ReturnType<ApplicationAssets["put"]> } {
	if (text.length <= 4000) return { text };
	return {
		text: `${text.slice(0, 2000)}\n… [Full content available]\n${text.slice(-1900)}`,
		full: assets.put(text, "text/plain", "utf8", undefined, slot),
	};
}

function annotations(value: unknown): ContentAnnotation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) => {
		const source = record(item);
		if (typeof source.type !== "string") return [];
		const annotation: ContentAnnotation = { type: source.type };
		for (const key of ["title", "url", "text", "fileId"] as const)
			if (typeof source[key] === "string") annotation[key] = source[key];
		for (const key of ["startIndex", "endIndex", "documentIndex", "startPage", "endPage"] as const)
			if (typeof source[key] === "number" && Number.isFinite(source[key])) annotation[key] = source[key];
		return [annotation];
	});
}

/** Normalize display data once. Signatures and provider continuation payloads never enter this contract. */
export function normalizeApplicationContent(
	value: unknown,
	owner: string,
	assets: ApplicationAssets,
	streaming = false,
): ApplicationContentBlock[] {
	const blocks = typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [];
	return blocks.map((value, index): ApplicationContentBlock => {
		const block = record(value);
		const id = `${owner}:${index}`;
		const slot = streaming ? id : undefined;
		switch (block.type) {
			case "text":
				return {
					id,
					type: "text",
					...preview(string(block.text) ?? "", assets, slot),
					...(annotations(block.annotations) ? { annotations: annotations(block.annotations) } : {}),
				};
			case "thinking":
				return {
					id,
					type: "thinking",
					...preview(string(block.thinking) ?? "", assets, slot),
					...(block.redacted === true ? { redacted: true } : {}),
				};
			case "image":
				if (typeof block.data === "string" && typeof block.mimeType === "string")
					return {
						id,
						type: "image",
						asset: assets.put(block.data, block.mimeType, "base64", string(block.name), slot),
					};
				return { id, type: "unsupported", providerType: "image", text: "Image data unavailable" };
			case "media":
				return {
					id,
					type: "media",
					mimeType: string(block.mimeType) ?? "application/octet-stream",
					...(typeof block.data === "string"
						? {
								asset: assets.put(
									block.data,
									string(block.mimeType) ?? "application/octet-stream",
									"base64",
									string(block.name),
									slot,
								),
							}
						: {}),
					...(typeof block.uri === "string" ? { uri: block.uri } : {}),
					...(typeof block.name === "string" ? { name: block.name } : {}),
				};
			case "resource":
				return {
					id,
					type: "resource",
					uri: string(block.uri) ?? "",
					...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
					...(typeof block.name === "string" ? { name: block.name } : {}),
					...(typeof block.text === "string" ? preview(block.text, assets, slot) : {}),
				};
			case "toolCall":
				return {
					id,
					type: "toolCall",
					toolCallId: string(block.id) ?? id,
					name: string(block.name) ?? "unknown",
					arguments: cloneDisplay(block.arguments ?? {}),
				};
			default:
				return {
					id,
					type: "unsupported",
					providerType: string(block.providerType) ?? string(block.type) ?? "unknown",
					...preview(string(block.text) ?? `Unsupported content: ${string(block.type) ?? "unknown"}`, assets, slot),
				};
		}
	});
}

export function normalizeApplicationMessage(value: unknown, id: string, assets: ApplicationAssets): ApplicationMessage {
	const source = record(value);
	const bashContent =
		source.role === "bashExecution"
			? [
					{ type: "text", text: `$ ${string(source.command) ?? ""}` },
					{ type: "text", text: string(source.fullOutput) ?? string(source.output) ?? "" },
					...(source.truncated === true && typeof source.fullOutput !== "string"
						? [
								{
									type: "unsupported",
									providerType: "shell-output-unavailable",
									text:
										string(source.fullOutputUnavailable) ??
										"Full shell output is unavailable; the displayed output is truncated",
								},
							]
						: []),
				]
			: undefined;
	// A compaction summary is written for the model: the web view shows what the terminal does.
	const compactionContent =
		source.role === "compactionSummary" && typeof source.summary === "string"
			? compactionSummaryDisplay({
					summary: source.summary,
					tokensBefore: typeof source.tokensBefore === "number" ? source.tokensBefore : 0,
				})
			: undefined;
	const content = normalizeApplicationContent(
		bashContent ?? compactionContent ?? source.content ?? source.summary ?? source.output,
		id,
		assets,
		source.stopReason === "pending",
	);
	const stopReason = string(source.stopReason);
	const complete = stopReason !== "pending";
	const message: ApplicationMessage = {
		id,
		role: string(source.role) ?? "custom",
		content,
		text: keepEnds(applicationContentText(content), OUTPUT_CHARS),
		complete,
		status: !complete
			? "streaming"
			: stopReason === "aborted" || (source.role === "bashExecution" && source.cancelled === true)
				? "aborted"
				: stopReason === "error" ||
					  source.isError === true ||
					  (source.role === "bashExecution" && typeof source.exitCode === "number" && source.exitCode !== 0)
					? "failed"
					: stopReason === "length"
						? "interrupted"
						: "completed",
	};
	for (const key of [
		"provider",
		"model",
		"responseId",
		"stopReason",
		"errorMessage",
		"toolCallId",
		"customType",
	] as const)
		if (typeof source[key] === "string") message[key] = source[key];
	for (const key of ["timestamp", "durationMs"] as const)
		if (typeof source[key] === "number" && Number.isFinite(source[key])) message[key] = source[key];
	if (source.usage && typeof source.usage === "object") message.usage = cloneDisplay(record(source.usage));
	if (source.details !== undefined) message.details = cloneDisplay(source.details);
	const detailKeys =
		source.role === "bashExecution"
			? [
					"command",
					"exitCode",
					"cancelled",
					"truncated",
					"excludeFromContext",
					"fullOutputPath",
					"fullOutputUnavailable",
				]
			: source.role === "branchSummary"
				? ["fromId"]
				: source.role === "compactionSummary"
					? ["tokensBefore"]
					: [];
	if (detailKeys.length)
		message.details = cloneDisplay(
			Object.fromEntries(detailKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
		);
	if (source.role === "custom" || source.role === "system")
		message.display = source.role === "custom" && source.display === true;
	if (JSON.stringify(message).length > 60000) {
		return {
			id,
			role: message.role,
			complete,
			status: message.status,
			display: message.display,
			text: "[Full message available]",
			content: [
				{ id: `${id}:full`, type: "unsupported", providerType: "large-message", text: "Full message available" },
			],
			full: assets.put(
				JSON.stringify(message),
				"application/json",
				"utf8",
				undefined,
				source.stopReason === "pending" ? `${id}:full` : undefined,
			),
		};
	}
	return message;
}

/** Keep structured output readable without putting unbounded JSON in every streamed frame. */
export function normalizeToolData(
	value: unknown,
	id: string,
	assets: ApplicationAssets,
	streaming = false,
): Partial<ApplicationTool> {
	const source = record(value);
	const data: Partial<ApplicationTool> = {
		content: normalizeApplicationContent(source.content, id, assets, streaming),
	};
	for (const key of ["structuredContent", "details"] as const)
		if (source[key] !== undefined) data[key] = cloneDisplay(source[key]);
	if (source.usage && typeof source.usage === "object") data.usage = cloneDisplay(record(source.usage));
	if (typeof source.durationMs === "number") data.durationMs = source.durationMs;
	if (JSON.stringify({ structuredContent: data.structuredContent, details: data.details }).length > 8000) {
		data.full = assets.put(
			JSON.stringify({ structuredContent: data.structuredContent, details: data.details }),
			"application/json",
			"utf8",
			undefined,
			streaming ? `${id}:data` : undefined,
		);
		delete data.structuredContent;
		delete data.details;
	}
	return data;
}
